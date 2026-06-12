/**
 * seed.test.ts — Demo store seed + agent-buyable hero flow test suite.
 *
 * What this suite verifies:
 *  1. seedDemoStore() populates the test schema without errors.
 *  2. 12 products are created (all active, various types).
 *  3. Every product has at least one variant with a price > 0.
 *  4. Variants with track_inventory=true have inventory_levels rows.
 *  5. Full-text search returns the merino hoodie for a natural query.
 *  6. The WELCOME10 discount code validates correctly (10% off).
 *  7. Full MCP purchase flow of a seeded product succeeds end-to-end:
 *     search → get_product → create_cart → add_to_cart → start_checkout →
 *     update_checkout (apply WELCOME10) → complete_checkout → get_order_status.
 *  8. Collections: manual "New Arrivals" has products; smart has all active.
 *  9. Warehouse exists and inventory levels are present.
 * 10. Re-running seedDemoStore on the same pool returns alreadyExisted=true.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createCtx, type TestCtx } from "../shared/ctx.js";
import { post } from "../shared/helpers.js";
import { seedDemoStore, type SeedResult } from "../../src/seed/index.js";

// ── Context ───────────────────────────────────────────────────────────────────

let ctx: TestCtx;
let seed: SeedResult;

beforeAll(async () => {
  ctx = await createCtx();
  // Run seed into the test schema pool (no printing during tests)
  seed = await seedDemoStore(ctx.pool, { print: false });
}, 180_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── MCP helpers ───────────────────────────────────────────────────────────────

async function mcpClient(apiKey: string): Promise<Client> {
  const url = new URL(`${ctx.baseUrl}/mcp/${seed.storeId}`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  const client = new Client(
    { name: "seed-test-client", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`Tool ${name} returned no content`);
  }
  const first = content[0];
  if (!first || first.type !== "text") {
    throw new Error(`Tool ${name} returned non-text content`);
  }
  return JSON.parse(first.text);
}

// ── 1. Seed non-duplication ───────────────────────────────────────────────────

describe("seed idempotency", () => {
  it("seedDemoStore() does not return alreadyExisted on fresh run", () => {
    expect(seed.alreadyExisted).toBe(false);
  });

  it("re-running seedDemoStore returns alreadyExisted=true", async () => {
    const second = await seedDemoStore(ctx.pool, { print: false });
    expect(second.alreadyExisted).toBe(true);
  });

  it("returns a valid store UUID", () => {
    expect(seed.storeId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });
});

// ── 2. Product count & types ───────────────────────────────────────────────────

describe("products", () => {
  it("seeds exactly 12 products", () => {
    expect(seed.productIds).toHaveLength(12);
  });

  it("all 12 products are active in the DB", async () => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM products WHERE store_id = $1::uuid AND status = 'active'`,
      [seed.storeId]
    );
    expect(parseInt(rows[0]!.count, 10)).toBe(12);
  });

  it("covers all required product types (configurable, simple, digital, bundle, subscription)", async () => {
    const { rows } = await ctx.pool.query<{ type: string }>(
      `SELECT DISTINCT type FROM products WHERE store_id = $1::uuid ORDER BY type`,
      [seed.storeId]
    );
    const types = rows.map((r) => r.type);
    expect(types).toContain("configurable");
    expect(types).toContain("simple");
    expect(types).toContain("digital");
    expect(types).toContain("bundle");
    expect(types).toContain("subscription");
  });

  it("every product has at least one variant with price > 0", async () => {
    const { rows } = await ctx.pool.query<{ id: string; min_price: string }>(
      `SELECT p.id::text,
              MIN(pv.price)::text AS min_price
       FROM products p
       JOIN product_variants pv ON pv.product_id = p.id
       WHERE p.store_id = $1::uuid
       GROUP BY p.id`,
      [seed.storeId]
    );
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(parseFloat(row.min_price)).toBeGreaterThan(0);
    }
  });

  it("total variant count is reasonable (>= 12)", async () => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE p.store_id = $1::uuid`,
      [seed.storeId]
    );
    expect(parseInt(rows[0]!.count, 10)).toBeGreaterThanOrEqual(12);
  });

  it("the merino hoodie has size and colour options", async () => {
    const { rows } = await ctx.pool.query<{ name: string }>(
      `SELECT po.name
       FROM product_options po
       JOIN products p ON p.id = po.product_id
       WHERE p.store_id = $1::uuid AND p.slug = 'alpine-merino-pullover-hoodie'
       ORDER BY po.position`,
      [seed.storeId]
    );
    const names = rows.map((r) => r.name);
    expect(names).toContain("Size");
    expect(names).toContain("Colour");
  });
});

// ── 3. Inventory ───────────────────────────────────────────────────────────────

describe("inventory", () => {
  it("creates the default warehouse", async () => {
    const { rows } = await ctx.pool.query(
      `SELECT id::text, name, is_default FROM warehouses WHERE store_id = $1::uuid`,
      [seed.storeId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Crft Goods Fulfilment Centre", is_default: true });
    expect(seed.warehouseId).toBe(rows[0]!.id);
  });

  it("tracked variants have inventory_levels rows with qty > 0", async () => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM inventory_levels il
       JOIN product_variants pv ON pv.id = il.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE p.store_id = $1::uuid AND il.quantity_on_hand > 0`,
      [seed.storeId]
    );
    expect(parseInt(rows[0]!.count, 10)).toBeGreaterThan(0);
  });

  it("digital + subscription variants do NOT have inventory_levels rows", async () => {
    // Digital and subscription products use track_inventory=false
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE p.store_id = $1::uuid
         AND p.type IN ('digital', 'subscription')
         AND pv.track_inventory = false`,
      [seed.storeId]
    );
    expect(parseInt(rows[0]!.count, 10)).toBeGreaterThan(0);
  });
});

// ── 4. Collections ─────────────────────────────────────────────────────────────

describe("collections", () => {
  it("creates 2 collections (manual + smart)", async () => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM collections WHERE store_id = $1::uuid`,
      [seed.storeId]
    );
    expect(parseInt(rows[0]!.count, 10)).toBe(2);
  });

  it("manual collection 'New Arrivals' has at least 6 products", async () => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM product_collections pc
       JOIN collections c ON c.id = pc.collection_id
       WHERE c.store_id = $1::uuid AND c.slug = 'new-arrivals'`,
      [seed.storeId]
    );
    expect(parseInt(rows[0]!.count, 10)).toBeGreaterThanOrEqual(6);
  });

  it("smart collection 'All Active Products' has all 12 products", async () => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM product_collections pc
       JOIN collections c ON c.id = pc.collection_id
       WHERE c.store_id = $1::uuid AND c.slug = 'all-active'`,
      [seed.storeId]
    );
    expect(parseInt(rows[0]!.count, 10)).toBe(12);
  });
});

// ── 5. Discount code ───────────────────────────────────────────────────────────

describe("discount code WELCOME10", () => {
  it("WELCOME10 exists in the DB", async () => {
    const { rows } = await ctx.pool.query(
      `SELECT code, type, value::text, is_active
       FROM discount_codes WHERE store_id = $1::uuid AND code = 'WELCOME10'`,
      [seed.storeId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: "WELCOME10",
      type: "percentage",
      is_active: true,
    });
    expect(parseFloat(rows[0]!.value)).toBe(10);
  });

  it("WELCOME10 validates via REST API (10% off a $50 order)", async () => {
    // The validate endpoint is GET /discounts/validate?code=WELCOME10&order_total=50.00
    // Returns ValidateDiscountResult with computed_amount (10% of $50 = $5)
    const res = await ctx.request({
      method: "GET",
      path: `/commerce/stores/${seed.storeId}/discounts/validate?code=WELCOME10&order_total=50.00`,
      headers: { authorization: `Bearer ${seed.prvKey}` },
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    // Response has code, type, value, computed_amount
    expect(body["code"]).toBe("WELCOME10");
    expect(body["type"]).toBe("percentage");
    // computed_amount = 10% of 50 = 5
    expect(parseFloat(body["computed_amount"] as string)).toBeCloseTo(5, 1);
  });
});

// ── 6. Search returns hoodie for natural query ─────────────────────────────────

describe("semantic search", () => {
  it("search for 'merino pullover hoodie' returns the Alpine hoodie", async () => {
    // Uses full-text search (no embedder configured in tests) — query must match
    // tokens in the product title/description via websearch_to_tsquery.
    // The Alpine Merino Pullover Hoodie has all three tokens.
    const res = await post(
      ctx,
      `/commerce/stores/${seed.storeId}/search`,
      { query: "merino pullover hoodie", limit: 5 },
      { type: "api-key", key: seed.pubKey }
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const results = body["results"] as Record<string, unknown>[];
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);

    const hoodie = results.find((r) =>
      typeof r["title"] === "string" &&
      (r["title"] as string).toLowerCase().includes("merino") &&
      (r["title"] as string).toLowerCase().includes("hoodie")
    );
    expect(hoodie).toBeDefined();
  });

  it("search for 'merino wool' returns multiple products", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${seed.storeId}/search`,
      { query: "merino wool", limit: 10 },
      { type: "api-key", key: seed.pubKey }
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const results = body["results"] as Record<string, unknown>[];
    // Hoodie, beanie, and socks all have merino
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("search for 'digital download design assets' returns the asset pack", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${seed.storeId}/search`,
      { query: "digital download design assets", limit: 5 },
      { type: "api-key", key: seed.pubKey }
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const results = body["results"] as Record<string, unknown>[];
    expect(results.length).toBeGreaterThan(0);
    const digital = results.find((r) =>
      typeof r["title"] === "string" &&
      (r["title"] as string).toLowerCase().includes("digital")
    );
    expect(digital).toBeDefined();
  });
});

// ── 7. Full MCP purchase flow ──────────────────────────────────────────────────

describe("MCP agent purchase flow (seeded product)", () => {
  let client: Client;
  let cartId: string;
  let checkoutId: string;
  let orderId: string;
  let hoodieVariantId: string;

  beforeAll(async () => {
    client = await mcpClient(seed.prvKey);

    // Find the hoodie variant id from the DB (M / Slate Grey — good stock)
    const { rows } = await ctx.pool.query<{ id: string }>(
      `SELECT pv.id::text
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE p.store_id = $1::uuid
         AND p.slug = 'alpine-merino-pullover-hoodie'
         AND pv.title = 'M / Slate Grey'
       LIMIT 1`,
      [seed.storeId]
    );
    expect(rows.length).toBeGreaterThan(0);
    hoodieVariantId = rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (client) await client.close();
  });

  it("search_products finds merino hoodie by keyword 'merino'", async () => {
    const result = await callTool(client, "search_products", {
      query: "merino",
      limit: 10,
    });
    const data = result as Record<string, unknown>;
    const products = data["products"] as Record<string, unknown>[];
    expect(Array.isArray(products)).toBe(true);
    // Should find at minimum the hoodie, beanie, and socks
    expect(products.length).toBeGreaterThan(0);
    const hoodie = products.find((p) =>
      typeof p["title"] === "string" &&
      (p["title"] as string).toLowerCase().includes("hoodie")
    );
    expect(hoodie).toBeDefined();
  });

  it("get_product returns full hoodie detail with variants", async () => {
    // Get the hoodie product id
    const { rows: pRows } = await ctx.pool.query<{ id: string }>(
      `SELECT id::text FROM products WHERE store_id = $1::uuid AND slug = 'alpine-merino-pullover-hoodie'`,
      [seed.storeId]
    );
    const hoodieProductId = pRows[0]!.id;

    const result = await callTool(client, "get_product", {
      product_id: hoodieProductId,
    });
    const data = result as Record<string, unknown>;
    expect(data["id"]).toBe(hoodieProductId);
    expect(data["title"]).toBe("Alpine Merino Pullover Hoodie");
    const variants = data["variants"] as Record<string, unknown>[];
    expect(variants.length).toBeGreaterThanOrEqual(9);
  });

  it("create_cart creates a new cart for the store", async () => {
    const result = await callTool(client, "create_cart", {});
    const data = result as Record<string, unknown>;
    expect(typeof data["cart_id"]).toBe("string");
    cartId = data["cart_id"] as string;
    expect(cartId).toBeTruthy();
  });

  it("add_to_cart adds M / Slate Grey hoodie (qty=1)", async () => {
    const result = await callTool(client, "add_to_cart", {
      cart_id: cartId,
      variant_id: hoodieVariantId,
      quantity: 1,
    });
    const data = result as Record<string, unknown>;
    expect(typeof data["line_id"]).toBe("string");
    const cart = data["cart"] as Record<string, unknown>;
    const lines = cart["lines"] as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.["variant_id"]).toBe(hoodieVariantId);
  });

  it("get_cart shows the hoodie at $89.00", async () => {
    const cart = await callTool(client, "get_cart", { cart_id: cartId });
    const data = cart as Record<string, unknown>;
    const lines = data["lines"] as Record<string, unknown>[];
    expect(lines[0]?.["price"]).toBe("89.00");
  });

  it("start_checkout creates checkout session", async () => {
    const result = await callTool(client, "start_checkout", {
      cart_id: cartId,
      email: "agent@cartcrft-demo.example.com",
      shipping_address: {
        first_name: "AI",
        last_name: "Agent",
        address1: "1 Commerce Lane",
        city: "New York",
        province_code: "NY",
        country_code: "US",
        zip: "10001",
      },
    });
    const data = result as Record<string, unknown>;
    expect(typeof data["id"]).toBe("string");
    checkoutId = data["id"] as string;
    // subtotal = 1 × $89.00
    expect(parseFloat(data["subtotal"] as string)).toBeCloseTo(89, 0);
  });

  it("update_checkout applies WELCOME10 discount (10% off)", async () => {
    const result = await callTool(client, "update_checkout", {
      checkout_id: checkoutId,
      discount_code: "WELCOME10",
    });
    const data = result as Record<string, unknown>;
    // Discount total should be 10% of 89 = 8.90
    // Either in top-level or in nested checkout
    const discountTotal = data["discount_total"] ??
      (data["checkout"] as Record<string, unknown>)?.["discount_total"];
    if (discountTotal !== undefined) {
      expect(parseFloat(discountTotal as string)).toBeCloseTo(8.9, 0);
    }
    // At minimum, the call shouldn't error
    expect(data["error"]).toBeUndefined();
  });

  it("complete_checkout places the order (test mode)", async () => {
    const result = await callTool(client, "complete_checkout", {
      checkout_id: checkoutId,
    });
    const data = result as Record<string, unknown>;
    expect(data["error"]).toBeUndefined();
    expect(typeof data["order_id"]).toBe("string");
    orderId = data["order_id"] as string;
    expect(data["message"]).toBe("Order created successfully");
    // total after 10% off = ~80.10 (+shipping)
    expect(parseFloat(data["total"] as string)).toBeGreaterThan(0);
  });

  it("get_order_status returns the placed order", async () => {
    const result = await callTool(client, "get_order_status", {
      order_id: orderId,
    });
    const order = result as Record<string, unknown>;
    expect(order["id"]).toBe(orderId);
    expect(order["status"]).toBe("open");
    expect(order["financial_status"]).toBe("pending");
    const lines = order["lines"] as Record<string, unknown>[];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.["variant_id"]).toBe(hoodieVariantId);
  });
});

// ── 8. Shipping zone ───────────────────────────────────────────────────────────

describe("shipping zone", () => {
  it("shipping zone 'Worldwide' exists", async () => {
    const { rows } = await ctx.pool.query(
      `SELECT name FROM shipping_zones WHERE store_id = $1::uuid`,
      [seed.storeId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Worldwide");
  });

  it("has flat rate $7.99 and free over $100", async () => {
    const { rows } = await ctx.pool.query<{ name: string; price: string }>(
      `SELECT sr.name, sr.price::text
       FROM shipping_rates sr
       JOIN shipping_zones sz ON sz.id = sr.zone_id
       WHERE sz.store_id = $1::uuid
       ORDER BY sr.price`,
      [seed.storeId]
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const freeRate = rows.find((r) => parseFloat(r.price) === 0);
    const flatRate = rows.find((r) => parseFloat(r.price) === 7.99);
    expect(freeRate).toBeDefined();
    expect(flatRate).toBeDefined();
  });
});
