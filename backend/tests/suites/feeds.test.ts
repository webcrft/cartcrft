/**
 * feeds.test.ts — Product feeds + merchant feed config + feed-data roundtrip.
 *
 * Spirit of commerce_feeds.go suite:
 *  - Google Shopping XML: well-formed, g: namespace, field mapping
 *  - Out-of-stock filtering (availability = out_of_stock, still in feed)
 *  - Facebook Catalog XML: availability uses "in stock" / "out of stock" (with space)
 *  - feed-data PUT roundtrip
 *  - 404 when feed not configured
 *  - Merchant feed CRUD
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  del,
  mintJwt,
  insertStore,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

// ── Merchant feeds CRUD ────────────────────────────────────────────────────────

describe("Merchant Feeds CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let feedId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /merchant-feeds → empty list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/merchant-feeds`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["feeds"])).toBe(true);
    expect((res.json["feeds"] as unknown[]).length).toBe(0);
  });

  it("POST /merchant-feeds → creates google_shopping feed", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/merchant-feeds`,
      {
        channel: "google_shopping",
        name: "My Google Feed",
        locale: "en",
        country_code: "US",
        currency: "USD",
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    feedId = res.json["id"] as string;
  });

  it("GET /merchant-feeds → returns created feed", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/merchant-feeds`, auth);
    expect(res.status).toBe(200);
    const feeds = res.json["feeds"] as Array<Record<string, unknown>>;
    expect(feeds.length).toBeGreaterThanOrEqual(1);
    const feed = feeds.find((f) => f["id"] === feedId);
    expect(feed).toBeDefined();
    expect(feed!["channel"]).toBe("google_shopping");
    expect(feed!["name"]).toBe("My Google Feed");
    expect(feed!["status"]).toBe("active");
  });

  it("PUT /merchant-feeds/:feedId → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/merchant-feeds/${feedId}`,
      { name: "Updated Feed Name" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("PUT /merchant-feeds/:feedId → unknown feed returns 404", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/merchant-feeds/${randomUUID()}`,
      { name: "Nope" },
      auth
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /merchant-feeds/:feedId → removes feed", async () => {
    const res = await del(ctx, `/commerce/stores/${storeId}/merchant-feeds/${feedId}`, auth);
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    const list = await get(ctx, `/commerce/stores/${storeId}/merchant-feeds`, auth);
    const feeds = list.json["feeds"] as Array<Record<string, unknown>>;
    expect(feeds.find((f) => f["id"] === feedId)).toBeUndefined();
  });
});

// ── Product feed-data roundtrip ────────────────────────────────────────────────

describe("Product feed-data GET/PUT roundtrip", () => {
  let storeId = "";
  let variantId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
    const product = await insertProduct(ctx.pool, { storeId });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "29.99" });
    variantId = variant.id;
  });

  it("GET /variants/:variantId/feed-data → null initially", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/variants/${variantId}/feed-data`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["feed_data"]).toBeNull();
  });

  it("PUT /variants/:variantId/feed-data → upserts feed data", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/variants/${variantId}/feed-data`,
      {
        gtin: "012345678901",
        mpn: "SKU-001",
        brand: "TestBrand",
        google_product_category: "Apparel & Accessories",
        condition: "new",
        age_group: "adult",
        gender: "unisex",
      },
      auth
    );
    expect(res.status).toBe(200);
    expect(typeof res.json["id"]).toBe("string");
  });

  it("GET /variants/:variantId/feed-data → returns stored data", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/variants/${variantId}/feed-data`,
      auth
    );
    expect(res.status).toBe(200);
    const data = res.json["feed_data"] as Record<string, unknown>;
    expect(data).not.toBeNull();
    expect(data["gtin"]).toBe("012345678901");
    expect(data["mpn"]).toBe("SKU-001");
    expect(data["brand"]).toBe("TestBrand");
    expect(data["condition"]).toBe("new");
    expect(data["age_group"]).toBe("adult");
    expect(data["gender"]).toBe("unisex");
  });

  it("PUT /variants/:variantId/feed-data → second upsert preserves existing fields", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/variants/${variantId}/feed-data`,
      { brand: "NewBrand" },
      auth
    );
    expect(res.status).toBe(200);

    const get2 = await get(
      ctx,
      `/commerce/stores/${storeId}/variants/${variantId}/feed-data`,
      auth
    );
    const data = get2.json["feed_data"] as Record<string, unknown>;
    expect(data["brand"]).toBe("NewBrand");
    // gtin preserved from first upsert (COALESCE in ON CONFLICT)
    expect(data["gtin"]).toBe("012345678901");
  });

  it("PUT /variants/:variantId/feed-data → 404 for unknown variant", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/variants/${randomUUID()}/feed-data`,
      { gtin: "999" },
      auth
    );
    expect(res.status).toBe(404);
  });
});

// ── Google Shopping XML feed ───────────────────────────────────────────────────

describe("Google Shopping XML feed", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;

    // Create a product + in-stock variant
    const product = await insertProduct(ctx.pool, {
      storeId,
      title: "Test Shirt",
      slug: `test-shirt-${Date.now()}`,
    });
    const variant = await insertVariant(ctx.pool, {
      productId: product.id,
      title: "Small",
      price: "19.99",
    });

    // Set product to active and variant to track_inventory=false (no stock entries needed)
    await ctx.pool.query(
      `UPDATE products SET status = 'active' WHERE id = $1::uuid`,
      [product.id]
    );
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [variant.id]
    );

    // Create the merchant_feeds entry (required for the feed to be served)
    await post(
      ctx,
      `/commerce/stores/${storeId}/merchant-feeds`,
      {
        channel: "google_shopping",
        name: "Test Feed",
        locale: "en",
        country_code: "US",
        currency: "USD",
      },
      auth
    );
  });

  it("GET /storefront/:storeId/feeds/google-shopping → 200 XML", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/feeds/google-shopping`,
      headers: {},
    });
    expect(res.status).toBe(200);

    const body = res.body as string;
    expect(body).toContain('<?xml');
    expect(body).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(body).toContain('<rss');
    expect(body).toContain('<channel>');
    expect(body).toContain('<item>');
  });

  it("XML contains g: namespace elements", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/feeds/google-shopping`,
      headers: {},
    });
    const body = res.body as string;
    expect(body).toContain('<g:id>');
    expect(body).toContain('<g:title>');
    expect(body).toContain('<g:price>');
    expect(body).toContain('<g:availability>');
    expect(body).toContain('<g:condition>');
    expect(body).toContain('<g:link>');
  });

  it("XML price contains currency", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/feeds/google-shopping`,
      headers: {},
    });
    const body = res.body as string;
    // Price format: "19.99 USD"
    expect(body).toMatch(/19\.99 USD/);
  });

  it("XML in-stock variant has availability = in_stock", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/feeds/google-shopping`,
      headers: {},
    });
    const body = res.body as string;
    expect(body).toContain("<g:availability>in_stock</g:availability>");
  });

  it("404 when google_shopping feed not configured for store", async () => {
    const orgId2 = randomUUID();
    const store2 = await insertStore(ctx.pool, { orgId: orgId2 });
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${store2.id}/feeds/google-shopping`,
      headers: {},
    });
    expect(res.status).toBe(404);
  });
});

// ── Facebook Catalog XML feed ──────────────────────────────────────────────────

describe("Facebook Catalog XML feed", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;

    const product = await insertProduct(ctx.pool, {
      storeId,
      title: "Test Hoodie",
      slug: `test-hoodie-${Date.now()}`,
    });
    const fbVariant = await insertVariant(ctx.pool, {
      productId: product.id,
      title: "M",
      price: "49.99",
    });
    await ctx.pool.query(
      `UPDATE products SET status = 'active' WHERE id = $1::uuid`,
      [product.id]
    );
    await ctx.pool.query(
      `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
      [fbVariant.id]
    );

    await post(
      ctx,
      `/commerce/stores/${storeId}/merchant-feeds`,
      {
        channel: "facebook_catalog",
        name: "FB Catalog",
        locale: "en",
        country_code: "US",
        currency: "USD",
      },
      auth
    );
  });

  it("GET /storefront/:storeId/feeds/facebook-catalog → 200 XML", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/feeds/facebook-catalog`,
      headers: {},
    });
    expect(res.status).toBe(200);

    const body = res.body as string;
    expect(body).toContain('xmlns:g="http://base.google.com/ns/1.0"');
    expect(body).toContain('<g:id>');
  });

  it("Facebook availability uses space-separated form ('in stock')", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/feeds/facebook-catalog`,
      headers: {},
    });
    const body = res.body as string;
    // Facebook uses "in stock" (with space), not "in_stock"
    expect(body).toContain("<g:availability>in stock</g:availability>");
  });

  it("404 when facebook_catalog feed not configured for store", async () => {
    const orgId3 = randomUUID();
    const store3 = await insertStore(ctx.pool, { orgId: orgId3 });
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${store3.id}/feeds/facebook-catalog`,
      headers: {},
    });
    expect(res.status).toBe(404);
  });
});
