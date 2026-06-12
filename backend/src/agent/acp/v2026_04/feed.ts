/**
 * ACP 2026-04 — Product feed service.
 *
 * GET /acp/:storeId/feed
 *
 * Returns active product variants in ACP feed shape.
 * Auth: cc_pub_ or cc_prv_ key (commerce:read).
 * Pagination: cursor-based (opaque base64-encoded offset).
 */

import { getPool } from "../../../db/pool.js";
import type { AcpFeedItem, AcpFeedResponse } from "./types.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/** Encode an integer offset as an opaque cursor string. */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf-8").toString("base64url");
}

/** Decode a cursor back to integer offset. Returns 0 on invalid input. */
function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    const n = parseInt(decoded, 10);
    return isNaN(n) || n < 0 ? 0 : n;
  } catch {
    return 0;
  }
}

interface FeedRow {
  id: string;
  product_id: string;
  title: string;
  description: string;
  product_slug: string;
  domain: string;
  price: string;
  currency: string;
  availability: string;
  image_link: string;
  condition: string;
  brand: string;
  gtin: string;
  mpn: string;
  google_product_category: string;
  age_group: string;
  gender: string;
  variant_title: string;
  sku: string;
}

/**
 * Get paginated ACP feed items for a store.
 *
 * @param storeId - UUID of the store
 * @param limit   - page size (capped at MAX_PAGE_SIZE)
 * @param cursor  - opaque cursor from previous response
 * @returns AcpFeedResponse
 */
export async function getAcpFeed(
  storeId: string,
  limit: number = DEFAULT_PAGE_SIZE,
  cursor?: string
): Promise<AcpFeedResponse> {
  const pool = getPool();
  const pageSize = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
  const offset = cursor ? decodeCursor(cursor) : 0;

  // Fetch one extra to determine has_more
  const { rows } = await pool.query<FeedRow>(
    `SELECT
       pv.id::text                                                           AS id,
       p.id::text                                                            AS product_id,
       COALESCE(pv.title, p.title, 'Item')                                   AS title,
       COALESCE(p.description, '')                                            AS description,
       p.slug                                                                AS product_slug,
       COALESCE(s.domain, '')                                                AS domain,
       pv.price::text                                                        AS price,
       COALESCE(s.currency, 'ZAR')                                           AS currency,
       CASE
         WHEN pv.track_inventory = false THEN 'in_stock'
         WHEN COALESCE(SUM(il.quantity_on_hand), 0) > 0 THEN 'in_stock'
         ELSE 'out_of_stock'
       END                                                                   AS availability,
       COALESCE(
         pfd.image_url,
         (SELECT COALESCE(pm.cdn_url, pm.url) FROM product_media pm
          WHERE pm.product_id = p.id ORDER BY pm.position ASC, pm.created_at ASC LIMIT 1),
         ''
       )                                                                     AS image_link,
       COALESCE(pfd.condition, 'new')                                        AS condition,
       COALESCE(pfd.brand, p.vendor, '')                                     AS brand,
       COALESCE(pfd.gtin, pv.barcode, '')                                    AS gtin,
       COALESCE(pfd.mpn, pv.sku, '')                                         AS mpn,
       COALESCE(pfd.google_product_category, '')                             AS google_product_category,
       COALESCE(pfd.age_group, '')                                            AS age_group,
       COALESCE(pfd.gender, '')                                               AS gender,
       COALESCE(pv.title, 'Default')                                         AS variant_title,
       COALESCE(pv.sku, '')                                                   AS sku
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     JOIN stores s ON s.id = p.store_id
     LEFT JOIN product_feed_data pfd ON pfd.variant_id = pv.id
     LEFT JOIN inventory_levels il ON il.variant_id = pv.id
     WHERE p.store_id = $1::uuid
       AND p.status = 'active'
       AND pv.is_active = true
     GROUP BY pv.id, p.id, s.domain, s.currency, pfd.image_url, pfd.condition,
              pfd.brand, pfd.gtin, pfd.mpn, pfd.google_product_category,
              pfd.age_group, pfd.gender
     ORDER BY p.created_at DESC, pv.position ASC, pv.created_at ASC
     LIMIT $2 OFFSET $3`,
    [storeId, pageSize + 1, offset]
  );

  const hasMore = rows.length > pageSize;
  const items = rows.slice(0, pageSize);

  const feedItems: AcpFeedItem[] = items.map((r) => {
    // Build link: if store has a domain use it; otherwise just /products/:slug
    const baseUrl = r.domain
      ? r.domain.startsWith("http") ? r.domain : `https://${r.domain}`
      : "";
    const link = baseUrl ? `${baseUrl}/products/${r.product_slug}` : `/products/${r.product_slug}`;

    const item: AcpFeedItem = {
      id: r.id,
      title: r.title,
      description: r.description,
      link,
      price: {
        amount: r.price,
        currency: r.currency,
      },
      availability: r.availability as AcpFeedItem["availability"],
      image_link: r.image_link,
      item_group_id: r.product_id,
      variant_title: r.variant_title,
      sku: r.sku || undefined,
    };

    if (r.condition) item.condition = r.condition;
    if (r.brand) item.brand = r.brand;
    if (r.gtin) item.gtin = r.gtin;
    if (r.mpn) item.mpn = r.mpn;
    if (r.google_product_category) item.google_product_category = r.google_product_category;
    if (r.age_group) item.age_group = r.age_group;
    if (r.gender) item.gender = r.gender;

    return item;
  });

  // Get total count for metadata
  const { rows: countRows } = await pool.query<{ total: string }>(
    `SELECT COUNT(DISTINCT pv.id)::text AS total
     FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     WHERE p.store_id = $1::uuid
       AND p.status = 'active'
       AND pv.is_active = true`,
    [storeId]
  );
  const total = parseInt(countRows[0]?.total ?? "0", 10);

  const nextOffset = offset + pageSize;
  const nextCursor = hasMore ? encodeCursor(nextOffset) : null;

  return {
    items: feedItems,
    total,
    cursor: nextCursor,
    has_more: hasMore,
  };
}
