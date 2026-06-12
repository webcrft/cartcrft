/**
 * catalog-csv.test.ts — T6.6 CSV product import/export.
 *
 * Assertions:
 *  1. Export roundtrip: seed store → export → import into second store → same product/variant counts.
 *  2. Quoting edge cases: commas/double-quotes/newlines in product titles.
 *  3. Dry-run: validation-only, no DB writes.
 *  4. Partial errors: one bad row does not abort the whole batch.
 *  5. Template endpoint returns valid CSV with header row + example row.
 *  6. Import upsert: re-importing the same CSV updates existing rows.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import { mintJwt, insertOrg, insertStore } from "../shared/helpers.js";
import { serializeCsv, parseCsv, csvCell, CSV_HEADERS } from "../../src/modules/catalog/csv.js";

let ctx: TestCtx;
let orgId: string;
let userId: string;
let storeId: string;
let storeId2: string;
let authHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createCtx();
  userId = "00000000-0000-0000-0000-000000000030";
  const org = await insertOrg(ctx.pool, { name: "CSV Test Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };

  const store = await insertStore(ctx.pool, {
    orgId,
    name: "CSV Store 1",
    slug: `csv-store-1-${Date.now()}`,
  });
  storeId = store.id;

  const store2 = await insertStore(ctx.pool, {
    orgId,
    name: "CSV Store 2",
    slug: `csv-store-2-${Date.now()}`,
  });
  storeId2 = store2.id;

  // Seed a warehouse in each store for inventory upsert
  await ctx.pool.query(
    `INSERT INTO warehouses (store_id, name) VALUES ($1::uuid, 'Default'), ($2::uuid, 'Default')`,
    [storeId, storeId2]
  );
});

afterAll(async () => {
  await ctx.teardown();
});

const base = (sid = storeId) => `/commerce/stores/${sid}`;

// ── CSV util unit tests ───────────────────────────────────────────────────────

describe("csv util", () => {
  it("csvCell: plain string passes through", () => {
    expect(csvCell("hello")).toBe("hello");
  });

  it("csvCell: string with comma is quoted", () => {
    expect(csvCell("hello, world")).toBe('"hello, world"');
  });

  it("csvCell: string with double-quote escapes inner quote", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("csvCell: string with newline is quoted", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("csvCell: null/undefined returns empty string", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("parseCsv: roundtrip simple row", () => {
    const csv = serializeCsv([
      {
        product_title: "Widget",
        product_slug: "widget",
        product_type: "simple",
        product_status: "active",
        product_vendor: "",
        product_description: "",
        product_tags: "",
        product_seo_title: "",
        product_seo_desc: "",
        variant_sku: "WID-001",
        variant_title: "Default",
        variant_price: "19.99",
        variant_compare_at_price: "",
        variant_cost_price: "",
        variant_weight_g: "100",
        variant_track_inventory: "true",
        variant_allow_backorder: "false",
        option_values: "",
        inventory_quantity: "50",
      },
    ]);
    const rows = parseCsv(csv);
    expect(rows.length).toBe(1);
    expect(rows[0]!["product_title"]).toBe("Widget");
    expect(rows[0]!["variant_sku"]).toBe("WID-001");
    expect(rows[0]!["variant_price"]).toBe("19.99");
  });

  it("parseCsv: handles commas in quoted fields", () => {
    const row = {
      product_title: "Widget, the best",
      product_slug: "widget-the-best",
      product_type: "simple",
      product_status: "active",
      product_vendor: "Brand, Inc.",
      product_description: "",
      product_tags: "",
      product_seo_title: "",
      product_seo_desc: "",
      variant_sku: "W1",
      variant_title: "Default",
      variant_price: "10.00",
      variant_compare_at_price: "",
      variant_cost_price: "",
      variant_weight_g: "0",
      variant_track_inventory: "true",
      variant_allow_backorder: "false",
      option_values: "",
      inventory_quantity: "0",
    };
    const csv = serializeCsv([row]);
    const parsed = parseCsv(csv);
    expect(parsed[0]!["product_title"]).toBe("Widget, the best");
    expect(parsed[0]!["product_vendor"]).toBe("Brand, Inc.");
  });

  it("parseCsv: handles double-quotes inside fields", () => {
    const row: Record<string, string | null> = {
      product_title: 'The "Premium" Widget',
      product_slug: "the-premium-widget",
      product_type: "simple",
      product_status: "draft",
      product_vendor: null,
      product_description: null,
      product_tags: null,
      product_seo_title: null,
      product_seo_desc: null,
      variant_sku: "PW1",
      variant_title: "Default",
      variant_price: "5.00",
      variant_compare_at_price: null,
      variant_cost_price: null,
      variant_weight_g: "0",
      variant_track_inventory: "true",
      variant_allow_backorder: "false",
      option_values: null,
      inventory_quantity: "0",
    };
    const csv = serializeCsv([row]);
    const parsed = parseCsv(csv);
    expect(parsed[0]!["product_title"]).toBe('The "Premium" Widget');
  });

  it("parseCsv: handles newlines in description field", () => {
    const row: Record<string, string | null> = {
      product_title: "Multi-line Product",
      product_slug: "multi-line-product",
      product_type: "simple",
      product_status: "draft",
      product_vendor: null,
      product_description: "Line one\nLine two\nLine three",
      product_tags: null,
      product_seo_title: null,
      product_seo_desc: null,
      variant_sku: "ML1",
      variant_title: "Default",
      variant_price: "25.00",
      variant_compare_at_price: null,
      variant_cost_price: null,
      variant_weight_g: "0",
      variant_track_inventory: "true",
      variant_allow_backorder: "false",
      option_values: null,
      inventory_quantity: "0",
    };
    const csv = serializeCsv([row]);
    const parsed = parseCsv(csv);
    expect(parsed[0]!["product_description"]).toBe("Line one\nLine two\nLine three");
  });

  it("CSV_HEADERS is exported and correct length", () => {
    expect(CSV_HEADERS.length).toBe(19);
    expect(CSV_HEADERS[0]).toBe("product_title");
  });
});

// ── Template endpoint ─────────────────────────────────────────────────────────

describe("template endpoint", () => {
  it("GET /products/import/template returns text/csv with header + example", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/products/import/template`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    // Body is CSV text
    const text = typeof res.body === "string" ? res.body : String(res.body);
    const lines = text.split(/\r?\n/).filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // First line should be headers
    expect(lines[0]).toContain("product_title");
    expect(lines[0]).toContain("variant_sku");
    expect(lines[0]).toContain("variant_price");
    // Second line should be the example row
    expect(lines[1]).toContain("Example Product");
  });
});

// ── Import ────────────────────────────────────────────────────────────────────

describe("CSV import", () => {
  const csvWithTwoProducts = `product_title,product_slug,product_type,product_status,product_vendor,product_description,product_tags,product_seo_title,product_seo_desc,variant_sku,variant_title,variant_price,variant_compare_at_price,variant_cost_price,variant_weight_g,variant_track_inventory,variant_allow_backorder,option_values,inventory_quantity
"Red Widget",red-widget,simple,active,Brand A,"A red widget","widgets;sale",,,"RW-001",Default,15.99,,8.00,200,true,false,,25
"Blue Widget",blue-widget,simple,draft,Brand B,"A blue widget","widgets",,,"BW-001",Default,19.99,,10.00,300,true,false,,10
`;

  it("imports two products from raw CSV body", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/products/import`,
      body: csvWithTwoProducts,
      headers: { ...authHeader, "content-type": "text/csv" },
    });
    expect(res.status).toBe(200);
    const body = res.json as {
      created: number;
      updated: number;
      skipped: number;
      rows: unknown[];
      errors: unknown[];
    };
    expect(body.created).toBe(2);
    expect(body.updated).toBe(0);
    expect(body.errors.length).toBe(0);

    // Verify products exist in DB
    const { rows: productRows } = await ctx.pool.query(
      `SELECT count(*) FROM products WHERE store_id = $1::uuid AND slug IN ('red-widget','blue-widget')`,
      [storeId]
    );
    expect(Number(productRows[0]?.count)).toBe(2);
  });

  it("dry_run=true validates without creating", async () => {
    const dryRunCsv = `product_title,product_slug,product_type,product_status,product_vendor,product_description,product_tags,product_seo_title,product_seo_desc,variant_sku,variant_title,variant_price,variant_compare_at_price,variant_cost_price,variant_weight_g,variant_track_inventory,variant_allow_backorder,option_values,inventory_quantity
"Dry Product",dry-product-${Date.now()},simple,draft,,,,,,DR-001,Default,9.99,,,,true,false,,5
`;
    const before = await ctx.pool.query(
      `SELECT count(*) FROM products WHERE store_id = $1::uuid AND slug LIKE 'dry-product%'`,
      [storeId]
    );
    const beforeCount = Number(before.rows[0]?.count);

    const res = await ctx.request({
      method: "POST",
      path: `${base()}/products/import?dry_run=true`,
      body: dryRunCsv,
      headers: { ...authHeader, "content-type": "text/csv" },
    });
    expect(res.status).toBe(200);
    const body = res.json as { dry_run: boolean; created: number };
    expect(body.dry_run).toBe(true);
    expect(body.created).toBe(1); // would create 1

    // Should NOT have created in DB
    const after = await ctx.pool.query(
      `SELECT count(*) FROM products WHERE store_id = $1::uuid AND slug LIKE 'dry-product%'`,
      [storeId]
    );
    expect(Number(after.rows[0]?.count)).toBe(beforeCount);
  });

  it("partial errors: one bad row does not abort batch", async () => {
    const mixedCsv = `product_title,product_slug,product_type,product_status,product_vendor,product_description,product_tags,product_seo_title,product_seo_desc,variant_sku,variant_title,variant_price,variant_compare_at_price,variant_cost_price,variant_weight_g,variant_track_inventory,variant_allow_backorder,option_values,inventory_quantity
,empty-title,simple,draft,,,,,,BAD-001,Default,not-a-price,,,,true,false,,0
"Good Product",good-product-${Date.now()},simple,draft,,,,,,GP-001,Default,5.00,,,,true,false,,10
`;
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/products/import`,
      body: mixedCsv,
      headers: { ...authHeader, "content-type": "text/csv" },
    });
    expect(res.status).toBe(200);
    const body = res.json as {
      created: number;
      updated: number;
      skipped: number;
      errors: Array<{ row: number; error: string }>;
    };
    // Row 1 (product_title empty) should be skipped with an error
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    // Row 2 (Good Product) should succeed
    expect(body.created).toBeGreaterThanOrEqual(1);
  });

  it("re-import same CSV updates existing rows (upsert)", async () => {
    // Import once
    const slug = `upsert-test-${Date.now()}`;
    const csv1 = `product_title,product_slug,product_type,product_status,product_vendor,product_description,product_tags,product_seo_title,product_seo_desc,variant_sku,variant_title,variant_price,variant_compare_at_price,variant_cost_price,variant_weight_g,variant_track_inventory,variant_allow_backorder,option_values,inventory_quantity
"Upsert Product",${slug},simple,draft,,,,,,UP-001,Default,10.00,,,,true,false,,5
`;
    const res1 = await ctx.request({
      method: "POST",
      path: `${base()}/products/import`,
      body: csv1,
      headers: { ...authHeader, "content-type": "text/csv" },
    });
    expect(res1.status).toBe(200);
    const body1 = res1.json as { created: number };
    expect(body1.created).toBe(1);

    // Re-import with updated price
    const csv2 = `product_title,product_slug,product_type,product_status,product_vendor,product_description,product_tags,product_seo_title,product_seo_desc,variant_sku,variant_title,variant_price,variant_compare_at_price,variant_cost_price,variant_weight_g,variant_track_inventory,variant_allow_backorder,option_values,inventory_quantity
"Upsert Product",${slug},simple,active,,,,,,UP-001,Default,12.50,,,,true,false,,8
`;
    const res2 = await ctx.request({
      method: "POST",
      path: `${base()}/products/import`,
      body: csv2,
      headers: { ...authHeader, "content-type": "text/csv" },
    });
    expect(res2.status).toBe(200);
    const body2 = res2.json as { created: number; updated: number };
    expect(body2.updated).toBe(1);
    expect(body2.created).toBe(0);

    // Verify updated price in DB
    const { rows: vRows } = await ctx.pool.query(
      `SELECT v.price::text FROM product_variants v
       JOIN products p ON p.id = v.product_id
       WHERE p.store_id = $1::uuid AND v.sku = 'UP-001'`,
      [storeId]
    );
    expect(vRows[0]?.price).toBe("12.50");
  });

  it("rejects empty CSV body", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/products/import`,
      body: "   ",
      headers: { ...authHeader, "content-type": "text/csv" },
    });
    expect(res.status).toBe(400);
  });
});

// ── Export ────────────────────────────────────────────────────────────────────

describe("CSV export", () => {
  it("GET /products/export.csv returns text/csv with headers", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/products/export.csv`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const text = typeof res.body === "string" ? res.body : String(res.body);
    const firstLine = text.split(/\r?\n/)[0]!;
    expect(firstLine).toContain("product_title");
    expect(firstLine).toContain("variant_sku");
    expect(firstLine).toContain("variant_price");
  });

  it("export roundtrip: seed → export → import into store2 → same product count", async () => {
    // Seed two products with variants into storeId
    const t = Date.now();
    await ctx.pool.query(
      `INSERT INTO products (store_id, title, slug, status)
       VALUES ($1::uuid, 'Roundtrip Alpha', 'rt-alpha-${t}', 'active'),
              ($1::uuid, 'Roundtrip Beta',  'rt-beta-${t}',  'active')`,
      [storeId]
    );
    // Add variants with SKUs
    const { rows: prods } = await ctx.pool.query<{ id: string }>(
      `SELECT id::text FROM products WHERE store_id = $1::uuid AND slug IN ('rt-alpha-${t}', 'rt-beta-${t}')`,
      [storeId]
    );
    for (const p of prods) {
      await ctx.pool.query(
        `INSERT INTO product_variants (product_id, sku, title, price)
         VALUES ($1::uuid, 'RT-SKU-${p.id.slice(0,8)}', 'Default', 20.00)`,
        [p.id]
      );
    }

    // Export from storeId
    const exportRes = await ctx.request({
      method: "GET",
      path: `${base()}/products/export.csv`,
      headers: authHeader,
    });
    expect(exportRes.status).toBe(200);
    const csvText = typeof exportRes.body === "string" ? exportRes.body : String(exportRes.body);
    expect(csvText).toContain("Roundtrip Alpha");
    expect(csvText).toContain("Roundtrip Beta");

    // Count products exported
    const parsedRows = parseCsv(csvText);
    // The export has one row per variant; count unique product_slugs for the two we added
    const rtSlugs = parsedRows.filter(
      (r) => r["product_slug"] === `rt-alpha-${t}` || r["product_slug"] === `rt-beta-${t}`
    );
    expect(rtSlugs.length).toBeGreaterThanOrEqual(2);

    // Import only our two products into store2
    const filteredCsv =
      CSV_HEADERS.join(",") +
      "\r\n" +
      rtSlugs
        .map((r) => CSV_HEADERS.map((h) => csvCell(r[h])).join(","))
        .join("\r\n") +
      "\r\n";

    const importRes = await ctx.request({
      method: "POST",
      path: `${base(storeId2)}/products/import`,
      body: filteredCsv,
      headers: {
        ...authHeader,
        "content-type": "text/csv",
      },
    });
    expect(importRes.status).toBe(200);
    const importBody = importRes.json as { created: number; errors: unknown[] };
    expect(importBody.created).toBe(2);
    expect(importBody.errors.length).toBe(0);

    // Verify store2 now has the same 2 products
    const { rows: store2Prods } = await ctx.pool.query(
      `SELECT count(*) FROM products WHERE store_id = $1::uuid AND slug IN ('rt-alpha-${t}', 'rt-beta-${t}')`,
      [storeId2]
    );
    expect(Number(store2Prods[0]?.count)).toBe(2);
  });
});
