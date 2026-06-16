---
title: "Products & catalog"
description: "Managing products, variants, options, collections, metafields, price lists, and translations — the full catalog surface."
---

# Products & catalog

The catalog module covers everything you sell: products, variants, options, media,
bundles, digital files, collections, price lists, and i18n translations. All routes
are under `/commerce/stores/:storeId/...`.

![CartCrft product catalog — dashboard view](/screenshots/dashboard-products.png)

*The products dashboard — add products, manage variants, and organise collections.*

---

## Product types

| Type | Description |
|------|-------------|
| `simple` | Single SKU, flat price |
| `bundle` | Fixed set of variant SKUs sold together |
| `configurable` | Multiple option axes (size, colour) each mapping to a variant |
| `digital` | Downloadable file attached via `digital_product_files` |
| `service` | Bookable or appointable (see [Bookings](./bookings.md)) |
| `subscription` | Recurring billing (see [Subscriptions](./subscriptions.md)) |
| `rental` | Time-windowed rental with availability calendar |

---

## Core endpoints

```
GET    /commerce/stores/:storeId/products
POST   /commerce/stores/:storeId/products
GET    /commerce/stores/:storeId/products/:productId
PUT    /commerce/stores/:storeId/products/:productId
DELETE /commerce/stores/:storeId/products/:productId

GET/POST         /products/:productId/variants
PUT/DELETE       /products/:productId/variants/:variantId
GET/POST/DELETE  /products/:productId/options/:optionId
POST/DELETE      /products/:productId/media
GET/POST/DELETE  /products/:productId/bundle-items
GET/POST/DELETE  /products/:productId/digital-files
GET/POST         /products/:productId/reviews
GET/PUT          /products/:productId/tags
```

**Auth:** `cc_pub_` for reads, `cc_prv_` for writes, `cc_prv_` with `commerce:admin` for deletes.

---

## Create a product

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Merino Hoodie",
    "product_type": "configurable",
    "status": "active",
    "description": "Lightweight merino wool pullover."
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/products"
```

---

## Collections

Collections group products. Manual collections have explicit membership; smart
collections match products by rules (e.g. `tag = "sale"`, `price < 50`).

```
GET/POST/PUT/DELETE  /commerce/stores/:storeId/collections
POST/DELETE          /collections/:collectionId/products/:productId
GET/POST/DELETE      /collections/:collectionId/rules
```

---

## Price lists

Named price tiers: `retail`, `wholesale`, `vip`, `staff`, `custom`. Each list
holds per-variant price overrides; a customer's active price list is matched at
checkout.

```
GET/POST             /commerce/stores/:storeId/price-lists
GET/PUT/DELETE       /price-lists/:listId
GET                  /price-lists/:listId/items
PUT/DELETE           /price-lists/:listId/items/:itemId
```

---

## Metafields

Typed extension fields (`string`, `integer`, `boolean`, `json`, `date`, `url`)
for any resource.

```
GET/POST         /commerce/stores/:storeId/metafield-definitions
GET/PUT/DELETE   /commerce/stores/:storeId/metafields
```

---

## Translations (i18n)

Per-resource locale overrides for `product`, `variant`, `option`, `option_value`,
`collection`.

```
GET     /translations/:resourceType/:resourceId
PUT     /translations/:resourceType/:resourceId/:locale
DELETE  /translations/:resourceType/:resourceId/:locale
```

---

## CSV import / export

```
POST  /commerce/stores/:storeId/products/csv-import   (multipart; write auth)
GET   /commerce/stores/:storeId/products/csv-export   (admin auth)
```

---

## Natural-language search

```bash
GET /commerce/stores/:storeId/search?q=merino+hoodie&in_stock=true&price_max=100
```

Uses pgvector hybrid search when an LLM key is configured; falls back to Postgres
full-text. See [BYO Keys](../byo-keys.md) to enable semantic ranking.

---

## Further reading

- [Inventory](./inventory.md) — stock levels, lots, serial numbers
- [Discounts](./discounts.md) — codes and auto-discounts
- [Digital products](./digital-products.md) — file delivery
- [Bookings](./bookings.md) — service/rental scheduling
