---
title: "Commerce overview"
description: "All of Cartcrft's standard-commerce modules at a glance — products, inventory, orders, payments, and every module in between."
---

# Commerce overview

Cartcrft is a headless commerce platform built as a set of Fastify modules, each
owning a slice of the commerce surface. Every route is under
`/commerce/stores/:storeId/...` and is protected by the store-auth middleware.
See [API Overview](./api-overview.md) for auth conventions and error codes.

---

## Module map

| Module | What it covers | Doc |
|--------|---------------|-----|
| **Products & catalog** | Products, variants, options, media, bundles, digital files, reviews, collections, price lists, metafields, translations, CSV import | [products →](./commerce/products.md) |
| **Inventory** | Warehouses, stock levels, FEFO lot tracking, serial numbers, suppliers, reorder points | [inventory →](./commerce/inventory.md) |
| **Orders & checkout** | Carts, checkout sessions, idempotent order creation, abandoned cart recovery, wishlists | [orders-checkout →](./commerce/orders-checkout.md) |
| **Payments** | Stripe, Paystack, Razorpay, Xendit — BYO keys, webhook routing, capture, refund, GA4 | [payments →](./commerce/payments.md) |
| **Customers** | Customer CRUD, tags, audit log, saved addresses, customer groups | [customers →](./commerce/customers.md) |
| **Discounts** | Code-based (%, fixed, BOGO, free-shipping, buy-X-get-Y) and auto-discounts | [discounts →](./commerce/discounts.md) |
| **Shipping** | Zones, rates, live rates (BobGo), collection points (PUDO), shipments, tracking | [shipping →](./commerce/shipping.md) |
| **Tax** | Tax categories, zones, and rates — inclusive/exclusive static tables | [tax →](./commerce/tax.md) |
| **B2B** | Companies, credit lines, net terms, quotes/RFQ, purchase orders | [b2b →](./commerce/b2b.md) |
| **Subscriptions** | Plans, billing cadence, lifecycle (pause/resume/cancel/bill), renewal scheduler | [subscriptions →](./commerce/subscriptions.md) |
| **Returns & RMA** | Return requests, refund/exchange/store-credit/repair resolution | [returns →](./commerce/returns.md) |
| **Wallet** | Gift cards (issue, lookup, redeem) and per-customer store credit ledger | [wallet →](./commerce/wallet.md) |
| **Digital products** | Time-limited, download-count-limited token delivery | [digital-products →](./commerce/digital-products.md) |
| **Bookings & rentals** | Resources, availability calendars, iCal export, OTA channels, booking lifecycle | [bookings →](./commerce/bookings.md) |

---

## Auth quick reference

| Key type | Scope | Use for |
|----------|-------|---------|
| `cc_pub_` | `commerce:read` | Storefront reads, product listing, search |
| `cc_prv_` | `commerce:read commerce:write` | Cart, checkout, customer ops |
| `cc_prv_` + `commerce:admin` | full | Delete, provider config, refunds |
| Management JWT | full org | Admin dashboard, server-side tools |

All amounts are **strings** in API payloads (e.g. `"89.00"`), stored as
`numeric(15,2)` in Postgres.

---

## Customer identity

Storefront customer auth (registration, login, magic links, Google/Microsoft/Discord
OAuth) is a separate module: [Customer identity & accounts →](./identity.md)

---

## Further reading

- Full endpoint table with auth tiers: [parity-endpoints →](./parity-endpoints.md)
- Payment provider setup: [byo-keys →](./byo-keys.md)
- Shareable checkout links: [checkout-links →](./checkout-links.md)
