/**
 * presentment-fx.test.ts — Multi-currency PRESENTMENT (display-only) pricing.
 *
 * Covers:
 *   1. Pure math: convertMoney + rateFor (direct, inverse, cross-rate, null).
 *   2. GET /commerce/stores/:storeId/exchange-rates returns the seeded snapshot.
 *   3. GET checkout?presentment_currency=XYZ returns a correct presentment block
 *      while the base-currency amounts are LEFT UNCHANGED (settlement is base).
 *
 * Seeds a USD-base exchange_rates snapshot directly via SQL in beforeAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  mintJwt,
  createApiKey,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { convertMoney, rateFor } from "../../src/lib/fx-convert.js";

let ctx: TestCtx;

// USD-base snapshot we seed once for all endpoint assertions.
const SEED_RATES = { EUR: 0.9, GBP: 0.8, ZAR: 18, JPY: 150 } as const;

beforeAll(async () => {
  ctx = await createCtx();
  // Seed a USD-base exchange_rates snapshot (owner role; bypasses RLS write lock).
  await ctx.pool.query(
    `INSERT INTO exchange_rates (base, rates, fetched_at)
     VALUES ('USD', $1::jsonb, now())`,
    [JSON.stringify(SEED_RATES)]
  );
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── 1. Pure math ──────────────────────────────────────────────────────────────

describe("fx-convert pure helpers", () => {
  it("convertMoney multiplies and formats to 2dp", () => {
    expect(convertMoney("100.00", 0.9)).toBe("90.00");
    expect(convertMoney(100, 18)).toBe("1800.00");
    expect(convertMoney("33.33", 1)).toBe("33.33");
    // Rounding half-up at 2dp.
    expect(convertMoney("10.005", 1)).toBe("10.01");
    // Non-numeric / NaN input → 0.00 (defensive).
    expect(convertMoney("not-a-number", 2)).toBe("0.00");
  });

  it("rateFor: identity when target == base", () => {
    expect(rateFor(SEED_RATES, "USD", "USD")).toBe(1);
    expect(rateFor(SEED_RATES, "EUR", "EUR")).toBe(1);
  });

  it("rateFor: direct USD-base lookup", () => {
    expect(rateFor(SEED_RATES, "USD", "EUR")).toBe(0.9);
    expect(rateFor(SEED_RATES, "USD", "ZAR")).toBe(18);
  });

  it("rateFor: inverse when target is the table base (USD)", () => {
    // 1 EUR = 1/0.9 USD ≈ 1.1111
    const r = rateFor(SEED_RATES, "EUR", "USD");
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(1 / 0.9, 6);
  });

  it("rateFor: cross-rate when base != USD and target != USD", () => {
    // 1 EUR = rates[GBP]/rates[EUR] GBP = 0.8 / 0.9
    const r = rateFor(SEED_RATES, "EUR", "GBP");
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(0.8 / 0.9, 6);
    // And ZAR per EUR: 18 / 0.9 = 20
    expect(rateFor(SEED_RATES, "EUR", "ZAR")).toBeCloseTo(20, 6);
  });

  it("rateFor: null on missing rate (defensive)", () => {
    expect(rateFor(SEED_RATES, "USD", "XXX")).toBeNull();
    expect(rateFor(SEED_RATES, "XXX", "EUR")).toBeNull();
    // Cross-rate with one missing leg.
    expect(rateFor(SEED_RATES, "EUR", "XXX")).toBeNull();
  });
});

// ── Shared store setup ──────────────────────────────────────────────────────────

async function setupStore(currency = "USD") {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(
    ctx,
    "/commerce/stores",
    { name: `FX Test Store ${randomUUID().slice(0, 8)}`, currency, timezone: "UTC" },
    auth
  );
  expect(storeRes.status).toBe(201);
  const storeId = storeRes.json["id"] as string;

  // public (cc_pub_) key — storefront read.
  const pubKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "public",
    scopes: ["commerce:read"],
  });
  // private key — used to create cart/checkout fixtures.
  const prvKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });

  return {
    storeId,
    pubAuth: { type: "api-key" as const, key: pubKey },
    prvAuth: { type: "api-key" as const, key: prvKey },
  };
}

// ── 2. Public exchange-rates endpoint ───────────────────────────────────────────

describe("GET /commerce/stores/:storeId/exchange-rates", () => {
  it("returns the seeded USD-base snapshot to a public storefront key", async () => {
    const { storeId, pubAuth } = await setupStore("USD");

    const res = await get(ctx, `/commerce/stores/${storeId}/exchange-rates`, pubAuth);
    expect(res.status).toBe(200);

    expect(res.json["base"]).toBe("USD");
    const rates = res.json["rates"] as Record<string, number>;
    expect(rates["EUR"]).toBe(0.9);
    expect(rates["ZAR"]).toBe(18);
    expect(res.json["fetched_at"]).toBeTruthy();
    expect(res.json["store_currency"]).toBe("USD");

    const currencies = res.json["currencies"] as string[];
    expect(currencies).toContain("EUR");
    expect(currencies).toContain("GBP");
    // sorted
    expect([...currencies].sort()).toEqual(currencies);
  });
});

// ── 3. Checkout presentment ─────────────────────────────────────────────────────

/** Build a pending USD checkout with a single $100 line (2 × $50). */
async function buildUsdCheckout(
  storeId: string,
  prvAuth: { type: "api-key"; key: string }
) {
  const product = await insertProduct(ctx.pool, { storeId, title: "Widget" });
  const variant = await insertVariant(ctx.pool, {
    productId: product.id,
    title: "Default",
    price: "50.00",
  });

  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, prvAuth);
  expect(cartRes.status).toBe(201);
  const cartId = cartRes.json["id"] as string;

  const lineRes = await post(
    ctx,
    `/commerce/stores/${storeId}/carts/${cartId}/lines`,
    { variant_id: variant.id, quantity: 2 },
    prvAuth
  );
  expect(lineRes.status).toBe(201);

  const coRes = await post(
    ctx,
    `/commerce/stores/${storeId}/checkouts`,
    { cart_id: cartId },
    prvAuth
  );
  expect(coRes.status).toBe(201);
  return coRes.json["id"] as string;
}

describe("GET checkout with ?presentment_currency", () => {
  it("attaches a presentment block without mutating base amounts", async () => {
    const { storeId, prvAuth } = await setupStore("USD");
    const checkoutId = await buildUsdCheckout(storeId, prvAuth);

    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}?presentment_currency=EUR`,
      prvAuth
    );
    expect(res.status).toBe(200);

    // Base amounts UNCHANGED — settlement currency stays USD.
    expect(res.json["currency"]).toBe("USD");
    expect(res.json["subtotal"]).toBe("100.00");
    expect(res.json["total"]).toBe("100.00");

    // Presentment block present and converted at the USD→EUR rate (0.9).
    const p = res.json["presentment"] as Record<string, unknown>;
    expect(p).toBeTruthy();
    expect(p["currency"]).toBe("EUR");
    expect(p["rate"]).toBe(0.9);
    expect(p["subtotal"]).toBe("90.00");
    expect(p["total"]).toBe("90.00");
  });

  it("omits presentment when no rate is available", async () => {
    const { storeId, prvAuth } = await setupStore("USD");
    const checkoutId = await buildUsdCheckout(storeId, prvAuth);

    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}?presentment_currency=XXX`,
      prvAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["presentment"]).toBeUndefined();
    // Base amounts intact.
    expect(res.json["total"]).toBe("100.00");
  });

  it("omits presentment when target equals base currency", async () => {
    const { storeId, prvAuth } = await setupStore("USD");
    const checkoutId = await buildUsdCheckout(storeId, prvAuth);

    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}?presentment_currency=USD`,
      prvAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["presentment"]).toBeUndefined();
  });
});
