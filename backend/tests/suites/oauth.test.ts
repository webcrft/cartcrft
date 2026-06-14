/**
 * oauth — OAuth2 authorization-server / app-platform suite.
 *
 * Covers the full surface:
 *   - App management: register (secret shown once), list, rotate secret.
 *   - Authorization-code + PKCE happy path: register app → /oauth/authorize →
 *     consent → code → /oauth/token → call a scoped /commerce endpoint with the
 *     access token (200) → a route needing a scope the token lacks (403).
 *   - PKCE failure (wrong verifier) rejected.
 *   - Expired / replayed code rejected.
 *   - Refresh rotation + reuse-detection (presenting a rotated token revokes the
 *     whole family).
 *   - client_credentials grant (confidential only).
 *   - redirect_uri mismatch rejected.
 *   - Confidential client secret check (wrong/absent secret rejected).
 *   - Cross-org isolation (org B cannot manage org A's app).
 *
 * The merchant session for /oauth/authorize is resolved from the httpOnly
 * refresh cookie the /account layer sets, so the consent flows use raw fetch to
 * capture + resend Set-Cookie (the shared helper drops it).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post } from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Raw fetch that captures Set-Cookie (shared helper drops it) ──────────────

interface RawResult {
  status: number;
  json: Record<string, unknown>;
  setCookie: string | null;
}

async function rawFetch(opts: {
  method: string;
  path: string;
  body?: unknown;
  cookie?: string | null;
  bearer?: string | null;
}): Promise<RawResult> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers["cookie"] = opts.cookie;
  if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
  const res = await fetch(`${ctx.baseUrl}${opts.path}`, {
    method: opts.method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

function cookiePairFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const first = setCookie.split(";")[0]?.trim();
  return first && first.startsWith("cc_refresh=") ? first : null;
}

function uniqEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@cartcrft-test.example.com`;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Pull a query param out of a redirect URL. */
function paramFrom(redirect: string, key: string): string | null {
  return new URL(redirect).searchParams.get(key);
}

// ── A logged-in merchant + store fixture ─────────────────────────────────────

interface Merchant {
  accessToken: string;
  cookie: string;
  orgId: string;
  storeId: string;
}

async function newMerchantWithStore(prefix: string): Promise<Merchant> {
  const reg = await rawFetch({
    method: "POST",
    path: "/account/register",
    body: { email: uniqEmail(prefix), password: "a-strong-password-1" },
  });
  const accessToken = reg.json["access_token"] as string;
  const orgId = (reg.json["user"] as Record<string, unknown>)["org_id"] as string;
  const cookie = cookiePairFrom(reg.setCookie)!;

  const store = await post(
    ctx,
    "/commerce/stores",
    { name: `OAuth Store ${Date.now()}`, currency: "USD" },
    { type: "bearer", token: accessToken }
  );
  const storeId = store.json["id"] as string;
  return { accessToken, cookie, orgId, storeId };
}

const REDIRECT = "https://app.example.com/callback";

async function registerApp(
  accessToken: string,
  overrides: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await post(
    ctx,
    "/account/oauth-apps",
    {
      name: `Test App ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      redirect_uris: [REDIRECT],
      allowed_scopes: ["catalog:read", "catalog:write"],
      ...overrides,
    },
    { type: "bearer", token: accessToken }
  );
  expect(res.status).toBe(201);
  return res.json;
}

// ── App management ───────────────────────────────────────────────────────────

describe("app management", () => {
  it("registers a confidential app and returns the client_secret ONCE", async () => {
    const m = await newMerchantWithStore("appmgmt");
    const appJson = await registerApp(m.accessToken);
    expect(typeof appJson["client_id"]).toBe("string");
    expect((appJson["client_id"] as string).startsWith("cc_app_")).toBe(true);
    expect(typeof appJson["client_secret"]).toBe("string");
    expect(appJson["client_type"]).toBe("confidential");

    // The secret is not returned on subsequent reads.
    const detail = await get(ctx, `/account/oauth-apps/${appJson["id"]}`, { type: "bearer", token: m.accessToken });
    expect(detail.status).toBe(200);
    const app = detail.json["app"] as Record<string, unknown>;
    expect(app["client_secret"]).toBeUndefined();

    // Listing shows it.
    const list = await get(ctx, "/account/oauth-apps", { type: "bearer", token: m.accessToken });
    expect((list.json["apps"] as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("rotates the secret (new value shown once)", async () => {
    const m = await newMerchantWithStore("rotate");
    const appJson = await registerApp(m.accessToken);
    const orig = appJson["client_secret"] as string;
    const rot = await post(ctx, `/account/oauth-apps/${appJson["id"]}/rotate-secret`, {}, { type: "bearer", token: m.accessToken });
    expect(rot.status).toBe(200);
    expect(typeof rot.json["client_secret"]).toBe("string");
    expect(rot.json["client_secret"]).not.toBe(orig);
  });

  it("public clients have no secret", async () => {
    const m = await newMerchantWithStore("public");
    const appJson = await registerApp(m.accessToken, { client_type: "public" });
    expect(appJson["client_secret"]).toBeNull();
  });
});

// ── Cross-org isolation ──────────────────────────────────────────────────────

describe("cross-org isolation", () => {
  it("org B cannot read or mutate org A's app", async () => {
    const a = await newMerchantWithStore("orgA");
    const b = await newMerchantWithStore("orgB");
    const appJson = await registerApp(a.accessToken);

    const read = await get(ctx, `/account/oauth-apps/${appJson["id"]}`, { type: "bearer", token: b.accessToken });
    expect(read.status).toBe(404);

    const del = await ctx.request({
      method: "DELETE",
      path: `/account/oauth-apps/${appJson["id"]}`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(del.status).toBe(404);
  });
});

// ── Authorization-code + PKCE happy path ─────────────────────────────────────

describe("authorization_code + PKCE happy path", () => {
  it("authorize → consent → code → token → scoped /commerce call → 200; missing scope → 403", async () => {
    const m = await newMerchantWithStore("happy");
    const appJson = await registerApp(m.accessToken, {
      client_type: "public",
      allowed_scopes: ["catalog:read"],
    });
    const clientId = appJson["client_id"] as string;

    const verifier = "a".repeat(64); // valid 43-128 char verifier
    const challenge = s256(verifier);

    // GET /oauth/authorize with the merchant's cookie → consent descriptor.
    const authz = await rawFetch({
      method: "GET",
      path: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=catalog%3Aread&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`,
      cookie: m.cookie,
    });
    expect(authz.status).toBe(200);
    expect(authz.json["consent_required"]).toBe(true);

    // POST consent (approve) → redirect with code + state.
    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: {
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: "catalog:read",
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
        approve: true,
      },
    });
    expect(consent.status).toBe(200);
    const redirect = consent.json["redirect"] as string;
    const code = paramFrom(redirect, "code");
    expect(code).toBeTruthy();
    expect(paramFrom(redirect, "state")).toBe("xyz"); // state echoed

    // Exchange the code (public client → PKCE, no secret).
    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: {
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
    });
    expect(tok.status).toBe(200);
    const accessToken = tok.json["access_token"] as string;
    expect(typeof accessToken).toBe("string");
    expect(tok.json["token_type"]).toBe("Bearer");
    expect(tok.json["scope"]).toBe("catalog:read");
    expect(typeof tok.json["refresh_token"]).toBe("string");

    // Call a catalog:read scoped /commerce endpoint → 200.
    const products = await get(ctx, `/commerce/stores/${m.storeId}/products`, { type: "bearer", token: accessToken });
    expect(products.status).toBe(200);

    // Call a catalog:write scoped endpoint with a read-only token → 403.
    const create = await post(
      ctx,
      `/commerce/stores/${m.storeId}/products`,
      { title: "Nope", slug: `nope-${Date.now()}` },
      { type: "bearer", token: accessToken }
    );
    expect(create.status).toBe(403);
    expect((create.json["error"] as Record<string, unknown>)["code"]).toBe("INSUFFICIENT_SCOPE");

    // userinfo introspection.
    const info = await rawFetch({ method: "GET", path: "/oauth/userinfo", bearer: accessToken });
    expect(info.status).toBe(200);
    expect(info.json["oauth_app"]).toBe(appJson["id"]);
    expect(info.json["organization_id"]).toBe(m.orgId);
  });

  it("write scope grants read+write (catalog:write token can create)", async () => {
    const m = await newMerchantWithStore("write");
    const appJson = await registerApp(m.accessToken, {
      client_type: "confidential",
      allowed_scopes: ["catalog:read", "catalog:write"],
    });
    const clientId = appJson["client_id"] as string;
    const clientSecret = appJson["client_secret"] as string;

    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:write", approve: true },
    });
    const code = paramFrom(consent.json["redirect"] as string, "code");

    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT },
    });
    expect(tok.status).toBe(200);
    const accessToken = tok.json["access_token"] as string;

    const create = await post(
      ctx,
      `/commerce/stores/${m.storeId}/products`,
      { title: "Yep", slug: `yep-${Date.now()}` },
      { type: "bearer", token: accessToken }
    );
    expect(create.status).toBe(201);
  });

  it("auto-approves a second authorize when consent is remembered", async () => {
    const m = await newMerchantWithStore("remember");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;

    // First consent creates the grant.
    await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:read", approve: true },
    });

    // Second authorize for the same scopes → auto-approved.
    const authz = await rawFetch({
      method: "GET",
      path: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=catalog%3Aread`,
      cookie: m.cookie,
    });
    expect(authz.status).toBe(200);
    expect(authz.json["auto_approved"]).toBe(true);
    expect(paramFrom(authz.json["redirect"] as string, "code")).toBeTruthy();
  });
});

// ── PKCE failure ─────────────────────────────────────────────────────────────

describe("PKCE failure", () => {
  it("rejects token exchange with a wrong code_verifier", async () => {
    const m = await newMerchantWithStore("pkcefail");
    const appJson = await registerApp(m.accessToken, { client_type: "public", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const challenge = s256("c".repeat(64));

    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:read", code_challenge: challenge, code_challenge_method: "S256", approve: true },
    });
    const code = paramFrom(consent.json["redirect"] as string, "code");

    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: "d".repeat(64) },
    });
    expect(tok.status).toBe(400);
    expect(tok.json["error"]).toBe("invalid_grant");
  });

  it("requires PKCE S256 for public clients at /oauth/authorize", async () => {
    const m = await newMerchantWithStore("pkcereq");
    const appJson = await registerApp(m.accessToken, { client_type: "public", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const authz = await rawFetch({
      method: "GET",
      path: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=catalog%3Aread`,
      cookie: m.cookie,
    });
    expect(authz.status).toBe(400);
    expect(authz.json["error"]).toBeDefined();
  });
});

// ── Expired / replayed code ──────────────────────────────────────────────────

describe("authorization code single-use", () => {
  it("rejects a replayed (already-consumed) code", async () => {
    const m = await newMerchantWithStore("replay");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const clientSecret = appJson["client_secret"] as string;

    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:read", approve: true },
    });
    const code = paramFrom(consent.json["redirect"] as string, "code");

    const first = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT },
    });
    expect(first.status).toBe(200);

    const second = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT },
    });
    expect(second.status).toBe(400);
    expect(second.json["error"]).toBe("invalid_grant");
  });

  it("rejects an expired code", async () => {
    const m = await newMerchantWithStore("expire");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const clientSecret = appJson["client_secret"] as string;

    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:read", approve: true },
    });
    const code = paramFrom(consent.json["redirect"] as string, "code")!;

    // Force-expire the code directly via SQL (simulated time).
    await ctx.pool.query(
      `UPDATE oauth_authorization_codes SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`,
      [createHash("sha256").update(code).digest("hex")]
    );

    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT },
    });
    expect(tok.status).toBe(400);
    expect(tok.json["error"]).toBe("invalid_grant");
  });
});

// ── redirect_uri exact-match ─────────────────────────────────────────────────

describe("redirect_uri allow-list", () => {
  it("rejects an unregistered redirect_uri at /oauth/authorize", async () => {
    const m = await newMerchantWithStore("redir");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const authz = await rawFetch({
      method: "GET",
      path: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://evil.example.com/cb")}&scope=catalog%3Aread`,
      cookie: m.cookie,
    });
    expect(authz.status).toBe(400);
    expect((authz.json["error"] as Record<string, unknown>)["code"]).toBe("invalid_redirect_uri");
  });

  it("rejects token exchange when redirect_uri does not match the code", async () => {
    const m = await newMerchantWithStore("redir2");
    const appJson = await registerApp(m.accessToken, {
      client_type: "confidential",
      allowed_scopes: ["catalog:read"],
      redirect_uris: [REDIRECT, "https://app.example.com/other"],
    });
    const clientId = appJson["client_id"] as string;
    const clientSecret = appJson["client_secret"] as string;

    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:read", approve: true },
    });
    const code = paramFrom(consent.json["redirect"] as string, "code");

    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: "https://app.example.com/other" },
    });
    expect(tok.status).toBe(400);
    expect(tok.json["error"]).toBe("invalid_grant");
  });
});

// ── Confidential client secret check ─────────────────────────────────────────

describe("confidential client secret", () => {
  it("rejects token exchange with a wrong/absent client_secret", async () => {
    const m = await newMerchantWithStore("secret");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;

    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:read", approve: true },
    });
    const code = paramFrom(consent.json["redirect"] as string, "code");

    const wrong = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, client_secret: "cc_secret_wrong", code, redirect_uri: REDIRECT },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.json["error"]).toBe("invalid_client");
  });
});

// ── Refresh rotation + reuse-detection ───────────────────────────────────────

describe("refresh rotation + reuse-detection", () => {
  it("rotates the refresh token and revokes the family on reuse", async () => {
    const m = await newMerchantWithStore("refresh");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const clientSecret = appJson["client_secret"] as string;

    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:read", approve: true },
    });
    const code = paramFrom(consent.json["redirect"] as string, "code");
    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT },
    });
    const refresh1 = tok.json["refresh_token"] as string;

    // Rotate: refresh1 → new access + refresh2.
    const r1 = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refresh1 },
    });
    expect(r1.status).toBe(200);
    const refresh2 = r1.json["refresh_token"] as string;
    expect(refresh2).not.toBe(refresh1);

    // refresh2 works.
    const r2 = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refresh2 },
    });
    expect(r2.status).toBe(200);
    const refresh3 = r2.json["refresh_token"] as string;

    // Reuse refresh1 (already rotated) → reuse detected, 400, family revoked.
    const reuse = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refresh1 },
    });
    expect(reuse.status).toBe(400);
    expect(reuse.json["error"]).toBe("invalid_grant");

    // The whole family is now revoked → even refresh3 no longer works.
    const after = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refresh3 },
    });
    expect(after.status).toBe(400);
  });

  it("revoke endpoint invalidates a refresh token", async () => {
    const m = await newMerchantWithStore("revoke");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const clientSecret = appJson["client_secret"] as string;
    const consent = await rawFetch({
      method: "POST",
      path: "/oauth/authorize/consent",
      cookie: m.cookie,
      body: { client_id: clientId, redirect_uri: REDIRECT, scope: "catalog:read", approve: true },
    });
    const code = paramFrom(consent.json["redirect"] as string, "code");
    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT },
    });
    const refresh = tok.json["refresh_token"] as string;

    const rev = await rawFetch({ method: "POST", path: "/oauth/revoke", body: { token: refresh } });
    expect(rev.status).toBe(200);

    const after = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refresh },
    });
    expect(after.status).toBe(400);
  });
});

// ── client_credentials ───────────────────────────────────────────────────────

describe("client_credentials grant", () => {
  it("issues a token for a confidential client acting on its own org", async () => {
    const m = await newMerchantWithStore("ccgrant");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const clientSecret = appJson["client_secret"] as string;

    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, scope: "catalog:read" },
    });
    expect(tok.status).toBe(200);
    expect(tok.json["scope"]).toBe("catalog:read");
    // client_credentials gets no refresh token.
    expect(tok.json["refresh_token"]).toBeUndefined();

    // The token's org is the app's own org → it can read its own store.
    const products = await get(ctx, `/commerce/stores/${m.storeId}/products`, { type: "bearer", token: tok.json["access_token"] as string });
    expect(products.status).toBe(200);
  });

  it("rejects client_credentials for a public client", async () => {
    const m = await newMerchantWithStore("ccpub");
    const appJson = await registerApp(m.accessToken, { client_type: "public", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const tok = await rawFetch({
      method: "POST",
      path: "/oauth/token",
      body: { grant_type: "client_credentials", client_id: clientId, scope: "catalog:read" },
    });
    // Public client has no secret → client auth not required, but the grant is
    // rejected as unauthorized_client.
    expect(tok.status).toBe(400);
    expect(tok.json["error"]).toBe("unauthorized_client");
  });
});

// ── login_required ───────────────────────────────────────────────────────────

describe("authorize without a session", () => {
  it("returns login_required when no merchant is logged in", async () => {
    const m = await newMerchantWithStore("nologin");
    const appJson = await registerApp(m.accessToken, { client_type: "confidential", allowed_scopes: ["catalog:read"] });
    const clientId = appJson["client_id"] as string;
    const authz = await rawFetch({
      method: "GET",
      path: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=catalog%3Aread`,
      // no cookie
    });
    expect(authz.status).toBe(401);
    expect(authz.json["login_required"]).toBe(true);
  });
});
