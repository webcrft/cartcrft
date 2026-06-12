/**
 * engagement.test.ts — Wishlists and abandoned carts.
 *
 * Key assertions:
 *  - Wishlist CRUD (create, list, get, delete)
 *  - Add/remove items from wishlist
 *  - Share token: public GET /storefront/:storeId/wishlists/:shareToken
 *  - Abandoned carts: list, mark recovered
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
  userId = "00000000-0000-0000-0000-000000000005";
  const org = await insertOrg(ctx.pool, { name: "Engagement Test Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, { orgId, name: "Engagement Store", slug: `engagement-store-${Date.now()}` });
  storeId = store.id;
});

afterAll(async () => {
  await ctx.teardown();
});

const base = () => `/commerce/stores/${storeId}`;

// ── Wishlists ─────────────────────────────────────────────────────────────────

describe("wishlists", () => {
  let wishlistId: string;
  let shareToken: string;
  let customerId: string;
  let product: { id: string; storeId: string; title: string };
  let variant: { id: string; productId: string; price: string };

  beforeAll(async () => {
    product = await insertProduct(ctx.pool, { storeId, title: "Wishlist Product" });
    variant = await insertVariant(ctx.pool, { productId: product.id, price: "29.99" });
    const customer = await insertCustomer(ctx.pool, { storeId, email: `wishlist${Date.now()}@test.example.com` });
    customerId = customer.id;
  });

  it("creates a wishlist", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/wishlists`,
      headers: authHeader,
      body: {
        customer_id: customerId,
        name: "My Favorites",
      },
    });
    expect(res.status).toBe(201);
    const body = res.json as { id: string; name: string; share_token: string };
    expect(body.name).toBe("My Favorites");
    expect(typeof body.share_token).toBe("string");
    wishlistId = body.id;
    shareToken = body.share_token;
  });

  it("lists wishlists", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/wishlists`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { wishlists: unknown[] };
    expect(body.wishlists.length).toBeGreaterThan(0);
  });

  it("gets a wishlist", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/wishlists/${wishlistId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const w = res.json as { id: string; name: string; items: unknown[] };
    expect(w.id).toBe(wishlistId);
    expect(w.name).toBe("My Favorites");
    expect(Array.isArray(w.items)).toBe(true);
  });

  it("adds a product to wishlist (by product_id)", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/wishlists/${wishlistId}/items`,
      headers: authHeader,
      body: { product_id: product.id },
    });
    expect(res.status).toBe(201);
  });

  it("adds same product again is idempotent", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/wishlists/${wishlistId}/items`,
      headers: authHeader,
      body: { product_id: product.id },
    });
    // Should not error — idempotent upsert
    expect([200, 201]).toContain(res.status);
  });

  it("adds product with variant_id", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/wishlists/${wishlistId}/items`,
      headers: authHeader,
      body: { product_id: product.id, variant_id: variant.id },
    });
    expect([200, 201]).toContain(res.status);
  });

  it("wishlist now has items", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/wishlists/${wishlistId}`,
      headers: authHeader,
    });
    const w = res.json as { items: unknown[] };
    expect(w.items.length).toBeGreaterThan(0);
  });

  it("removes an item from wishlist", async () => {
    // First get item id
    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/wishlists/${wishlistId}`,
      headers: authHeader,
    });
    const w = getRes.json as { items: Array<{ id: string }> };
    const itemId = w.items[0]?.id ?? "";

    const res = await ctx.request({
      method: "DELETE",
      path: `${base()}/wishlists/${wishlistId}/items/${itemId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
  });

  it("public share token: GET /storefront/:storeId/wishlists/:shareToken", async () => {
    // Fetch the share_token from the DB since it's a text/hex value
    const { rows: wlRows } = await ctx.pool.query<{ share_token: string }>(
      `SELECT share_token FROM wishlists WHERE id = $1::uuid`,
      [wishlistId]
    );
    const dbShareToken = wlRows[0]?.share_token ?? shareToken;

    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/wishlists/${dbShareToken}`,
    });
    expect(res.status).toBe(200);
    const w = res.json as { id: string; name: string; items: unknown[] };
    expect(w.id).toBe(wishlistId);
    expect(w.name).toBe("My Favorites");
    expect(Array.isArray(w.items)).toBe(true);
  });

  it("invalid share token returns 404", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/wishlists/nonexistent-token-that-does-not-exist`,
    });
    expect(res.status).toBe(404);
  });

  it("deletes a wishlist", async () => {
    const res = await ctx.request({
      method: "DELETE",
      path: `${base()}/wishlists/${wishlistId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);

    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/wishlists/${wishlistId}`,
      headers: authHeader,
    });
    expect(getRes.status).toBe(404);
  });
});

// ── Abandoned carts ────────────────────────────────────────────────────────────

describe("abandoned carts", () => {
  let cartId: string;

  beforeAll(async () => {
    // Seed an abandoned cart directly via abandoned_carts table (requires FK to carts)
    const customer = await insertCustomer(ctx.pool, { storeId, email: `abandoned${Date.now()}@test.example.com` });

    // First create a cart
    const { rows: cartRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO carts (store_id, customer_id, currency, status)
       VALUES ($1::uuid, $2::uuid, 'USD', 'abandoned')
       RETURNING id::text`,
      [storeId, customer.id]
    );
    const cid = cartRows[0]?.id ?? "";

    // Then create an abandoned_carts record pointing to it
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO abandoned_carts (store_id, cart_id, customer_id, abandoned_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '2 hours')
       RETURNING id::text`,
      [storeId, cid, customer.id]
    );
    cartId = cid; // The route uses cart_id (the carts.id) not abandoned_carts.id
  });

  it("lists abandoned carts", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/abandoned-carts`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { carts: unknown[] };
    expect(Array.isArray(body.carts)).toBe(true);
  });

  it("marks cart as recovered", async () => {
    if (!cartId) {
      return; // skip if setup failed
    }

    const res = await ctx.request({
      method: "POST",
      path: `${base()}/abandoned-carts/${cartId}/recover`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { ok: boolean; recovered_at: string };
    expect(body.ok).toBe(true);
    expect(typeof body.recovered_at).toBe("string");
  });

  it("marks cart recovered with order_id", async () => {
    const customer = await insertCustomer(ctx.pool, { storeId, email: `abcart2${Date.now()}@test.example.com` });

    // Create a second abandoned cart (FK: carts -> abandoned_carts)
    const { rows: cartRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO carts (store_id, customer_id, currency, status)
       VALUES ($1::uuid, $2::uuid, 'USD', 'abandoned')
       RETURNING id::text`,
      [storeId, customer.id]
    );
    const cartId2 = cartRows[0]?.id ?? "";
    await ctx.pool.query(
      `INSERT INTO abandoned_carts (store_id, cart_id, customer_id, abandoned_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '1 hour')`,
      [storeId, cartId2, customer.id]
    );

    // Create a dummy order to link
    const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, order_number, status, financial_status, fulfillment_status, currency, subtotal, total)
       VALUES ($1::uuid, $2::uuid, $3, 'open', 'paid', 'unfulfilled', 'USD', 25.00, 25.00)
       RETURNING id::text`,
      [storeId, customer.id, `AC-${Date.now()}`]
    );
    const orderId = orderRows[0]?.id ?? "";

    const res = await ctx.request({
      method: "POST",
      path: `${base()}/abandoned-carts/${cartId2}/recover`,
      headers: authHeader,
      body: { order_id: orderId },
    });
    expect(res.status).toBe(200);
    const body = res.json as { ok: boolean; recovery_order_id: string };
    expect(body.ok).toBe(true);
    expect(body.recovery_order_id).toBe(orderId);
  });
});
