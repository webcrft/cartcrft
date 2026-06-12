/**
 * digital.test.ts — Digital product delivery module.
 *
 * Key assertions:
 *  - Generate download links for an order (only digital lines)
 *  - Non-digital order lines: generate returns 0 links
 *  - GET /storefront/:storeId/downloads/:token → 302 redirect
 *  - Token expiry: expired link returns 410
 *  - Max downloads exhaustion: after max_downloads hits, returns 410
 *  - Admin list per order
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import { mintJwt, insertOrg, insertStore, insertProduct, insertVariant, insertCustomer } from "../shared/helpers.js";

let ctx: TestCtx;
let orgId: string;
let userId: string;
let storeId: string;
let authHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createCtx();
  userId = "00000000-0000-0000-0000-000000000004";
  const org = await insertOrg(ctx.pool, { name: "Digital Test Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, { orgId, name: "Digital Store", slug: `digital-store-${Date.now()}` });
  storeId = store.id;
});

afterAll(async () => {
  await ctx.teardown();
});

const base = () => `/commerce/stores/${storeId}`;

// ── Setup helpers ─────────────────────────────────────────────────────────────

async function createDigitalOrder() {
  const product = await insertProduct(ctx.pool, { storeId, title: "E-Book" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, price: "19.99" });
  const customer = await insertCustomer(ctx.pool, { storeId, email: `dltest${Date.now()}@test.example.com` });

  // Create digital file via catalog endpoint
  const fileRes = await ctx.request({
    method: "POST",
    path: `${base()}/products/${product.id}/digital-files`,
    headers: authHeader,
    body: {
      name: "ebook.pdf",
      file_url: "https://cdn.example.com/ebooks/ebook.pdf",
      mime_type: "application/pdf",
      variant_id: variant.id,
    },
  });

  // Create an order with the digital variant
  const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders
       (store_id, customer_id, order_number, status, financial_status, fulfillment_status, currency, subtotal, total)
     VALUES ($1::uuid, $2::uuid, $3, 'open', 'paid', 'unfulfilled', 'USD', 19.99, 19.99)
     RETURNING id::text`,
    [storeId, customer.id, `DL-TEST-${Date.now()}`]
  );
  const orderId = orderRows[0]?.id ?? "";

  // Create order line with the digital variant
  await ctx.pool.query(
    `INSERT INTO order_lines (order_id, variant_id, title, quantity, price, total)
     VALUES ($1::uuid, $2::uuid, 'E-Book', 1, 19.99, 19.99)`,
    [orderId, variant.id]
  );

  return { orderId, productId: product.id, variantId: variant.id };
}

// ── Generate download links ───────────────────────────────────────────────────

describe("generate download links", () => {
  let orderId: string;
  let token: string;

  beforeAll(async () => {
    const result = await createDigitalOrder();
    orderId = result.orderId;
  });

  it("generates links for digital order lines", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/download-links`,
      headers: authHeader,
      body: { max_downloads: 3 },
    });
    expect(res.status).toBe(201);
    const body = res.json as { links: Array<{ token: string }>; count: number };
    expect(body.count).toBeGreaterThan(0);
    expect(body.links.length).toBeGreaterThan(0);
    token = body.links[0]?.token ?? "";
    expect(typeof token).toBe("string");
  });

  it("lists download links for an order (admin)", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/orders/${orderId}/download-links`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { links: unknown[] };
    expect(body.links.length).toBeGreaterThan(0);
  });

  it("storefront download token → 302 redirect", async () => {
    // Use raw fetch with redirect:'manual' so we capture the 302
    const res = await fetch(`${ctx.baseUrl}/storefront/${storeId}/downloads/${token}`, {
      method: "GET",
      redirect: "manual",
    });
    // With redirect:manual, fetch returns the 302 opaque redirect response
    // The status is either 302 or 0 (opaqueredirect) depending on environment
    expect([0, 302, 303]).toContain(res.status);
  });

  it("invalid token → 404", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/downloads/00000000-0000-0000-0000-000000000000`,
    });
    expect(res.status).toBe(404);
  });

  it("max_downloads exhaustion: returns 410 after limit", async () => {
    // Create order with max_downloads=1
    const result = await createDigitalOrder();
    const genRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${result.orderId}/download-links`,
      headers: authHeader,
      body: { max_downloads: 1 },
    });
    const genBody = genRes.json as { links: Array<{ token: string }> };
    const limitToken = genBody.links[0]?.token ?? "";

    // First download: use manual redirect to avoid following external URL
    const first = await fetch(`${ctx.baseUrl}/storefront/${storeId}/downloads/${limitToken}`, {
      method: "GET",
      redirect: "manual",
    });
    // Status 0 = opaqueredirect (manual mode), 302 also acceptable
    expect([0, 302, 303]).toContain(first.status);

    // Second download should fail (limit exceeded)
    const second = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/downloads/${limitToken}`,
    });
    expect(second.status).toBe(410);
    expect((second.json as { error: { code: string } }).error.code).toBe("DOWNLOAD_LIMIT_EXCEEDED");
  });

  it("expired link: returns 410", async () => {
    // Create order with already-expired link
    const result = await createDigitalOrder();
    const genRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${result.orderId}/download-links`,
      headers: authHeader,
      body: { expires_at: "2020-01-01T00:00:00Z" }, // past date
    });
    const genBody = genRes.json as { links: Array<{ token: string }> };
    const expiredToken = genBody.links[0]?.token ?? "";

    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/downloads/${expiredToken}`,
    });
    expect(res.status).toBe(410);
    expect((res.json as { error: { code: string } }).error.code).toBe("LINK_EXPIRED");
  });
});

// ── Non-digital order ─────────────────────────────────────────────────────────

describe("non-digital order", () => {
  it("generate for non-digital lines returns 0 links", async () => {
    // Create order with a physical product (no digital file)
    const product = await insertProduct(ctx.pool, { storeId, title: "Physical Product" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "49.99" });
    const customer = await insertCustomer(ctx.pool, { storeId, email: `physical${Date.now()}@test.example.com` });

    const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, order_number, status, financial_status, fulfillment_status, currency, subtotal, total)
       VALUES ($1::uuid, $2::uuid, $3, 'open', 'paid', 'unfulfilled', 'USD', 49.99, 49.99)
       RETURNING id::text`,
      [storeId, customer.id, `PHYS-${Date.now()}`]
    );
    const orderId = orderRows[0]?.id ?? "";
    await ctx.pool.query(
      `INSERT INTO order_lines (order_id, variant_id, title, quantity, price, total)
       VALUES ($1::uuid, $2::uuid, 'Physical Product', 1, 49.99, 49.99)`,
      [orderId, variant.id]
    );

    const res = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/download-links`,
      headers: authHeader,
      body: {},
    });
    expect(res.status).toBe(201);
    const body = res.json as { count: number };
    expect(body.count).toBe(0);
  });
});
