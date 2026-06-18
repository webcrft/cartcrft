/**
 * tax-exempt — TAX-EXEMPT customers / companies (Wave-18.1).
 *
 * A tax-exempt customer (or a customer checking out under a tax-exempt company)
 * gets ZERO tax at checkout — the tax engine is skipped entirely. A non-exempt
 * customer in the SAME taxable zone still gets the correct non-zero tax
 * (regression guard for the byte-identical non-exempt path). Toggling the flag
 * flips the outcome.
 *
 * DB setup mirrors checkout.test.ts (REST store + SQL product/variant + SQL tax
 * zone/rate) and order-edit-tax.test.ts (REST-driven checkout flow).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  mintJwt,
  createApiKey,
  insertStore,
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

// ── Setup helpers ───────────────────────────────────────────────────────────────

async function setupStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: "Tax Exempt Store",
    currency: "ZAR",
    timezone: "Africa/Johannesburg",
  }, auth);
  expect(storeRes.status).toBe(201);
  const storeId = storeRes.json["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const keyAuth = { type: "api-key" as const, key: apiKey };

  return { storeId, auth, keyAuth };
}

/** Seed a national ZA tax zone with a 15% exclusive VAT rate via SQL. */
async function seedZaVat(storeId: string): Promise<void> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO tax_zones (store_id, name) VALUES ($1::uuid, 'South Africa')
     RETURNING id::text`,
    [storeId]
  );
  const zoneId = rows[0]!.id;
  await ctx.pool.query(
    `INSERT INTO tax_zone_regions (zone_id, country_code) VALUES ($1::uuid, 'ZA')`,
    [zoneId]
  );
  await ctx.pool.query(
    `INSERT INTO tax_rates (zone_id, name, rate_pct, is_inclusive, is_active)
     VALUES ($1::uuid, 'VAT', 15, false, true)`,
    [zoneId]
  );
}

async function insertVariantNoTrack(storeId: string, price: string): Promise<string> {
  const product = await insertProduct(ctx.pool, { storeId, title: "Exempt Widget" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, title: "Default", price });
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
    [variant.id]
  );
  return variant.id;
}

async function insertCustomer(storeId: string, exempt: boolean): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO customers (store_id, email, tax_exempt)
     VALUES ($1::uuid, $2, $3)
     RETURNING id::text`,
    [storeId, `cust-${randomUUID()}@example.com`, exempt]
  );
  return rows[0]!.id;
}

async function insertCompany(storeId: string, exempt: boolean): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO companies (store_id, name, tax_exempt)
     VALUES ($1::uuid, $2, $3)
     RETURNING id::text`,
    [storeId, `Co ${randomUUID()}`, exempt]
  );
  return rows[0]!.id;
}

const keyAuth = (key: string) => ({ type: "api-key" as const, key });

/**
 * Run a full cart → checkout → complete flow under a customer (and optional
 * company), with a ZA shipping address (taxable zone). Returns the created
 * order's tax_total and total as numbers.
 */
async function completeOrder(
  storeId: string,
  key: string,
  variantId: string,
  customerId: string,
  companyId?: string
): Promise<{ checkoutTax: number; orderTax: number; orderTotal: number }> {
  const auth = keyAuth(key);

  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, auth);
  const cartId = cartRes.json["id"] as string;
  await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
    variant_id: variantId, quantity: 1,
  }, auth);

  const coBody: Record<string, unknown> = {
    cart_id: cartId,
    customer_id: customerId,
    shipping_address: { country_code: "ZA", province_code: "GP" },
  };
  if (companyId) coBody["company_id"] = companyId;

  const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, coBody, auth);
  expect(coRes.status).toBe(201);
  const checkoutId = coRes.json["id"] as string;
  const checkoutTax = parseFloat(coRes.json["tax_total"] as string);

  const complRes = await post(ctx, `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, {}, auth);
  expect(complRes.status).toBe(200);
  const orderId = complRes.json["order_id"] as string;

  const ordRes = await get(ctx, `/commerce/stores/${storeId}/orders/${orderId}`, auth);
  expect(ordRes.status).toBe(200);
  return {
    checkoutTax,
    orderTax: parseFloat(ordRes.json["tax_total"] as string),
    orderTotal: parseFloat(ordRes.json["total"] as string),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Tax-exempt customers / companies", () => {
  let storeId: string;
  let key: string;
  let variantId: string; // price 100.00 → 15% VAT = 15.00 when not exempt

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    key = s.keyAuth.key;
    await seedZaVat(storeId);
    variantId = await insertVariantNoTrack(storeId, "100.00");
  });

  it("NON-exempt customer in ZA still gets 15% VAT (byte-identical regression guard)", async () => {
    const customerId = await insertCustomer(storeId, false);
    const r = await completeOrder(storeId, key, variantId, customerId);
    expect(r.checkoutTax).toBeCloseTo(15.0, 2);
    expect(r.orderTax).toBeCloseTo(15.0, 2);
    expect(r.orderTotal).toBeCloseTo(115.0, 2);
  });

  it("TAX-EXEMPT customer in ZA gets tax_total 0 on the order", async () => {
    const customerId = await insertCustomer(storeId, true);
    const r = await completeOrder(storeId, key, variantId, customerId);
    expect(r.checkoutTax).toBeCloseTo(0, 2);
    expect(r.orderTax).toBeCloseTo(0, 2);
    expect(r.orderTotal).toBeCloseTo(100.0, 2);
  });

  it("toggling the customer flag flips the outcome", async () => {
    const customerId = await insertCustomer(storeId, false);

    // Not exempt → taxed.
    const taxed = await completeOrder(storeId, key, variantId, customerId);
    expect(taxed.orderTax).toBeCloseTo(15.0, 2);

    // Flip to exempt via the admin endpoint → zero tax.
    const auth = keyAuth(key);
    const setRes = await put(storeId, customerId, auth, true, "RESALE-123");
    expect(setRes.status).toBe(200);
    const exempt = await completeOrder(storeId, key, variantId, customerId);
    expect(exempt.orderTax).toBeCloseTo(0, 2);

    // Flip back to non-exempt → taxed again.
    const clearRes = await put(storeId, customerId, auth, false, null);
    expect(clearRes.status).toBe(200);
    const taxedAgain = await completeOrder(storeId, key, variantId, customerId);
    expect(taxedAgain.orderTax).toBeCloseTo(15.0, 2);
  });

  it("customer whose COMPANY is exempt is also exempt (customer not flagged)", async () => {
    const customerId = await insertCustomer(storeId, false);
    const companyId = await insertCompany(storeId, true);
    const r = await completeOrder(storeId, key, variantId, customerId, companyId);
    expect(r.checkoutTax).toBeCloseTo(0, 2);
    expect(r.orderTax).toBeCloseTo(0, 2);
    expect(r.orderTotal).toBeCloseTo(100.0, 2);
  });

  it("non-exempt customer under a non-exempt company is still taxed", async () => {
    const customerId = await insertCustomer(storeId, false);
    const companyId = await insertCompany(storeId, false);
    const r = await completeOrder(storeId, key, variantId, customerId, companyId);
    expect(r.orderTax).toBeCloseTo(15.0, 2);
    expect(r.orderTotal).toBeCloseTo(115.0, 2);
  });

  it("admin read includes the tax_exempt flag + ref", async () => {
    const customerId = await insertCustomer(storeId, false);
    const auth = keyAuth(key);
    await put(storeId, customerId, auth, true, "CERT-9");
    const res = await get(ctx, `/commerce/stores/${storeId}/customers/${customerId}`, auth);
    expect(res.status).toBe(200);
    const customer = res.json["customer"] as Record<string, unknown>;
    expect(customer["tax_exempt"]).toBe(true);
    expect(customer["tax_exempt_ref"]).toBe("CERT-9");
  });
});

/** PUT the tax-exempt admin endpoint. */
async function put(
  storeId: string,
  customerId: string,
  auth: { type: "api-key"; key: string },
  exempt: boolean,
  ref: string | null
) {
  return ctx.request({
    method: "PUT",
    path: `/commerce/stores/${storeId}/customers/${customerId}/tax-exempt`,
    body: { tax_exempt: exempt, tax_exempt_ref: ref },
    headers: { authorization: `Bearer ${auth.key}` },
  });
}
