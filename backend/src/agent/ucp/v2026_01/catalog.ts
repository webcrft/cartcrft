/**
 * UCP 2026-01 — Catalog conformance service.
 *
 * GET /ucp/:storeId/catalog            — paginated product entities with offers
 * GET /ucp/:storeId/catalog/:productId — single product entity (all variants)
 *
 * Auth: cc_pub_ or cc_prv_ key (commerce:read).
 * UCP-Version: "2026-01" header returned on all responses (set in routes).
 *
 * Spec version: 2026-01 NRF baseline, provisional.
 * See docs/ucp.md for field mapping and assumptions.
 */

import { getPool } from "../../../db/pool.js";
import type {
  UcpProductEntity,
  UcpCatalogResponse,
  UcpOffer,
  UcpItemGroup,
  UcpAttribute,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;

// ── DB row shape ──────────────────────────────────────────────────────────────

interface CatalogRow {
  // Variant
  variant_id: string;
  variant_title: string;
  variant_sku: string;
  variant_price: string;
  variant_compare_at_price: string | null;
  variant_is_active: boolean;
  variant_allow_backorder: boolean;
  variant_track_inventory: boolean;
  // Availability (aggregated)
  qty_on_hand: string;   // SUM as text
  // Product
  product_id: string;
  product_title: string;
  product_description: string;
  product_slug: string;
  product_type: string;
  product_vendor: string;
  product_metadata: unknown;
  // Store
  store_domain: string;
  store_currency: string;
  // Media
  image_url: string;
  // Feed data
  fd_gtin: string;
  fd_mpn: string;
  fd_brand: string;
  fd_condition: string;
  fd_google_product_category: string;
  fd_age_group: string;
  fd_gender: string;
  fd_image_url: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildStoreUrl(domain: string, slug: string): string {
  if (!domain) return `/products/${slug}`;
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  return `${base}/products/${slug}`;
}

/**
 * Derive UCP availability from inventory state.
 * Mapping:
 *   track_inventory = false                    → IN_STOCK (untracked, always available)
 *   track_inventory = true, qty > 0            → IN_STOCK
 *   track_inventory = true, qty = 0, backorder → BACKORDER
 *   track_inventory = true, qty = 0            → OUT_OF_STOCK
 */
function deriveAvailability(
  trackInventory: boolean,
  qtyOnHand: number,
  allowBackorder: boolean
): UcpOffer["availability"] {
  if (!trackInventory) return "IN_STOCK";
  if (qtyOnHand > 0) return "IN_STOCK";
  if (allowBackorder) return "BACKORDER";
  return "OUT_OF_STOCK";
}

/**
 * Derive UCP condition from feed data.
 * Default: NEW (most products are new condition).
 */
function deriveCondition(fdCondition: string): UcpOffer["condition"] {
  const c = fdCondition?.toLowerCase();
  if (c === "used") return "USED";
  if (c === "refurbished") return "REFURBISHED";
  return "NEW";
}

/**
 * Extract structured attributes from product metadata + feed data.
 * Metadata is a JSONB column; we pull top-level string/number/boolean fields.
 */
function extractStructuredAttributes(
  metadata: unknown,
  feedData: { gtin?: string | undefined; mpn?: string | undefined; brand?: string | undefined; age_group?: string | undefined; gender?: string | undefined }
): UcpAttribute[] {
  const attrs: UcpAttribute[] = [];

  // From product metadata (flat key-value pairs)
  if (metadata && typeof metadata === "object") {
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      const t = typeof value;
      if (t === "string" || t === "number" || t === "boolean") {
        attrs.push({
          key,
          value: String(value),
          type: t as "string" | "number" | "boolean",
        });
      }
    }
  }

  // From feed data enrichment
  if (feedData.brand) attrs.push({ key: "brand", value: feedData.brand, type: "string" });
  if (feedData.age_group) attrs.push({ key: "age_group", value: feedData.age_group, type: "string" });
  if (feedData.gender) attrs.push({ key: "gender", value: feedData.gender, type: "string" });
  if (feedData.gtin) attrs.push({ key: "gtin", value: feedData.gtin, type: "string" });
  if (feedData.mpn) attrs.push({ key: "mpn", value: feedData.mpn, type: "string" });

  return attrs;
}

/**
 * Map a set of CatalogRows sharing the same product_id into a UcpProductEntity[].
 * Each row is one variant → one UcpProductEntity with a shared item_group.
 */
function rowsToEntities(rows: CatalogRow[]): UcpProductEntity[] {
  return rows.map((r) => {
    const qtyOnHand = parseFloat(r.qty_on_hand || "0");
    const availability = deriveAvailability(
      r.variant_track_inventory,
      qtyOnHand,
      r.variant_allow_backorder
    );
    const condition = deriveCondition(r.fd_condition);

    const offer: UcpOffer = {
      price: { amount: r.variant_price, currency: r.store_currency },
      availability,
      condition,
      item_id: r.variant_id,
    };
    if (r.variant_compare_at_price && parseFloat(r.variant_compare_at_price) > parseFloat(r.variant_price)) {
      // sale_price is the lower current price; compare_at is the original higher price
      // UCP: sale_price = current lower price already in offer.price
      // We expose compare_at as a separate field for strikethrough rendering
      offer.sale_price = { amount: r.variant_compare_at_price, currency: r.store_currency };
    }

    const imageUrl = r.fd_image_url || r.image_url || "";
    const link = buildStoreUrl(r.store_domain, r.product_slug);

    const itemGroup: UcpItemGroup = {
      id: r.product_id,
      title: r.product_title,
      description: r.product_description || "",
      image_url: imageUrl,
      link,
    };
    if (r.fd_brand || r.product_vendor) {
      itemGroup.brand = r.fd_brand || r.product_vendor;
    }
    if (r.fd_google_product_category) {
      itemGroup.google_product_category = r.fd_google_product_category;
    }

    const structuredAttributes = extractStructuredAttributes(r.product_metadata, {
      gtin: r.fd_gtin || undefined,
      mpn: r.fd_mpn || undefined,
      brand: r.fd_brand || r.product_vendor || undefined,
      age_group: r.fd_age_group || undefined,
      gender: r.fd_gender || undefined,
    });

    const entity: UcpProductEntity = {
      id: r.variant_id,
      title: r.variant_title || r.product_title,
      description: r.product_description || "",
      image_url: imageUrl,
      link,
      offers: [offer],
      item_group: itemGroup,
      structured_attributes: structuredAttributes,
    };

    if (r.variant_sku) entity.sku = r.variant_sku;
    if (r.fd_gtin) entity.gtin = r.fd_gtin;
    if (r.fd_mpn) entity.mpn = r.fd_mpn;
    if (r.fd_age_group) entity.age_group = r.fd_age_group;
    if (r.fd_gender) entity.gender = r.fd_gender;
    if (r.fd_google_product_category) entity.google_product_category = r.fd_google_product_category;

    return entity;
  });
}

// ── The core catalog SQL fragment ─────────────────────────────────────────────

const CATALOG_SELECT = `
  SELECT
    pv.id::text                                                             AS variant_id,
    COALESCE(pv.title, p.title, 'Item')                                    AS variant_title,
    COALESCE(pv.sku, '')                                                    AS variant_sku,
    pv.price::text                                                          AS variant_price,
    pv.compare_at_price::text                                               AS variant_compare_at_price,
    pv.is_active                                                            AS variant_is_active,
    pv.allow_backorder                                                      AS variant_allow_backorder,
    pv.track_inventory                                                      AS variant_track_inventory,
    COALESCE(SUM(il.quantity_on_hand), 0)::text                            AS qty_on_hand,
    p.id::text                                                              AS product_id,
    p.title                                                                 AS product_title,
    COALESCE(p.description, '')                                             AS product_description,
    p.slug                                                                  AS product_slug,
    p.type                                                                  AS product_type,
    COALESCE(p.vendor, '')                                                  AS product_vendor,
    COALESCE(p.metadata, '{}'::jsonb)                                       AS product_metadata,
    COALESCE(s.domain, '')                                                  AS store_domain,
    COALESCE(s.currency, 'ZAR')                                             AS store_currency,
    COALESCE(
      (SELECT COALESCE(pm.cdn_url, pm.url)
       FROM product_media pm
       WHERE pm.product_id = p.id
       ORDER BY pm.position ASC, pm.created_at ASC
       LIMIT 1),
      ''
    )                                                                       AS image_url,
    COALESCE(pfd.gtin, pv.barcode, '')                                      AS fd_gtin,
    COALESCE(pfd.mpn, pv.sku, '')                                           AS fd_mpn,
    COALESCE(pfd.brand, p.vendor, '')                                       AS fd_brand,
    COALESCE(pfd.condition, 'new')                                          AS fd_condition,
    COALESCE(pfd.google_product_category, '')                               AS fd_google_product_category,
    COALESCE(pfd.age_group, '')                                             AS fd_age_group,
    COALESCE(pfd.gender, '')                                                AS fd_gender,
    COALESCE(pfd.image_url, '')                                             AS fd_image_url
  FROM product_variants pv
  JOIN products p ON p.id = pv.product_id
  JOIN stores s ON s.id = p.store_id
  LEFT JOIN product_feed_data pfd ON pfd.variant_id = pv.id
  LEFT JOIN inventory_levels il ON il.variant_id = pv.id`;

// ── Public service functions ──────────────────────────────────────────────────

/**
 * Get paginated UCP catalog for a store (all active variants as product entities).
 *
 * Pagination: page-based (page 1-indexed, page_size 1–250).
 */
export async function getUcpCatalog(
  storeId: string,
  page: number = 1,
  pageSize: number = DEFAULT_PAGE_SIZE
): Promise<UcpCatalogResponse> {
  const pool = getPool();
  const ps = Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
  const pg = Math.max(page, 1);
  const offset = (pg - 1) * ps;

  // Fetch one extra to determine has_more
  const { rows } = await pool.query<CatalogRow>(
    `${CATALOG_SELECT}
     WHERE p.store_id = $1::uuid
       AND p.status = 'active'
       AND pv.is_active = true
     GROUP BY pv.id, p.id, s.domain, s.currency,
              pfd.gtin, pfd.mpn, pfd.brand, pfd.condition,
              pfd.google_product_category, pfd.age_group, pfd.gender, pfd.image_url
     ORDER BY p.created_at DESC, pv.position ASC, pv.created_at ASC
     LIMIT $2 OFFSET $3`,
    [storeId, ps + 1, offset]
  );

  const hasMore = rows.length > ps;
  const pageRows = rows.slice(0, ps);

  // Total count
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

  return {
    products: rowsToEntities(pageRows),
    total,
    page: pg,
    page_size: ps,
    has_more: hasMore,
    next_page: hasMore ? pg + 1 : undefined,
  };
}

/**
 * Get a single product entity by product ID, returning all active variants.
 *
 * UCP product-level endpoint: returns one UcpCatalogResponse with all
 * variants of the product grouped under a shared item_group.
 */
export async function getUcpProduct(
  storeId: string,
  productId: string
): Promise<UcpCatalogResponse | null> {
  const pool = getPool();

  // Check product exists + is active
  const { rows: checkRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM products
     WHERE id = $1::uuid AND store_id = $2::uuid AND status = 'active'`,
    [productId, storeId]
  );
  if (checkRows.length === 0) return null;

  const { rows } = await pool.query<CatalogRow>(
    `${CATALOG_SELECT}
     WHERE p.id = $1::uuid
       AND p.store_id = $2::uuid
       AND p.status = 'active'
       AND pv.is_active = true
     GROUP BY pv.id, p.id, s.domain, s.currency,
              pfd.gtin, pfd.mpn, pfd.brand, pfd.condition,
              pfd.google_product_category, pfd.age_group, pfd.gender, pfd.image_url
     ORDER BY pv.position ASC, pv.created_at ASC`,
    [productId, storeId]
  );

  const entities = rowsToEntities(rows);

  return {
    products: entities,
    total: entities.length,
    page: 1,
    page_size: entities.length,
    has_more: false,
  };
}
