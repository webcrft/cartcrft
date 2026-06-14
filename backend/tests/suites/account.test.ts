/**
 * account — platform-account auth suite (P3 / audit item 1).
 *
 * Verifies the new dashboard login model that replaces the cc_prv_-in-browser
 * trust model:
 *   - POST /account/register creates a NEW org + an owner platform_user and
 *     returns a short-lived access JWT + an httpOnly refresh cookie.
 *   - The access JWT is accepted by the EXISTING org middleware: it
 *     authenticates GET /commerce/stores (requireJwt), creates a store under
 *     its org, and passes the storeAuthAdmin tier on GET /commerce/stores/:id.
 *   - POST /account/login authenticates by email+password; lockout after N
 *     failures; the issued access JWT also works on /commerce.
 *   - POST /account/refresh reads the httpOnly cookie, rotates the session
 *     (old refresh token no longer works), and mints a fresh access JWT.
 *   - POST /account/logout revokes the session (its refresh token stops
 *     working) and clears the cookie.
 *   - Team: /account/users list, invite, delete, with owner/admin role gating.
 *
 * Cookie handling: the shared ctx.request() helper does not expose response
 * headers, so the cookie-dependent flows use raw fetch() against ctx.baseUrl to
 * capture Set-Cookie and resend it.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post } from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Raw fetch helper that captures Set-Cookie (the shared helper drops it) ────

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

/** Extract the cc_refresh cookie name=value pair from a Set-Cookie header for resending. */
function cookiePairFrom(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const first = setCookie.split(";")[0]?.trim();
  return first && first.startsWith("cc_refresh=") ? first : null;
}

function uniqEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@cartcrft-test.example.com`;
}

// ── Register ──────────────────────────────────────────────────────────────────

describe("register → creates org + owner + session", () => {
  it("returns an access token, an owner user, and sets an httpOnly refresh cookie", async () => {
    const email = uniqEmail("owner");
    const res = await rawFetch({
      method: "POST",
      path: "/account/register",
      body: { email, password: "correct horse battery" },
    });
    expect(res.status).toBe(201);
    expect(typeof res.json["access_token"]).toBe("string");
    const user = res.json["user"] as Record<string, unknown>;
    expect(user["email"]).toBe(email);
    expect(user["role"]).toBe("owner");
    expect(typeof user["org_id"]).toBe("string");

    // Cookie hardening: httpOnly + SameSite=Lax + scoped to /account.
    const sc = res.setCookie ?? "";
    expect(sc).toContain("cc_refresh=");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(sc).toContain("Path=/account");
  });

  it("rejects a weak (too-short) password", async () => {
    const res = await rawFetch({
      method: "POST",
      path: "/account/register",
      body: { email: uniqEmail("weak"), password: "short" },
    });
    expect(res.status).toBe(400);
  });
});

// ── Access JWT is accepted by the existing org middleware ────────────────────

describe("access JWT works on existing /commerce routes (org middleware)", () => {
  let accessToken = "";
  let orgId = "";

  beforeAll(async () => {
    const reg = await rawFetch({
      method: "POST",
      path: "/account/register",
      body: { email: uniqEmail("commerce"), password: "a-strong-password-1" },
    });
    accessToken = reg.json["access_token"] as string;
    orgId = (reg.json["user"] as Record<string, unknown>)["org_id"] as string;
  });

  it("GET /commerce/stores authenticates with the access JWT (requireJwt)", async () => {
    const res = await get(ctx, "/commerce/stores", { type: "bearer", token: accessToken });
    expect(res.status).toBe(200);
    // New org → empty store list.
    expect(Array.isArray((res.json as Record<string, unknown>)["stores"])).toBe(true);
  });

  it("POST /commerce/stores creates a store under the JWT's org, and storeAuthAdmin accepts the token", async () => {
    const create = await post(
      ctx,
      "/commerce/stores",
      { name: `Acct Store ${Date.now()}`, currency: "USD" },
      { type: "bearer", token: accessToken }
    );
    expect(create.status).toBe(201);
    const storeId = create.json["id"] as string;
    expect(typeof storeId).toBe("string");

    // storeAuthAdmin tier (admin JWT path) — proves full admin access.
    const detail = await get(ctx, `/commerce/stores/${storeId}`, { type: "bearer", token: accessToken });
    expect(detail.status).toBe(200);
  });

  it("rejects a missing token", async () => {
    const res = await get(ctx, "/commerce/stores");
    expect(res.status).toBe(401);
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────

describe("login", () => {
  const email = uniqEmail("login");
  const password = "login-password-123";

  beforeAll(async () => {
    await rawFetch({ method: "POST", path: "/account/register", body: { email, password } });
  });

  it("succeeds with correct credentials and issues a working access JWT", async () => {
    const res = await rawFetch({ method: "POST", path: "/account/login", body: { email, password } });
    expect(res.status).toBe(200);
    const token = res.json["access_token"] as string;
    expect(typeof token).toBe("string");
    expect(cookiePairFrom(res.setCookie)).not.toBeNull();

    const stores = await get(ctx, "/commerce/stores", { type: "bearer", token });
    expect(stores.status).toBe(200);
  });

  it("fails with a wrong password (401 INVALID_CREDENTIALS)", async () => {
    const res = await rawFetch({ method: "POST", path: "/account/login", body: { email, password: "nope" } });
    expect(res.status).toBe(401);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("INVALID_CREDENTIALS");
  });

  it("does not enumerate: unknown email also returns 401 INVALID_CREDENTIALS", async () => {
    const res = await rawFetch({ method: "POST", path: "/account/login", body: { email: uniqEmail("ghost"), password: "whatever123" } });
    expect(res.status).toBe(401);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("INVALID_CREDENTIALS");
  });
});

// ── Lockout ───────────────────────────────────────────────────────────────────

describe("lockout after repeated failures", () => {
  it("locks the account (423 LOCKED) after 5 consecutive bad passwords", async () => {
    const email = uniqEmail("lock");
    const password = "lockout-password-1";
    await rawFetch({ method: "POST", path: "/account/register", body: { email, password } });

    // 5 wrong attempts → the 5th flips the lock.
    let last: RawResult | null = null;
    for (let i = 0; i < 5; i++) {
      last = await rawFetch({ method: "POST", path: "/account/login", body: { email, password: "wrong-pass" } });
    }
    expect(last!.status).toBe(423);

    // Even the CORRECT password is now refused while locked.
    const correct = await rawFetch({ method: "POST", path: "/account/login", body: { email, password } });
    expect(correct.status).toBe(423);
    expect((correct.json["error"] as Record<string, unknown>)["code"]).toBe("LOCKED");
  });
});

// ── Refresh (rotation) ────────────────────────────────────────────────────────

describe("refresh rotates the session", () => {
  it("issues a new access token from the httpOnly cookie and invalidates the old refresh token", async () => {
    const email = uniqEmail("refresh");
    const reg = await rawFetch({ method: "POST", path: "/account/register", body: { email, password: "refresh-pass-12" } });
    const cookie1 = cookiePairFrom(reg.setCookie);
    expect(cookie1).not.toBeNull();

    // Refresh with the original cookie → new access token + a NEW rotated cookie.
    const r1 = await rawFetch({ method: "POST", path: "/account/refresh", cookie: cookie1 });
    expect(r1.status).toBe(200);
    expect(typeof r1.json["access_token"]).toBe("string");
    const cookie2 = cookiePairFrom(r1.setCookie);
    expect(cookie2).not.toBeNull();
    expect(cookie2).not.toBe(cookie1); // rotated

    // The new access token works on /commerce.
    const stores = await get(ctx, "/commerce/stores", { type: "bearer", token: r1.json["access_token"] as string });
    expect(stores.status).toBe(200);

    // The ORIGINAL refresh token is now revoked (rotation) → 401.
    const reuse = await rawFetch({ method: "POST", path: "/account/refresh", cookie: cookie1 });
    expect(reuse.status).toBe(401);

    // The rotated cookie still works.
    const r2 = await rawFetch({ method: "POST", path: "/account/refresh", cookie: cookie2 });
    expect(r2.status).toBe(200);
  });

  it("rejects refresh with no cookie (401)", async () => {
    const res = await rawFetch({ method: "POST", path: "/account/refresh" });
    expect(res.status).toBe(401);
  });
});

// ── Logout (revoke) ───────────────────────────────────────────────────────────

describe("logout revokes the session and clears the cookie", () => {
  it("after logout the refresh token no longer works and the cookie is cleared", async () => {
    const email = uniqEmail("logout");
    const reg = await rawFetch({ method: "POST", path: "/account/register", body: { email, password: "logout-pass-12" } });
    const cookie = cookiePairFrom(reg.setCookie);

    const out = await rawFetch({ method: "POST", path: "/account/logout", cookie });
    expect(out.status).toBe(200);
    // Cookie cleared (Max-Age=0).
    expect(out.setCookie ?? "").toContain("Max-Age=0");

    // The refresh token is revoked → refresh now 401s.
    const after = await rawFetch({ method: "POST", path: "/account/refresh", cookie });
    expect(after.status).toBe(401);
  });
});

// ── /account/me ───────────────────────────────────────────────────────────────

describe("GET /account/me", () => {
  it("returns the authenticated platform user", async () => {
    const email = uniqEmail("me");
    const reg = await rawFetch({ method: "POST", path: "/account/register", body: { email, password: "me-password-12" } });
    const token = reg.json["access_token"] as string;
    const me = await get(ctx, "/account/me", { type: "bearer", token });
    expect(me.status).toBe(200);
    expect((me.json["user"] as Record<string, unknown>)["email"]).toBe(email);
    expect((me.json["user"] as Record<string, unknown>)["role"]).toBe("owner");
  });

  it("rejects without a token", async () => {
    const me = await get(ctx, "/account/me");
    expect(me.status).toBe(401);
  });
});

// ── Team: invite / list / remove + role gating ───────────────────────────────

describe("team management + role gating", () => {
  let ownerToken = "";
  let memberId = "";
  const memberEmail = uniqEmail("member");

  beforeAll(async () => {
    const reg = await rawFetch({ method: "POST", path: "/account/register", body: { email: uniqEmail("team-owner"), password: "team-owner-12" } });
    ownerToken = reg.json["access_token"] as string;
  });

  it("owner can invite a member", async () => {
    const res = await post(
      ctx,
      "/account/users/invite",
      { email: memberEmail, password: "member-pass-12", role: "member" },
      { type: "bearer", token: ownerToken }
    );
    expect(res.status).toBe(201);
    const u = res.json["user"] as Record<string, unknown>;
    expect(u["email"]).toBe(memberEmail);
    expect(u["role"]).toBe("member");
    memberId = u["id"] as string;
  });

  it("owner sees both users in the team list (org-scoped)", async () => {
    const res = await get(ctx, "/account/users", { type: "bearer", token: ownerToken });
    expect(res.status).toBe(200);
    const users = res.json["users"] as Array<Record<string, unknown>>;
    expect(users.length).toBe(2);
    expect(users.some((u) => u["email"] === memberEmail)).toBe(true);
  });

  it("a member (non-admin) is forbidden from inviting", async () => {
    const login = await rawFetch({ method: "POST", path: "/account/login", body: { email: memberEmail, password: "member-pass-12" } });
    const memberToken = login.json["access_token"] as string;
    const res = await post(
      ctx,
      "/account/users/invite",
      { email: uniqEmail("nope"), password: "nope-pass-12", role: "member" },
      { type: "bearer", token: memberToken }
    );
    expect(res.status).toBe(403);
  });

  it("owner can remove the member", async () => {
    const res = await ctx.request({
      method: "DELETE",
      path: `/account/users/${memberId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(200);

    const list = await get(ctx, "/account/users", { type: "bearer", token: ownerToken });
    expect((list.json["users"] as unknown[]).length).toBe(1);
  });

  it("the owner cannot be removed and cannot remove themselves", async () => {
    // Re-derive the owner's own id from /account/me.
    const me = await get(ctx, "/account/me", { type: "bearer", token: ownerToken });
    const ownerId = (me.json["user"] as Record<string, unknown>)["id"] as string;
    const res = await ctx.request({
      method: "DELETE",
      path: `/account/users/${ownerId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.status).toBe(409);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("CANNOT_REMOVE_SELF");
  });
});
