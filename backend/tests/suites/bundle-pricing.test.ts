/**
 * bundle-pricing.test.ts — Server-side BUNDLE PRICING at checkout completion.
 *
 * A bundle product (products.type = 'bundle') references component variants via
 * product_bundle_items (variant_id + quantity). At completion, the bundle line's
 * unit price is recomputed SERVER-SIDE from the component variants at their live
 * prices — the stored cart_lines.price (the bundle variant's snapshot) is NEVER
 * trusted. Pricing model:
 *
 *   unit = round2( SUM(component.price × qty) × (1 − bundle_discount_pct) )
 *
 * where bundle_discount_pct is an optional metadata fraction/percentage (default
 * 0 → pure sum-of-components).
 *
 * Covers:
 *  - bundle line + subtotal + total reflect the server-computed price, NOT the
 *    (deliberately wrong) stored bundle-variant price
 *  - a tampered cart_lines.price for the bundle is overridden at completion
 *  - an optional bundle_discount_pct is applied
 *  - a NON-bundle checkout is unaffected (regression guard)
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
import { addBundleItem } from "../../src/modules/catalog/service.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function bootstrapStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: `Bundle Pricing Test Store ${Date.now()}`,
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

/** Insert a component variant on its own product; untracked inventory. */
async function makeComponent(storeId: string, title: string, price: string): Promise<string> {
  const product = await insertProduct(ctx.pool, { storeId, title: `Comp ${title}` });
  const variant = await insertVariant(ctx.pool, { productId: product.id, title, price });
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
    [variant.id]
  );
  return variant.id;
}

/**
 * Create a BUNDLE product with a single sellable bundle variant carrying a
 * DELIBERATELY WRONG stored price (so we can prove it is never trusted), plus
 * its component items. Returns the bundle variant id.
 */
async function makeBundle(
  storeId: string,
  storedWrongPrice: string,
  components: Array<{ variantId: string; quantity: number }>,
  discountPct?: string
): Promise<{ bundleProductId: string; bundleVariantId: string }> {
  const product = await insertProduct(ctx.pool, { storeId, title: "Combo Bundle" });
  await ctx.pool.query(
    `UPDATE products SET type = 'bundle', metadata = $2::jsonb WHERE id = $1::uuid`,
    [product.id, JSON.stringify(discountPct ? { bundle_discount_pct: discountPct } : {})]
  );
  const bundleVariant = await insertVariant(ctx.pool, {
    productId: product.id,
    title: "Bundle",
    price: storedWrongPrice,
  });
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
    [bundleVariant.id]
  );
  for (const c of components) {
    await addBundleItem(storeId, product.id, { variant_id: c.variantId, quantity: c.quantity });
  }
  return { bundleProductId: product.id, bundleVariantId: bundleVariant.id };
}

/** Create cart, add a line, create checkout. Returns { cartId, checkoutId, preview }. */
async function makeCheckout(
  storeId: string,
  keyAuth: { type: "api-key"; key: string },
  variantId: string,
  qty: number
): Promise<{ cartId: string; checkoutId: string; preview: Record<string, unknown> }> {
  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
  expect(cartRes.status).toBe(201);
  const cartId = cartRes.json["id"] as string;

  const lineRes = await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
    variant_id: variantId,
    quantity: qty,
  }, keyAuth);
  expect(lineRes.status).toBe(201);

  const coRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
    cart_id: cartId,
  }, keyAuth);
  expect(coRes.status).toBe(201);
  return { cartId, checkoutId: coRes.json["id"] as string, preview: coRes.json };
}

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

/** Read the order's bundle line (price/total) + order subtotal/total. */
async function readOrder(orderId: string) {
  const { rows: oRows } = await ctx.pool.query<{ subtotal: string; total: string }>(
    `SELECT subtotal::text, total::text FROM orders WHERE id = $1::uuid`,
    [orderId]
  );
  const { rows: lRows } = await ctx.pool.query<{
    variant_id: string;
    price: string;
    total: string;
    quantity: number;
  }>(
    `SELECT variant_id::text, price::text, total::text, quantity
     FROM order_lines WHERE order_id = $1::uuid`,
    [orderId]
  );
  return { order: oRows[0]!, lines: lRows };
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("bundle pricing — server-side recompute at completion", () => {
  it("prices a bundle as SUM(component price × qty), ignoring the stored bundle-variant price", async () => {
    const { storeId, keyAuth } = await bootstrapStore();

    // components: 100.00 ×2  +  50.00 ×1  → base = 250.00
    const c1 = await makeComponent(storeId, "A", "100.00");
    const c2 = await makeComponent(storeId, "B", "50.00");
    const { bundleVariantId } = await makeBundle(storeId, "999.00", [
      { variantId: c1, quantity: 2 },
      { variantId: c2, quantity: 1 },
    ]);

    const { checkoutId } = await makeCheckout(storeId, keyAuth, bundleVariantId, 1);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);

    const { order, lines } = await readOrder(res.json["order_id"] as string);
    const bundleLine = lines.find((l) => l.variant_id === bundleVariantId)!;
    expect(bundleLine.price).toBe("250.00");      // not the stored 999.00
    expect(bundleLine.total).toBe("250.00");      // 250 × 1
    expect(order.subtotal).toBe("250.00");
    expect(order.total).toBe("250.00");
  });

  it("overrides a TAMPERED cart-line price for the bundle at completion", async () => {
    const { storeId, keyAuth } = await bootstrapStore();

    const c1 = await makeComponent(storeId, "A", "30.00");
    const c2 = await makeComponent(storeId, "B", "20.00");
    // base = 30×1 + 20×2 = 70.00
    const { bundleVariantId } = await makeBundle(storeId, "70.00", [
      { variantId: c1, quantity: 1 },
      { variantId: c2, quantity: 2 },
    ]);

    const { cartId, checkoutId } = await makeCheckout(storeId, keyAuth, bundleVariantId, 1);

    // Attacker manipulates the stored cart-line price down to 1.00.
    await ctx.pool.query(
      `UPDATE cart_lines SET price = '1.00' WHERE cart_id = $1::uuid AND variant_id = $2::uuid`,
      [cartId, bundleVariantId]
    );

    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);

    const { order, lines } = await readOrder(res.json["order_id"] as string);
    const bundleLine = lines.find((l) => l.variant_id === bundleVariantId)!;
    expect(bundleLine.price).toBe("70.00");   // authoritative, tamper ignored
    expect(order.total).toBe("70.00");
  });

  it("applies an optional bundle_discount_pct (percentage form)", async () => {
    const { storeId, keyAuth } = await bootstrapStore();

    const c1 = await makeComponent(storeId, "A", "100.00");
    const c2 = await makeComponent(storeId, "B", "100.00");
    // base = 200.00; 10% off → 180.00
    const { bundleVariantId } = await makeBundle(
      storeId,
      "5.00",
      [
        { variantId: c1, quantity: 1 },
        { variantId: c2, quantity: 1 },
      ],
      "10"
    );

    const { checkoutId } = await makeCheckout(storeId, keyAuth, bundleVariantId, 1);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);

    const { order, lines } = await readOrder(res.json["order_id"] as string);
    const bundleLine = lines.find((l) => l.variant_id === bundleVariantId)!;
    expect(bundleLine.price).toBe("180.00");
    expect(order.total).toBe("180.00");
  });

  it("REGRESSION: a non-bundle checkout is unaffected (uses live variant price)", async () => {
    const { storeId, keyAuth } = await bootstrapStore();

    const product = await insertProduct(ctx.pool, { storeId, title: "Plain Widget" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "42.50" });
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variant.id]
    );

    const { checkoutId } = await makeCheckout(storeId, keyAuth, variant.id, 2);
    const res = await completeCheckout(storeId, checkoutId, keyAuth);
    expect(res.status).toBe(200);

    const { order, lines } = await readOrder(res.json["order_id"] as string);
    const line = lines.find((l) => l.variant_id === variant.id)!;
    expect(line.price).toBe("42.50");   // unchanged
    expect(line.total).toBe("85.00");   // 42.50 × 2
    expect(order.subtotal).toBe("85.00");
    expect(order.total).toBe("85.00");
  });
});
