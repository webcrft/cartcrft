---
title: "Commerce capabilities"
description: "Full surface area of Cartcrft's standard-ecommerce modules: catalog, inventory, checkout, payments, discounts, B2B, subscriptions, returns, shipping, tax, wallet, digital products, bookings, feeds, analytics, and engagement."
---

# Commerce capabilities

Cartcrft is a headless commerce platform built as a set of Fastify modules, each
owning a slice of the commerce surface. Every route is under
`/commerce/stores/:storeId/...` and is protected by the store-auth middleware
(`cc_pub_` read-tier, `cc_prv_` write/admin-tier, or a management JWT). See
[API Overview](./api-overview.md) for auth conventions and error codes.

---

## Catalog

Products, variants, options, media, bundles, digital files, reviews, tags,
collections, price lists, metafields, and i18n translations.

### Product types

| Type | Description |
|------|-------------|
| `simple` | Single SKU, flat price |
| `bundle` | Fixed set of variant SKUs |
| `configurable` | Multiple options (size, colour) each mapping to a variant |
| `digital` | Downloadable file attached via `digital_product_files` |
| `service` | Bookable or appointable (time-based) |
| `subscription` | Recurring billing via subscription-plans |
| `rental` | Time-windowed rental with availability calendar |

### Key endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/products` | read |
| `POST` | `/products` | write |
| `GET/PUT/DELETE` | `/products/:productId` | read / write / admin |
| `GET/POST` | `/products/:productId/variants` | read / write |
| `PUT/DELETE` | `/products/:productId/variants/:variantId` | write |
| `GET/POST/DELETE` | `/products/:productId/options/:optionId` | write |
| `POST/DELETE` | `/products/:productId/media` | write |
| `GET/POST/DELETE` | `/products/:productId/bundle-items` | write |
| `GET/POST/DELETE` | `/products/:productId/digital-files` | write |
| `GET/POST` | `/products/:productId/reviews` | read / write |
| `GET/PUT` | `/products/:productId/tags` | read / write |
| `GET/POST/PUT/DELETE` | `/collections` | read / write |
| `POST/DELETE` | `/collections/:collectionId/products/:productId` | write |
| `GET/POST/DELETE` | `/collections/:collectionId/rules` | write |

### Price lists

Named price-list types: `retail`, `wholesale`, `vip`, `staff`, `custom`. Each
list holds per-variant overrides. A variant is matched against the customer's
active price list at checkout.

```
GET    /commerce/stores/:storeId/price-lists
POST   /commerce/stores/:storeId/price-lists
GET/PUT/DELETE  /commerce/stores/:storeId/price-lists/:listId
GET    /commerce/stores/:storeId/price-lists/:listId/items
PUT/DELETE  /commerce/stores/:storeId/price-lists/:listId/items/:itemId
```

### Metafields

Typed extension fields (`string`, `integer`, `boolean`, `json`, `date`, `url`)
for any resource. Definitions are created per-store; fields are attached per-
resource instance.

```
GET/POST  /commerce/stores/:storeId/metafield-definitions
GET/PUT/DELETE  /commerce/stores/:storeId/metafields
```

### Translations (i18n)

Resource types: `product`, `variant`, `option`, `option_value`, `collection`.
Store one locale override per resource per locale key.

```
GET  /commerce/stores/:storeId/translations/:resourceType/:resourceId
PUT  /commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale
DELETE  /commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale
```

### CSV import

`POST /commerce/stores/:storeId/products/csv-import` — bulk-import products from
a CSV file (multipart). `GET /commerce/stores/:storeId/products/csv-export` —
export the full catalog as CSV (admin auth).

---

## Inventory & warehousing

FEFO (first-expiry, first-out) lot tracking, serial numbers, and multi-warehouse
support.

| Concept | Description |
|---------|-------------|
| Warehouses | Physical or virtual stock locations |
| Inventory levels | On-hand, reserved, and available counts per variant×warehouse |
| Lots | Batch/lot tracking with expiry dates; FEFO allocation at fulfillment |
| Serials | One-to-one serial numbers on individual units |
| Suppliers | Vendor records linked to purchase and restock workflows |

```
GET/POST              /commerce/stores/:storeId/warehouses
PUT/DELETE            /commerce/stores/:storeId/warehouses/:warehouseId
GET                   /commerce/stores/:storeId/inventory
POST                  /commerce/stores/:storeId/inventory/set
POST                  /commerce/stores/:storeId/inventory/adjust
GET                   /commerce/stores/:storeId/inventory/adjustments
GET/POST              /commerce/stores/:storeId/inventory/lots
PUT/DELETE            /commerce/stores/:storeId/inventory/lots/:lotId
GET/POST              /commerce/stores/:storeId/inventory/serials
GET/PUT               /commerce/stores/:storeId/inventory/serials/:serialId
GET/POST/PUT/DELETE   /commerce/stores/:storeId/suppliers
```

---

## Carts

Carts are lightweight sessions. Line items reference variant IDs. Abandoned-cart
recovery is built in.

```
POST       /commerce/stores/:storeId/carts
GET/PUT    /commerce/stores/:storeId/carts/:cartId
POST       /commerce/stores/:storeId/carts/:cartId/lines
PUT/DELETE /commerce/stores/:storeId/carts/:cartId/lines/:lineId
GET        /commerce/stores/:storeId/abandoned-carts
POST       /commerce/stores/:storeId/abandoned-carts/:cartId/recover
```

---

## Checkout

A checkout session holds shipping address, billing address, payment session,
discount codes, and tax totals. Completing a checkout creates an order and fires
the payment provider webhook path.

```
POST  /commerce/stores/:storeId/checkouts
GET   /commerce/stores/:storeId/checkouts/:checkoutId
PUT   /commerce/stores/:storeId/checkouts/:checkoutId
POST  /commerce/stores/:storeId/checkouts/:checkoutId/complete
POST  /commerce/stores/:storeId/checkouts/:checkoutId/payment-session
```

`POST .../complete` is idempotent when an `Idempotency-Key` header is provided,
and a DB-level unique constraint prevents duplicate order creation under
concurrent retries.

---

## Orders

```
GET        /commerce/stores/:storeId/orders
POST       /commerce/stores/:storeId/orders
GET/PUT    /commerce/stores/:storeId/orders/:orderId
POST       /commerce/stores/:storeId/orders/:orderId/cancel
POST       /commerce/stores/:storeId/orders/:orderId/notes
GET        /commerce/stores/:storeId/orders/:orderId/events
```

---

## Payments

Supported providers: **Stripe**, **Paystack**, **Razorpay**, **Xendit**.

Configure a provider per store (key is never re-returned after creation). The
webhook router at `/webhooks/:storeId/...` confirms payments from all four
providers and fires GA4 server-side purchase events when a `google_analytics_4`
tracking pixel is configured.

| Method | Path | Auth |
|--------|------|------|
| `GET/POST` | `/orders/:orderId/payments` | write |
| `POST` | `/orders/:orderId/payments/:paymentId/capture` | admin |
| `POST` | `/orders/:orderId/payments/:paymentId/refund` | admin |
| `GET/POST/DELETE` | `/payment-providers` | admin |

Refund reasons: `customer_request`, `defective`, `not_received`, `other`. Pass
`restock: true` to automatically return inventory.

---

## Discounts

Code-based (`/discounts`) and automatic (`/auto-discounts`) discount rules.

```
GET/POST         /commerce/stores/:storeId/discounts
POST             /commerce/stores/:storeId/discounts/validate
GET/PUT/DELETE   /commerce/stores/:storeId/discounts/:discountId
GET/POST         /commerce/stores/:storeId/auto-discounts
PUT/DELETE       /commerce/stores/:storeId/auto-discounts/:discountId
```

Discount validation returns the applicable amount given a cart total, customer
group, and code — call it before rendering the checkout summary.

Error codes specific to discounts: `DISCOUNT_EXHAUSTED` (usage cap reached),
`DISCOUNT_ALREADY_USED` (once-per-customer code already redeemed).

---

## B2B — companies, credit, quotes, purchase orders

Companies model a buying organisation. Members of a company can be linked to
customer accounts, giving them shared credit lines and access to net-terms
purchasing.

| Concept | Endpoint prefix |
|---------|-----------------|
| Companies | `/companies` |
| Company customers | `/companies/:companyId/customers` |
| Customer groups | `/customer-groups` |
| Quotes | `/quotes` |
| Purchase orders | `/purchase-orders` |

```
GET/POST         /commerce/stores/:storeId/companies
GET/PUT/DELETE   /commerce/stores/:storeId/companies/:companyId
GET/POST/DELETE  /commerce/stores/:storeId/companies/:companyId/customers
GET/POST         /commerce/stores/:storeId/customer-groups
GET/PUT/DELETE   /commerce/stores/:storeId/customer-groups/:groupId
POST/DELETE      /commerce/stores/:storeId/customer-groups/:groupId/members/:customerId
GET/POST         /commerce/stores/:storeId/quotes
GET/PUT          /commerce/stores/:storeId/quotes/:quoteId
POST             /commerce/stores/:storeId/quotes/:quoteId/send
POST             /commerce/stores/:storeId/quotes/:quoteId/accept
POST             /commerce/stores/:storeId/quotes/:quoteId/reject
GET/POST         /commerce/stores/:storeId/purchase-orders
GET/PUT          /commerce/stores/:storeId/purchase-orders/:poId
POST             /commerce/stores/:storeId/orders/:orderId/purchase-order
```

---

## Subscriptions

Subscription plans define billing cadence and price. Subscriptions track a
customer's active plan, billing state, and renewal date.

```
GET/POST         /commerce/stores/:storeId/subscription-plans
GET/PUT/DELETE   /commerce/stores/:storeId/subscription-plans/:planId
GET/POST         /commerce/stores/:storeId/subscriptions
GET              /commerce/stores/:storeId/subscriptions/:subId
POST             /commerce/stores/:storeId/subscriptions/:subId/pause
POST             /commerce/stores/:storeId/subscriptions/:subId/resume
POST             /commerce/stores/:storeId/subscriptions/:subId/cancel
POST             /commerce/stores/:storeId/subscriptions/:subId/bill
```

The scheduler in `backend/src/modules/subscriptions/scheduler.ts` handles
automatic renewal billing.

---

## Returns & RMA

```
GET/POST         /commerce/stores/:storeId/returns
GET              /commerce/stores/:storeId/returns/:returnId
GET/POST         /commerce/stores/:storeId/orders/:orderId/returns
GET/POST         /commerce/stores/:storeId/returns/:returnId/events
PUT              /commerce/stores/:storeId/returns/:returnId
```

---

## Shipping

Zones, carrier rates, collection points (click-and-collect), shipments, and
fulfillment orders. A public webhook at `/webhooks/:storeId/tracking/:shipmentId`
accepts carrier tracking updates.

```
GET/POST/PUT/DELETE    /shipping-zones
GET/POST/PUT/DELETE    /shipping-zones/:zoneId/rates
GET                    /shipping-rates/available
GET/POST/DELETE        /shipping-providers
GET/POST/PUT/DELETE    /collection-points
GET/POST/PUT           /orders/:orderId/shipments
GET                    /orders/:orderId/shipments/:shipmentId/tracking
GET/POST               /orders/:orderId/fulfillment-orders
PUT                    /fulfillment-orders/:foId
```

---

## Tax

Tax categories define the type of goods (physical, digital, food, etc.). Tax
zones pair a geographic region with a list of rates. Checkout uses the store's
zone + category combination to compute tax at order time.

```
GET/POST/DELETE      /commerce/stores/:storeId/tax-categories
GET/POST/PUT/DELETE  /commerce/stores/:storeId/tax-zones
GET/POST/PUT/DELETE  /commerce/stores/:storeId/tax-zones/:zoneId/rates
```

---

## Wallet — gift cards & store credit

### Gift cards

Opaque codes with a balance. Look up a code, partially redeem at checkout.

```
GET/POST     /commerce/stores/:storeId/gift-cards
POST         /commerce/stores/:storeId/gift-cards/lookup
GET/POST     /commerce/stores/:storeId/gift-cards/:giftCardId/disable
```

### Store credit

Per-customer credit balance with a full transaction log. Issue, adjust, and
consume credit through dedicated endpoints.

```
GET     /commerce/stores/:storeId/customers/:customerId/credits
POST    /commerce/stores/:storeId/customers/:customerId/credits/issue
POST    /commerce/stores/:storeId/customers/:customerId/credits/adjust
GET     /commerce/stores/:storeId/customers/:customerId/credits/transactions
```

Error codes: `INSUFFICIENT_CREDIT` (422), `WALLET_NOT_FOUND` (404).

---

## Digital products

Digital product files are managed through the catalog module (attached to a
product with type `digital`). The delivery module issues time-limited, download-
count-limited tokens.

```
GET/POST  /commerce/stores/:storeId/orders/:orderId/download-links
GET       /storefront/:storeId/downloads/:token
```

The public download endpoint validates the token expiry and `max_downloads`
counter, then 302-redirects to the file URL. Errors: `DOWNLOAD_LIMIT_EXCEEDED`
(422), `LINK_EXPIRED` (410).

---

## Bookings & rentals

Resources (rooms, equipment, service slots) each have an availability calendar,
price rules, iCal feed export, and OTA channel linkage. Bookings move through a
lifecycle: `pending → confirmed → checked_in → checked_out → cancelled`.

Key sub-resources: cancellation policies, modification requests, messages, check-
in tokens, damage claims.

```
GET/POST/PUT/DELETE  /booking-policies
GET/POST/PUT/DELETE  /booking-resources
GET/POST             /booking-resources/:resourceId/availability
GET/POST/PUT/DELETE  /booking-resources/:resourceId/price-rules
GET/POST/PUT/DELETE  /booking-resources/:resourceId/ical-feeds
GET                  /storefront/:storeId/booking-resources/:resourceId/ical.ics
GET/POST             /bookings
GET                  /bookings/:bookingId
POST                 /bookings/:bookingId/confirm
POST                 /bookings/:bookingId/check-in
POST                 /bookings/:bookingId/check-out
POST                 /bookings/:bookingId/cancel
GET/POST             /bookings/:bookingId/messages
GET/POST             /bookings/:bookingId/damage-claims
```

---

## Product feeds

Generates Google Shopping (RSS/XML) and Facebook Catalog (XML) feeds from live
catalog data. Per-variant feed data overrides (GTINs, Google category IDs) are
stored and used in feed generation.

```
GET    /storefront/:storeId/feeds/google-shopping
GET    /storefront/:storeId/feeds/facebook-catalog
GET/POST/PUT/DELETE   /commerce/stores/:storeId/merchant-feeds
GET/PUT               /commerce/stores/:storeId/variants/:variantId/feed-data
```

---

## Analytics & GA4

Server-side analytics events are stored in `analytics_events`. Four summary
endpoints expose aggregated ecommerce metrics. All require a management JWT and a
`store_id` query param.

```
GET /analytics/ecommerce/overview   — total orders, revenue, AOV, refund rate
GET /analytics/ecommerce/products   — top products by views/cart/purchases
GET /analytics/ecommerce/funnel     — per-stage counts + drop-off %
GET /analytics/ecommerce/revenue    — daily revenue chart
```

Query: `?store_id=<uuid>&start=YYYY-MM-DD&end=YYYY-MM-DD`. Window defaults to
the last 30 days, capped at 365.

GA4 server-side purchase events fire automatically on order completion when the
store has a `google_analytics_4` tracking pixel configured (via the integrations
module).

---

## Engagement — wishlists & abandoned carts

```
GET/POST         /commerce/stores/:storeId/wishlists
GET/DELETE       /commerce/stores/:storeId/wishlists/:wishlistId
POST/DELETE      /commerce/stores/:storeId/wishlists/:wishlistId/items
GET              /storefront/:storeId/wishlists/:shareToken
GET              /commerce/stores/:storeId/abandoned-carts
POST             /commerce/stores/:storeId/abandoned-carts/:cartId/recover
```

Wishlists support public share tokens so customers can share their list without
logging in.

---

## Integrations & tracking pixels

Store-level integration definitions (e.g. third-party ERPs) and tracking pixel
configurations. Pixel types include `google_analytics_4` (fires GA4 Measurement
Protocol purchase events on order completion) and other configurable pixel kinds.

```
GET           /commerce/integration-definitions
GET/POST/DELETE  /commerce/stores/:storeId/integrations
GET/POST/DELETE  /commerce/stores/:storeId/tracking-pixels
GET           /storefront/:storeId/pixels
```

---

## Further reading

- Full endpoint inventory with auth tiers: [parity-endpoints.md](./parity-endpoints.md)
- Payment provider setup: [byo-keys.md](./byo-keys.md)
- Customer identity and accounts: [identity.md](./identity.md)
- Shareable checkout links: [checkout-links.md](./checkout-links.md)
