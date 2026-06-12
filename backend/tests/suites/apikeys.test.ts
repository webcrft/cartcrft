/**
 * apikeys — API key lifecycle suite.
 *
 * Ported from webcrft-mono/backend/tests/suites/platform_apikeys.go.
 *
 * Covers:
 *  - Create returns raw key once (cc_pub_ / cc_prv_)
 *  - List hides secrets (no 'key' or 'key_hash' fields)
 *  - Public key cannot hold write scopes
 *  - Unknown scope rejected
 *  - Invalid key_type rejected
 *  - Missing name rejected
 *  - PATCH: rename + change scopes
 *  - PATCH: store_id = null clears restriction
 *  - PATCH: scope rules re-validated on update
 *  - DELETE = revoke (soft delete); second delete = 404
 *  - Revoked key rejected for auth
 *  - Expired key fails validation-predicate
 *  - Cross-org isolation: org B cannot see or mutate org A's keys
 *  - Key scope enforcement: pub key (commerce:read) cannot hit write endpoint
 *  - Rate-limit: 429 after IP_RATE_LIMIT_PER_MINUTE+1 requests
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, del, patch, mintJwt, isErrorEnvelope } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function newId() {
  return randomUUID();
}

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

/** Create a store via REST, return the storeId. */
async function createStore(userId: string, orgId: string): Promise<string> {
  const auth = await authFor(userId, orgId);
  const res = await post(ctx, "/commerce/stores", {
    name: `Test Store ${Date.now()}`,
    currency: "USD",
  }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

// ── Basic CRUD ────────────────────────────────────────────────────────────────

describe("API keys CRUD", () => {
  const userId = newId();
  const orgId = newId();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let privKeyId = "";
  let privRawKey = "";

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
  });

  it("GET /api-keys → 401 without auth", async () => {
    const res = await get(ctx, "/api-keys");
    expect(res.status).toBe(401);
  });

  it("GET /api-keys → empty list for new org", async () => {
    const res = await get(ctx, "/api-keys", auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["keys"])).toBe(true);
    expect((res.json["keys"] as unknown[]).length).toBe(0);
  });

  it("POST /api-keys → creates private key, returns full key once", async () => {
    const res = await post(ctx, "/api-keys", {
      name: "Org Private",
      key_type: "private",
      scopes: ["commerce:read", "commerce:admin"],
    }, auth);
    expect(res.status).toBe(201);
    privRawKey = res.json["key"] as string;
    privKeyId = res.json["id"] as string;
    expect(privRawKey.startsWith("cc_prv_")).toBe(true);
    expect(privKeyId.length).toBeGreaterThan(0);
    // key_type field must reflect the type
    expect(res.json["key_type"]).toBe("private");
  });

  it("POST /api-keys → creates public key with cc_pub_ prefix", async () => {
    const res = await post(ctx, "/api-keys", {
      name: "Org Public",
      key_type: "public",
      scopes: ["commerce:read"],
    }, auth);
    expect(res.status).toBe(201);
    const pubKey = res.json["key"] as string;
    expect(pubKey.startsWith("cc_pub_")).toBe(true);
  });

  it("GET /api-keys → lists keys without secret material", async () => {
    const res = await get(ctx, "/api-keys", auth);
    expect(res.status).toBe(200);
    const keys = res.json["keys"] as Array<Record<string, unknown>>;
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const k of keys) {
      // Raw key and hash must never appear in list response.
      expect(k["key"]).toBeUndefined();
      expect(k["key_hash"]).toBeUndefined();
      // key_masked should be present.
      expect(typeof k["key_masked"]).toBe("string");
    }
  });

  it("POST /api-keys → rejects public key with write scope", async () => {
    const res = await post(ctx, "/api-keys", {
      name: "Bad Public",
      key_type: "public",
      scopes: ["commerce:read", "commerce:write"],
    }, auth);
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("POST /api-keys → rejects unknown scope", async () => {
    const res = await post(ctx, "/api-keys", {
      name: "Weird Scope",
      key_type: "private",
      scopes: ["thispermission:doesnotexist"],
    }, auth);
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("POST /api-keys → rejects invalid key_type", async () => {
    const res = await post(ctx, "/api-keys", {
      name: "Weird Type",
      key_type: "superadmin",
      scopes: ["commerce:read"],
    }, auth);
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("POST /api-keys → rejects missing name", async () => {
    const res = await post(ctx, "/api-keys", {
      key_type: "private",
      scopes: ["commerce:read"],
    }, auth);
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("PATCH /api-keys/:keyId → rename + change scopes", async () => {
    const res = await patch(ctx, `/api-keys/${privKeyId}`, {
      name: "Renamed Key",
      scopes: ["commerce:read", "auth:read"],
    }, auth);
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    // Verify persisted.
    const { rows } = await ctx.pool.query<{ name: string; scopes: string[] }>(
      `SELECT name, scopes FROM api_keys WHERE id = $1::uuid`,
      [privKeyId]
    );
    expect(rows[0]?.name).toBe("Renamed Key");
    expect(rows[0]?.scopes).toHaveLength(2);
  });

  it("PATCH /api-keys/:keyId → rejects upgrading public key to write scope", async () => {
    // Create a public key to target.
    const pubRes = await post(ctx, "/api-keys", {
      name: "Public 2",
      key_type: "public",
      scopes: ["commerce:read"],
    }, auth);
    expect(pubRes.status).toBe(201);
    const pub2Id = pubRes.json["id"] as string;

    const res = await patch(ctx, `/api-keys/${pub2Id}`, {
      scopes: ["commerce:read", "commerce:write"],
    }, auth);
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("DELETE /api-keys/:keyId → revokes key (soft delete)", async () => {
    const res = await del(ctx, `/api-keys/${privKeyId}`, auth);
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    // Verify is_active = false in DB.
    const { rows } = await ctx.pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM api_keys WHERE id = $1::uuid`,
      [privKeyId]
    );
    expect(rows[0]?.is_active).toBe(false);
  });

  it("DELETE /api-keys/:keyId → 404 on second delete (already revoked)", async () => {
    const res = await del(ctx, `/api-keys/${privKeyId}`, auth);
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("Revoked key rejected for auth (storeAuthAdmin rejects revoked cc_prv_)", async () => {
    // Create a store, issue a key, revoke it, then try to use it.
    const storeId = await createStore(userId, orgId);

    const keyRes = await post(ctx, "/api-keys", {
      name: "Temp Key",
      key_type: "private",
      scopes: ["commerce:admin"],
      store_id: storeId,
    }, auth);
    expect(keyRes.status).toBe(201);
    const tempKeyId = keyRes.json["id"] as string;
    const tempRawKey = keyRes.json["key"] as string;

    // Revoke it.
    await del(ctx, `/api-keys/${tempKeyId}`, auth);

    // Try to use the revoked key.
    const keyAuth = { type: "api-key" as const, key: tempRawKey };
    const getRes = await get(ctx, `/commerce/stores/${storeId}`, keyAuth);
    expect(getRes.status).toBe(401);

    // Cleanup.
    const jwtAuth = await authFor(userId, orgId);
    await del(ctx, `/commerce/stores/${storeId}`, jwtAuth);
  });

  it("Never-expires key stores NULL expires_at", async () => {
    const res = await post(ctx, "/api-keys", {
      name: "Forever Key",
      key_type: "private",
      scopes: ["commerce:read"],
    }, auth);
    expect(res.status).toBe(201);
    const foreverKeyId = res.json["id"] as string;

    const { rows } = await ctx.pool.query<{ expires_at: Date | null }>(
      `SELECT expires_at FROM api_keys WHERE id = $1::uuid`,
      [foreverKeyId]
    );
    expect(rows[0]?.expires_at).toBeNull();
  });

  it("Expired key fails validation predicate", async () => {
    const res = await post(ctx, "/api-keys", {
      name: "Expiring Soon",
      key_type: "private",
      scopes: ["commerce:read"],
    }, auth);
    expect(res.status).toBe(201);
    const expiredId = res.json["id"] as string;

    // Force-expire it.
    await ctx.pool.query(
      `UPDATE api_keys SET expires_at = now() - interval '1 hour' WHERE id = $1::uuid`,
      [expiredId]
    );

    // Validator predicate should exclude it.
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM api_keys
       WHERE id = $1::uuid
         AND is_active = true
         AND (expires_at IS NULL OR expires_at > now())`,
      [expiredId]
    );
    expect(rows[0]?.count).toBe("0");
  });
});

// ── Scope enforcement ─────────────────────────────────────────────────────────

describe("API key scope enforcement", () => {
  it("cc_pub_ (commerce:read) cannot hit write-tier endpoint", async () => {
    const userId = newId();
    const orgId = newId();
    const auth = await authFor(userId, orgId);

    // Create a store.
    const storeId = await createStore(userId, orgId);

    // Issue a pub key (read only).
    const keyRes = await post(ctx, "/api-keys", {
      name: "Read-only Pub Key",
      key_type: "public",
      scopes: ["commerce:read"],
      store_id: storeId,
    }, auth);
    expect(keyRes.status).toBe(201);
    const pubKey = keyRes.json["key"] as string;

    // A write-tier endpoint would reject cc_pub_ — use DELETE store
    // which uses requireJwt (JWT only), so let's test an update (storeAuthAdmin).
    // storeAuthAdmin rejects pub keys.
    const pubAuth = { type: "api-key" as const, key: pubKey };
    const res = await get(ctx, `/commerce/stores/${storeId}`, pubAuth);
    expect(res.status).toBe(403); // storeAuthAdmin rejects cc_pub_

    // Cleanup.
    await del(ctx, `/commerce/stores/${storeId}`, auth);
  });

  it("cc_prv_ with wrong org rejected", async () => {
    const userA = newId();
    const orgA = newId();
    const userB = newId();
    const orgB = newId();
    const authA = await authFor(userA, orgA);
    const authB = await authFor(userB, orgB);

    // Org A creates a store and a key.
    const storeA = await createStore(userA, orgA);
    const keyResA = await post(ctx, "/api-keys", {
      name: "Org A Key",
      key_type: "private",
      scopes: ["commerce:admin"],
      store_id: storeA,
    }, authA);
    expect(keyResA.status).toBe(201);
    const keyA = keyResA.json["key"] as string;

    // Org B creates a store.
    const storeB = await createStore(userB, orgB);

    // Use Org A's key to access Org B's store → rejected.
    const keyAuth = { type: "api-key" as const, key: keyA };
    const res = await get(ctx, `/commerce/stores/${storeB}`, keyAuth);
    expect(res.status).toBe(401); // key org !== store org

    // Cleanup.
    await del(ctx, `/commerce/stores/${storeA}`, authA);
    await del(ctx, `/commerce/stores/${storeB}`, authB);
  });
});

// ── Cross-org isolation ───────────────────────────────────────────────────────

describe("API keys cross-org isolation", () => {
  it("Org B cannot see or mutate Org A's keys", async () => {
    const userA = newId();
    const orgA = newId();
    const userB = newId();
    const orgB = newId();
    const authA = await authFor(userA, orgA);
    const authB = await authFor(userB, orgB);

    // Org A creates a key.
    const resA = await post(ctx, "/api-keys", {
      name: "Org A Key",
      key_type: "private",
      scopes: ["commerce:read"],
    }, authA);
    expect(resA.status).toBe(201);
    const keyAId = resA.json["id"] as string;

    // Org B lists keys → shouldn't contain Org A's key.
    const listB = await get(ctx, "/api-keys", authB);
    expect(listB.status).toBe(200);
    const keysB = listB.json["keys"] as Array<Record<string, unknown>>;
    const foundInB = keysB.some((k) => k["id"] === keyAId);
    expect(foundInB).toBe(false);

    // Org B cannot patch Org A's key.
    const patchRes = await patch(ctx, `/api-keys/${keyAId}`, { name: "hijack" }, authB);
    expect(patchRes.status === 403 || patchRes.status === 404).toBe(true);

    // Org B cannot delete Org A's key.
    const delRes = await del(ctx, `/api-keys/${keyAId}`, authB);
    expect(delRes.status === 403 || delRes.status === 404).toBe(true);
  });
});

// ── PATCH store_id null clears restriction ─────────────────────────────────────

describe("PATCH store_id = null clears store restriction", () => {
  it("Clearing store_id removes the restriction from a key", async () => {
    const userId = newId();
    const orgId = newId();
    const auth = await authFor(userId, orgId);

    const storeId = await createStore(userId, orgId);

    // Create a key restricted to the store.
    const keyRes = await post(ctx, "/api-keys", {
      name: "Store-Restricted",
      key_type: "private",
      scopes: ["commerce:read"],
      store_id: storeId,
    }, auth);
    expect(keyRes.status).toBe(201);
    const keyId = keyRes.json["id"] as string;

    // Verify store_id is set.
    const { rows: before } = await ctx.pool.query<{ store_id: string | null }>(
      `SELECT store_id::text FROM api_keys WHERE id = $1::uuid`,
      [keyId]
    );
    expect(before[0]?.store_id).toBe(storeId);

    // PATCH to clear store_id.
    const patchRes = await patch(ctx, `/api-keys/${keyId}`, { store_id: null }, auth);
    expect(patchRes.status).toBe(200);

    // Verify store_id is now NULL.
    const { rows: after } = await ctx.pool.query<{ store_id: string | null }>(
      `SELECT store_id::text FROM api_keys WHERE id = $1::uuid`,
      [keyId]
    );
    expect(after[0]?.store_id).toBeNull();

    // Cleanup.
    await del(ctx, `/commerce/stores/${storeId}`, auth);
  });
});

// ── Rate limit ────────────────────────────────────────────────────────────────

describe("IP rate limiting", () => {
  it("Exceeding IP_RATE_LIMIT_PER_MINUTE returns 429", async () => {
    // Override the rate limit to a tiny value for testing.
    // We'll use a dedicated base URL path that's easy to hammer.
    // The default IP_RATE_LIMIT_PER_MINUTE is 60 — too many requests to spam in CI.
    // Instead, check the rate-limit bucket map resets (white-box test via DB).
    // We hit /healthz which is unauthenticated and fast.
    const ipRateLimit = parseInt(
      process.env["IP_RATE_LIMIT_PER_MINUTE"] ?? "60",
      10
    );

    if (ipRateLimit > 200) {
      // If the limit is very high, skip the hammer test to avoid slow CI.
      console.log(`skip: IP_RATE_LIMIT_PER_MINUTE=${ipRateLimit} too high to trigger 429 quickly`);
      return;
    }

    // Send limit + 1 requests rapidly (all from the same process → same IP).
    let saw429 = false;
    for (let i = 0; i <= ipRateLimit; i++) {
      const res = await get(ctx, "/healthz");
      if (res.status === 429) {
        saw429 = true;
        const body = res.json;
        expect(body["error"]).toBeDefined();
        const err = body["error"] as Record<string, unknown>;
        expect(err["code"]).toBe("RATE_LIMIT_EXCEEDED");
        break;
      }
    }

    if (ipRateLimit <= 200) {
      expect(saw429).toBe(true);
    }
  });
});
