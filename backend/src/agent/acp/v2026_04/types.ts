/**
 * ACP 2026-04 baseline type definitions.
 *
 * Pinned spec version: 2026-04
 * These types represent the wire shape of the Agentic Commerce Protocol adapter.
 * Core types are mapped from Cartcrft internal types here; see docs/acp.md for
 * the full field mapping table.
 */

// ── Product feed ──────────────────────────────────────────────────────────────

/**
 * ACP product feed item — one entry per active variant.
 *
 * Field mapping (Cartcrft core → ACP):
 *  product_variants.id          → id
 *  products.title / pv.title    → title
 *  products.description         → description
 *  store domain + product slug  → link
 *  pv.price + store.currency    → price (object with amount + currency)
 *  inventory_levels             → availability ("in_stock" | "out_of_stock" | "preorder")
 *  product_media (first image)  → image_link
 *  products.id                  → item_group_id (groups variants of same product)
 *  product_feed_data.*          → attribute enrichment (gtin, mpn, brand, condition, etc.)
 */
export interface AcpFeedItem {
  id: string;
  title: string;
  description: string;
  link: string;
  price: {
    amount: string;   // numeric string, e.g. "29.99"
    currency: string; // ISO-4217, e.g. "ZAR"
  };
  availability: "in_stock" | "out_of_stock" | "preorder";
  image_link: string;
  item_group_id: string;      // product UUID — groups variants
  condition?: string | undefined;         // "new" | "refurbished" | "used"
  brand?: string | undefined;
  gtin?: string | undefined;
  mpn?: string | undefined;
  google_product_category?: string | undefined;
  age_group?: string | undefined;
  gender?: string | undefined;
  variant_title?: string | undefined;
  sku?: string | undefined;
}

export interface AcpFeedResponse {
  items: AcpFeedItem[];
  total: number;
  cursor: string | null;   // opaque cursor for next page
  has_more: boolean;
}

// ── Checkout sessions ─────────────────────────────────────────────────────────

export interface AcpLineItem {
  variant_id: string;
  quantity: number;
}

export interface AcpAddress {
  name?: string;
  phone?: string;
  email?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province_code?: string;
  zip?: string;
  country_code?: string;
}

export interface AcpFulfillmentOption {
  id: string;
  name: string;
  price: { amount: string; currency: string };
  estimated_days?: number | undefined;
  carrier?: string | undefined;  // populated when shipping_rates.carrier column exists (T2.6+)
}

export interface AcpPaymentReadiness {
  ready: boolean;
  missing: string[];  // e.g. ["email", "shipping_address", "shipping_rate"]
}

/**
 * ACP checkout session.
 *
 * Field mapping (Cartcrft checkout → ACP):
 *  checkouts.id                → id
 *  checkouts.subtotal          → totals.subtotal
 *  checkouts.shipping_total    → totals.shipping
 *  checkouts.tax_total         → totals.tax
 *  checkouts.discount_total    → totals.discount
 *  checkouts.total             → totals.total
 *  checkouts.currency          → totals.currency
 *  checkouts.status            → status ("open" | "completed" | "expired")
 *  shipping_zones/rates        → fulfillment_options
 */
export interface AcpCheckoutSession {
  id: string;
  store_id: string;
  status: "open" | "completed" | "expired";
  line_items: AcpLineItem[];
  buyer?: {
    email?: string | undefined;
    shipping_address?: AcpAddress | undefined;
    billing_address?: AcpAddress | undefined;
  } | undefined;
  selected_fulfillment_id?: string | undefined;
  fulfillment_options: AcpFulfillmentOption[];
  totals: {
    subtotal: string;
    shipping: string;
    tax: string;
    discount: string;
    total: string;
    currency: string;
  };
  payment_readiness: AcpPaymentReadiness;
  created_at: string;  // ISO-8601
  updated_at: string;  // ISO-8601
}

export interface AcpSessionCreatedResponse {
  session: AcpCheckoutSession;
}

export interface AcpSessionCompleteResponse {
  session: AcpCheckoutSession;
  order_id: string;
  order_number: string;
}

// ── Error objects ─────────────────────────────────────────────────────────────

/**
 * ACP error envelope — machine-readable, maps from Cartcrft error codes.
 *
 * Code mapping (Cartcrft → ACP):
 *  NOT_FOUND              → session_not_found / feed_not_found
 *  VALIDATION_ERROR       → invalid_request
 *  UNAUTHORIZED           → unauthorized
 *  FORBIDDEN              → forbidden
 *  INSUFFICIENT_INVENTORY → insufficient_inventory
 *  DISCOUNT_EXHAUSTED     → discount_exhausted
 *  DISCOUNT_ALREADY_USED  → discount_already_used
 *  INTERNAL_ERROR         → internal_error
 *  DELEGATE_PAYMENT_LIVE_MODE_UNSUPPORTED → not_supported
 */
export interface AcpError {
  code: string;
  message: string;
  details?: unknown;
}

export interface AcpErrorResponse {
  error: AcpError;
}
