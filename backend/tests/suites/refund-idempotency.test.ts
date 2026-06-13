/**
 * refund-idempotency — H1.5: Idempotency-Key on POST .../refunds.
 *
 * Tests:
 *  1. No Idempotency-Key — two POSTs create two separate refund rows.
 *  2. Same Idempotency-Key twice (sequential) — second POST returns the same
 *     refund id; exactly one row in the DB.
 *  3. Same Idempotency-Key twice (concurrent, Promise.all) — both resolve to
 *     the same refund id; exactly one row in the DB.
 *  4. Different Idempotency-Keys — two distinct refund rows.
 *  5. Same key on a different payment — allowed (key is scoped to payment_id).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { post, mintJwt } from "../shared/helpers.js";
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

function bearerHeader(auth: { type: "bearer"; token: string }) {
  return { authorization: `Bearer ${auth.token}` };
}

async function createStore(
  orgId: string,
  auth: { type: "bearer"; token: string }
): Promise<string> {
  const res = await post(ctx, "/commerce/stores", { name: "Refund Idempotency Store" }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

async function insertOrder(storeId: string, total = "200.00"): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders
       (store_id, order_number, currency, status, financial_status, fulfillment_status,
        subtotal, shipping_total, tax_total, discount_total, total)
     VALUES
       ($1::uuid, next_order_number($1::uuid), 'USD', 'open', 'pending', 'unfulfilled',
        $2::numeric, 0, 0, 0, $2::numeric)
     RETURNING id::text`,
    [storeId, total]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("insertOrder: no id returned");
  return id;
}

async function insertAndCapturePayment(
  storeId: string,
  orderId: string,
  auth: { type: "bearer"; token: string },
  amount = "200.00"
): Promise<string> {
  const payRes = await post(
    ctx,
    `/commerce/stores/${storeId}/orders/${orderId}/payments`,
    { amount, currency: "USD" },
    auth
  );
  if (payRes.status !== 201) {
    throw new Error(`insertAndCapturePayment: expected 201 creating payment, got ${payRes.status}`);
  }
  const paymentId = payRes.json["id"] as string;

  const capRes = await post(
    ctx,
    `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/capture`,
    {},
    auth
  );
  if (capRes.status !== 200) {
    throw new Error(`insertAndCapturePayment: expected 200 capturing payment, got ${capRes.status}`);
  }
  return paymentId;
}

/** POST a refund with an optional Idempotency-Key header. */
async function postRefund(
  storeId: string,
  orderId: string,
  paymentId: string,
  amount: string,
  auth: { type: "bearer"; token: string },
  idempotencyKey?: string
) {
  return ctx.request({
    method: "POST",
    path: `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/refund`,
    body: { amount, reason: "customer_request" },
    headers: {
      ...bearerHeader(auth),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  });
}

/** Count refund rows for a given payment. */
async function countRefunds(paymentId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM refunds WHERE payment_id = $1::uuid`,
    [paymentId]
  );
  return parseInt(rows[0]?.n ?? "0", 10);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Refund idempotency (H1.5)", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(orgId, auth);
  });

  it("1. No Idempotency-Key — two POSTs create two distinct refund rows", async () => {
    const orderId = await insertOrder(storeId, "200.00");
    const paymentId = await insertAndCapturePayment(storeId, orderId, auth, "200.00");

    const r1 = await postRefund(storeId, orderId, paymentId, "10.00", auth);
    const r2 = await postRefund(storeId, orderId, paymentId, "10.00", auth);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Different ids
    expect(r1.json["id"]).not.toBe(r2.json["id"]);
    expect(await countRefunds(paymentId)).toBe(2);
  });

  it("2. Same Idempotency-Key (sequential) — second POST returns same id", async () => {
    const orderId = await insertOrder(storeId, "200.00");
    const paymentId = await insertAndCapturePayment(storeId, orderId, auth, "200.00");
    const key = `idem-seq-${randomUUID()}`;

    const r1 = await postRefund(storeId, orderId, paymentId, "30.00", auth, key);
    const r2 = await postRefund(storeId, orderId, paymentId, "30.00", auth, key);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.json["id"]).toBe(r1.json["id"]);
    // Exactly one refund row
    expect(await countRefunds(paymentId)).toBe(1);
  });

  it("3. Same Idempotency-Key (concurrent Promise.all) — exactly one refund row", async () => {
    const orderId = await insertOrder(storeId, "200.00");
    const paymentId = await insertAndCapturePayment(storeId, orderId, auth, "200.00");
    const key = `idem-concurrent-${randomUUID()}`;

    const [r1, r2] = await Promise.all([
      postRefund(storeId, orderId, paymentId, "50.00", auth, key),
      postRefund(storeId, orderId, paymentId, "50.00", auth, key),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Both must return the same id
    expect(r1.json["id"]).toBe(r2.json["id"]);
    // Exactly one row in DB
    expect(await countRefunds(paymentId)).toBe(1);
  });

  it("4. Different Idempotency-Keys — two distinct refund rows", async () => {
    const orderId = await insertOrder(storeId, "200.00");
    const paymentId = await insertAndCapturePayment(storeId, orderId, auth, "200.00");

    const r1 = await postRefund(storeId, orderId, paymentId, "20.00", auth, `key-a-${randomUUID()}`);
    const r2 = await postRefund(storeId, orderId, paymentId, "20.00", auth, `key-b-${randomUUID()}`);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.json["id"]).not.toBe(r2.json["id"]);
    expect(await countRefunds(paymentId)).toBe(2);
  });

  it("5. Same key on different payment — allowed (key is scoped to payment_id)", async () => {
    const sharedKey = `shared-key-${randomUUID()}`;

    const orderId1 = await insertOrder(storeId, "100.00");
    const paymentId1 = await insertAndCapturePayment(storeId, orderId1, auth, "100.00");

    const orderId2 = await insertOrder(storeId, "100.00");
    const paymentId2 = await insertAndCapturePayment(storeId, orderId2, auth, "100.00");

    const r1 = await postRefund(storeId, orderId1, paymentId1, "25.00", auth, sharedKey);
    const r2 = await postRefund(storeId, orderId2, paymentId2, "25.00", auth, sharedKey);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Different payments → different refund rows despite same key
    expect(r1.json["id"]).not.toBe(r2.json["id"]);
  });

  it("6. Idempotent refund does not double-charge total_refunded", async () => {
    const orderId = await insertOrder(storeId, "200.00");
    const paymentId = await insertAndCapturePayment(storeId, orderId, auth, "200.00");
    const key = `idem-money-${randomUUID()}`;

    await postRefund(storeId, orderId, paymentId, "60.00", auth, key);
    await postRefund(storeId, orderId, paymentId, "60.00", auth, key);

    // total_refunded should be 60 (not 120)
    const { rows } = await ctx.pool.query<{ total_refunded: string }>(
      `SELECT total_refunded::text FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(parseFloat(rows[0]?.total_refunded ?? "0")).toBeCloseTo(60.0, 1);
  });
});
