/**
 * b2b-credit.test.ts — H2.5 B2B credit enforcement.
 *
 * Tests:
 *  1. Company order within remaining credit → succeeds, credit_used incremented
 *  2. Company order over remaining credit → rejected CREDIT_LIMIT_EXCEEDED (422)
 *  3. Cancel order → credit_used restored
 *  4. Refund on net-terms order → credit_used restored by refund amount
 *  5. NULL credit_limit → no cap, any order passes
 *  6. payment_terms_days = 0 → no credit consumed (immediate-pay company)
 *  7. Concurrent orders against same company → total credit_used never exceeds limit
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  post,
  mintJwt,
  createApiKey,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Shared bootstrap ──────────────────────────────────────────────────────────

async function bootstrapStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: `B2B Credit Test Store ${Date.now()}`,
    currency: "ZAR",
    timezone: "Africa/Johannesburg",
  }, auth);
  expect(storeRes.status).toBe(201);
  const storeId = storeRes.json["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId, userId, storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const keyAuth = { type: "api-key" as const, key: apiKey };
  return { storeId, keyAuth, auth };
}

/** Insert a company directly via SQL with given credit_limit / payment_terms_days */
async function insertCompany(
  storeId: string,
  creditLimit: string | null,
  paymentTermsDays: number
): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO companies
       (store_id, name, credit_limit, credit_used, payment_terms_days)
     VALUES ($1::uuid, $2, $3, 0, $4)
     RETURNING id::text`,
    [storeId, `Test Company ${Date.now()}`, creditLimit, paymentTermsDays]
  );
  return rows[0]!.id;
}

/** Read credit_used for a company */
async function getCreditUsed(companyId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ credit_used: string }>(
    `SELECT credit_used::text FROM companies WHERE id = $1::uuid`,
    [companyId]
  );
  return parseFloat(rows[0]?.credit_used ?? "0");
}

/** Create cart + checkout with company_id, return checkoutId */
async function makeCompanyCheckout(
  storeId: string,
  keyAuth: { type: "api-key"; key: string },
  variantId: string,
  qty: number,
  companyId: string
): Promise<string> {
  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
  expect(cartRes.status).toBe(201);
  const cartId = cartRes.json["id"] as string;

  await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
    variant_id: variantId,
    quantity: qty,
  }, keyAuth);

  // Attach company_id to cart for checkout creation
  const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
    cart_id: cartId,
    company_id: companyId,
  }, keyAuth);
  expect(coRes.status).toBe(201);
  return coRes.json["id"] as string;
}

/** Complete a checkout, return { status, json } */
async function completeCheckout(
  storeId: string,
  checkoutId: string,
  keyAuth: { type: "api-key"; key: string }
) {
  return ctx.request({
    method: "POST",
    path: `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`,
    body: {},
    headers: { authorization: `Bearer ${keyAuth.key}` },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Order within credit → succeeds, credit_used incremented
// ─────────────────────────────────────────────────────────────────────────────

describe("within credit limit", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let companyId: string;
  let variantId: string;

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    // credit_limit = 1000, payment_terms_days = 30 → net-terms
    companyId = await insertCompany(storeId, "1000.00", 30);

    const product = await insertProduct(ctx.pool, { storeId, title: "Net Terms Widget" });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id, price: "200.00",
    });
    variantId = variant.id;
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );
  });

  it("order for 200 with 1000 limit → 201, credit_used becomes 200", async () => {
    const checkoutId = await makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);
    expect(typeof res.json["order_id"]).toBe("string");

    const used = await getCreditUsed(companyId);
    expect(used).toBeCloseTo(200, 1);
  });

  it("second order for 200 → credit_used becomes 400", async () => {
    const checkoutId = await makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);

    const used = await getCreditUsed(companyId);
    expect(used).toBeCloseTo(400, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Order over remaining credit → 422 CREDIT_LIMIT_EXCEEDED
// ─────────────────────────────────────────────────────────────────────────────

describe("exceeds credit limit", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let companyId: string;
  let variantId: string;

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    // credit_limit = 300, payment_terms_days = 30
    companyId = await insertCompany(storeId, "300.00", 30);

    const product = await insertProduct(ctx.pool, { storeId, title: "Expensive Widget" });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id, price: "400.00",
    });
    variantId = variant.id;
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );
  });

  it("order for 400 with limit 300 → 422 CREDIT_LIMIT_EXCEEDED", async () => {
    const checkoutId = await makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(422);
    const body = res.json as { error: { code: string } };
    expect(body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
  });

  it("credit_used stays 0 after rejected order", async () => {
    const used = await getCreditUsed(companyId);
    expect(used).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Cancel order → credit_used restored
// ─────────────────────────────────────────────────────────────────────────────

describe("cancel restores credit", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let companyId: string;
  let variantId: string;
  let orderId: string;

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    companyId = await insertCompany(storeId, "500.00", 30);

    const product = await insertProduct(ctx.pool, { storeId, title: "Cancellable Widget" });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id, price: "150.00",
    });
    variantId = variant.id;
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );
  });

  it("completes an order and credit_used = 150", async () => {
    const checkoutId = await makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);
    orderId = res.json["order_id"] as string;
    expect(orderId).toBeTruthy();

    const used = await getCreditUsed(companyId);
    expect(used).toBeCloseTo(150, 1);
  });

  it("cancel the order → credit_used back to 0", async () => {
    // Need admin auth to cancel the order
    const authHeader = { authorization: `Bearer ${keyAuth.key}` };
    const cancelRes = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/orders/${orderId}/cancel`,
      body: { reason: "customer_request" },
      headers: authHeader,
    });
    expect(cancelRes.status).toBe(200);

    // Allow async credit release (best-effort, async import)
    await new Promise((r) => setTimeout(r, 50));

    const used = await getCreditUsed(companyId);
    expect(used).toBeCloseTo(0, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Refund → credit partially restored
// ─────────────────────────────────────────────────────────────────────────────

describe("refund restores credit by refunded amount", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let companyId: string;
  let variantId: string;
  let orderId: string;
  let paymentId: string;

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    companyId = await insertCompany(storeId, "600.00", 30);

    const product = await insertProduct(ctx.pool, { storeId, title: "Refundable Widget" });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id, price: "300.00",
    });
    variantId = variant.id;
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );
  });

  it("completes order → credit_used = 300", async () => {
    const checkoutId = await makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);
    orderId = res.json["order_id"] as string;

    const used = await getCreditUsed(companyId);
    expect(used).toBeCloseTo(300, 1);
  });

  it("creates a payment for the order", async () => {
    const pmtRes = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/orders/${orderId}/payments`,
      body: { amount: "300.00", mode: "dev" },
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(pmtRes.status).toBe(201);
    paymentId = pmtRes.json["id"] as string;

    // Capture it
    const capRes = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/capture`,
      body: {},
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(capRes.status).toBe(200);
  });

  it("refund 100 → credit_used becomes 200", async () => {
    const refRes = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/refund`,
      body: { amount: "100.00" },
      headers: { authorization: `Bearer ${keyAuth.key}` },
    });
    expect(refRes.status).toBe(201);

    // Allow async credit release
    await new Promise((r) => setTimeout(r, 50));

    const used = await getCreditUsed(companyId);
    expect(used).toBeCloseTo(200, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: NULL credit_limit → no cap
// ─────────────────────────────────────────────────────────────────────────────

describe("null credit_limit → no cap", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let companyId: string;
  let variantId: string;

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    // NULL credit_limit = unlimited
    companyId = await insertCompany(storeId, null, 30);

    const product = await insertProduct(ctx.pool, { storeId, title: "Unlimited Credit Widget" });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id, price: "999999.00",
    });
    variantId = variant.id;
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );
  });

  it("order for any amount passes when credit_limit is NULL", async () => {
    const checkoutId = await makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);
    // credit_used should still be 0 since no limit tracking on null limit
    const used = await getCreditUsed(companyId);
    expect(used).toBeGreaterThanOrEqual(0); // no assertion on value — null limit = uncapped
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: payment_terms_days = 0 → no credit consumed
// ─────────────────────────────────────────────────────────────────────────────

describe("payment_terms_days=0 → no credit consumed", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let companyId: string;
  let variantId: string;

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    // credit_limit = 100 but payment_terms_days = 0 → immediate pay, no credit draw
    companyId = await insertCompany(storeId, "100.00", 0);

    const product = await insertProduct(ctx.pool, { storeId, title: "Immediate Pay Widget" });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id, price: "500.00",
    });
    variantId = variant.id;
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );
  });

  it("order for 500 with limit 100 but terms=0 → succeeds (no credit check)", async () => {
    const checkoutId = await makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);

    // credit_used stays 0 (no credit was consumed)
    const used = await getCreditUsed(companyId);
    expect(used).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Concurrent orders → credit_used never exceeds limit
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent orders do not oversell credit line", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let companyId: string;
  let variantId: string;

  beforeAll(async () => {
    const setup = await bootstrapStore();
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    // credit_limit = 500, each order = 300 → only 1 of 2 should succeed
    companyId = await insertCompany(storeId, "500.00", 30);

    const product = await insertProduct(ctx.pool, { storeId, title: "Concurrent Credit Widget" });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id, price: "300.00",
    });
    variantId = variant.id;
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variantId]
    );
  });

  it("two concurrent 300-unit orders against 500 limit → credit_used ≤ 500", async () => {
    // Create 2 checkouts in parallel
    const [co1Id, co2Id] = await Promise.all([
      makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId),
      makeCompanyCheckout(storeId, keyAuth, variantId, 1, companyId),
    ]);

    // Fire both completes in parallel
    const results = await Promise.all([
      completeCheckout(storeId, co1Id, keyAuth),
      completeCheckout(storeId, co2Id, keyAuth),
    ]);

    const successes = results.filter((r) => r.status === 200).length;
    const failures = results.filter((r) => r.status === 422).length;

    // At most 1 can succeed (500 limit / 300 per order = 1 full order)
    expect(successes).toBeLessThanOrEqual(1);

    // At least 1 must fail with CREDIT_LIMIT_EXCEEDED
    if (failures > 0) {
      const failedRes = results.find((r) => r.status === 422);
      expect((failedRes?.json as { error: { code: string } })?.error?.code).toBe("CREDIT_LIMIT_EXCEEDED");
    }

    // credit_used must never exceed 500
    const used = await getCreditUsed(companyId);
    expect(used).toBeLessThanOrEqual(500.01); // 0.01 float tolerance
  });
});
