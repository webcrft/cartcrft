/**
 * feeds/service.ts — SQL-backed service for merchant feeds and product feed data.
 *
 * Covers: merchant_feeds CRUD, product_feed_data get/upsert,
 * and the feed-generation queries for Google Shopping / Facebook Catalog.
 */

import { getPool } from "../../db/pool.js";
import type {
  MerchantFeedRow,
  CreateMerchantFeedInput,
  UpdateMerchantFeedInput,
  FeedDataRow,
  UpsertFeedDataInput,
  FeedItem,
} from "./types.js";

// ── Store info ─────────────────────────────────────────────────────────────────

export interface StoreInfo {
  name: string;
  url: string;
  currency: string;
}

export async function getStoreInfo(storeId: string): Promise<StoreInfo | null> {
  const pool = getPool();
  const res = await pool.query<{ name: string; domain: string; currency: string }>(
    `SELECT name, COALESCE(domain, '') AS domain, COALESCE(currency, 'USD') AS currency
     FROM stores WHERE id = $1::uuid AND is_active = true`,
    [storeId]
  );
  const row = res.rows[0];
  if (!row) return null;
  let url = row.domain || "";
  if (url && !url.startsWith("http")) {
    url = "https://" + url;
  }
  return { name: row.name, url, currency: row.currency };
}

// ── Feed existence check ───────────────────────────────────────────────────────

export async function feedExists(storeId: string, channel: string): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM merchant_feeds
       WHERE store_id = $1::uuid AND channel = $2 AND status = 'active'
     ) AS exists`,
    [storeId, channel]
  );
  return res.rows[0]?.exists ?? false;
}

export async function updateFeedGeneratedAt(storeId: string, channel: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE merchant_feeds SET last_generated_at = now()
     WHERE store_id = $1::uuid AND channel = $2 AND status = 'active'`,
    [storeId, channel]
  );
}

// ── Feed item queries ──────────────────────────────────────────────────────────

/**
 * Fetch all active product variants with feed data for the Google Shopping feed.
 * Out-of-stock variants are included (marked availability = 'out_of_stock').
 */
export async function getFeedItems(storeId: string): Promise<
  Array<FeedItem & { googleProductCategory: string; ageGroup: string; gender: string }>
> {
  const pool = getPool();
  const res = await pool.query<{
    id: string;
    title: string;
    description: string;
    product_slug: string;
    image_url: string;
    price: string;
    availability: string;
    condition: string;
    brand: string;
    gtin: string;
    mpn: string;
    google_product_category: string;
    age_group: string;
    gender: string;
  }>(
    `SELECT
       pv.id::text                                                AS id,
       COALESCE(pv.title, p.title)                                AS title,
       COALESCE(p.description, '')                                 AS description,
       p.slug                                                     AS product_slug,
       COALESCE(pfd.image_url,
         (SELECT COALESCE(pm.cdn_url, pm.url) FROM product_media pm
          WHERE pm.product_id = p.id ORDER BY pm.position ASC LIMIT 1),
         ''
       )                                                          AS image_url,
       pv.price::text                                             AS price,
       CASE
         WHEN COALESCE(il.quantity_on_hand, 0) > 0
           OR pv.track_inventory = false THEN 'in_stock'
         ELSE 'out_of_stock'
       END                                                        AS availability,
       COALESCE(pfd.condition, 'new')                             AS condition,
       COALESCE(pfd.brand, p.vendor, '')                          AS brand,
       COALESCE(pfd.gtin, pv.barcode, '')                         AS gtin,
       COALESCE(pfd.mpn, pv.sku, '')                              AS mpn,
       COALESCE(pfd.google_product_category, '')                  AS google_product_category,
       COALESCE(pfd.age_group, '')                                AS age_group,
       COALESCE(pfd.gender, '')                                   AS gender
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     LEFT JOIN product_feed_data pfd ON pfd.variant_id = pv.id
     LEFT JOIN inventory_levels il ON il.variant_id = pv.id
     WHERE p.store_id = $1::uuid
       AND p.status = 'active'
       AND pv.is_active = true
     ORDER BY p.created_at DESC, pv.position ASC
     LIMIT 50000`,
    [storeId]
  );

  return res.rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    slug: r.product_slug,
    imageUrl: r.image_url,
    price: r.price,
    availability: r.availability,
    condition: r.condition,
    brand: r.brand,
    gtin: r.gtin,
    mpn: r.mpn,
    googleProductCategory: r.google_product_category,
    ageGroup: r.age_group,
    gender: r.gender,
  }));
}

/** Same query but for the Facebook catalog (availability uses "in stock" / "out of stock"). */
export async function getFacebookFeedItems(storeId: string): Promise<
  Array<FeedItem & { productType: string }>
> {
  const pool = getPool();
  const res = await pool.query<{
    id: string;
    title: string;
    description: string;
    product_slug: string;
    image_url: string;
    price: string;
    availability: string;
    condition: string;
    brand: string;
    gtin: string;
    category: string;
  }>(
    `SELECT
       pv.id::text                                                AS id,
       COALESCE(pv.title, p.title)                                AS title,
       COALESCE(p.description, '')                                 AS description,
       p.slug                                                     AS product_slug,
       COALESCE(pfd.image_url,
         (SELECT COALESCE(pm.cdn_url, pm.url) FROM product_media pm
          WHERE pm.product_id = p.id ORDER BY pm.position ASC LIMIT 1),
         ''
       )                                                          AS image_url,
       pv.price::text                                             AS price,
       CASE
         WHEN COALESCE(il.quantity_on_hand, 0) > 0
           OR pv.track_inventory = false THEN 'in stock'
         ELSE 'out of stock'
       END                                                        AS availability,
       COALESCE(pfd.condition, 'new')                             AS condition,
       COALESCE(pfd.brand, p.vendor, '')                          AS brand,
       COALESCE(pfd.gtin, pv.barcode, '')                         AS gtin,
       COALESCE(pfd.google_product_category, '')                  AS category
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     LEFT JOIN product_feed_data pfd ON pfd.variant_id = pv.id
     LEFT JOIN inventory_levels il ON il.variant_id = pv.id
     WHERE p.store_id = $1::uuid
       AND p.status = 'active'
       AND pv.is_active = true
     ORDER BY p.created_at DESC, pv.position ASC
     LIMIT 50000`,
    [storeId]
  );

  return res.rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    slug: r.product_slug,
    imageUrl: r.image_url,
    price: r.price,
    availability: r.availability,
    condition: r.condition,
    brand: r.brand,
    gtin: r.gtin,
    mpn: "",
    googleProductCategory: r.category,
    ageGroup: "",
    gender: "",
    productType: r.category,
  }));
}

// ── Merchant feeds CRUD ────────────────────────────────────────────────────────

export async function listMerchantFeeds(storeId: string): Promise<MerchantFeedRow[]> {
  const pool = getPool();
  const res = await pool.query<MerchantFeedRow>(
    `SELECT id::text, store_id::text,
            store_integration_id::text,
            channel, name, format, locale, currency, country_code,
            include_out_of_stock, generation_interval_minutes,
            last_generated_at, status, error_log, config, created_at, updated_at
     FROM merchant_feeds
     WHERE store_id = $1::uuid
     ORDER BY channel, locale`,
    [storeId]
  );
  return res.rows;
}

export async function createMerchantFeed(
  storeId: string,
  input: CreateMerchantFeedInput
): Promise<string> {
  const pool = getPool();

  const channel = input.channel ?? "google_shopping";
  const name = input.name?.trim() || "Google Shopping Feed";
  const locale = input.locale ?? "en";
  const countryCode = (input.country_code ?? "US").toUpperCase();
  const format = input.format ?? "xml";

  let currency = (input.currency ?? "").toUpperCase();
  if (!currency) {
    const res = await pool.query<{ currency: string }>(
      `SELECT COALESCE(currency, 'USD') AS currency FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    currency = res.rows[0]?.currency ?? "USD";
  }

  const configJson = JSON.stringify(input.config ?? {});

  const res = await pool.query<{ id: string }>(
    `INSERT INTO merchant_feeds
       (store_id, store_integration_id, channel, name, format, locale,
        currency, country_code, include_out_of_stock, generation_interval_minutes, config)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
             COALESCE($9, false), COALESCE($10, 60), $11::jsonb)
     ON CONFLICT (store_id, channel, locale, country_code) DO UPDATE SET
       name                        = EXCLUDED.name,
       store_integration_id        = COALESCE(EXCLUDED.store_integration_id, merchant_feeds.store_integration_id),
       include_out_of_stock        = EXCLUDED.include_out_of_stock,
       generation_interval_minutes = EXCLUDED.generation_interval_minutes,
       config                      = EXCLUDED.config,
       status                      = 'active',
       updated_at                  = now()
     RETURNING id::text`,
    [
      storeId,
      input.store_integration_id ?? null,
      channel,
      name,
      format,
      locale,
      currency,
      countryCode,
      input.include_out_of_stock ?? false,
      input.generation_interval_minutes ?? 60,
      configJson,
    ]
  );

  const id = res.rows[0]?.id;
  if (!id) throw new Error("createMerchantFeed: no id returned");
  return id;
}

export async function updateMerchantFeed(
  feedId: string,
  storeId: string,
  input: UpdateMerchantFeedInput
): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE merchant_feeds SET
       name                        = COALESCE($3, name),
       include_out_of_stock        = COALESCE($4, include_out_of_stock),
       generation_interval_minutes = COALESCE($5, generation_interval_minutes),
       status                      = COALESCE($6, status),
       config                      = COALESCE($7::jsonb, config),
       updated_at                  = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      feedId,
      storeId,
      input.name ?? null,
      input.include_out_of_stock ?? null,
      input.generation_interval_minutes ?? null,
      input.status ?? null,
      input.config != null ? JSON.stringify(input.config) : null,
    ]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteMerchantFeed(feedId: string, storeId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM merchant_feeds WHERE id = $1::uuid AND store_id = $2::uuid`,
    [feedId, storeId]
  );
}

// ── Product feed data (per-variant Google Shopping attributes) ─────────────────

export async function getProductFeedData(
  variantId: string,
  storeId: string
): Promise<FeedDataRow | null> {
  const pool = getPool();
  const res = await pool.query<FeedDataRow>(
    `SELECT pfd.id::text, pfd.variant_id::text,
            pfd.gtin, pfd.mpn, pfd.brand, pfd.google_product_category,
            pfd.condition, pfd.age_group, pfd.gender,
            pfd.size_type, pfd.size_system, pfd.material, pfd.pattern,
            pfd.multipack, pfd.is_bundle,
            pfd.custom_label_0, pfd.custom_label_1, pfd.custom_label_2,
            pfd.custom_label_3, pfd.custom_label_4,
            pfd.image_url, pfd.additional_image_urls,
            pfd.excluded_destinations, pfd.included_destinations, pfd.ads_redirect,
            pfd.created_at, pfd.updated_at
     FROM product_feed_data pfd
     JOIN product_variants pv ON pv.id = pfd.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE pfd.variant_id = $1::uuid AND p.store_id = $2::uuid`,
    [variantId, storeId]
  );
  return res.rows[0] ?? null;
}

export async function upsertProductFeedData(
  variantId: string,
  storeId: string,
  input: UpsertFeedDataInput
): Promise<string> {
  const pool = getPool();

  // Verify variant belongs to store
  const check = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1::uuid AND p.store_id = $2::uuid
     ) AS exists`,
    [variantId, storeId]
  );
  if (!check.rows[0]?.exists) {
    throw Object.assign(new Error("variant not found"), { code: "NOT_FOUND" });
  }

  const condition = input.condition || "new";

  const res = await pool.query<{ id: string }>(
    `INSERT INTO product_feed_data
       (variant_id, gtin, mpn, brand, google_product_category,
        condition, age_group, gender, size_type, size_system,
        material, pattern, multipack, is_bundle,
        custom_label_0, custom_label_1, custom_label_2, custom_label_3, custom_label_4,
        image_url, ads_redirect)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (variant_id) DO UPDATE SET
       gtin                    = COALESCE(EXCLUDED.gtin, product_feed_data.gtin),
       mpn                     = COALESCE(EXCLUDED.mpn, product_feed_data.mpn),
       brand                   = COALESCE(EXCLUDED.brand, product_feed_data.brand),
       google_product_category = COALESCE(EXCLUDED.google_product_category, product_feed_data.google_product_category),
       condition               = EXCLUDED.condition,
       age_group               = COALESCE(EXCLUDED.age_group, product_feed_data.age_group),
       gender                  = COALESCE(EXCLUDED.gender, product_feed_data.gender),
       size_type               = COALESCE(EXCLUDED.size_type, product_feed_data.size_type),
       size_system             = COALESCE(EXCLUDED.size_system, product_feed_data.size_system),
       material                = COALESCE(EXCLUDED.material, product_feed_data.material),
       pattern                 = COALESCE(EXCLUDED.pattern, product_feed_data.pattern),
       multipack               = COALESCE(EXCLUDED.multipack, product_feed_data.multipack),
       is_bundle               = EXCLUDED.is_bundle,
       custom_label_0          = COALESCE(EXCLUDED.custom_label_0, product_feed_data.custom_label_0),
       custom_label_1          = COALESCE(EXCLUDED.custom_label_1, product_feed_data.custom_label_1),
       custom_label_2          = COALESCE(EXCLUDED.custom_label_2, product_feed_data.custom_label_2),
       custom_label_3          = COALESCE(EXCLUDED.custom_label_3, product_feed_data.custom_label_3),
       custom_label_4          = COALESCE(EXCLUDED.custom_label_4, product_feed_data.custom_label_4),
       image_url               = COALESCE(EXCLUDED.image_url, product_feed_data.image_url),
       ads_redirect            = COALESCE(EXCLUDED.ads_redirect, product_feed_data.ads_redirect),
       updated_at              = now()
     RETURNING id::text`,
    [
      variantId,
      input.gtin ?? null,
      input.mpn ?? null,
      input.brand ?? null,
      input.google_product_category ?? null,
      condition,
      input.age_group ?? null,
      input.gender ?? null,
      input.size_type ?? null,
      input.size_system ?? null,
      input.material ?? null,
      input.pattern ?? null,
      input.multipack ?? null,
      input.is_bundle ?? false,
      input.custom_label_0 ?? null,
      input.custom_label_1 ?? null,
      input.custom_label_2 ?? null,
      input.custom_label_3 ?? null,
      input.custom_label_4 ?? null,
      input.image_url ?? null,
      input.ads_redirect ?? null,
    ]
  );

  const id = res.rows[0]?.id;
  if (!id) throw new Error("upsertProductFeedData: no id returned");
  return id;
}
