/**
 * edit-reconciliation — Payment reconciliation on order edits (Wave 6.1).
 *
 * editOrderLines() re-prices an order; when the new total diverges from what has
 * already been captured we reconcile CONSERVATIVELY:
 *
 *   1. DECREASE total below captured  → AUTO-refund the over-payment (delta),
 *      via the existing provider refund path. Idempotent on a retried edit that
 *      lands on the same total (no double-refund).
 *   2. INCREASE total above captured  → record an outstanding balance
 *      (financial_status → 'partially_paid' + order_event), NO auto-charge; then
 *      POST /collect-balance captures the delta via the saved payment method.
 *   3. No captured payment yet         → no refund attempted, no balance event.
 *
 * Provider HTTP is stubbed (no real gateway), following payment-refund.test.ts.
 * DB/order setup follows fulfillment-edits.test.ts conventions.
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

const REAL_FETCH = globalThis.fetch;

type CapturedCall = { url: string; init: RequestInit };

/** Pass localhost through to the real test server; mock external provider calls. */
function stubProviderFetch(
  calls: CapturedCall[],
  mockResponse: Record<string, unknown>,
  opts: { ok?: boolean; status?: number } = {}
) {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
      return REAL_FETCH(url as string, init);
    }
    calls.push({ url: urlStr, init: init ?? {} });
    return {
      ok,
      status,
      text: async () => JSON.stringify(mockResponse),
      json: async () => mockResponse,
    };
  });
}

async function authFor() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  return { auth: { type: "bearer" as const, token }, userId, orgId };
}

async function createStore(auth: { type: "bearer"; token: string }): Promise<string> {
  const res = await post(ctx, "/commerce/stores", { name: `Edit Reconcile ${randomUUID().slice(0, 8)}` }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

async function seedStripeProvider(storeId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO payment_providers (store_id, name, type, slug, config, is_active, position)
     VALUES ($1::uuid, 'stripe provider', 'stripe', 'stripe', $2::jsonb, true, 0)
     RETURNING id::text`,
    [storeId, JSON.stringify({ secret_key: "sk_test_fake_stripe" })]
  );
  return rows[0]!.id;
}

/** Tracked product+variant priced at `price`, with `onHand` units in a warehouse. */
async function insertTrackedVariant(storeId: string, price: number, onHand: number): Promise<string> {
  const { rows: prodRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO products (store_id, title, slug)
     VALUES ($1::uuid, 'Reconcile Product', $2)
     RETURNING id::text`,
    [storeId, `prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
  );
  const productId = prodRows[0]!.id;
  const { rows: varRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO product_variants (product_id, title, price, track_inventory)
     VALUES ($1::uuid, 'Default', $2, true)
     RETURNING id::text`,
    [productId, price]
  );
  const variantId = varRows[0]!.id;
  const { rows: whRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO warehouses (store_id, name, is_default)
     VALUES ($1::uuid, 'Main', true)
     RETURNING id::text`,
    [storeId]
  );
  await ctx.pool.query(
    `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [variantId, whRows[0]!.id, onHand]
  );
  return variantId;
}

async function createOrder(
  storeId: string,
  auth: { type: "bearer"; token: string },
  lines: Array<{ variant_id: string; quantity: number }>
): Promise<string> {
  const res = await post(ctx, `/commerce/stores/${storeId}/orders`, { currency: "USD", lines }, auth);
  if (res.status !== 201) {
    throw new Error(`createOrder: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

/**
 * Capture a payment for `amount` against `orderId` with stripe provider linkage,
 * so reconciliation has a real captured payment to refund against. Inserts a
 * 'captured' payment row directly (mirrors payment-refund.test.ts).
 */
async function insertCapturedPayment(
  orderId: string,
  providerId: string,
  amount: string,
  providerReference: string
): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO payments
       (order_id, provider_id, amount, currency, status, provider_reference, captured_at, mode)
     VALUES ($1::uuid, $2::uuid, $3::numeric, 'USD', 'captured', $4, now(), 'live')
     RETURNING id::text`,
    [orderId, providerId, amount, providerReference]
  );
  // Reflect the payment on the order so it reads as 'paid'.
  await ctx.pool.query(
    `UPDATE orders SET financial_status = 'paid' WHERE id = $1::uuid`,
    [orderId]
  );
  return rows[0]!.id;
}

async function getOrderRow(orderId: string) {
  const { rows } = await ctx.pool.query<{
    total: string;
    financial_status: string;
    total_refunded: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT total::text, financial_status, total_refunded::text, metadata
     FROM orders WHERE id = $1::uuid`,
    [orderId]
  );
  return rows[0]!;
}

async function lineIdFor(storeId: string, orderId: string, auth: { type: "bearer"; token: string }): Promise<string> {
  const res = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
  return (res.json["lines"] as Array<Record<string, unknown>>)[0]!["id"] as string;
}

describe("Order edit payment reconciliation", () => {
  let auth: { type: "bearer"; token: string };
  let storeId: string;
  let providerId: string;

  beforeAll(async () => {
    ({ auth } = await authFor());
    storeId = await createStore(auth);
    providerId = await seedStripeProvider(storeId);
  });

  it("1. decreasing total below captured AUTO-refunds the delta (idempotent on retry)", async () => {
    // Order: 5 × 10.00 = 50.00, fully captured.
    const variantId = await insertTrackedVariant(storeId, 10, 100);
    const orderId = await createOrder(storeId, auth, [{ variant_id: variantId, quantity: 5 }]);
    const paymentId = await insertCapturedPayment(orderId, providerId, "50.00", "pi_dec_001");
    const lineId = await lineIdFor(storeId, orderId, auth);

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, { id: "re_edit_001", status: "succeeded" });

    // Decrease 5 → 2: new total 20.00, captured 50.00 → auto-refund 30.00.
    const edit = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 2 }] },
      auth
    );
    expect(edit.status).toBe(200);
    expect(edit.json["total"]).toBe("20.00");

    const recon = edit.json["reconciliation"] as Record<string, unknown>;
    expect(recon).toBeTruthy();
    expect(recon["kind"]).toBe("refunded");
    expect(recon["amount"]).toBe("30.00");

    // Provider refund actually called once with 30.00 → 3000 minor units.
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/refunds");
    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(body.get("amount")).toBe("3000");

    // total_refunded moved by exactly 30.
    let row = await getOrderRow(orderId);
    expect(parseFloat(row.total_refunded)).toBeCloseTo(30, 2);

    // payment_refunded event recorded; refund row links to the order.
    const { rows: refundRows } = await ctx.pool.query<{ id: string; amount: string }>(
      `SELECT id::text, amount::text FROM refunds WHERE order_id = $1::uuid`,
      [orderId]
    );
    expect(refundRows.length).toBe(1);
    expect(parseFloat(refundRows[0]!.amount)).toBeCloseTo(30, 2);

    const calls2: CapturedCall[] = [];
    stubProviderFetch(calls2, { id: "re_edit_001b", status: "succeeded" });

    const { reconcilePaymentDelta } = await import("../../src/modules/payments/service.js");

    // (a) Natural retry: reconciling again now that the refund is reflected in
    //     net-paid (captured 50 − refunded 30 = 20 = total) is a no-op. A
    //     retried/duplicate edit therefore never double-refunds.
    const retryNatural = await reconcilePaymentDelta(orderId, storeId);
    expect(retryNatural.kind).toBe("none");
    expect(calls2.length).toBe(0);

    // (b) Computed-marker dedup: even if reconciliation is forced for the EXACT
    //     same (order, refund amount) — e.g. two concurrent edits racing before
    //     the first refund is visible — the deterministic idempotency key makes
    //     the second refund resolve to the SAME row at the refunds unique index,
    //     with NO new provider call. Drive this by issuing the same auto-refund
    //     key directly through the refund path.
    const { createRefund } = await import("../../src/modules/payments/service.js");
    const sameKey = `edit-reconcile:${orderId}:refund:30.00`;
    const dup = await createRefund(
      paymentId,
      orderId,
      storeId,
      { amount: "30.00", reason: "other", idempotency_key: sameKey }
    );
    const { rows: origRows } = await ctx.pool.query<{ id: string }>(
      `SELECT id::text FROM refunds WHERE order_id = $1::uuid AND idempotency_key = $2`,
      [orderId, sameKey]
    );
    expect(dup.id).toBe(origRows[0]!.id); // same refund row, not a new one
    expect(calls2.length).toBe(0);        // provider NOT re-called

    // Still exactly one refund row, total_refunded still 30.
    const { rows: refundRows2 } = await ctx.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM refunds WHERE order_id = $1::uuid`,
      [orderId]
    );
    expect(parseInt(refundRows2[0]!.c, 10)).toBe(1);
    row = await getOrderRow(orderId);
    expect(parseFloat(row.total_refunded)).toBeCloseTo(30, 2);
  });

  it("2. increasing total records outstanding balance (no auto-charge), then collect-balance captures it", async () => {
    // Order: 2 × 10.00 = 20.00, fully captured.
    const variantId = await insertTrackedVariant(storeId, 10, 100);
    const orderId = await createOrder(storeId, auth, [{ variant_id: variantId, quantity: 2 }]);
    await insertCapturedPayment(orderId, providerId, "20.00", "pi_inc_001");
    const lineId = await lineIdFor(storeId, orderId, auth);

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, {}); // any provider call here would be a bug

    // Increase 2 → 5: new total 50.00, captured 20.00 → owes 30.00.
    const edit = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 5 }] },
      auth
    );
    expect(edit.status).toBe(200);
    expect(edit.json["total"]).toBe("50.00");

    const recon = edit.json["reconciliation"] as Record<string, unknown>;
    expect(recon["kind"]).toBe("balance_outstanding");
    expect(recon["amount"]).toBe("30.00");

    // NO provider charge happened, NO new captured payment, balance recorded.
    expect(calls.length).toBe(0);
    let row = await getOrderRow(orderId);
    expect(row.financial_status).toBe("partially_paid");
    expect(String(row.metadata["outstanding_balance"])).toBe("30.00");

    // balance_outstanding event present.
    const after = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    const events = (after.json["events"] as Array<Record<string, unknown>>).map((e) => e["type"]);
    expect(events).toContain("balance_outstanding");

    // Captured money is still only the original 20.00 (no auto-charge).
    const { rows: cap1 } = await ctx.pool.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS sum FROM payments
       WHERE order_id = $1::uuid AND status = 'captured'`,
      [orderId]
    );
    expect(parseFloat(cap1[0]!.sum)).toBeCloseTo(20, 2);

    // ── Explicit collection: captures the 30.00 delta via saved method. ────────
    const collect = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/collect-balance`,
      {},
      auth
    );
    expect(collect.status).toBe(200);
    expect(collect.json["collected"]).toBe(true);
    expect(collect.json["amount"]).toBe("30.00");

    // Now fully captured (20 + 30 = 50 = total) → financial_status 'paid'.
    const { rows: cap2 } = await ctx.pool.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount),0)::text AS sum FROM payments
       WHERE order_id = $1::uuid AND status = 'captured'`,
      [orderId]
    );
    expect(parseFloat(cap2[0]!.sum)).toBeCloseTo(50, 2);
    row = await getOrderRow(orderId);
    expect(row.financial_status).toBe("paid");
    expect(row.metadata["outstanding_balance"]).toBeUndefined();

    // payment_captured event recorded for the collection.
    const after2 = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    const events2 = (after2.json["events"] as Array<Record<string, unknown>>).map((e) => e["type"]);
    expect(events2).toContain("payment_captured");

    // Second collect is a no-op (nothing outstanding).
    const collect2 = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/collect-balance`,
      {},
      auth
    );
    expect(collect2.status).toBe(200);
    expect(collect2.json["collected"]).toBe(false);
  });

  it("3. no captured payment → no refund attempted, no balance event", async () => {
    // Order with NO payment at all.
    const variantId = await insertTrackedVariant(storeId, 10, 100);
    const orderId = await createOrder(storeId, auth, [{ variant_id: variantId, quantity: 5 }]);
    const lineId = await lineIdFor(storeId, orderId, auth);

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, { id: "re_should_not_happen", status: "succeeded" });

    // Decrease 5 → 1: total drops, but nothing was captured → no reconciliation.
    const edit = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/edit-lines`,
      { ops: [{ op: "update_quantity", order_line_id: lineId, quantity: 1 }] },
      auth
    );
    expect(edit.status).toBe(200);
    expect(edit.json["total"]).toBe("10.00");

    // No reconciliation surfaced (kind "none" is suppressed from the response).
    expect(edit.json["reconciliation"]).toBeUndefined();

    // No provider call, no refund row, financial_status still pending.
    expect(calls.length).toBe(0);
    const { rows: refundRows } = await ctx.pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM refunds WHERE order_id = $1::uuid`,
      [orderId]
    );
    expect(parseInt(refundRows[0]!.c, 10)).toBe(0);

    const row = await getOrderRow(orderId);
    expect(row.financial_status).toBe("pending");

    const after = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
    const events = (after.json["events"] as Array<Record<string, unknown>>).map((e) => e["type"]);
    expect(events).not.toContain("balance_outstanding");
  });
});
