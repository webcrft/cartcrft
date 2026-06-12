/**
 * catalog/service.ts — SQL-backed catalog CRUD service.
 *
 * Covers: products, variants, options, media, bundle items, digital files,
 * reviews, product tags, collections, collection rules, price lists,
 * metafields, metafield definitions, translations.
 *
 * Money: API strings → DB numeric(15,2). SELECT uses price::text.
 * All IDs: id::text in SELECT.
 */

import type pg from "pg";
import { getPool, withTx } from "../../db/pool.js";
import type {
  ProductPublic,
  CreateProductInput,
  UpdateProductInput,
  VariantPublic,
  CreateVariantInput,
  UpdateVariantInput,
  OptionPublic,
  OptionValuePublic,
  OptionWithValues,
  CreateOptionInput,
  MediaPublic,
  AddMediaInput,
  BundleItemPublic,
  AddBundleItemInput,
  UpdateBundleItemInput,
  DigitalFilePublic,
  CreateDigitalFileInput,
  ReviewPublic,
  CreateReviewInput,
  UpdateReviewInput,
  CollectionPublic,
  CreateCollectionInput,
  UpdateCollectionInput,
  CollectionRulePublic,
  AddCollectionRuleInput,
  PriceListPublic,
  CreatePriceListInput,
  UpdatePriceListInput,
  PriceListItemPublic,
  UpsertPriceListItemInput,
  UpdatePriceListItemInput,
  MetafieldPublic,
  UpsertMetafieldInput,
  UpdateMetafieldInput,
  MetafieldDefinitionPublic,
  CreateMetafieldDefinitionInput,
  UpdateMetafieldDefinitionInput,
  TranslationResourceType,
  TranslationPublic,
  UpsertTranslationInput,
  RuleField,
  RuleRelation,
} from "./types.js";

// ── Slug helper ───────────────────────────────────────────────────────────────

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

// ── Duplicate error helper ─────────────────────────────────────────────────────

function throwDuplicateSlug(msg: string): never {
  const e = new Error(msg);
  (e as NodeJS.ErrnoException).code = "DUPLICATE_SLUG";
  throw e;
}

function isDuplicateError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.includes("unique") ||
      err.message.includes("duplicate") ||
      // postgres unique_violation sqlstate
      ("code" in err && (err as NodeJS.ErrnoException).code === "23505"))
  );
}

// ── Products ──────────────────────────────────────────────────────────────────

const PRODUCT_COLS = `
  p.id::text,
  p.store_id::text,
  p.title,
  p.slug,
  p.description,
  p.type,
  p.status,
  p.vendor,
  p.seo_title,
  p.seo_desc,
  p.metadata,
  p.created_at,
  p.updated_at
`;

export async function listProducts(
  storeId: string,
  opts: {
    status?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
): Promise<ProductPublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const params: unknown[] = [storeId];
  let statusClause = "";
  if (opts.status) {
    params.push(opts.status);
    statusClause = ` AND p.status = $${params.length}`;
  }
  params.push(limit, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const query = `
    SELECT ${PRODUCT_COLS},
      COALESCE(
        json_agg(DISTINCT jsonb_build_object(
          'id', m.id::text, 'product_id', m.product_id::text,
          'variant_id', m.variant_id::text, 'url', m.url,
          'cdn_url', m.cdn_url, 'type', m.type,
          'alt_text', m.alt_text, 'position', m.position,
          'created_at', m.created_at
        )) FILTER (WHERE m.id IS NOT NULL), '[]'
      ) AS media
    FROM products p
    LEFT JOIN product_media m ON m.product_id = p.id
    WHERE p.store_id = $1::uuid${statusClause}
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `;

  const { rows } = await pool.query(query, params);
  return rows as ProductPublic[];
}

export async function getProduct(
  storeId: string,
  productId: string
): Promise<ProductPublic | null> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLS}
     FROM products p
     WHERE p.id = $1::uuid AND p.store_id = $2::uuid`,
    [productId, storeId]
  );
  if (!rows[0]) return null;
  const product = rows[0] as ProductPublic;

  // Fetch variants
  const varRes = await pool.query(
    `SELECT
      id::text, product_id::text, sku, barcode, title,
      price::text, compare_at_price::text, cost_price::text,
      weight_g::text, requires_shipping, is_taxable, track_inventory,
      allow_backorder, position, is_active, metadata, created_at, updated_at
     FROM product_variants
     WHERE product_id = $1::uuid
     ORDER BY position, created_at`,
    [productId]
  );
  product.variants = varRes.rows as VariantPublic[];

  // Fetch options with values (product_options has no created_at/updated_at)
  const optRes = await pool.query(
    `SELECT
      o.id::text, o.product_id::text, o.name, o.position,
      COALESCE(
        json_agg(jsonb_build_object(
          'id', ov.id::text, 'option_id', ov.option_id::text,
          'value', ov.value, 'position', ov.position
        ) ORDER BY ov.position) FILTER (WHERE ov.id IS NOT NULL),
        '[]'
      ) AS values
     FROM product_options o
     LEFT JOIN product_option_values ov ON ov.option_id = o.id
     WHERE o.product_id = $1::uuid
     GROUP BY o.id
     ORDER BY o.position`,
    [productId]
  );
  product.options = optRes.rows as OptionWithValues[];

  // Fetch media (product_media has no updated_at)
  const medRes = await pool.query(
    `SELECT
      id::text, product_id::text, variant_id::text, url, cdn_url, type,
      alt_text, position, created_at
     FROM product_media
     WHERE product_id = $1::uuid
     ORDER BY position, created_at`,
    [productId]
  );
  product.media = medRes.rows as MediaPublic[];

  // Fetch bundle items
  const bRes = await pool.query(
    `SELECT id::text, product_id::text, variant_id::text, quantity, is_optional, position
     FROM product_bundle_items
     WHERE product_id = $1::uuid
     ORDER BY position, id`,
    [productId]
  );
  product.bundle_items = bRes.rows as BundleItemPublic[];

  return product;
}

export async function createProduct(
  storeId: string,
  input: CreateProductInput
): Promise<string> {
  return withTx(async (client) => {
    const title = input.title.trim();
    const slug = (input.slug?.trim() || slugify(title)).slice(0, 255);
    const type = input.type ?? "simple";
    const status = input.status ?? "draft";

    let productId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO products
           (store_id, title, slug, description, type, status,
            vendor, seo_title, seo_desc, metadata)
         VALUES
           ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id::text`,
        [
          storeId,
          title,
          slug,
          input.description ?? null,
          type,
          status,
          input.vendor ?? null,
          input.seo_title ?? null,
          input.seo_desc ?? null,
          JSON.stringify(input.metadata ?? {}),
        ]
      );
      const row = rows[0];
      if (!row) throw new Error("createProduct: no row returned");
      productId = row.id;
    } catch (err) {
      if (isDuplicateError(err)) {
        throwDuplicateSlug("a product with that slug already exists in this store");
      }
      throw err;
    }

    // Auto-create default variant if price provided
    if (input.price !== undefined) {
      await client.query(
        `INSERT INTO product_variants (product_id, title, price, weight_g, metadata)
         VALUES ($1::uuid, 'Default', $2::numeric, 0, '{}')`,
        [productId, input.price]
      );
    }

    // Auto-attach media if images provided
    if (input.images && input.images.length > 0) {
      for (let i = 0; i < input.images.length; i++) {
        await client.query(
          `INSERT INTO product_media (product_id, url, type, position)
           VALUES ($1::uuid, $2, 'image', $3)`,
          [productId, input.images[i], i]
        );
      }
    }

    return productId;
  });
}

export async function updateProduct(
  storeId: string,
  productId: string,
  input: UpdateProductInput
): Promise<boolean> {
  const pool = getPool();

  // Check slug uniqueness before update if slug is changing
  if (input.slug !== undefined) {
    const { rows: existRows } = await pool.query(
      `SELECT id::text FROM products
       WHERE store_id = $1::uuid AND slug = $2 AND id != $3::uuid`,
      [storeId, input.slug, productId]
    );
    if (existRows.length > 0) {
      throwDuplicateSlug("a product with that slug already exists in this store");
    }
  }

  const { rowCount } = await pool.query(
    `UPDATE products SET
       title       = COALESCE($3, title),
       slug        = COALESCE($4, slug),
       description = COALESCE($5, description),
       type        = COALESCE($6, type),
       status      = COALESCE($7, status),
       vendor      = COALESCE($8, vendor),
       seo_title   = COALESCE($9, seo_title),
       seo_desc    = COALESCE($10, seo_desc),
       metadata    = COALESCE($11, metadata),
       updated_at  = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      productId,
      storeId,
      input.title ?? null,
      input.slug ?? null,
      input.description ?? null,
      input.type ?? null,
      input.status ?? null,
      input.vendor ?? null,
      input.seo_title ?? null,
      input.seo_desc ?? null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteProduct(
  storeId: string,
  productId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
    [productId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Variants ──────────────────────────────────────────────────────────────────

export async function listVariants(
  storeId: string,
  productId: string
): Promise<VariantPublic[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
      v.id::text, v.product_id::text, v.sku, v.barcode, v.title,
      v.price::text, v.compare_at_price::text, v.cost_price::text,
      v.weight_g::text, v.requires_shipping, v.is_taxable, v.track_inventory,
      v.allow_backorder, v.position, v.is_active, v.metadata, v.created_at, v.updated_at
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.product_id = $1::uuid AND p.store_id = $2::uuid
     ORDER BY v.position, v.created_at`,
    [productId, storeId]
  );
  return rows as VariantPublic[];
}

export async function createVariant(
  storeId: string,
  productId: string,
  input: CreateVariantInput
): Promise<string> {
  const pool = getPool();

  // Verify product belongs to store
  const { rows: pRows } = await pool.query(
    `SELECT id FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
    [productId, storeId]
  );
  if (!pRows[0]) throw Object.assign(new Error("product not found"), { code: "NOT_FOUND" });

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO product_variants
       (product_id, sku, barcode, title, price, compare_at_price, cost_price,
        weight_g, requires_shipping, is_taxable, track_inventory, allow_backorder,
        position, is_active, metadata)
     VALUES
       ($1::uuid, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric,
        $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id::text`,
    [
      productId,
      input.sku ?? null,
      input.barcode ?? null,
      input.title ?? "Default",
      input.price,
      input.compare_at_price ?? null,
      input.cost_price ?? null,
      input.weight_g ?? 0,
      input.requires_shipping ?? true,
      input.is_taxable ?? true,
      input.track_inventory ?? true,
      input.allow_backorder ?? false,
      input.position ?? 0,
      input.is_active ?? true,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("createVariant: no row returned");

  // Seed inventory in default warehouse if inventory_quantity provided
  if (input.inventory_quantity !== undefined && input.inventory_quantity > 0) {
    // Find the default warehouse for the store
    const { rows: wRows } = await pool.query<{ id: string }>(
      `SELECT id::text FROM warehouses WHERE store_id = $1::uuid ORDER BY created_at LIMIT 1`,
      [storeId]
    );
    if (wRows[0]) {
      await pool.query(
        `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_available)
         VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET quantity_available = EXCLUDED.quantity_available`,
        [row.id, wRows[0].id, input.inventory_quantity]
      );
    }
  }

  return row.id;
}

export async function updateVariant(
  storeId: string,
  productId: string,
  variantId: string,
  input: UpdateVariantInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE product_variants v SET
       sku              = COALESCE($4, v.sku),
       barcode          = COALESCE($5, v.barcode),
       title            = COALESCE($6, v.title),
       price            = COALESCE($7::numeric, v.price),
       compare_at_price = COALESCE($8::numeric, v.compare_at_price),
       cost_price       = COALESCE($9::numeric, v.cost_price),
       weight_g         = COALESCE($10, v.weight_g),
       requires_shipping= COALESCE($11, v.requires_shipping),
       is_taxable       = COALESCE($12, v.is_taxable),
       track_inventory  = COALESCE($13, v.track_inventory),
       allow_backorder  = COALESCE($14, v.allow_backorder),
       position         = COALESCE($15, v.position),
       is_active        = COALESCE($16, v.is_active),
       metadata         = COALESCE($17, v.metadata),
       updated_at       = now()
     FROM products p
     WHERE v.id = $1::uuid
       AND v.product_id = $2::uuid
       AND p.id = v.product_id
       AND p.store_id = $3::uuid`,
    [
      variantId,
      productId,
      storeId,
      input.sku ?? null,
      input.barcode ?? null,
      input.title ?? null,
      input.price ?? null,
      input.compare_at_price ?? null,
      input.cost_price ?? null,
      input.weight_g ?? null,
      input.requires_shipping ?? null,
      input.is_taxable ?? null,
      input.track_inventory ?? null,
      input.allow_backorder ?? null,
      input.position ?? null,
      input.is_active ?? null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteVariant(
  storeId: string,
  productId: string,
  variantId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM product_variants v
     USING products p
     WHERE v.id = $1::uuid
       AND v.product_id = $2::uuid
       AND p.id = v.product_id
       AND p.store_id = $3::uuid`,
    [variantId, productId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Options ───────────────────────────────────────────────────────────────────

export async function listOptions(
  storeId: string,
  productId: string
): Promise<OptionWithValues[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
      o.id::text, o.product_id::text, o.name, o.position,
      COALESCE(
        json_agg(jsonb_build_object(
          'id', ov.id::text, 'option_id', ov.option_id::text,
          'value', ov.value, 'position', ov.position
        ) ORDER BY ov.position) FILTER (WHERE ov.id IS NOT NULL),
        '[]'
      ) AS values
     FROM product_options o
     LEFT JOIN product_option_values ov ON ov.option_id = o.id
     JOIN products p ON p.id = o.product_id
     WHERE o.product_id = $1::uuid AND p.store_id = $2::uuid
     GROUP BY o.id
     ORDER BY o.position`,
    [productId, storeId]
  );
  return rows as OptionWithValues[];
}

export async function createOption(
  storeId: string,
  productId: string,
  input: CreateOptionInput
): Promise<string> {
  return withTx(async (client) => {
    // Verify product belongs to store
    const { rows: pRows } = await client.query(
      `SELECT id FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
      [productId, storeId]
    );
    if (!pRows[0]) throw Object.assign(new Error("product not found"), { code: "NOT_FOUND" });

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO product_options (product_id, name, position)
       VALUES ($1::uuid, $2, $3)
       RETURNING id::text`,
      [productId, input.name, input.position ?? 0]
    );
    const row = rows[0];
    if (!row) throw new Error("createOption: no row returned");
    const optionId = row.id;

    // Insert values in same transaction
    if (input.values && input.values.length > 0) {
      for (let i = 0; i < input.values.length; i++) {
        await client.query(
          `INSERT INTO product_option_values (option_id, value, position)
           VALUES ($1::uuid, $2, $3)`,
          [optionId, input.values[i], i]
        );
      }
    }

    return optionId;
  });
}

export async function deleteOption(
  storeId: string,
  productId: string,
  optionId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM product_options o
     USING products p
     WHERE o.id = $1::uuid
       AND o.product_id = $2::uuid
       AND p.id = o.product_id
       AND p.store_id = $3::uuid`,
    [optionId, productId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Media ─────────────────────────────────────────────────────────────────────

export async function addMedia(
  storeId: string,
  productId: string,
  input: AddMediaInput
): Promise<string> {
  const pool = getPool();

  // Verify product belongs to store
  const { rows: pRows } = await pool.query(
    `SELECT id FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
    [productId, storeId]
  );
  if (!pRows[0]) throw Object.assign(new Error("product not found"), { code: "NOT_FOUND" });

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO product_media (product_id, variant_id, url, type, alt_text, position)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
     RETURNING id::text`,
    [
      productId,
      input.variant_id ?? null,
      input.url,
      input.type ?? "image",
      input.alt_text ?? null,
      input.position ?? 0,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("addMedia: no row returned");
  return row.id;
}

export async function deleteMedia(
  storeId: string,
  productId: string,
  mediaId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM product_media m
     USING products p
     WHERE m.id = $1::uuid
       AND m.product_id = $2::uuid
       AND p.id = m.product_id
       AND p.store_id = $3::uuid`,
    [mediaId, productId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Bundle items ──────────────────────────────────────────────────────────────

export async function listBundleItems(
  storeId: string,
  productId: string
): Promise<BundleItemPublic[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT bi.id::text, bi.product_id::text, bi.variant_id::text,
            bi.quantity, bi.is_optional, bi.position
     FROM product_bundle_items bi
     JOIN products p ON p.id = bi.product_id
     WHERE bi.product_id = $1::uuid AND p.store_id = $2::uuid
     ORDER BY bi.position, bi.id`,
    [productId, storeId]
  );
  return rows as BundleItemPublic[];
}

export async function addBundleItem(
  storeId: string,
  productId: string,
  input: AddBundleItemInput
): Promise<string> {
  const pool = getPool();
  const { rows: pRows } = await pool.query(
    `SELECT id FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
    [productId, storeId]
  );
  if (!pRows[0]) throw Object.assign(new Error("product not found"), { code: "NOT_FOUND" });

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO product_bundle_items (product_id, variant_id, quantity, is_optional, position)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)
     RETURNING id::text`,
    [
      productId,
      input.variant_id,
      input.quantity ?? 1,
      input.is_optional ?? false,
      input.position ?? 0,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("addBundleItem: no row returned");
  return row.id;
}

export async function updateBundleItem(
  storeId: string,
  productId: string,
  itemId: string,
  input: UpdateBundleItemInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE product_bundle_items bi SET
       quantity    = COALESCE($4, bi.quantity),
       is_optional = COALESCE($5, bi.is_optional),
       position    = COALESCE($6, bi.position)
     FROM products p
     WHERE bi.id = $1::uuid
       AND bi.product_id = $2::uuid
       AND p.id = bi.product_id
       AND p.store_id = $3::uuid`,
    [
      itemId,
      productId,
      storeId,
      input.quantity ?? null,
      input.is_optional ?? null,
      input.position ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteBundleItem(
  storeId: string,
  productId: string,
  itemId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM product_bundle_items bi
     USING products p
     WHERE bi.id = $1::uuid
       AND bi.product_id = $2::uuid
       AND p.id = bi.product_id
       AND p.store_id = $3::uuid`,
    [itemId, productId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Digital files ─────────────────────────────────────────────────────────────

export async function listDigitalFiles(
  storeId: string,
  productId: string
): Promise<DigitalFilePublic[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT
      id::text, store_id::text, product_id::text, variant_id::text,
      name, file_url, file_size::text, mime_type, version,
      download_limit, is_active, created_at, updated_at
     FROM digital_product_files
     WHERE product_id = $1::uuid AND store_id = $2::uuid
     ORDER BY created_at`,
    [productId, storeId]
  );
  return rows as DigitalFilePublic[];
}

export async function createDigitalFile(
  storeId: string,
  productId: string,
  input: CreateDigitalFileInput
): Promise<string> {
  const pool = getPool();
  const { rows: pRows } = await pool.query(
    `SELECT id FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
    [productId, storeId]
  );
  if (!pRows[0]) throw Object.assign(new Error("product not found"), { code: "NOT_FOUND" });

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO digital_product_files
       (store_id, product_id, variant_id, name, file_url, file_size, mime_type, version, download_limit, is_active)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id::text`,
    [
      storeId,
      productId,
      input.variant_id ?? null,
      input.name,
      input.file_url,
      input.file_size ?? null,
      input.mime_type ?? null,
      input.version ?? null,
      input.download_limit ?? null,
      input.is_active ?? true,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("createDigitalFile: no row returned");
  return row.id;
}

export async function deleteDigitalFile(
  storeId: string,
  productId: string,
  fileId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM digital_product_files
     WHERE id = $1::uuid AND product_id = $2::uuid AND store_id = $3::uuid`,
    [fileId, productId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function listReviews(
  storeId: string,
  productId: string,
  opts: { status?: string | undefined; limit?: number | undefined; offset?: number | undefined } = {}
): Promise<ReviewPublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;
  const status = opts.status ?? "approved";

  const { rows } = await pool.query(
    `SELECT
      id::text, store_id::text, product_id::text, customer_id::text,
      order_id::text, rating, title, body, reviewer_name, reviewer_email,
      status, is_verified_purchase, helpful_count, media_urls, reply,
      replied_at, published_at, created_at, updated_at
     FROM product_reviews
     WHERE product_id = $1::uuid AND store_id = $2::uuid AND status = $3
     ORDER BY created_at DESC
     LIMIT $4 OFFSET $5`,
    [productId, storeId, status, limit, offset]
  );
  return rows as ReviewPublic[];
}

export async function createReview(
  storeId: string,
  productId: string,
  input: CreateReviewInput
): Promise<string> {
  const pool = getPool();
  const { rows: pRows } = await pool.query(
    `SELECT id FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
    [productId, storeId]
  );
  if (!pRows[0]) throw Object.assign(new Error("product not found"), { code: "NOT_FOUND" });

  // Compute is_verified_purchase server-side
  let isVerified = false;
  if (input.customer_id && input.order_id) {
    const { rows: orderRows } = await pool.query(
      `SELECT id FROM orders
       WHERE id = $1::uuid AND store_id = $2::uuid`,
      [input.order_id, storeId]
    );
    isVerified = orderRows.length > 0;
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO product_reviews
       (store_id, product_id, customer_id, order_id, rating, title, body,
        reviewer_name, reviewer_email, status, is_verified_purchase, media_urls)
     VALUES
       ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, 'pending', $10, $11)
     RETURNING id::text`,
    [
      storeId,
      productId,
      input.customer_id ?? null,
      input.order_id ?? null,
      input.rating,
      input.title ?? null,
      input.body ?? null,
      input.reviewer_name ?? null,
      input.reviewer_email ?? null,
      isVerified,
      input.media_urls ? input.media_urls : [],
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("createReview: no row returned");
  return row.id;
}

export async function updateReview(
  storeId: string,
  reviewId: string,
  input: UpdateReviewInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE product_reviews SET
       status     = COALESCE($3, status),
       reply      = COALESCE($4, reply),
       replied_at = CASE WHEN $4 IS NOT NULL THEN now() ELSE replied_at END,
       published_at = CASE WHEN $3 = 'approved' AND published_at IS NULL THEN now() ELSE published_at END,
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [reviewId, storeId, input.status ?? null, input.reply ?? null]
  );
  return (rowCount ?? 0) > 0;
}

// ── Product tags ──────────────────────────────────────────────────────────────

export async function getProductTags(
  storeId: string,
  productId: string
): Promise<string[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT pt.tag
     FROM product_tags pt
     JOIN products p ON p.id = pt.product_id
     WHERE pt.product_id = $1::uuid AND p.store_id = $2::uuid
     ORDER BY pt.tag`,
    [productId, storeId]
  );
  return rows.map((r: { tag: string }) => r.tag);
}

export async function setProductTags(
  storeId: string,
  productId: string,
  tags: string[]
): Promise<void> {
  await withTx(async (client) => {
    // Verify product belongs to store
    const { rows: pRows } = await client.query(
      `SELECT id FROM products WHERE id = $1::uuid AND store_id = $2::uuid`,
      [productId, storeId]
    );
    if (!pRows[0]) throw Object.assign(new Error("product not found"), { code: "NOT_FOUND" });

    // Delete all existing tags
    await client.query(
      `DELETE FROM product_tags WHERE product_id = $1::uuid`,
      [productId]
    );

    // Insert new tags (lowercase + trim, ON CONFLICT DO NOTHING)
    const normalized = tags
      .map((t) => t.toLowerCase().trim())
      .filter((t) => t.length > 0);

    for (const tag of normalized) {
      await client.query(
        `INSERT INTO product_tags (product_id, tag) VALUES ($1::uuid, $2)
         ON CONFLICT DO NOTHING`,
        [productId, tag]
      );
    }
  });
}

// ── Collections ───────────────────────────────────────────────────────────────

const COLLECTION_COLS = `
  id::text,
  store_id::text,
  title,
  slug,
  description,
  parent_id::text,
  image_url,
  seo_title,
  seo_desc,
  sort_order,
  is_smart,
  smart_match,
  is_active,
  metadata,
  created_at,
  updated_at
`;

export async function listCollections(
  storeId: string,
  opts: { limit?: number | undefined; offset?: number | undefined } = {}
): Promise<CollectionPublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;
  const { rows } = await pool.query(
    `SELECT ${COLLECTION_COLS}
     FROM collections
     WHERE store_id = $1::uuid
     ORDER BY title
     LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]
  );
  return rows as CollectionPublic[];
}

export async function getCollection(
  storeId: string,
  collectionId: string
): Promise<CollectionPublic | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT ${COLLECTION_COLS}
     FROM collections
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [collectionId, storeId]
  );
  return (rows[0] as CollectionPublic) ?? null;
}

export async function createCollection(
  storeId: string,
  input: CreateCollectionInput
): Promise<string> {
  const pool = getPool();
  const title = input.title.trim();
  const slug = (input.slug?.trim() || slugify(title)).slice(0, 255);

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO collections
         (store_id, title, slug, description, parent_id, image_url,
          seo_title, seo_desc, sort_order, is_active, metadata)
       VALUES
         ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11)
       RETURNING id::text`,
      [
        storeId,
        title,
        slug,
        input.description ?? null,
        input.parent_id ?? null,
        input.image_url ?? null,
        input.seo_title ?? null,
        input.seo_desc ?? null,
        input.sort_order ?? "manual",
        input.is_active ?? true,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    const row = rows[0];
    if (!row) throw new Error("createCollection: no row returned");
    return row.id;
  } catch (err) {
    if (isDuplicateError(err)) {
      throwDuplicateSlug("a collection with that slug already exists in this store");
    }
    throw err;
  }
}

export async function updateCollection(
  storeId: string,
  collectionId: string,
  input: UpdateCollectionInput
): Promise<boolean> {
  const pool = getPool();

  if (input.slug !== undefined) {
    const { rows: existRows } = await pool.query(
      `SELECT id FROM collections
       WHERE store_id = $1::uuid AND slug = $2 AND id != $3::uuid`,
      [storeId, input.slug, collectionId]
    );
    if (existRows.length > 0) {
      throwDuplicateSlug("a collection with that slug already exists in this store");
    }
  }

  const { rowCount } = await pool.query(
    `UPDATE collections SET
       title       = COALESCE($3, title),
       slug        = COALESCE($4, slug),
       description = COALESCE($5, description),
       parent_id   = COALESCE($6::uuid, parent_id),
       image_url   = COALESCE($7, image_url),
       seo_title   = COALESCE($8, seo_title),
       seo_desc    = COALESCE($9, seo_desc),
       sort_order  = COALESCE($10, sort_order),
       is_active   = COALESCE($11, is_active),
       metadata    = COALESCE($12, metadata),
       updated_at  = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      collectionId,
      storeId,
      input.title ?? null,
      input.slug ?? null,
      input.description ?? null,
      input.parent_id ?? null,
      input.image_url ?? null,
      input.seo_title ?? null,
      input.seo_desc ?? null,
      input.sort_order ?? null,
      input.is_active ?? null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteCollection(
  storeId: string,
  collectionId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM collections WHERE id = $1::uuid AND store_id = $2::uuid`,
    [collectionId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

export async function addProductToCollection(
  storeId: string,
  collectionId: string,
  productId: string
): Promise<void> {
  const pool = getPool();
  // Verify collection belongs to store
  const { rows: cRows } = await pool.query(
    `SELECT id FROM collections WHERE id = $1::uuid AND store_id = $2::uuid`,
    [collectionId, storeId]
  );
  if (!cRows[0]) throw Object.assign(new Error("collection not found"), { code: "NOT_FOUND" });

  await pool.query(
    `INSERT INTO product_collections (product_id, collection_id, position)
     VALUES ($1::uuid, $2::uuid, 0)
     ON CONFLICT DO NOTHING`,
    [productId, collectionId]
  );
}

export async function removeProductFromCollection(
  storeId: string,
  collectionId: string,
  productId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM product_collections pc
     USING collections c
     WHERE pc.product_id = $1::uuid
       AND pc.collection_id = $2::uuid
       AND c.id = pc.collection_id
       AND c.store_id = $3::uuid`,
    [productId, collectionId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

export async function getCollectionProducts(
  storeId: string,
  collectionId: string,
  opts: { limit?: number | undefined; offset?: number | undefined } = {}
): Promise<ProductPublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;
  const { rows } = await pool.query(
    `SELECT
      p.id::text, p.store_id::text, p.title, p.slug, p.description,
      p.type, p.status, p.vendor, p.seo_title, p.seo_desc,
      p.metadata, p.created_at, p.updated_at
     FROM products p
     JOIN product_collections pc ON pc.product_id = p.id
     JOIN collections c ON c.id = pc.collection_id
     WHERE pc.collection_id = $1::uuid AND c.store_id = $2::uuid
     ORDER BY pc.position, p.title
     LIMIT $3 OFFSET $4`,
    [collectionId, storeId, limit, offset]
  );
  return rows as ProductPublic[];
}

// ── Collection rules ──────────────────────────────────────────────────────────

export async function listCollectionRules(
  storeId: string,
  collectionId: string
): Promise<CollectionRulePublic[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT r.id::text, r.collection_id::text, r.field, r.relation, r.value, r.position, r.created_at
     FROM collection_rules r
     JOIN collections c ON c.id = r.collection_id
     WHERE r.collection_id = $1::uuid AND c.store_id = $2::uuid
     ORDER BY r.position, r.created_at`,
    [collectionId, storeId]
  );
  return rows as CollectionRulePublic[];
}

export async function addCollectionRule(
  storeId: string,
  collectionId: string,
  input: AddCollectionRuleInput
): Promise<string> {
  return withTx(async (client) => {
    // Verify collection belongs to store
    const { rows: cRows } = await client.query(
      `SELECT id FROM collections WHERE id = $1::uuid AND store_id = $2::uuid`,
      [collectionId, storeId]
    );
    if (!cRows[0]) throw Object.assign(new Error("collection not found"), { code: "NOT_FOUND" });

    // Insert the rule
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO collection_rules (collection_id, field, relation, value, position)
       VALUES ($1::uuid, $2, $3, $4, $5)
       RETURNING id::text`,
      [collectionId, input.field, input.relation, input.value, input.position ?? 0]
    );
    const row = rows[0];
    if (!row) throw new Error("addCollectionRule: no row returned");

    // Mark collection as smart
    await client.query(
      `UPDATE collections SET is_smart = true, updated_at = now() WHERE id = $1::uuid`,
      [collectionId]
    );

    return row.id;
  }).then(async (ruleId) => {
    // Refresh smart collection membership after transaction commits
    await refreshSmartCollectionMembership(collectionId).catch(() => {
      // Non-fatal: log but don't fail
    });
    return ruleId;
  });
}

export async function deleteCollectionRule(
  storeId: string,
  collectionId: string,
  ruleId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM collection_rules r
     USING collections c
     WHERE r.id = $1::uuid
       AND r.collection_id = $2::uuid
       AND c.id = r.collection_id
       AND c.store_id = $3::uuid`,
    [ruleId, collectionId, storeId]
  );
  if ((rowCount ?? 0) > 0) {
    await refreshSmartCollectionMembership(collectionId).catch(() => {});
  }
  return (rowCount ?? 0) > 0;
}

// ── Smart collection membership refresh ───────────────────────────────────────

export async function refreshSmartCollectionMembership(
  collectionId: string
): Promise<void> {
  const pool = getPool();

  // Fetch collection metadata
  const { rows: colRows } = await pool.query<{
    store_id: string;
    smart_match: "all" | "any";
  }>(
    `SELECT store_id::text, smart_match FROM collections WHERE id = $1::uuid`,
    [collectionId]
  );
  const col = colRows[0];
  if (!col) return;

  const storeId = col.store_id;
  const smartMatch = col.smart_match ?? "all";

  // Fetch all rules
  const { rows: ruleRows } = await pool.query<{
    field: RuleField;
    relation: RuleRelation;
    value: string;
  }>(
    `SELECT field, relation, value FROM collection_rules WHERE collection_id = $1::uuid`,
    [collectionId]
  );

  if (ruleRows.length === 0) {
    // No rules → clear all memberships
    await pool.query(
      `DELETE FROM product_collections WHERE collection_id = $1::uuid`,
      [collectionId]
    );
    return;
  }

  // Fetch all active products for the store with their tags
  const { rows: productRows } = await pool.query<{
    id: string;
    title: string;
    vendor: string | null;
    status: string;
    type: string;
    tags: string[];
  }>(
    `SELECT
      p.id::text,
      p.title,
      p.vendor,
      p.status,
      p.type,
      COALESCE(
        ARRAY(SELECT pt.tag FROM product_tags pt WHERE pt.product_id = p.id),
        ARRAY[]::text[]
      ) AS tags
     FROM products p
     WHERE p.store_id = $1::uuid AND p.status = 'active'`,
    [storeId]
  );

  // Evaluate rules for each product
  function matchRule(
    product: {
      title: string;
      vendor: string | null;
      status: string;
      type: string;
      tags: string[];
    },
    rule: { field: RuleField; relation: RuleRelation; value: string }
  ): boolean {
    const { field, relation, value } = rule;
    const lv = value.toLowerCase();

    if (field === "tag") {
      // Check if any tag matches
      const tagMatch = product.tags.some((t) => {
        const tl = t.toLowerCase();
        switch (relation) {
          case "equals": return tl === lv;
          case "not_equals": return tl !== lv;
          case "contains": return tl.includes(lv);
          case "not_contains": return !tl.includes(lv);
          case "starts_with": return tl.startsWith(lv);
          case "ends_with": return tl.endsWith(lv);
          default: return false;
        }
      });
      return tagMatch;
    }

    let fieldValue = "";
    switch (field) {
      case "title": fieldValue = product.title; break;
      case "vendor": fieldValue = product.vendor ?? ""; break;
      case "status": fieldValue = product.status; break;
      case "type": fieldValue = product.type; break;
    }
    const fl = fieldValue.toLowerCase();

    switch (relation) {
      case "equals": return fl === lv;
      case "not_equals": return fl !== lv;
      case "contains": return fl.includes(lv);
      case "not_contains": return !fl.includes(lv);
      case "starts_with": return fl.startsWith(lv);
      case "ends_with": return fl.endsWith(lv);
      case "greater_than": return fl > lv;
      case "less_than": return fl < lv;
      default: return false;
    }
  }

  const matchingIds = new Set<string>();
  for (const product of productRows) {
    const ruleResults = ruleRows.map((r) => matchRule(product, r));
    const matches =
      smartMatch === "all"
        ? ruleResults.every(Boolean)
        : ruleResults.some(Boolean);
    if (matches) {
      matchingIds.add(product.id);
    }
  }

  // Sync product_collections: insert matches, delete non-matches
  await withTx(async (client) => {
    // Delete non-matching
    await client.query(
      `DELETE FROM product_collections
       WHERE collection_id = $1::uuid
         AND product_id != ALL($2::uuid[])`,
      [collectionId, Array.from(matchingIds)]
    );

    // Insert matches (ON CONFLICT DO NOTHING)
    for (const productId of matchingIds) {
      await client.query(
        `INSERT INTO product_collections (product_id, collection_id, position)
         VALUES ($1::uuid, $2::uuid, 0)
         ON CONFLICT DO NOTHING`,
        [productId, collectionId]
      );
    }
  });
}

// ── Price lists ───────────────────────────────────────────────────────────────

export async function listPriceLists(
  storeId: string,
  opts: { limit?: number | undefined; offset?: number | undefined } = {}
): Promise<PriceListPublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, name, currency, type, is_default, metadata, created_at, updated_at
     FROM price_lists
     WHERE store_id = $1::uuid
     ORDER BY name
     LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]
  );
  return rows as PriceListPublic[];
}

export async function getPriceList(
  storeId: string,
  listId: string
): Promise<PriceListPublic | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, name, currency, type, is_default, metadata, created_at, updated_at
     FROM price_lists
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [listId, storeId]
  );
  return (rows[0] as PriceListPublic) ?? null;
}

export async function createPriceList(
  storeId: string,
  input: CreatePriceListInput
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO price_lists (store_id, name, currency, type, is_default, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     RETURNING id::text`,
    [
      storeId,
      input.name,
      input.currency,
      input.type ?? "retail",
      input.is_default ?? false,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("createPriceList: no row returned");
  return row.id;
}

export async function updatePriceList(
  storeId: string,
  listId: string,
  input: UpdatePriceListInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE price_lists SET
       name       = COALESCE($3, name),
       currency   = COALESCE($4, currency),
       type       = COALESCE($5, type),
       is_default = COALESCE($6, is_default),
       metadata   = COALESCE($7, metadata),
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      listId,
      storeId,
      input.name ?? null,
      input.currency ?? null,
      input.type ?? null,
      input.is_default ?? null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deletePriceList(
  storeId: string,
  listId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM price_lists WHERE id = $1::uuid AND store_id = $2::uuid`,
    [listId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

export async function listPriceListItems(
  storeId: string,
  listId: string,
  opts: { limit?: number | undefined; offset?: number | undefined } = {}
): Promise<PriceListItemPublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;
  const { rows } = await pool.query(
    `SELECT pli.id::text, pli.price_list_id::text, pli.variant_id::text,
            pli.price::text, pli.min_qty, pli.max_qty, pli.created_at
     FROM price_list_items pli
     JOIN price_lists pl ON pl.id = pli.price_list_id
     WHERE pli.price_list_id = $1::uuid AND pl.store_id = $2::uuid
     ORDER BY pli.created_at
     LIMIT $3 OFFSET $4`,
    [listId, storeId, limit, offset]
  );
  return rows as PriceListItemPublic[];
}

export async function upsertPriceListItem(
  storeId: string,
  listId: string,
  input: UpsertPriceListItemInput
): Promise<string> {
  const pool = getPool();
  // Verify list belongs to store
  const { rows: lRows } = await pool.query(
    `SELECT id FROM price_lists WHERE id = $1::uuid AND store_id = $2::uuid`,
    [listId, storeId]
  );
  if (!lRows[0]) throw Object.assign(new Error("price list not found"), { code: "NOT_FOUND" });

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO price_list_items (price_list_id, variant_id, price, min_qty, max_qty)
     VALUES ($1::uuid, $2::uuid, $3::numeric, $4, $5)
     ON CONFLICT (price_list_id, variant_id, min_qty) DO UPDATE
       SET price = EXCLUDED.price, max_qty = EXCLUDED.max_qty
     RETURNING id::text`,
    [
      listId,
      input.variant_id,
      input.price,
      input.min_qty ?? 1,
      input.max_qty ?? null,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("upsertPriceListItem: no row returned");
  return row.id;
}

export async function updatePriceListItem(
  storeId: string,
  listId: string,
  itemId: string,
  input: UpdatePriceListItemInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE price_list_items pli SET
       price   = COALESCE($4::numeric, pli.price),
       min_qty = COALESCE($5, pli.min_qty),
       max_qty = COALESCE($6, pli.max_qty)
     FROM price_lists pl
     WHERE pli.id = $1::uuid
       AND pli.price_list_id = $2::uuid
       AND pl.id = pli.price_list_id
       AND pl.store_id = $3::uuid`,
    [
      itemId,
      listId,
      storeId,
      input.price ?? null,
      input.min_qty ?? null,
      input.max_qty ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deletePriceListItem(
  storeId: string,
  listId: string,
  itemId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM price_list_items pli
     USING price_lists pl
     WHERE pli.id = $1::uuid
       AND pli.price_list_id = $2::uuid
       AND pl.id = pli.price_list_id
       AND pl.store_id = $3::uuid`,
    [itemId, listId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Metafields ────────────────────────────────────────────────────────────────

export async function listMetafields(
  storeId: string,
  opts: {
    owner_resource?: string | undefined;
    owner_id?: string | undefined;
    namespace?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
): Promise<MetafieldPublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const conditions = [`store_id = $1::uuid`];
  const params: unknown[] = [storeId];

  if (opts.owner_resource) {
    params.push(opts.owner_resource);
    conditions.push(`owner_resource = $${params.length}`);
  }
  if (opts.owner_id) {
    params.push(opts.owner_id);
    conditions.push(`owner_id = $${params.length}::uuid`);
  }
  if (opts.namespace) {
    params.push(opts.namespace);
    conditions.push(`namespace = $${params.length}`);
  }

  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT
      id::text, store_id::text, owner_resource, owner_id::text,
      namespace, key, value, value_type AS type, created_at, updated_at
     FROM metafields
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows as MetafieldPublic[];
}

export async function upsertMetafield(
  storeId: string,
  input: UpsertMetafieldInput
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO metafields
       (store_id, owner_resource, owner_id, namespace, key, value, value_type)
     VALUES
       ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)
     ON CONFLICT (store_id, owner_resource, owner_id, namespace, key) DO UPDATE
       SET value      = EXCLUDED.value,
           value_type = EXCLUDED.value_type,
           updated_at = now()
     RETURNING id::text`,
    [
      storeId,
      input.owner_resource,
      input.owner_id,
      input.namespace,
      input.key,
      input.value ?? null,
      input.type ?? "string",
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("upsertMetafield: no row returned");
  return row.id;
}

export async function updateMetafield(
  storeId: string,
  metafieldId: string,
  input: UpdateMetafieldInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE metafields SET
       value      = COALESCE($3, value),
       value_type = COALESCE($4, value_type),
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [metafieldId, storeId, input.value ?? null, input.type ?? null]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteMetafield(
  storeId: string,
  metafieldId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM metafields WHERE id = $1::uuid AND store_id = $2::uuid`,
    [metafieldId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

export async function listMetafieldDefinitions(
  storeId: string,
  opts: { limit?: number | undefined; offset?: number | undefined } = {}
): Promise<MetafieldDefinitionPublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;
  const { rows } = await pool.query(
    `SELECT
      id::text, store_id::text, namespace, key, name, owner_resource,
      description, value_type AS type, validations, is_required, created_at, updated_at
     FROM metafield_definitions
     WHERE store_id = $1::uuid
     ORDER BY created_at
     LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]
  );
  return rows as MetafieldDefinitionPublic[];
}

export async function createMetafieldDefinition(
  storeId: string,
  input: CreateMetafieldDefinitionInput
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO metafield_definitions
       (store_id, namespace, key, name, owner_resource, description, value_type, validations, is_required)
     VALUES
       ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id::text`,
    [
      storeId,
      input.namespace,
      input.key,
      input.name,
      input.owner_resource,
      input.description ?? null,
      input.type ?? "string",
      input.validations ? JSON.stringify(input.validations) : null,
      input.is_required ?? false,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("createMetafieldDefinition: no row returned");
  return row.id;
}

export async function updateMetafieldDefinition(
  storeId: string,
  defId: string,
  input: UpdateMetafieldDefinitionInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE metafield_definitions SET
       name        = COALESCE($3, name),
       description = COALESCE($4, description),
       value_type  = COALESCE($5, value_type),
       validations = COALESCE($6, validations),
       is_required = COALESCE($7, is_required),
       updated_at  = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      defId,
      storeId,
      input.name ?? null,
      input.description ?? null,
      input.type ?? null,
      input.validations !== undefined ? JSON.stringify(input.validations) : null,
      input.is_required ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteMetafieldDefinition(
  storeId: string,
  defId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM metafield_definitions WHERE id = $1::uuid AND store_id = $2::uuid`,
    [defId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Translations ──────────────────────────────────────────────────────────────

// Map resourceType → (table, id column, translatable fields)
const TRANSLATION_TABLE_MAP: Record<
  TranslationResourceType,
  {
    table: string;
    idCol: string;
    fields: string[];
  }
> = {
  product: {
    table: "product_translations",
    idCol: "product_id",
    fields: ["title", "description", "seo_title", "seo_desc"],
  },
  variant: {
    table: "product_variant_translations",
    idCol: "variant_id",
    fields: ["title"],
  },
  option: {
    table: "product_option_translations",
    idCol: "option_id",
    fields: ["name"],
  },
  option_value: {
    table: "product_option_value_translations",
    idCol: "option_value_id",
    fields: ["value"],
  },
  collection: {
    table: "collection_translations",
    idCol: "collection_id",
    fields: ["title", "description", "seo_title", "seo_desc"],
  },
};

export async function listTranslations(
  _storeId: string,
  resourceType: TranslationResourceType,
  resourceId: string
): Promise<TranslationPublic[]> {
  const pool = getPool();
  const meta = TRANSLATION_TABLE_MAP[resourceType];
  if (!meta) return [];

  const { rows } = await pool.query(
    `SELECT * FROM ${meta.table} WHERE ${meta.idCol} = $1::uuid ORDER BY locale`,
    [resourceId]
  );

  return rows.map((row: Record<string, unknown>) => {
    const fields: Record<string, string | null> = {};
    for (const f of meta.fields) {
      fields[f] = (row[f] as string | null) ?? null;
    }
    return {
      locale: row["locale"] as string,
      fields,
    };
  });
}

export async function upsertTranslation(
  _storeId: string,
  resourceType: TranslationResourceType,
  resourceId: string,
  locale: string,
  input: UpsertTranslationInput
): Promise<void> {
  const pool = getPool();
  const meta = TRANSLATION_TABLE_MAP[resourceType];
  if (!meta) throw new Error(`Unknown resource type: ${resourceType}`);

  const setFields = meta.fields.filter((f) => f in input.fields);
  if (setFields.length === 0) {
    // No translatable fields provided — just ensure the row exists
    await pool.query(
      `INSERT INTO ${meta.table} (${meta.idCol}, locale)
       VALUES ($1::uuid, $2)
       ON CONFLICT (${meta.idCol}, locale) DO NOTHING`,
      [resourceId, locale]
    );
    return;
  }

  const setClauses = setFields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const conflictSet = setFields.map((f, i) => `${f} = $${i + 3}`).join(", ");
  const values = setFields.map((f) => input.fields[f] ?? null);

  await pool.query(
    `INSERT INTO ${meta.table} (${meta.idCol}, locale, ${setFields.join(", ")})
     VALUES ($1::uuid, $2, ${setFields.map((_, i) => `$${i + 3}`).join(", ")})
     ON CONFLICT (${meta.idCol}, locale) DO UPDATE SET ${conflictSet}`,
    [resourceId, locale, ...values]
  );
}

export async function deleteTranslation(
  _storeId: string,
  resourceType: TranslationResourceType,
  resourceId: string,
  locale: string
): Promise<boolean> {
  const pool = getPool();
  const meta = TRANSLATION_TABLE_MAP[resourceType];
  if (!meta) return false;

  const { rowCount } = await pool.query(
    `DELETE FROM ${meta.table} WHERE ${meta.idCol} = $1::uuid AND locale = $2`,
    [resourceId, locale]
  );
  return (rowCount ?? 0) > 0;
}
