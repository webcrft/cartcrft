---
title: "ACP Adapter"
description: "Agentic Commerce Protocol adapter — versioned, isolated API surface for agent-driven checkout flows. Pinned to the 2026-04 baseline."
sidebar:
  label: "ACP Adapter"
  order: 2
---

# Cartcrft ACP Adapter

**Pinned spec version:** 2026-04 baseline
**Adapter location:** `backend/src/agent/acp/v2026_04/`
**Version registry:** `backend/src/agent/acp/index.ts`

---

## Overview

The Agentic Commerce Protocol (ACP) adapter exposes a versioned, isolated API surface for agent-driven commerce interactions. Spec churn never touches the core commerce modules — the adapter wraps core cart/checkout/feed services without modifying them.

All ACP endpoints are mounted at `/acp/:storeId/...` (unversioned, pinned to latest) and `/acp/v2026-04/:storeId/...` (explicit version, for negotiation windows).

---

## Endpoint Table

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/acp/:storeId/feed` | cc_pub_ / cc_prv_ (commerce:read) | Paginated JSON product feed in ACP shape |
| `POST` | `/acp/:storeId/checkout_sessions` | cc_pub_ / cc_prv_ (commerce:read) | Create ACP checkout session from line_items |
| `GET` | `/acp/:storeId/checkout_sessions/:sessionId` | cc_pub_ / cc_prv_ (commerce:read) | Get session by id |
| `POST` | `/acp/:storeId/checkout_sessions/:sessionId` | cc_pub_ / cc_prv_ (commerce:read) | Update buyer info / fulfillment selection; re-totals |
| `POST` | `/acp/:storeId/checkout_sessions/:sessionId/complete` | cc_pub_ / cc_prv_ (commerce:read) | Complete session (test mode → real order; live mode → 501) |

**Response header:** `ACP-Version: 2026-04` on all responses.

**Idempotency:** `Idempotency-Key` header honored on session create and complete.

---

## Product Feed: Field Mapping

| ACP Field | Core Source | Notes |
|-----------|-------------|-------|
| `id` | `product_variants.id` | UUID; one entry per active variant |
| `title` | `COALESCE(pv.title, p.title)` | Variant title if set, else product title |
| `description` | `products.description` | Plain text; HTML stripped at query level |
| `link` | `store.domain + /products/ + p.slug` | Falls back to relative path if no domain |
| `price.amount` | `product_variants.price::text` | String, e.g. `"29.99"` |
| `price.currency` | `stores.currency` | ISO-4217, e.g. `"ZAR"` |
| `availability` | `inventory_levels.quantity_on_hand` | `"in_stock"` if `track_inventory=false` or `qty>0`; `"out_of_stock"` if tracked & qty=0 |
| `image_link` | `product_feed_data.image_url` → `product_media` (first, by position) | Falls back to first media row |
| `item_group_id` | `products.id` | Groups all variants of the same product |
| `condition` | `product_feed_data.condition` | Default `"new"` |
| `brand` | `product_feed_data.brand` → `products.vendor` | Enrichment when feed_data present |
| `gtin` | `product_feed_data.gtin` → `product_variants.barcode` | |
| `mpn` | `product_feed_data.mpn` → `product_variants.sku` | |
| `google_product_category` | `product_feed_data.google_product_category` | |
| `age_group` | `product_feed_data.age_group` | |
| `gender` | `product_feed_data.gender` | |
| `variant_title` | `product_variants.title` | ACP extension field |
| `sku` | `product_variants.sku` | ACP extension field |

**Pagination:** cursor-based (opaque base64url-encoded offset). Query params: `limit` (1–500, default 100), `cursor`. Response: `{ items, total, cursor, has_more }`.

---

## Checkout Session: Field Mapping

| ACP Field | Core Source | Notes |
|-----------|-------------|-------|
| `id` | `checkouts.id` | Same UUID used for checkout and ACP session |
| `store_id` | `checkouts.store_id` | |
| `status` | `checkouts.status` | Mapped: `pending`→`open`, `completed`→`completed`, `expired`→`expired` |
| `line_items` | `cart_lines` (via checkout.cart_id) | Array of `{ variant_id, quantity }` |
| `buyer.email` | `checkouts.email` | |
| `buyer.shipping_address` | `checkouts.shipping_address` | JSON passthrough |
| `buyer.billing_address` | `checkouts.billing_address` | JSON passthrough |
| `selected_fulfillment_id` | `checkouts.shipping_rate.id` | UUID of selected shipping rate |
| `fulfillment_options` | `shipping_rates` (store's active rates) | Filtered by country if `buyer.shipping_address.country_code` present |
| `totals.subtotal` | `checkouts.subtotal::text` | String |
| `totals.shipping` | `checkouts.shipping_total::text` | String |
| `totals.tax` | `checkouts.tax_total::text` | String |
| `totals.discount` | `checkouts.discount_total::text` | String |
| `totals.total` | `checkouts.total::text` | String |
| `totals.currency` | `checkouts.currency` | ISO-4217 |
| `payment_readiness.ready` | Derived | `true` if email + shipping_address + shipping_rate set |
| `payment_readiness.missing` | Derived | Array of missing field names |
| `created_at` | `checkouts.created_at` | ISO-8601 |
| `updated_at` | `checkouts.updated_at` | ISO-8601 |

---

## Error Code Mapping

| Cartcrft code | ACP code | HTTP |
|---------------|----------|------|
| `NOT_FOUND` | `session_not_found` | 404 |
| `VALIDATION_ERROR` | `invalid_request` | 400 |
| `UNAUTHORIZED` | `unauthorized` | 401 |
| `FORBIDDEN` | `forbidden` | 403 |
| `INSUFFICIENT_INVENTORY` | `insufficient_inventory` | 422 |
| `DISCOUNT_EXHAUSTED` | `discount_exhausted` | 422 |
| `DISCOUNT_ALREADY_USED` | `discount_already_used` | 422 |
| `INTERNAL_ERROR` | `internal_error` | 500 |
| (live-mode delegate payment) | `DELEGATE_PAYMENT_LIVE_MODE_UNSUPPORTED` | 501 |

**ACP error shape:** `{ error: { code: string, message: string } }`

---

## Divergences from ACP Spec / TODOs

### 1. Delegate payment live mode — NOT YET SUPPORTED

`POST .../checkout_sessions/:id/complete` with `payment_data.mode = "live"` returns:

```json
HTTP 501
{
  "error": {
    "code": "DELEGATE_PAYMENT_LIVE_MODE_UNSUPPORTED",
    "message": "Delegate payment live mode is not yet supported. ..."
  }
}
```

**Roadmap:** Live-mode card token passthrough requires wiring to the store's configured payment provider (Stripe/Paystack/Razorpay/Xendit). The checkout already has a `payment_session` concept (T2.4); ACP live mode will call `createStripeSession` / `createPaystackSession` etc. based on the store's provider config, then complete via the provider's payment intent flow.

### 2. Webhooks — out of scope for 2026-04

ACP session completion webhooks (e.g., `checkout.completed` → ACP callback URL) are not yet implemented. The core `dispatchStoreEvent()` infrastructure (T2.10) will be wired to fire ACP callbacks in a future pass.

### 3. Fulfillment options — static rates only

The current 2026-04 release returns static shipping rates from `shipping_rates` / `shipping_zones`. Live rates from BobGo (T2.6) and collection points (PUDO) are not yet surfaced in `fulfillment_options`. The `carrier` field on `AcpFulfillmentOption` is reserved for T2.6.

### 4. Mandate enforcement at ACP checkout

ACP sessions do not currently require an agent mandate. The `verifyAgentCheckout()` function (T3.3) is available for wiring: when an `X-Cartcrft-Agent` header is present on the ACP checkout create/complete, we should call `verifyAgentCheckout()` to enforce spend limits. This is a follow-up in the mandate integration pass.

### 5. `preorder` availability not yet mapped

The `availability` field supports `"preorder"` in the ACP spec. Cartcrft's schema has `allow_backorder` on variants but no explicit preorder status. Mapping `allow_backorder = true AND qty = 0 → preorder` is a TODO.

### 6. Multi-currency price lists

The feed currently returns `product_variants.price` (the base price). Per-currency price list lookups (T2.2's `price_list_items`) are not yet surfaced in the ACP feed. A `currency` query parameter on the feed endpoint will be added to select the appropriate price list.

---

## Versioning

The adapter uses date-versioned directories under `backend/src/agent/acp/`:

```
backend/src/agent/acp/
├── index.ts          ← version registry (registers each version at its prefix)
└── v2026_04/
    ├── types.ts      ← ACP 2026-04 wire types
    ├── feed.ts       ← product feed service
    ├── sessions.ts   ← checkout session service
    └── routes.ts     ← Fastify plugin (routes relative, prefix injected by index)
```

To add a new ACP version:
1. Create `backend/src/agent/acp/vYYYY_MM/` with the new types/feed/sessions/routes
2. Register in `index.ts` under `/acp/vYYYY-MM`
3. Update this doc with the new version's endpoint table and divergences
4. Optionally re-point the unversioned `/acp` prefix to the new version
