/**
 * giftcard-tender — Gift-card / store-credit applied as a PAYMENT TENDER at
 * checkout completion (Wave-15).
 *
 * A tender PAYS part of the bill; it does NOT change subtotal/tax/total. The
 * debit happens ATOMICALLY inside the checkout-completion transaction.
 *
 * Covers:
 *  - PARTIAL: gift card balance < total → order completes, card debited to 0,
 *    a captured gift_card payment is recorded, remaining balance still owed
 *    (financial_status='pending', provider charges the rest).
 *  - FULL: gift card balance >= total → order completes fully paid, card debited
 *    by exactly the total, NO provider charge needed, financial_status='paid'.
 *  - STORE CREDIT as a tender (full coverage).
 *  - INVALID / disabled / empty card rejected at apply with NO order side effects.
 *  - NO-DOUBLE-SPEND: completing twice never debits more than the balance.
 *  - NON-TENDER path unchanged: a plain checkout still completes 'pending' with
 *    no payments row.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  mintJwt,
  createApiKey,
  insertProduct,
  insertVariant,
  insertCustomer,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ─────────────────────────────────────────────────────────────────

type KeyAuth = { type: "api-key"; key: string };

async function setupStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: "Tender Test Store",
    currency: "ZAR",
    timezone: "Africa/Johannesburg",
  }, auth);
  expect(storeRes.status).toBe(201);
  const storeId = (storeRes.json as Record<string, unknown>)["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId, userId, storeId, type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const keyAuth: KeyAuth = { type: "api-key", key: apiKey };
  return { storeId, keyAuth };
}

/** Create a product+variant with inventory tracking off (keeps complete simple). */
async function setupVariant(storeId: string, price = "100.00"): Promise<string> {
  const product = await insertProduct(ctx.pool, { storeId, title: "Tender Widget" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, title: "Default", price });
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
    [variant.id]
  );
  return variant.id;
}

/** Build a pending checkout for qty*price; returns { checkoutId, total }. */
async function buildCheckout(
  storeId: string,
  keyAuth: KeyAuth,
  variantId: string,
  quantity: number,
  body: Record<string, unknown> = {}
): Promise<{ checkoutId: string; total: number }> {
  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
  const cartId = cartRes.json["id"] as string;
  await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
    variant_id: variantId, quantity,
  }, keyAuth);
  const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
    cart_id: cartId, ...body,
  }, keyAuth);
  expect(coRes.status).toBe(201);
  return {
    checkoutId: coRes.json["id"] as string,
    total: parseFloat(coRes.json["total"] as string),
  };
}

async function createGiftCard(
  storeId: string,
  keyAuth: KeyAuth,
  initialValue: string,
  code?: string
): Promise<{ id: string; code: string }> {
  const gcCode = code ?? `GC-${randomUUID().slice(0, 8).toUpperCase()}`;
  const res = await post(ctx, `/commerce/stores/${storeId}/gift-cards`, {
    code: gcCode, initial_value: initialValue, currency: "ZAR",
  }, keyAuth);
  expect(res.status).toBe(201);
  return { id: res.json["id"] as string, code: gcCode };
}

async function giftCardBalance(giftCardId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ balance: string }>(
    `SELECT balance::text FROM gift_cards WHERE id = $1::uuid`,
    [giftCardId]
  );
  return parseFloat(rows[0]!.balance);
}

async function orderRow(orderId: string): Promise<{ financial_status: string; total: string }> {
  const { rows } = await ctx.pool.query<{ financial_status: string; total: string }>(
    `SELECT financial_status, total::text FROM orders WHERE id = $1::uuid`,
    [orderId]
  );
  return rows[0]!;
}

async function capturedPayments(orderId: string): Promise<Array<{ amount: string; status: string; metadata: Record<string, unknown> }>> {
  const { rows } = await ctx.pool.query<{ amount: string; status: string; metadata: Record<string, unknown> }>(
    `SELECT amount::text, status, metadata FROM payments WHERE order_id = $1::uuid ORDER BY created_at`,
    [orderId]
  );
  return rows;
}

// ── PARTIAL coverage ──────────────────────────────────────────────────────────

describe("gift card tender — partial coverage (balance < total)", () => {
  let storeId: string;
  let keyAuth: KeyAuth;
  let variantId: string;

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore());
    variantId = await setupVariant(storeId, "100.00");
  });

  it("debits card to 0, records captured gift_card payment, leaves balance owed", async () => {
    // total = 100 * 2 = 200; gift card = 50
    const { checkoutId, total } = await buildCheckout(storeId, keyAuth, variantId, 2);
    expect(total).toBeCloseTo(200, 2);
    const gc = await createGiftCard(storeId, keyAuth, "50.00");

    const applyRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/gift-card`, { code: gc.code }, keyAuth);
    expect(applyRes.status).toBe(200);
    expect(applyRes.json["tender_total"]).toBe("50.00");
    expect(applyRes.json["amount_due"]).toBe("150.00");

    const completeRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(completeRes.status).toBe(200);
    const orderId = completeRes.json["order_id"] as string;

    // Gift card debited to 0
    expect(await giftCardBalance(gc.id)).toBeCloseTo(0, 2);

    // Order still owes the remainder → partially_paid (the captured 50 is
    // counted; the provider must still collect the other 150).
    const ord = await orderRow(orderId);
    expect(parseFloat(ord.total)).toBeCloseTo(200, 2);
    expect(ord.financial_status).toBe("partially_paid");

    // A single captured gift_card payment of 50
    const pays = await capturedPayments(orderId);
    expect(pays.length).toBe(1);
    expect(pays[0]!.status).toBe("captured");
    expect(parseFloat(pays[0]!.amount)).toBeCloseTo(50, 2);
    expect(pays[0]!.metadata["tender"]).toBe("gift_card");
    expect(pays[0]!.metadata["gift_card_id"]).toBe(gc.id);
  });
});

// ── FULL coverage ───────────────────────────────────────────────────────────

describe("gift card tender — full coverage (balance >= total)", () => {
  let storeId: string;
  let keyAuth: KeyAuth;
  let variantId: string;

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore());
    variantId = await setupVariant(storeId, "100.00");
  });

  it("debits exactly total, order is paid, no provider charge needed", async () => {
    // total = 100; gift card = 250 (more than enough)
    const { checkoutId, total } = await buildCheckout(storeId, keyAuth, variantId, 1);
    expect(total).toBeCloseTo(100, 2);
    const gc = await createGiftCard(storeId, keyAuth, "250.00");

    const applyRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/gift-card`, { code: gc.code }, keyAuth);
    expect(applyRes.status).toBe(200);
    // Tender is capped at the total (100), not the full 250 balance.
    expect(applyRes.json["tender_total"]).toBe("100.00");
    expect(applyRes.json["amount_due"]).toBe("0.00");

    const completeRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(completeRes.status).toBe(200);
    const orderId = completeRes.json["order_id"] as string;

    // Card debited by exactly the total → 250 - 100 = 150 left.
    expect(await giftCardBalance(gc.id)).toBeCloseTo(150, 2);

    const ord = await orderRow(orderId);
    expect(ord.financial_status).toBe("paid");

    const pays = await capturedPayments(orderId);
    expect(pays.length).toBe(1);
    expect(parseFloat(pays[0]!.amount)).toBeCloseTo(100, 2);
    expect(pays[0]!.status).toBe("captured");
  });
});

// ── STORE CREDIT as a tender ───────────────────────────────────────────────

describe("store credit tender — full coverage", () => {
  let storeId: string;
  let keyAuth: KeyAuth;
  let variantId: string;
  let customerId: string;

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore());
    variantId = await setupVariant(storeId, "80.00");
    const customer = await insertCustomer(ctx.pool, { storeId });
    customerId = customer.id;
    // Seed a store-credit wallet with 200 ZAR.
    await ctx.pool.query(
      `INSERT INTO store_credits (store_id, customer_id, currency, balance)
       VALUES ($1::uuid, $2::uuid, 'ZAR', 200)`,
      [storeId, customerId]
    );
  });

  it("debits store credit by the total, order paid, captured store_credit payment", async () => {
    const { checkoutId, total } = await buildCheckout(storeId, keyAuth, variantId, 1, { customer_id: customerId });
    expect(total).toBeCloseTo(80, 2);

    const applyRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/store-credit`, {}, keyAuth);
    expect(applyRes.status).toBe(200);
    expect(applyRes.json["tender_total"]).toBe("80.00");
    expect(applyRes.json["amount_due"]).toBe("0.00");

    const completeRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(completeRes.status).toBe(200);
    const orderId = completeRes.json["order_id"] as string;

    const { rows: scRows } = await ctx.pool.query<{ balance: string }>(
      `SELECT balance::text FROM store_credits WHERE store_id = $1::uuid AND customer_id = $2::uuid AND currency = 'ZAR'`,
      [storeId, customerId]
    );
    expect(parseFloat(scRows[0]!.balance)).toBeCloseTo(120, 2);

    const ord = await orderRow(orderId);
    expect(ord.financial_status).toBe("paid");
    const pays = await capturedPayments(orderId);
    expect(pays.length).toBe(1);
    expect(pays[0]!.metadata["tender"]).toBe("store_credit");
    expect(parseFloat(pays[0]!.amount)).toBeCloseTo(80, 2);
  });
});

// ── INVALID / disabled / empty — rejected at apply, NO order side effects ───

describe("gift card tender — invalid codes rejected at apply", () => {
  let storeId: string;
  let keyAuth: KeyAuth;
  let variantId: string;

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore());
    variantId = await setupVariant(storeId, "100.00");
  });

  it("unknown code → 422 GIFT_CARD_INVALID", async () => {
    const { checkoutId } = await buildCheckout(storeId, keyAuth, variantId, 1);
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/gift-card`, { code: "NOPE-NONE" }, keyAuth);
    expect(res.status).toBe(422);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("GIFT_CARD_INVALID");
  });

  it("disabled card → 422 GIFT_CARD_INVALID, no tender stored", async () => {
    const { checkoutId } = await buildCheckout(storeId, keyAuth, variantId, 1);
    const gc = await createGiftCard(storeId, keyAuth, "50.00");
    await ctx.pool.query(`UPDATE gift_cards SET is_active = false WHERE id = $1::uuid`, [gc.id]);

    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/gift-card`, { code: gc.code }, keyAuth);
    expect(res.status).toBe(422);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("GIFT_CARD_INVALID");

    // No tender recorded, balance untouched.
    const state = await get(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/tenders`, keyAuth);
    expect((state.json["applied_tenders"] as unknown[]).length).toBe(0);
    expect(await giftCardBalance(gc.id)).toBeCloseTo(50, 2);
  });

  it("empty (zero-balance) card → 422 GIFT_CARD_INVALID", async () => {
    const { checkoutId } = await buildCheckout(storeId, keyAuth, variantId, 1);
    const gc = await createGiftCard(storeId, keyAuth, "0.00");
    const res = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/gift-card`, { code: gc.code }, keyAuth);
    expect(res.status).toBe(422);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("GIFT_CARD_INVALID");
  });
});

// ── NO DOUBLE-SPEND: completing twice never over-debits ─────────────────────

describe("gift card tender — no double-spend on repeat completion", () => {
  let storeId: string;
  let keyAuth: KeyAuth;
  let variantId: string;

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore());
    variantId = await setupVariant(storeId, "100.00");
  });

  it("second completion is rejected and the card is debited only once", async () => {
    const { checkoutId } = await buildCheckout(storeId, keyAuth, variantId, 1); // total 100
    const gc = await createGiftCard(storeId, keyAuth, "250.00");

    await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/gift-card`, { code: gc.code }, keyAuth);

    const first = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(first.status).toBe(200);
    const balAfterFirst = await giftCardBalance(gc.id);
    expect(balAfterFirst).toBeCloseTo(150, 2); // 250 - 100

    // Second completion: checkout is no longer 'pending' → rejected, no extra debit.
    const second = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);

    expect(await giftCardBalance(gc.id)).toBeCloseTo(150, 2); // unchanged
  });

  it("balance dropped between apply and complete → debits only what remains (no over-debit)", async () => {
    // total 100, applied with a 250 card, then drain the card to 30 before completing.
    const { checkoutId } = await buildCheckout(storeId, keyAuth, variantId, 1);
    const gc = await createGiftCard(storeId, keyAuth, "250.00");
    await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/gift-card`, { code: gc.code }, keyAuth);

    // Simulate the card being spent elsewhere down to 30.
    await ctx.pool.query(`UPDATE gift_cards SET balance = 30 WHERE id = $1::uuid`, [gc.id]);

    const completeRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(completeRes.status).toBe(200);
    const orderId = completeRes.json["order_id"] as string;

    // Re-validated live balance (30) is debited, not the stored 100 cap → never below 0.
    expect(await giftCardBalance(gc.id)).toBeCloseTo(0, 2);
    const pays = await capturedPayments(orderId);
    expect(pays.length).toBe(1);
    expect(parseFloat(pays[0]!.amount)).toBeCloseTo(30, 2);
    // Order still owes 70 → partially_paid (the captured 30 is counted).
    expect((await orderRow(orderId)).financial_status).toBe("partially_paid");
  });
});

// ── NON-TENDER path unchanged ───────────────────────────────────────────────

describe("non-tender path is unchanged", () => {
  let storeId: string;
  let keyAuth: KeyAuth;
  let variantId: string;

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore());
    variantId = await setupVariant(storeId, "100.00");
  });

  it("plain checkout completes pending with no payments row", async () => {
    const { checkoutId } = await buildCheckout(storeId, keyAuth, variantId, 1);
    const completeRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, keyAuth);
    expect(completeRes.status).toBe(200);
    const orderId = completeRes.json["order_id"] as string;

    const ord = await orderRow(orderId);
    expect(ord.financial_status).toBe("pending");
    const pays = await capturedPayments(orderId);
    expect(pays.length).toBe(0);
  });
});
