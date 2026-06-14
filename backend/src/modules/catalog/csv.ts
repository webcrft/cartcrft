/**
 * catalog/csv.ts — CSV product import/export utilities.
 *
 * No external dependencies — tiny RFC4180-compliant serialiser/parser.
 *
 * CSV shape (one row per variant):
 *
 *   product_title, product_slug, product_type, product_status, product_vendor,
 *   product_description, product_tags, product_seo_title, product_seo_desc,
 *   variant_sku, variant_title, variant_price, variant_compare_at_price,
 *   variant_cost_price, variant_weight_g, variant_track_inventory,
 *   variant_allow_backorder, option_values, inventory_quantity
 *
 * option_values — pipe-separated option:value pairs for a variant, e.g.
 *   "Color:Red|Size:M"
 *
 * product_tags — semicolon-separated list, e.g. "apparel;sale"
 *
 * Import semantics:
 *   - Upsert by variant_sku (if provided), else by product_slug + variant_title.
 *   - On product rows (same slug): if the product exists, update it; else create.
 *   - Inventory upserted into the store's default warehouse.
 *   - dry_run=true — validate rows and return results without persisting.
 *
 * Export semantics:
 *   - One row per variant (all variants). Products with no variants get one
 *     row with blank variant fields.
 *   - Inventory quantity: sum of quantity_available across all warehouses
 *     (mirrors default-warehouse intent without requiring warehouse selection
 *     at export time — import will upsert into the first/default warehouse).
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import type pg from "pg";

// ── RFC4180 CSV ───────────────────────────────────────────────────────────────

export const CSV_HEADERS = [
  "product_title",
  "product_slug",
  "product_type",
  "product_status",
  "product_vendor",
  "product_description",
  "product_tags",
  "product_seo_title",
  "product_seo_desc",
  "variant_sku",
  "variant_title",
  "variant_price",
  "variant_compare_at_price",
  "variant_cost_price",
  "variant_weight_g",
  "variant_track_inventory",
  "variant_allow_backorder",
  "option_values",
  "inventory_quantity",
] as const;

export type CsvHeader = (typeof CSV_HEADERS)[number];

/** Escape a single CSV cell per RFC4180. */
export function csvCell(v: string | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Needs quoting if contains comma, double-quote, newline, or carriage return
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize rows to a CSV string (with header). */
export function serializeCsv(rows: Record<string, string | null>[]): string {
  const header = CSV_HEADERS.join(",");
  const lines = rows.map((row) =>
    CSV_HEADERS.map((h) => csvCell(row[h])).join(",")
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}

/** Parse CSV text → array of row objects keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  const lines = splitCsvLines(normalized);
  if (lines.length < 1) return [];

  const rawHeaders = parseCsvLine(lines[0]!).map((h) =>
    h.trim().toLowerCase()
  );
  if (rawHeaders.length === 0) return [];

  return lines
    .slice(1)
    .filter((l) => l.trim() !== "")
    .map((line) => {
      const values = parseCsvLine(line);
      const row: Record<string, string> = {};
      rawHeaders.forEach((h, i) => {
        row[h] = values[i] ?? "";
      });
      return row;
    });
}

/**
 * Split CSV text into lines, honouring quoted fields that may contain newlines.
 * Returns an array of raw line strings (multi-line fields are joined back).
 *
 * IMPORTANT: this function passes through all characters unmodified — it only
 * tracks whether we are inside a quoted field to decide if a newline is a
 * record separator or part of a field value.  Escape-sequence decoding
 * (`""` → `"`) is performed later by parseCsvLine.
 */
function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        // Escaped double-quote inside a quoted field — consume both chars and
        // stay in quoted mode.  Pass them through raw for parseCsvLine to decode.
        current += '""';
        i++;
      } else {
        // Opening or closing quote
        inQuotes = !inQuotes;
        current += ch;
      }
    } else if (ch === "\n" && !inQuotes) {
      lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Parse a single CSV line → array of unescaped field values. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped double-quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── Export ────────────────────────────────────────────────────────────────────

interface ExportRow {
  product_title: string;
  product_slug: string;
  product_type: string;
  product_status: string;
  product_vendor: string;
  product_description: string;
  product_tags: string;
  product_seo_title: string;
  product_seo_desc: string;
  variant_sku: string;
  variant_title: string;
  variant_price: string;
  variant_compare_at_price: string;
  variant_cost_price: string;
  variant_weight_g: string;
  variant_track_inventory: string;
  variant_allow_backorder: string;
  option_values: string;
  inventory_quantity: string;
}

export async function exportProductsCsv(storeId: string): Promise<string> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();

  // One row per variant; products with no variants get a placeholder row.
  const { rows } = await pool.query<ExportRow>(
    `SELECT
       p.title                                  AS product_title,
       p.slug                                   AS product_slug,
       p.type                                   AS product_type,
       p.status                                 AS product_status,
       COALESCE(p.vendor, '')                   AS product_vendor,
       COALESCE(p.description, '')              AS product_description,
       COALESCE(
         (SELECT string_agg(pt.tag, ';' ORDER BY pt.tag)
          FROM product_tags pt WHERE pt.product_id = p.id),
         ''
       )                                        AS product_tags,
       COALESCE(p.seo_title, '')                AS product_seo_title,
       COALESCE(p.seo_desc, '')                 AS product_seo_desc,
       COALESCE(v.sku, '')                      AS variant_sku,
       COALESCE(v.title, '')                    AS variant_title,
       COALESCE(v.price::text, '')              AS variant_price,
       COALESCE(v.compare_at_price::text, '')   AS variant_compare_at_price,
       COALESCE(v.cost_price::text, '')         AS variant_cost_price,
       COALESCE(v.weight_g::text, '0')          AS variant_weight_g,
       COALESCE(v.track_inventory::text, 'true') AS variant_track_inventory,
       COALESCE(v.allow_backorder::text, 'false') AS variant_allow_backorder,
       COALESCE(
         (
           SELECT string_agg(
             po.name || ':' || pov.value,
             '|'
             ORDER BY po.position, pov.position
           )
           FROM variant_option_values vov
           JOIN product_option_values pov ON pov.id = vov.option_value_id
           JOIN product_options po ON po.id = pov.option_id
           WHERE vov.variant_id = v.id
         ),
         ''
       )                                        AS option_values,
       COALESCE(
         (SELECT SUM(il.quantity_on_hand - il.quantity_committed)
          FROM inventory_levels il
          WHERE il.variant_id = v.id)::text,
         '0'
       )                                        AS inventory_quantity
     FROM products p
     LEFT JOIN product_variants v ON v.product_id = p.id
     WHERE p.store_id = $1::uuid
     ORDER BY p.created_at, v.position, v.created_at`,
    [storeId]
  );

  return serializeCsv(rows as unknown as Record<string, string | null>[]);
}

// ── Import ────────────────────────────────────────────────────────────────────

export interface ImportRowResult {
  row: number;
  product_title: string;
  action: "created" | "updated" | "skipped";
  error?: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowResult[];
  rows: ImportRowResult[];
}

/**
 * importProductsCsv — parse CSV text and upsert products/variants/inventory.
 *
 * Upsert logic:
 *  1. Group consecutive rows by product_slug to detect multi-variant products.
 *  2. For each product group: upsert the product (ON CONFLICT slug DO UPDATE).
 *  3. For each variant row: if variant_sku is set, upsert by sku; else upsert
 *     by (product_id, title).
 *  4. Inventory: upsert into the store's first warehouse.
 *
 * Returns per-row results. dry_run=true returns results without DB writes.
 */
export async function importProductsCsv(
  storeId: string,
  csvText: string,
  opts: { dryRun?: boolean } = {}
): Promise<ImportResult> {
  const dryRun = opts.dryRun ?? false;
  const parsedRows = parseCsv(csvText);

  const result: ImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    rows: [],
  };

  if (parsedRows.length === 0) {
    return result;
  }

  // Validate rows first
  const validatedRows: Array<{
    rowNum: number;
    data: Record<string, string>;
    error?: string;
  }> = parsedRows.map((row, i) => {
    const title = (row["product_title"] ?? "").trim();
    const price = (row["variant_price"] ?? "").trim();

    if (!title) {
      return { rowNum: i + 2, data: row, error: "product_title is required" };
    }
    if (price && isNaN(parseFloat(price))) {
      return {
        rowNum: i + 2,
        data: row,
        error: `invalid variant_price: ${price}`,
      };
    }
    if (
      row["variant_compare_at_price"] &&
      row["variant_compare_at_price"].trim() !== "" &&
      isNaN(parseFloat(row["variant_compare_at_price"]))
    ) {
      return {
        rowNum: i + 2,
        data: row,
        error: `invalid variant_compare_at_price: ${row["variant_compare_at_price"]}`,
      };
    }
    return { rowNum: i + 2, data: row };
  });

  if (dryRun) {
    for (const v of validatedRows) {
      if (v.error) {
        result.errors.push({
          row: v.rowNum,
          product_title: (v.data["product_title"] ?? "").trim(),
          action: "skipped",
          error: v.error,
        });
        result.skipped++;
      } else {
        result.rows.push({
          row: v.rowNum,
          product_title: (v.data["product_title"] ?? "").trim(),
          action: "created", // dry-run: would create
        });
        result.created++;
      }
    }
    return result;
  }

  const pool = getPool();

  // Find the default warehouse (first by created_at)
  const { rows: wRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM warehouses WHERE store_id = $1::uuid ORDER BY created_at LIMIT 1`,
    [storeId]
  );
  const warehouseId = wRows[0]?.id ?? null;

  // Process each row individually — partial failures don't abort the batch.
  for (const v of validatedRows) {
    if (v.error) {
      result.errors.push({
        row: v.rowNum,
        product_title: (v.data["product_title"] ?? "").trim(),
        action: "skipped",
        error: v.error,
      });
      result.skipped++;
      continue;
    }

    try {
      const rowResult = await importSingleRow(pool, storeId, v.data, warehouseId);
      result.rows.push({ row: v.rowNum, ...rowResult });
      if (rowResult.action === "created") result.created++;
      else if (rowResult.action === "updated") result.updated++;
      else result.skipped++;
    } catch (err) {
      result.errors.push({
        row: v.rowNum,
        product_title: (v.data["product_title"] ?? "").trim(),
        action: "skipped",
        error: err instanceof Error ? err.message : String(err),
      });
      result.skipped++;
    }
  }

  return result;
}

// ── Import single row ─────────────────────────────────────────────────────────

async function importSingleRow(
  pool: pg.Pool,
  storeId: string,
  row: Record<string, string>,
  warehouseId: string | null
): Promise<{ product_title: string; action: "created" | "updated" }> {
  const productTitle = (row["product_title"] ?? "").trim();
  const productSlug =
    (row["product_slug"] ?? "").trim() ||
    productTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 255);
  const productType = (row["product_type"] ?? "simple").trim() || "simple";
  const productStatus = (row["product_status"] ?? "draft").trim() || "draft";
  const productVendor = (row["product_vendor"] ?? "").trim() || null;
  const productDesc = (row["product_description"] ?? "").trim() || null;
  const productSeoTitle = (row["product_seo_title"] ?? "").trim() || null;
  const productSeoDesc = (row["product_seo_desc"] ?? "").trim() || null;
  const productTagsStr = (row["product_tags"] ?? "").trim();

  const variantSku = (row["variant_sku"] ?? "").trim() || null;
  const variantTitle = (row["variant_title"] ?? "Default").trim() || "Default";
  const variantPriceStr = (row["variant_price"] ?? "0").trim() || "0";
  const variantPrice = parseFloat(variantPriceStr) || 0;
  const variantCompareAtStr = (row["variant_compare_at_price"] ?? "").trim();
  const variantCompareAt =
    variantCompareAtStr !== "" ? parseFloat(variantCompareAtStr) : null;
  const variantCostStr = (row["variant_cost_price"] ?? "").trim();
  const variantCost =
    variantCostStr !== "" ? parseFloat(variantCostStr) : null;
  const variantWeightG = parseInt(row["variant_weight_g"] ?? "0") || 0;
  const variantTrackInventory = (row["variant_track_inventory"] ?? "true").trim() !== "false";
  const variantAllowBackorder = (row["variant_allow_backorder"] ?? "false").trim() === "true";
  const inventoryQty = parseInt(row["inventory_quantity"] ?? "0") || 0;

  return withTx(async (client) => {
    // Upsert product by slug
    // Check if product already exists by store_id + slug
    const { rows: existingPRows } = await client.query<{ id: string }>(
      `SELECT id::text FROM products WHERE store_id = $1::uuid AND slug = $2 LIMIT 1`,
      [storeId, productSlug]
    );
    let productId: string;
    let isNewProduct: boolean;
    if (existingPRows[0]) {
      productId = existingPRows[0].id;
      isNewProduct = false;
      await client.query(
        `UPDATE products SET
           title       = $2,
           type        = $3,
           status      = $4,
           vendor      = COALESCE($5, vendor),
           description = COALESCE($6, description),
           seo_title   = COALESCE($7, seo_title),
           seo_desc    = COALESCE($8, seo_desc),
           updated_at  = now()
         WHERE id = $1::uuid`,
        [productId, productTitle, productType, productStatus, productVendor, productDesc, productSeoTitle, productSeoDesc]
      );
    } else {
      const { rows: pRows } = await client.query<{ id: string }>(
        `INSERT INTO products
           (store_id, title, slug, type, status, vendor, description, seo_title, seo_desc)
         VALUES
           ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id::text`,
        [storeId, productTitle, productSlug, productType, productStatus, productVendor, productDesc, productSeoTitle, productSeoDesc]
      );
      const pRow = pRows[0];
      if (!pRow) throw new Error("product insert returned no row");
      productId = pRow.id;
      isNewProduct = true;
    }

    // Upsert product tags
    if (productTagsStr) {
      const tags = productTagsStr
        .split(";")
        .map((t) => t.trim())
        .filter(Boolean);
      await client.query(
        `DELETE FROM product_tags WHERE product_id = $1::uuid`,
        [productId]
      );
      for (const tag of tags) {
        await client.query(
          `INSERT INTO product_tags (product_id, tag) VALUES ($1::uuid, $2)
           ON CONFLICT DO NOTHING`,
          [productId, tag.toLowerCase()]
        );
      }
    }

    // Upsert variant: by sku if provided, else by (product_id, title)
    let variantId: string;
    let isNewVariant: boolean;

    if (variantSku) {
      // Upsert by SKU: SELECT-then-UPDATE or INSERT (no unique constraint on sku globally)
      const { rows: existSkuRows } = await client.query<{ id: string }>(
        `SELECT id::text FROM product_variants
         WHERE product_id = $1::uuid AND sku = $2 LIMIT 1`,
        [productId, variantSku]
      );
      if (existSkuRows[0]) {
        variantId = existSkuRows[0].id;
        isNewVariant = false;
        await client.query(
          `UPDATE product_variants
           SET title            = $2,
               price            = $3::numeric,
               compare_at_price = COALESCE($4::numeric, compare_at_price),
               cost_price       = COALESCE($5::numeric, cost_price),
               weight_g         = $6,
               track_inventory  = $7,
               allow_backorder  = $8,
               updated_at       = now()
           WHERE id = $1::uuid`,
          [
            variantId,
            variantTitle,
            variantPrice,
            variantCompareAt,
            variantCost,
            variantWeightG,
            variantTrackInventory,
            variantAllowBackorder,
          ]
        );
      } else {
        const { rows: insRows } = await client.query<{ id: string }>(
          `INSERT INTO product_variants
             (product_id, sku, title, price, compare_at_price, cost_price,
              weight_g, track_inventory, allow_backorder)
           VALUES
             ($1::uuid, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7, $8, $9)
           RETURNING id::text`,
          [
            productId,
            variantSku,
            variantTitle,
            variantPrice,
            variantCompareAt,
            variantCost,
            variantWeightG,
            variantTrackInventory,
            variantAllowBackorder,
          ]
        );
        const insRow = insRows[0];
        if (!insRow) throw new Error("variant insert returned no row");
        variantId = insRow.id;
        isNewVariant = true;
      }
    } else {
      // Upsert by (product_id, title): SELECT first, then INSERT or UPDATE.
      const { rows: existVRows } = await client.query<{ id: string }>(
        `SELECT id::text FROM product_variants
         WHERE product_id = $1::uuid AND title = $2 LIMIT 1`,
        [productId, variantTitle]
      );
      if (existVRows[0]) {
        variantId = existVRows[0].id;
        isNewVariant = false;
        await client.query(
          `UPDATE product_variants
           SET price            = $2::numeric,
               compare_at_price = COALESCE($3::numeric, compare_at_price),
               cost_price       = COALESCE($4::numeric, cost_price),
               weight_g         = $5,
               track_inventory  = $6,
               allow_backorder  = $7,
               updated_at       = now()
           WHERE id = $1::uuid`,
          [
            variantId,
            variantPrice,
            variantCompareAt,
            variantCost,
            variantWeightG,
            variantTrackInventory,
            variantAllowBackorder,
          ]
        );
      } else {
        const { rows: insVRows } = await client.query<{ id: string }>(
          `INSERT INTO product_variants
             (product_id, title, price, compare_at_price, cost_price,
              weight_g, track_inventory, allow_backorder)
           VALUES
             ($1::uuid, $2, $3::numeric, $4::numeric, $5::numeric,
              $6, $7, $8)
           RETURNING id::text`,
          [
            productId,
            variantTitle,
            variantPrice,
            variantCompareAt,
            variantCost,
            variantWeightG,
            variantTrackInventory,
            variantAllowBackorder,
          ]
        );
        const insVRow = insVRows[0];
        if (!insVRow) throw new Error("variant insert returned no row");
        variantId = insVRow.id;
        isNewVariant = true;
      }
    }

    // Upsert inventory into the default warehouse (if warehouse exists)
    if (warehouseId && inventoryQty > 0) {
      await client.query(
        `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
         VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (variant_id, warehouse_id)
         DO UPDATE SET quantity_on_hand = EXCLUDED.quantity_on_hand`,
        [variantId, warehouseId, inventoryQty]
      );
    }

    // Determine overall action
    const action: "created" | "updated" =
      isNewProduct && isNewVariant ? "created" : "updated";
    return { product_title: productTitle, action };
  });
}

// ── Template header ───────────────────────────────────────────────────────────

/** Return a CSV template (header row + one example row). */
export function csvTemplateString(): string {
  const exampleRow: Record<string, string | null> = {
    product_title: "Example Product",
    product_slug: "example-product",
    product_type: "simple",
    product_status: "draft",
    product_vendor: "My Brand",
    product_description: "A great product",
    product_tags: "tag1;tag2",
    product_seo_title: "",
    product_seo_desc: "",
    variant_sku: "SKU-001",
    variant_title: "Default",
    variant_price: "99.99",
    variant_compare_at_price: "149.99",
    variant_cost_price: "50.00",
    variant_weight_g: "500",
    variant_track_inventory: "true",
    variant_allow_backorder: "false",
    option_values: "Color:Red|Size:M",
    inventory_quantity: "100",
  };
  return serializeCsv([exampleRow]);
}
