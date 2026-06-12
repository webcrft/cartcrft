# Cartcrft UCP Adapter

**Pinned spec version:** 2026-01 NRF baseline, provisional
**Adapter location:** `backend/src/agent/ucp/v2026_01/`
**Version registry:** `backend/src/agent/ucp/index.ts`

---

## Overview

The Universal Commerce Protocol (UCP) adapter exposes conformance endpoints for Google surfaces (Shopping, Lens, Maps, Assistant) and the NRF 2026 standardisation effort. UCP is a young, provisional spec — this implementation pins the 2026-01 NRF baseline and documents all divergences and pragmatic assumptions below.

Like the ACP adapter, UCP is date-versioned and isolated under `backend/src/agent/ucp/` so spec churn never touches core commerce modules. The adapter imports (never edits) the same catalog/cart/checkout services used by the rest of the platform.

All UCP endpoints are mounted at:
- `/ucp/:storeId/...` — unversioned (pinned to latest: 2026-01)
- `/ucp/v2026-01/:storeId/...` — explicit version (for negotiation windows)

---

## Endpoint Table

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/ucp/:storeId/catalog` | cc_pub_ / cc_prv_ (commerce:read) | Paginated product entities with offers, item groups, structured attributes |
| `GET` | `/ucp/:storeId/catalog/:productId` | cc_pub_ / cc_prv_ (commerce:read) | All active variants for a single product as UCP entities |
| `POST` | `/ucp/:storeId/checkout` | cc_pub_ / cc_prv_ (commerce:read) | Create checkout entity from line_items |
| `PATCH` | `/ucp/:storeId/checkout/:checkoutId` | cc_pub_ / cc_prv_ (commerce:read) | Update buyer/address/fulfillment; re-totals |
| `POST` | `/ucp/:storeId/checkout/:checkoutId/submit` | cc_pub_ / cc_prv_ (commerce:read) | Submit (test mode → real order; live → 501) |

**Response header:** `UCP-Version: 2026-01` on all responses.

**Idempotency:** `Idempotency-Key` header honored on checkout create and submit.

---

## Catalog: Field Mapping (Core → UCP)

### UcpProductEntity (one per active variant)

| UCP Field | Core Source | Notes |
|-----------|-------------|-------|
| `id` | `product_variants.id` | UUID; one entity per active variant |
| `title` | `COALESCE(pv.title, p.title)` | Variant title if set, else product title |
| `description` | `products.description` | Plain text |
| `image_url` | `product_feed_data.image_url` → `product_media` (first by position) | Falls back to first media row |
| `link` | `store.domain + /products/ + p.slug` | Relative `/products/:slug` when no domain set |
| `sku` | `product_variants.sku` | Optional |
| `gtin` | `product_feed_data.gtin` → `product_variants.barcode` | Enrichment when feed data present |
| `mpn` | `product_feed_data.mpn` → `product_variants.sku` | |
| `age_group` | `product_feed_data.age_group` | |
| `gender` | `product_feed_data.gender` | |
| `google_product_category` | `product_feed_data.google_product_category` | Google Shopping taxonomy string |

### UcpOffer (one per variant, inside `offers[]`)

| UCP Field | Core Source | Notes |
|-----------|-------------|-------|
| `price.amount` | `product_variants.price::text` | Numeric string, e.g. `"29.99"` |
| `price.currency` | `stores.currency` | ISO-4217 |
| `availability` | Derived from `inventory_levels` | See Availability Mapping below |
| `condition` | `product_feed_data.condition` (lowercased) | Mapped to enum: `NEW` / `USED` / `REFURBISHED`; default `NEW` |
| `item_id` | `product_variants.id` | Ties offer back to the variant |
| `sale_price` | `product_variants.compare_at_price` | Exposed as `sale_price` when compare_at > current price |

#### Availability Mapping

| Core state | UCP value |
|-----------|-----------|
| `track_inventory = false` | `IN_STOCK` |
| `track_inventory = true`, `qty_on_hand > 0` | `IN_STOCK` |
| `track_inventory = true`, `qty_on_hand = 0`, `allow_backorder = true` | `BACKORDER` |
| `track_inventory = true`, `qty_on_hand = 0`, `allow_backorder = false` | `OUT_OF_STOCK` |

> Note: `PREORDER` is not yet mapped. Cartcrft's schema does not have an explicit preorder status column. Future work: add `preorder_available_from` to `product_variants` and map `PREORDER` when that date is in the future.

### UcpItemGroup (inside `item_group{}`)

| UCP Field | Core Source | Notes |
|-----------|-------------|-------|
| `id` | `products.id` | Groups all variants of the same product |
| `title` | `products.title` | Product-level title |
| `description` | `products.description` | |
| `image_url` | First product media image | |
| `link` | Store domain + product slug URL | |
| `brand` | `product_feed_data.brand` → `products.vendor` | |
| `google_product_category` | `product_feed_data.google_product_category` | |

### structured_attributes

Structured attributes are extracted from two sources:
1. **`products.metadata` (JSONB):** Top-level string/number/boolean key-value pairs are surfaced as `{ key, value, type }` objects.
2. **`product_feed_data`:** `brand`, `age_group`, `gender`, `gtin`, `mpn` are appended as typed attributes.

This allows Google's custom_label fields and structured data requirements to be served without schema changes.

### Pagination

Page-based (not cursor-based — divergence from ACP). Query params: `page` (1-indexed, default 1), `page_size` (1–250, default 50). Response: `{ products, total, page, page_size, has_more, next_page? }`.

**Assumption:** UCP spec uses page-based pagination (vs. ACP cursor-based) to align with Google's typical feed ingestion patterns. If the spec standardises on cursors, this is a one-file change.

---

## Checkout: Field Mapping (Core → UCP)

### UcpCheckoutEntity

| UCP Field | Core Source | Notes |
|-----------|-------------|-------|
| `id` | `checkouts.id` | Same UUID used for both |
| `store_id` | `checkouts.store_id` | |
| `status` | `checkouts.status` | Mapped: `pending`→`OPEN`, `completed`→`COMPLETED`, `expired`→`EXPIRED` (uppercase) |
| `line_items[].variant_id` | `cart_lines.variant_id` | |
| `line_items[].quantity` | `cart_lines.quantity` | |
| `line_items[].unit_price` | `cart_lines.price` | Price snapshot at cart-add time |
| `buyer.email` | `checkouts.email` | |
| `buyer.shipping_address` | `checkouts.shipping_address` | Field name remapping: `province_code`→`state_or_province`, `zip`→`postal_code` |
| `buyer.billing_address` | `checkouts.billing_address` | Same remapping |
| `selected_fulfillment_id` | `checkouts.shipping_rate.id` | UUID of selected shipping rate |
| `fulfillment_options` | `shipping_rates` (store's active rates) | Filtered by `buyer.shipping_address.country_code` when present |
| `totals.*` | `checkouts.*_total` | String; same as ACP |
| `payment_readiness.ready` | Derived | `true` if email + shipping_address.country_code + (no open fulfillment options OR shipping_rate set) |
| `payment_readiness.missing` | Derived | UCP field names: `buyer.email`, `buyer.shipping_address`, `selected_fulfillment_id` |
| `created_at` / `updated_at` | `checkouts.*_at` | ISO-8601 |

### Address field name differences (Core vs UCP)

| Core field | UCP field | Note |
|-----------|-----------|------|
| `province_code` | `state_or_province` | UCP uses fuller name |
| `zip` | `postal_code` | UCP is more explicit |
| `address1` / `address2` | same | No change |
| `country_code` | `country_code` | Same |

The adapter performs bidirectional remapping on PATCH (inbound UCP → core) and on GET (core → outbound UCP).

---

## Error Code Mapping

| Cartcrft code | UCP code | HTTP |
|---------------|----------|------|
| `NOT_FOUND` | `ENTITY_NOT_FOUND` | 404 |
| `VALIDATION_ERROR` | `INVALID_REQUEST` | 400 |
| `UNAUTHORIZED` | `AUTHENTICATION_REQUIRED` | 401 |
| `FORBIDDEN` | `PERMISSION_DENIED` | 403 |
| `INSUFFICIENT_INVENTORY` | `INVENTORY_UNAVAILABLE` | 422 |
| `DISCOUNT_EXHAUSTED` | `PROMOTION_EXHAUSTED` | 422 |
| `DISCOUNT_ALREADY_USED` | `PROMOTION_ALREADY_REDEEMED` | 422 |
| `MANDATE_SPEND_LIMIT_EXCEEDED` | `MANDATE_SPEND_LIMIT_EXCEEDED` | 422 |
| `MANDATE_REQUIRED` | `MANDATE_REQUIRED` | 422 |
| `INTERNAL_ERROR` | `INTERNAL_ERROR` | 500 |
| (live payment token) | `PAYMENT_TOKEN_UNSUPPORTED` | 501 |

**UCP error shape:** `{ error: { code: string, message: string, field?: string } }`

The optional `field` property names the request field that caused the error, which differs from ACP (ACP has no `field`). This is a UCP extension.

---

## Divergences and Assumptions

### 1. Spec maturity — 2026-01 NRF baseline, provisional

The UCP spec (Google / NRF 2026 Universal Commerce Protocol) had very sparse public documentation at implementation time. All design decisions are pragmatic and documented here. Breaking changes are expected as the spec matures.

**Decision:** Mirror ACP's shape where possible, adapt field names to align with Google's Shopping API conventions (e.g., SCREAMING_SNAKE_CASE for enum values, `item_group_id` concept via `item_group` object).

### 2. Live payment token passthrough — NOT YET SUPPORTED

`POST .../checkout/:id/submit` with `mode = "live"` or `payment_token` present (and `mode != "test"`) returns:

```json
HTTP 501
{
  "error": {
    "code": "PAYMENT_TOKEN_UNSUPPORTED",
    "message": "Live-mode payment token passthrough is not yet supported. ..."
  }
}
```

**Roadmap:** Same as ACP — wire to store's configured payment provider once live-mode delegate payment flows are implemented.

### 3. Checkout uses PATCH (not POST) for updates

Unlike ACP (which uses POST for both create and update of sessions), UCP uses `PATCH /ucp/:storeId/checkout/:id` for updates. This is semantically correct for partial updates and aligns with REST conventions. The core `updateCheckout()` service is used in both cases.

### 4. Page-based pagination (not cursor-based)

UCP catalog uses `page` / `page_size` pagination. ACP uses opaque base64url cursors. Rationale: Google Shopping feed ingestion typically uses numeric page offsets; cursor-based pagination is harder to integrate with feed crawlers. If the spec standardises on cursors, this is a one-file change.

### 5. PREORDER availability not mapped

Cartcrft does not have an explicit `preorder_available_from` column on `product_variants`. The `PREORDER` enum value in `UcpOffer.availability` is defined but never emitted. `allow_backorder = true, qty = 0` maps to `BACKORDER` instead. Future work: add preorder date support to variants schema and emit `PREORDER` when appropriate.

### 6. Multi-currency price lists

The catalog currently returns `product_variants.price` (base price in store currency). Per-currency price list lookups (`price_list_items`, T2.2) are not yet surfaced. A `currency` query parameter will be added to select the appropriate price list in a future pass.

### 7. Fulfillment options — static rates only

Same limitation as ACP: only static `shipping_rates` are returned. BobGo live rates (T2.6) and collection points (PUDO) are not surfaced in `fulfillment_options`.

### 8. Mandate enforcement

UCP checkouts do not currently require an agent mandate. The `verifyAgentCheckout()` function (T3.3) can be wired when `X-Cartcrft-Agent` header is present on UCP checkout create/submit.

### 9. Relationship to ACP adapter

UCP and ACP serve different protocol surfaces:

| Dimension | ACP | UCP |
|-----------|-----|-----|
| Purpose | Agent-to-agent commerce (LLM + autonomous agents) | Google surfaces (Shopping, Lens, Assistant) + NRF standard |
| Spec | ACP 2026-04 baseline | UCP 2026-01 NRF baseline (provisional) |
| Product surface | Feed (one item per variant) | Catalog (entity per variant with item_group + offers) |
| Checkout sessions | `checkout_sessions` resource (POST create, POST update, POST complete) | `checkout` resource (POST create, PATCH update, POST submit) |
| Status enum | lowercase (`open`, `completed`) | SCREAMING_SNAKE (`OPEN`, `COMPLETED`) |
| Error codes | lowercase with underscores | SCREAMING_SNAKE |
| Availability | lowercase (`in_stock`, `out_of_stock`) | SCREAMING_SNAKE (`IN_STOCK`, `OUT_OF_STOCK`, `BACKORDER`) |
| Pagination | Cursor-based | Page-based |
| Address fields | `province_code` / `zip` | `state_or_province` / `postal_code` |
| Idempotency | `Idempotency-Key` header | `Idempotency-Key` header (same) |
| Version header | `ACP-Version: 2026-04` | `UCP-Version: 2026-01` |

Both adapters consume the same core services (catalog, cart, checkout, complete) without modification. They co-exist under `backend/src/agent/`.

---

## Versioning

The adapter uses date-versioned directories under `backend/src/agent/ucp/`:

```
backend/src/agent/ucp/
├── index.ts          ← version registry (registers each version at its prefix)
└── v2026_01/
    ├── types.ts      ← UCP 2026-01 wire types
    ├── catalog.ts    ← catalog service (product entities + pagination)
    ├── checkout.ts   ← checkout service (create/update/submit)
    └── routes.ts     ← Fastify plugin (routes relative, prefix injected by index)
```

To add a new UCP version:
1. Create `backend/src/agent/ucp/vYYYY_MM/` with the new types/catalog/checkout/routes
2. Register in `index.ts` under `/ucp/vYYYY-MM`
3. Update this doc with the new version's endpoint table and divergences
4. Optionally re-point the unversioned `/ucp` prefix to the new version
