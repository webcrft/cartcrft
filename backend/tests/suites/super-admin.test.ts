/**
 * super-admin — H1.4 timing-safe super-token + JWT layer on store takedown/restore.
 *
 * Verified behaviours:
 *  1. Takedown with no token (no Authorization at all) → 401 (requireJwt rejects)
 *  2. Takedown with JWT but no x-super-token → 403 (super-token check fails)
 *  3. Takedown with JWT but wrong x-super-token → 403
 *  4. Takedown with valid JWT + correct x-super-token → 200 ok; store is_active=false
 *  5. Restore with no token → 401
 *  6. Restore with JWT but no x-super-token → 403
 *  7. Restore with valid JWT + correct x-super-token → 200 ok; store is_active=true
 *  8. timingSafeCheckSuperToken unit: undefined/wrong/correct
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { mintJwt, isErrorEnvelope } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

const SUPER_TOKEN = "test-super-token-h1-4";

let ctx: TestCtx;

beforeAll(async () => {
  process.env["SUPER_TOKEN"] = SUPER_TOKEN;
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  delete process.env["SUPER_TOKEN"];
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function jwtToken(orgId?: string): Promise<string> {
  return mintJwt({ userId: randomUUID(), orgId: orgId ?? randomUUID() });
}

/**
 * Create a store via the REST API using a JWT for the given org.
 * Returns { storeId, orgId, jwt }.
 */
async function createStore(): Promise<{ storeId: string; orgId: string; jwt: string }> {
  const orgId = randomUUID();
  const jwt = await jwtToken(orgId);
  const res = await ctx.request({
    method: "POST",
    path: "/commerce/stores",
    body: { name: `Super Admin Test Store ${randomUUID().slice(0, 8)}` },
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
  });
  if (res.status !== 201) {
    throw new Error(
      `createStore: expected 201 but got ${res.status}: ${JSON.stringify(res.body)}`
    );
  }
  const storeId = (res.json as Record<string, unknown>)["id"] as string;
  return { storeId, orgId, jwt };
}

// ── Takedown endpoint ─────────────────────────────────────────────────────────

describe("Super-admin takedown (H1.4)", () => {
  let storeId: string;
  let jwt: string;

  beforeAll(async () => {
    const store = await createStore();
    storeId = store.storeId;
    jwt = store.jwt;
  });

  it("1. No Authorization header → 401 (requireJwt rejects)", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${storeId}/takedown`,
      body: { reason: "abuse" },
    });
    expect(res.status).toBe(401);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("2. Valid JWT but missing x-super-token → 403", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${storeId}/takedown`,
      body: { reason: "abuse" },
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(403);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("3. Valid JWT but wrong x-super-token → 403", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${storeId}/takedown`,
      body: { reason: "abuse" },
      headers: {
        authorization: `Bearer ${jwt}`,
        "x-super-token": "definitely-not-the-right-token",
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(403);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("4. Valid JWT + correct x-super-token → 200; store marked inactive in DB", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${storeId}/takedown`,
      body: { reason: "policy violation" },
      headers: {
        authorization: `Bearer ${jwt}`,
        "x-super-token": SUPER_TOKEN,
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>)["ok"]).toBe(true);

    // Verify DB: store should now be inactive.
    const { rows } = await ctx.pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    expect(rows[0]?.is_active).toBe(false);
  });

  it("4b. Missing reason body → 400 (takedown body validation)", async () => {
    const { storeId: sid, jwt: sjwt } = await createStore();
    const res = await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${sid}/takedown`,
      body: {},
      headers: {
        authorization: `Bearer ${sjwt}`,
        "x-super-token": SUPER_TOKEN,
        "content-type": "application/json",
      },
    });
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── Restore endpoint ──────────────────────────────────────────────────────────

describe("Super-admin restore (H1.4)", () => {
  let storeId: string;
  let jwt: string;

  beforeAll(async () => {
    // Create + immediately take down the store so we have something to restore.
    const store = await createStore();
    storeId = store.storeId;
    jwt = store.jwt;

    // Takedown first.
    await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${storeId}/takedown`,
      body: { reason: "test setup" },
      headers: {
        authorization: `Bearer ${jwt}`,
        "x-super-token": SUPER_TOKEN,
        "content-type": "application/json",
      },
    });
  });

  it("5. No Authorization header → 401 (requireJwt rejects)", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${storeId}/restore`,
    });
    expect(res.status).toBe(401);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("6. Valid JWT but no x-super-token → 403", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${storeId}/restore`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(403);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("7. Valid JWT + correct x-super-token → 200; store marked active in DB", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/super/commerce/stores/${storeId}/restore`,
      headers: {
        authorization: `Bearer ${jwt}`,
        "x-super-token": SUPER_TOKEN,
      },
    });
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>)["ok"]).toBe(true);

    // Verify DB: store should now be active again.
    const { rows } = await ctx.pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    expect(rows[0]?.is_active).toBe(true);
  });
});

// ── timingSafeCheckSuperToken unit tests ──────────────────────────────────────

describe("timingSafeCheckSuperToken unit tests (H1.4)", () => {
  it("8a. Returns false for undefined", async () => {
    const { timingSafeCheckSuperToken } = await import(
      "../../src/lib/auth/super-token.js"
    );
    // SUPER_TOKEN is set to SUPER_TOKEN const from env.
    expect(timingSafeCheckSuperToken(undefined)).toBe(false);
  });

  it("8b. Returns false for wrong token", async () => {
    const { timingSafeCheckSuperToken } = await import(
      "../../src/lib/auth/super-token.js"
    );
    expect(timingSafeCheckSuperToken("wrong-value")).toBe(false);
  });

  it("8c. Returns true for correct token", async () => {
    const { timingSafeCheckSuperToken } = await import(
      "../../src/lib/auth/super-token.js"
    );
    expect(timingSafeCheckSuperToken(SUPER_TOKEN)).toBe(true);
  });

  it("8d. Returns false for empty string", async () => {
    const { timingSafeCheckSuperToken } = await import(
      "../../src/lib/auth/super-token.js"
    );
    expect(timingSafeCheckSuperToken("")).toBe(false);
  });

  it("8e. Returns false when SUPER_TOKEN env not set", async () => {
    const savedToken = process.env["SUPER_TOKEN"];
    delete process.env["SUPER_TOKEN"];
    try {
      // Re-import won't re-read env — timingSafeCheckSuperToken reads
      // process.env at call time, so this exercises the guard correctly.
      const { timingSafeCheckSuperToken } = await import(
        "../../src/lib/auth/super-token.js"
      );
      expect(timingSafeCheckSuperToken("any-value")).toBe(false);
    } finally {
      process.env["SUPER_TOKEN"] = savedToken;
    }
  });

  it("8f. Returns false for string[] (multiple header values)", async () => {
    const { timingSafeCheckSuperToken } = await import(
      "../../src/lib/auth/super-token.js"
    );
    expect(timingSafeCheckSuperToken([SUPER_TOKEN, SUPER_TOKEN])).toBe(false);
  });
});
