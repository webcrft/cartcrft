/**
 * UCP 2026-01 baseline type definitions.
 *
 * Pinned spec version: 2026-01 NRF baseline, provisional
 * These types represent the wire shape of the Universal Commerce Protocol adapter.
 * Core types are mapped from Cartcrft internal types here; see docs/ucp.md for
 * the full field mapping table.
 *
 * UCP targets Google surfaces (Shopping, Lens, Maps, Assistant) and NRF 2026
 * standardisation efforts. The spec is sparse/provisional — design decisions
 * are documented in docs/ucp.md under "Assumptions / Divergences".
 */

// ── Catalog ───────────────────────────────────────────────────────────────────

/**
 * UCP product offer — price + availability for a specific variant + surface.
 *
 * One UCP ProductEntity may carry multiple offers (e.g. different currencies),
 * but we currently emit one offer per variant using the store's base currency.
 */
export interface UcpOffer {
  price: {
    amount: string;   // numeric string, e.g. "29.99"
    currency: string; // ISO-4217
  };
  availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "BACKORDER";
  condition: "NEW" | "USED" | "REFURBISHED";
  /** Variant / SKU identifier */
  item_id: string;
  /** Optional compare-at price for showing strikethrough */
  sale_price?: { amount: string; currency: string } | undefined;
}

/**
 * UCP item group — groups variants of the same parent product.
 * Maps to Google's item_group_id concept.
 */
export interface UcpItemGroup {
  id: string;           // products.id
  title: string;        // products.title
  description: string;  // products.description
  image_url: string;    // first media image
  link: string;         // storefront URL
  brand?: string | undefined;
  google_product_category?: string | undefined;
}

/**
 * UCP structured attribute — key/value pair from product feed data or
 * product.attributes (metadata). Maps to Google's custom_label / attribute fields.
 */
export interface UcpAttribute {
  key: string;
  value: string;
  type?: "string" | "number" | "boolean" | undefined;
}

/**
 * UCP ProductEntity — one entry per active variant.
 *
 * Field mapping (Cartcrft core → UCP):
 *  product_variants.id         → id
 *  products.title + pv.title   → title (variant-enriched)
 *  products.description        → description
 *  pv.price + store.currency   → offers[0].price
 *  inventory_levels            → offers[0].availability
 *  product_media               → image_url (first by position)
 *  products.id                 → item_group.id (groups variants)
 *  product_feed_data.*         → attributes + feed enrichment
 *  products.attributes/metadata→ structured_attributes
 */
export interface UcpProductEntity {
  id: string;               // variant UUID
  title: string;            // variant-level title
  description: string;
  image_url: string;
  link: string;             // storefront URL
  sku?: string | undefined;
  gtin?: string | undefined;
  mpn?: string | undefined;
  age_group?: string | undefined;
  gender?: string | undefined;
  /** Google product category taxonomy string */
  google_product_category?: string | undefined;
  /** Pricing + availability offers */
  offers: UcpOffer[];
  /** item_group links this variant to its parent product */
  item_group: UcpItemGroup;
  /** Structured attributes from product_feed_data + products.metadata */
  structured_attributes: UcpAttribute[];
}

export interface UcpCatalogResponse {
  products: UcpProductEntity[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
  next_page?: number | undefined;
}

// ── Checkout ──────────────────────────────────────────────────────────────────

export interface UcpLineItem {
  variant_id: string;
  quantity: number;
  /** Unit price at time of checkout creation (string, numeric) */
  unit_price?: string | undefined;
}

export interface UcpAddress {
  name?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  address1?: string | undefined;
  address2?: string | undefined;
  city?: string | undefined;
  state_or_province?: string | undefined;
  postal_code?: string | undefined;
  country_code?: string | undefined;
}

export interface UcpFulfillmentOption {
  id: string;
  name: string;
  price: { amount: string; currency: string };
  estimated_days_min?: number | undefined;
  estimated_days_max?: number | undefined;
  carrier?: string | undefined;
}

export interface UcpBuyer {
  email?: string | undefined;
  shipping_address?: UcpAddress | undefined;
  billing_address?: UcpAddress | undefined;
}

/**
 * UCP CheckoutEntity — the primary checkout object.
 *
 * Field mapping (Cartcrft checkout → UCP):
 *  checkouts.id              → id
 *  checkouts.store_id        → store_id
 *  checkouts.status          → status (pending→"OPEN", completed→"COMPLETED", expired→"EXPIRED")
 *  cart_lines                → line_items
 *  checkouts.email + addrs   → buyer
 *  shipping_rates            → fulfillment_options
 *  checkouts.subtotal        → totals.subtotal
 *  checkouts.shipping_total  → totals.shipping
 *  checkouts.tax_total       → totals.tax
 *  checkouts.discount_total  → totals.discount
 *  checkouts.total           → totals.total
 *  checkouts.currency        → totals.currency
 */
export interface UcpCheckoutEntity {
  id: string;
  store_id: string;
  status: "OPEN" | "COMPLETED" | "EXPIRED";
  line_items: UcpLineItem[];
  buyer?: UcpBuyer | undefined;
  selected_fulfillment_id?: string | undefined;
  fulfillment_options: UcpFulfillmentOption[];
  totals: {
    subtotal: string;
    shipping: string;
    tax: string;
    discount: string;
    total: string;
    currency: string;
  };
  /** Machine-readable readiness assessment */
  payment_readiness: {
    ready: boolean;
    missing: string[];
  };
  created_at: string;  // ISO-8601
  updated_at: string;  // ISO-8601
}

export interface UcpCheckoutCreateResponse {
  checkout: UcpCheckoutEntity;
}

export interface UcpCheckoutUpdateResponse {
  checkout: UcpCheckoutEntity;
}

export interface UcpCheckoutSubmitResponse {
  checkout: UcpCheckoutEntity;
  order_reference: {
    order_id: string;
    order_number: string;
  };
}

// ── Error objects ─────────────────────────────────────────────────────────────

/**
 * UCP error envelope — machine-readable, maps from Cartcrft error codes.
 *
 * Code mapping (Cartcrft → UCP):
 *  NOT_FOUND              → ENTITY_NOT_FOUND
 *  VALIDATION_ERROR       → INVALID_REQUEST
 *  UNAUTHORIZED           → AUTHENTICATION_REQUIRED
 *  FORBIDDEN              → PERMISSION_DENIED
 *  INSUFFICIENT_INVENTORY → INVENTORY_UNAVAILABLE
 *  DISCOUNT_EXHAUSTED     → PROMOTION_EXHAUSTED
 *  DISCOUNT_ALREADY_USED  → PROMOTION_ALREADY_REDEEMED
 *  INTERNAL_ERROR         → INTERNAL_ERROR
 *  (live payment tokens)  → PAYMENT_TOKEN_UNSUPPORTED (501)
 */
export interface UcpError {
  code: string;
  message: string;
  field?: string | undefined;
  details?: unknown;
}

export interface UcpErrorResponse {
  error: UcpError;
}
