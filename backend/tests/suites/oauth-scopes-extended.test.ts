/**
 * oauth-scopes-extended — per-resource OAuth scope enforcement for the
 * additional modules tagged in Wave 21.2 (inventory, discounts, tax, …).
 *
 * The mechanism is identical to oauth-scopes.test.ts: a storeAuth tier guard
 * tagged with a resource (e.g. `storeAuthRead("inventory")`) makes the central
 * resolver (lib/auth/middleware.ts → resolveStoreAuth) require the SPECIFIC
 * scope `${resource}:${tier}` for OAuth-app principals. A scope on a DIFFERENT
 * resource never satisfies the route. Dashboard JWTs and API keys carry no
 * oauth_app claim, so they bypass the gate entirely and keep full access.
 *
 * This suite proves enforcement for three newly-tagged resources end-to-end
 * against the running app + Neon test DB:
 *   1. inventory:read  → GET /inventory/low-stock 200, but the same token is
 *      403 INSUFFICIENT_SCOPE on a discounts route it lacks scope for.
 *   2. discounts:read  → GET /discounts/validate passes the auth gate (non-403),
 *      but is 403 on an inventory route.
 *   3. tax:write       → POST /tax/duty-rates passes the auth gate; a tax:read
 *      token is 403 on the same write route (read does not imply write).
 *   4. A dashboard JWT reaches all of the above (unaffected by scopes).
 *
 * OAuth tokens are obtained via the client_credentials grant (confidential
 * client acting on its OWN org), matching oauth-scopes.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, mintJwt } from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

async function rawFetch(opts: {
  method: string;
  path: string;
  body?: unknown;
  bearer?: string | null;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
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
  return { status: res.status, json };
}

function uniqEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@cartcrft-test.example.com`;
}

interface Merchant {
  accessToken: string; // dashboard JWT
  orgId: string;
  userId: string;
  storeId: string;
}

async function newMerchantWithStore(prefix: string): Promise<Merchant> {
  const reg = await rawFetch({
    method: "POST",
    path: "/account/register",
    body: { email: uniqEmail(prefix), password: "a-strong-password-1" },
  });
  expect(reg.status).toBe(201);
  const accessToken = reg.json["access_token"] as string;
  const user = reg.json["user"] as Record<string, unknown>;
  const orgId = user["org_id"] as string;
  const userId = user["id"] as string;

  const store = await post(
    ctx,
    "/commerce/stores",
    { name: `Scopes Store ${Date.now()}`, currency: "USD" },
    { type: "bearer", token: accessToken }
  );
  expect(store.status).toBe(201);
  const storeId = store.json["id"] as string;
  return { accessToken, orgId, userId, storeId };
}

/**
 * Register a confidential app with the given allowed_scopes and mint an OAuth
 * access token for those scopes via client_credentials (acts on its own org).
 */
async function oauthToken(merchant: Merchant, scopes: string[]): Promise<string> {
  const reg = await post(
    ctx,
    "/account/oauth-apps",
    {
      name: `Scopes App ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      redirect_uris: ["https://app.example.com/callback"],
      allowed_scopes: scopes,
    },
    { type: "bearer", token: merchant.accessToken }
  );
  expect(reg.status).toBe(201);
  const clientId = reg.json["client_id"] as string;
  const clientSecret = reg.json["client_secret"] as string;

  const tok = await rawFetch({
    method: "POST",
    path: "/oauth/token",
    body: {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: scopes.join(" "),
    },
  });
  expect(tok.status).toBe(200);
  return tok.json["access_token"] as string;
}

function errCode(json: Record<string, unknown>): unknown {
  return (json["error"] as Record<string, unknown> | undefined)?.["code"];
}

// ── 1. inventory:read reads inventory but not a discounts route ───────────────

describe("per-resource read scope (inventory:read)", () => {
  it("GETs inventory low-stock (200) but is 403 on a discounts route", async () => {
    const m = await newMerchantWithStore("invread");
    const token = await oauthToken(m, ["inventory:read"]);

    // Read-tier route tagged "inventory" → satisfied.
    const lowStock = await get(
      ctx,
      `/commerce/stores/${m.storeId}/inventory/low-stock`,
      { type: "bearer", token }
    );
    expect(lowStock.status).toBe(200);

    // Read-tier route tagged "discounts" → different resource → 403.
    const validate = await get(
      ctx,
      `/commerce/stores/${m.storeId}/discounts/validate?code=NOPE&order_total=10`,
      { type: "bearer", token }
    );
    expect(validate.status).toBe(403);
    expect(errCode(validate.json)).toBe("INSUFFICIENT_SCOPE");
  });
});

// ── 2. discounts:read reads discounts but not an inventory route ──────────────

describe("per-resource read scope (discounts:read)", () => {
  it("passes the discounts auth gate (non-403) but is 403 on an inventory route", async () => {
    const m = await newMerchantWithStore("disread");
    const token = await oauthToken(m, ["discounts:read"]);

    // Read-tier route tagged "discounts" → satisfied. The handler 404s on an
    // unknown code, but auth passed — assert we are NOT scope-blocked.
    const validate = await get(
      ctx,
      `/commerce/stores/${m.storeId}/discounts/validate?code=NOPE&order_total=10`,
      { type: "bearer", token }
    );
    expect(validate.status).not.toBe(403);

    // Read-tier route tagged "inventory" → different resource → 403.
    const lowStock = await get(
      ctx,
      `/commerce/stores/${m.storeId}/inventory/low-stock`,
      { type: "bearer", token }
    );
    expect(lowStock.status).toBe(403);
    expect(errCode(lowStock.json)).toBe("INSUFFICIENT_SCOPE");
  });
});

// ── 3. tax:write writes tax; tax:read cannot (read does not imply write) ───────

describe("per-resource write scope (tax)", () => {
  const dutyBody = { destination_country: "US", rate_pct: 5 };

  it("tax:write passes the write-tier tax auth gate (non-403)", async () => {
    const m = await newMerchantWithStore("taxwrite");
    const token = await oauthToken(m, ["tax:write"]);

    const created = await post(
      ctx,
      `/commerce/stores/${m.storeId}/tax/duty-rates`,
      dutyBody,
      { type: "bearer", token }
    );
    expect(created.status).not.toBe(403);
  });

  it("tax:read cannot write tax (403)", async () => {
    const m = await newMerchantWithStore("taxread");
    const token = await oauthToken(m, ["tax:read"]);

    const created = await post(
      ctx,
      `/commerce/stores/${m.storeId}/tax/duty-rates`,
      dutyBody,
      { type: "bearer", token }
    );
    expect(created.status).toBe(403);
    expect(errCode(created.json)).toBe("INSUFFICIENT_SCOPE");
  });
});

// ── 4. Dashboard JWT bypasses the per-resource gate entirely ──────────────────

describe("dashboard JWT is unaffected by per-resource scopes", () => {
  it("reaches inventory, discounts, and tax write routes", async () => {
    const m = await newMerchantWithStore("jwtwave");
    const jwt = await mintJwt({ userId: m.userId, orgId: m.orgId });

    const lowStock = await get(
      ctx,
      `/commerce/stores/${m.storeId}/inventory/low-stock`,
      { type: "bearer", token: jwt }
    );
    expect(lowStock.status).toBe(200);

    const validate = await get(
      ctx,
      `/commerce/stores/${m.storeId}/discounts/validate?code=NOPE&order_total=10`,
      { type: "bearer", token: jwt }
    );
    expect(validate.status).not.toBe(403);

    const created = await post(
      ctx,
      `/commerce/stores/${m.storeId}/tax/duty-rates`,
      { destination_country: "US", rate_pct: 5 },
      { type: "bearer", token: jwt }
    );
    expect(created.status).not.toBe(403);
  });
});
