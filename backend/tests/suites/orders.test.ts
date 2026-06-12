/**
 * orders — Orders CRUD suite.
 *
 * Tests:
 *  1. List orders (empty store) → { orders: [], total: 0 }
 *  2. Create order with lines → { id, order_number }
 *  3. Get order → has lines, payments=[], events with order_created
 *  4. Create order invalid (no lines) → 400
 *  5. List orders with status filter
 *  6. Update order notes
 *  7. Update order with status field → 400 (blocked)
 *  8. Cancel order → ok
 *  9. Cancel already-cancelled → 409
 * 10. Add note (requireJwt — use JWT auth)
 * 11. List events
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  mintJwt,
  isErrorEnvelope,
  errorCode,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

/** Create a store via REST, return its id. */
async function createStore(
  orgId: string,
  auth: { type: "bearer"; token: string }
): Promise<string> {
  const res = await post(ctx, "/commerce/stores", { name: "Orders Test Store" }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

/** Insert a product+variant directly via SQL. Returns variantId. */
async function insertTestVariant(storeId: string): Promise<string> {
  // Insert product
  const { rows: prodRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO products (store_id, title, slug)
     VALUES ($1::uuid, 'Test Product', $2)
     RETURNING id::text`,
    [storeId, `prod-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`]
  );
  const productId = prodRows[0]?.id;
  if (!productId) throw new Error("insertTestVariant: no product id");

  // Insert variant
  const { rows: varRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO product_variants (product_id, title, price)
     VALUES ($1::uuid, 'Default', 99.99)
     RETURNING id::text`,
    [productId]
  );
  const variantId = varRows[0]?.id;
  if (!variantId) throw new Error("insertTestVariant: no variant id");
  return variantId;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Orders CRUD", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;
  let variantId: string;
  let orderId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(orgId, auth);
    variantId = await insertTestVariant(storeId);
  });

  it("1. List orders → empty for new store", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders`,
      auth
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["orders"])).toBe(true);
    expect((res.json["orders"] as unknown[]).length).toBe(0);
    expect(res.json["total"]).toBe(0);
  });

  it("2. Create order with lines → { id, order_number }", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders`,
      {
        currency: "USD",
        lines: [{ variant_id: variantId, quantity: 2 }],
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    expect(typeof res.json["order_number"]).toBe("string");
    expect(res.json["mode"]).toBe("live");
    expect(res.json["is_test"]).toBe(false);
    orderId = res.json["id"] as string;
  });

  it("3. Get order → has lines, payments=[], events with order_created", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}`,
      auth
    );
    expect(res.status).toBe(200);
    const order = res.json;
    expect(order["id"]).toBe(orderId);
    expect(order["status"]).toBe("open");

    // Lines
    const lines = order["lines"] as unknown[];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(1);
    const line = lines[0] as Record<string, unknown>;
    expect(line["variant_id"]).toBe(variantId);
    expect(Number(line["quantity"])).toBe(2);

    // Payments empty
    const payments = order["payments"] as unknown[];
    expect(Array.isArray(payments)).toBe(true);
    expect(payments.length).toBe(0);

    // Events contain order_created
    const events = order["events"] as unknown[];
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    const types = events.map(
      (e) => (e as Record<string, unknown>)["type"]
    );
    expect(types).toContain("order_created");
  });

  it("4. Create order invalid (no lines) → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders`,
      { currency: "USD", lines: [] },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("5. List orders with status filter", async () => {
    // Filter by status=open
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders?status=open`,
      auth
    );
    expect(res.status).toBe(200);
    const orders = res.json["orders"] as unknown[];
    expect(orders.length).toBeGreaterThan(0);

    // Filter by status=cancelled (none yet)
    const res2 = await get(
      ctx,
      `/commerce/stores/${storeId}/orders?status=cancelled`,
      auth
    );
    expect(res2.status).toBe(200);
    expect((res2.json["orders"] as unknown[]).length).toBe(0);
  });

  it("6. Update order notes", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}`,
      { notes: "Customer requested gift wrap" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    // Verify persisted
    const getRes = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}`,
      auth
    );
    expect(getRes.json["notes"]).toBe("Customer requested gift wrap");
  });

  it("7. Update order with status field → 400 (blocked)", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}`,
      { status: "closed" },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("8. Cancel order → ok", async () => {
    // Create a fresh order to cancel
    const createRes = await post(
      ctx,
      `/commerce/stores/${storeId}/orders`,
      {
        currency: "USD",
        lines: [{ variant_id: variantId, quantity: 1 }],
      },
      auth
    );
    expect(createRes.status).toBe(201);
    const newOrderId = createRes.json["id"] as string;

    const cancelRes = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${newOrderId}/cancel`,
      { reason: "Customer changed mind" },
      auth
    );
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.json["ok"]).toBe(true);

    // Verify cancelled
    const getRes = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${newOrderId}`,
      auth
    );
    expect(getRes.json["status"]).toBe("cancelled");
    expect(getRes.json["cancel_reason"]).toBe("Customer changed mind");
  });

  it("9. Cancel already-cancelled → 409", async () => {
    // Create and cancel an order
    const createRes = await post(
      ctx,
      `/commerce/stores/${storeId}/orders`,
      {
        currency: "USD",
        lines: [{ variant_id: variantId, quantity: 1 }],
      },
      auth
    );
    const cancelTargetId = createRes.json["id"] as string;

    // First cancel
    await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${cancelTargetId}/cancel`,
      {},
      auth
    );

    // Second cancel → 409
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${cancelTargetId}/cancel`,
      {},
      auth
    );
    expect(res.status).toBe(409);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("10. Add note (requireJwt auth)", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/notes`,
      { note: "Customer called to confirm address" },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
  });

  it("11. List events", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/events`,
      auth
    );
    expect(res.status).toBe(200);
    const events = res.json["events"] as unknown[];
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    // Should contain note_added from test 10
    const types = events.map(
      (e) => (e as Record<string, unknown>)["type"]
    );
    expect(types).toContain("note_added");
    expect(types).toContain("order_created");
  });

  it("Create order with mode=dev → is_test=true", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders`,
      {
        currency: "USD",
        mode: "dev",
        lines: [{ variant_id: variantId, quantity: 1 }],
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(res.json["mode"]).toBe("dev");
    expect(res.json["is_test"]).toBe(true);
  });

  it("Create order with invalid variant_id → 400", async () => {
    const fakeVariantId = randomUUID();
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders`,
      {
        currency: "USD",
        lines: [{ variant_id: fakeVariantId, quantity: 1 }],
      },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("GET order → 404 for non-existent order", async () => {
    const fakeId = randomUUID();
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${fakeId}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe("NOT_FOUND");
  });

  it("Unauthenticated requests → 401", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/orders`);
    expect(res.status).toBe(401);
  });
});
