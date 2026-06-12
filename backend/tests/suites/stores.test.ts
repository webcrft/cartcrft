/**
 * stores — Stores CRUD suite.
 *
 * Ported from webcrft-mono/backend/tests/suites/commerce.go (stores subset).
 *
 * Covers:
 *  - List stores → empty for new org
 *  - Create store → returns id, provisions auth_jwt_secret
 *  - Get store → correct name and fields
 *  - List stores → 1 result
 *  - Update store → name change persists; currency blocked if orders exist
 *  - Delete store → 200; second delete 404
 *  - Org isolation: org A cannot see org B's stores
 *  - auth_enabled defaults false, auth_jwt_secret provisioned on create
 *  - 401 without auth; 404 for wrong org
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, del, mintJwt, insertStore, isErrorEnvelope } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function newUserId() {
  return randomUUID();
}

function newOrgId() {
  return randomUUID();
}

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Stores CRUD", () => {
  const userId = newUserId();
  const orgId = newOrgId();
  let storeId = "";
  let auth: Awaited<ReturnType<typeof authFor>>;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
  });

  it("GET /commerce/stores → 401 without auth", async () => {
    const res = await get(ctx, "/commerce/stores");
    expect(res.status).toBe(401);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("GET /commerce/stores → empty list for new org", async () => {
    const res = await get(ctx, "/commerce/stores", auth);
    expect(res.status).toBe(200);
    const body = res.json;
    expect(Array.isArray(body["stores"])).toBe(true);
    expect((body["stores"] as unknown[]).length).toBe(0);
  });

  it("POST /commerce/stores → creates store, returns id", async () => {
    const res = await post(ctx, "/commerce/stores", {
      name: "Test Store",
      currency: "ZAR",
      timezone: "Africa/Johannesburg",
    }, auth);
    expect(res.status).toBe(201);
    const body = res.json;
    expect(typeof body["id"]).toBe("string");
    storeId = body["id"] as string;
    expect(storeId.length).toBeGreaterThan(0);
  });

  it("Store has auth_jwt_secret provisioned and auth_enabled defaults false", async () => {
    const { rows } = await ctx.pool.query<{
      has_secret: boolean;
      auth_enabled: boolean;
    }>(
      `SELECT auth_jwt_secret IS NOT NULL AND auth_jwt_secret <> '' AS has_secret,
              auth_enabled
       FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    expect(rows[0]?.has_secret).toBe(true);
    expect(rows[0]?.auth_enabled).toBe(false);
  });

  it("GET /commerce/stores/:storeId → correct store data", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}`, auth);
    expect(res.status).toBe(200);
    const body = res.json;
    expect(body["name"]).toBe("Test Store");
    expect(body["currency"]).toBe("ZAR");
    // auth_jwt_secret must NOT be in the response
    expect(body["auth_jwt_secret"]).toBeUndefined();
  });

  it("GET /commerce/stores → 1 store after creation", async () => {
    const res = await get(ctx, "/commerce/stores", auth);
    expect(res.status).toBe(200);
    const stores = res.json["stores"] as unknown[];
    expect(stores.length).toBe(1);
  });

  it("PUT /commerce/stores/:storeId → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}`,
      { name: "Renamed Store" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    // Verify persisted.
    const getRes = await get(ctx, `/commerce/stores/${storeId}`, auth);
    expect(getRes.json["name"]).toBe("Renamed Store");
  });

  it("PUT /commerce/stores/:storeId → 409 if currency changed with existing orders", async () => {
    // Insert a fake order to trigger the currency lock.
    const storeIdBuf = storeId;
    try {
      await ctx.pool.query(
        `INSERT INTO orders
           (store_id, order_number, currency, status,
            financial_status, fulfillment_status, subtotal,
            shipping_total, discount_total, total)
         VALUES
           ($1::uuid, 'ORD-TEST-1', 'ZAR', 'open',
            'pending', 'unfulfilled',
            '100.00', '0.00', '0.00', '100.00')`,
        [storeIdBuf]
      );

      const res = await put(
        ctx,
        `/commerce/stores/${storeId}`,
        { currency: "USD" },
        auth
      );
      expect(res.status).toBe(409);
      expect(isErrorEnvelope(res)).toBe(true);
    } finally {
      // Clean up the fake order.
      await ctx.pool.query(
        `DELETE FROM orders WHERE store_id = $1::uuid AND order_number = 'ORD-TEST-1'`,
        [storeIdBuf]
      );
    }
  });

  it("POST /commerce/stores → 409 on duplicate slug", async () => {
    // Get the current slug.
    const { rows } = await ctx.pool.query<{ slug: string }>(
      `SELECT slug FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    const slug = rows[0]?.slug;
    if (!slug) {
      console.warn("skip: no slug found");
      return;
    }

    const res = await post(ctx, "/commerce/stores", {
      name: "Duplicate Slug Store",
      slug,
      currency: "ZAR",
    }, auth);
    expect(res.status).toBe(409);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("DELETE /commerce/stores/:storeId → 200 ok", async () => {
    const res = await del(ctx, `/commerce/stores/${storeId}`, auth);
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /commerce/stores/:storeId → 404 on second delete", async () => {
    const res = await del(ctx, `/commerce/stores/${storeId}`, auth);
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── Org isolation ─────────────────────────────────────────────────────────────

describe("Stores org isolation", () => {
  const orgA = newOrgId();
  const orgB = newOrgId();
  const userA = newUserId();
  const userB = newUserId();
  let storeAId = "";

  it("Org A creates a store; Org B cannot see it", async () => {
    const authA = await authFor(userA, orgA);
    const authB = await authFor(userB, orgB);

    // Org A creates a store.
    const createRes = await post(ctx, "/commerce/stores", {
      name: "Org A Store",
      currency: "USD",
    }, authA);
    expect(createRes.status).toBe(201);
    storeAId = createRes.json["id"] as string;

    // Org B lists stores → empty.
    const listB = await get(ctx, "/commerce/stores", authB);
    expect(listB.status).toBe(200);
    const bStores = listB.json["stores"] as unknown[];
    const foundInB = bStores.some(
      (s) => (s as Record<string, unknown>)["id"] === storeAId
    );
    expect(foundInB).toBe(false);

    // Org B cannot GET Org A's store.
    const getB = await get(ctx, `/commerce/stores/${storeAId}`, authB);
    expect(getB.status).toBe(404);

    // Org B cannot DELETE Org A's store.
    const delB = await del(ctx, `/commerce/stores/${storeAId}`, authB);
    expect(delB.status).toBe(404);
  });

  afterAll(async () => {
    if (storeAId) {
      const authA = await authFor(userA, orgA);
      await del(ctx, `/commerce/stores/${storeAId}`, authA);
    }
  });
});

// ── Auth enforcement ──────────────────────────────────────────────────────────

describe("Stores auth enforcement", () => {
  it("GET /commerce/stores/:storeId → 401 without Bearer token", async () => {
    const res = await get(ctx, `/commerce/stores/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("POST /commerce/stores → 400 with empty name", async () => {
    const userId = newUserId();
    const orgId = newOrgId();
    const auth = await authFor(userId, orgId);
    const res = await post(ctx, "/commerce/stores", { name: "" }, auth);
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("storeAuthAdmin accepts cc_prv_ key with commerce:admin scope", async () => {
    // Create org + store via JWT, then issue a cc_prv_ key and verify GET works.
    const userId = newUserId();
    const orgId = newOrgId();
    const jwtAuth = await authFor(userId, orgId);

    const createRes = await post(ctx, "/commerce/stores", {
      name: "Auth Test Store",
      currency: "USD",
    }, jwtAuth);
    expect(createRes.status).toBe(201);
    const sid = createRes.json["id"] as string;

    // Issue a private key via the API.
    const keyRes = await post(ctx, "/api-keys", {
      name: "Admin Key",
      key_type: "private",
      scopes: ["commerce:admin"],
      store_id: sid,
    }, jwtAuth);
    expect(keyRes.status).toBe(201);
    const rawKey = keyRes.json["key"] as string;
    expect(rawKey.startsWith("cc_prv_")).toBe(true);

    // Use the key to GET the store.
    const keyAuth = { type: "api-key" as const, key: rawKey };
    const getRes = await get(ctx, `/commerce/stores/${sid}`, keyAuth);
    expect(getRes.status).toBe(200);
    expect(getRes.json["name"]).toBe("Auth Test Store");

    // Cleanup.
    await del(ctx, `/commerce/stores/${sid}`, jwtAuth);
  });

  it("storeAuthAdmin rejects cc_pub_ key", async () => {
    const userId = newUserId();
    const orgId = newOrgId();
    const jwtAuth = await authFor(userId, orgId);

    const createRes = await post(ctx, "/commerce/stores", {
      name: "Pub Key Test Store",
      currency: "USD",
    }, jwtAuth);
    expect(createRes.status).toBe(201);
    const sid = createRes.json["id"] as string;

    // Issue a public key.
    const keyRes = await post(ctx, "/api-keys", {
      name: "Pub Key",
      key_type: "public",
      scopes: ["commerce:read"],
      store_id: sid,
    }, jwtAuth);
    expect(keyRes.status).toBe(201);
    const pubKey = keyRes.json["key"] as string;

    // Public key cannot access admin endpoint (GET store uses storeAuthAdmin).
    const keyAuth = { type: "api-key" as const, key: pubKey };
    const getRes = await get(ctx, `/commerce/stores/${sid}`, keyAuth);
    expect(getRes.status).toBe(403);

    // Cleanup.
    await del(ctx, `/commerce/stores/${sid}`, jwtAuth);
  });
});
