---
title: "Orders & checkout"
description: "Cart creation, checkout sessions, idempotent order placement, order lifecycle, and abandoned cart recovery."
---

# Orders & checkout

Checkout is a three-step flow: cart → checkout session → order. Price
re-validation, inventory decrement, and discount burn all happen atomically
inside the `CompleteByID` transaction. Routes under
`/commerce/stores/:storeId/...`.

![CartCrft orders dashboard](/screenshots/dashboard-orders.png)

*The orders dashboard — view financial and fulfillment status, cancel, and add notes.*

---

## Carts

Carts are lightweight sessions holding line items with price snapshots.

```
POST       /commerce/stores/:storeId/carts
GET/PUT    /commerce/stores/:storeId/carts/:cartId
POST       /commerce/stores/:storeId/carts/:cartId/lines
PUT/DELETE /commerce/stores/:storeId/carts/:cartId/lines/:lineId
GET        /commerce/stores/:storeId/abandoned-carts
POST       /commerce/stores/:storeId/abandoned-carts/:cartId/recover
```

### Create a cart and add an item

```bash
# 1. Create cart (public key)
CART=$(curl -s -X POST \
  -H "Authorization: Bearer <cc_pub_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/carts" | jq -r '.id')

# 2. Add a line (private key)
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{"variant_id":"<uuid>","quantity":2}' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/carts/$CART/lines"
```

---

## Checkout sessions

A checkout holds shipping address, billing address, payment session, discount
codes, and computed tax totals.

```
POST  /commerce/stores/:storeId/checkouts
GET   /commerce/stores/:storeId/checkouts/:checkoutId
PUT   /commerce/stores/:storeId/checkouts/:checkoutId
POST  /commerce/stores/:storeId/checkouts/:checkoutId/complete
POST  /commerce/stores/:storeId/checkouts/:checkoutId/payment-session
```

### Complete a checkout (idempotent)

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Idempotency-Key: $(uuidgen)" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/checkouts/<CHECKOUT_ID>/complete"
```

The `complete` endpoint is idempotent when an `Idempotency-Key` header is
supplied. A DB-level `UNIQUE` constraint on `(checkout_id, order_id)` prevents
duplicate orders under concurrent retries.

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

### Order status fields

| Field | Values |
|-------|--------|
| `financial_status` | `pending`, `paid`, `refunded`, `partially_refunded` |
| `fulfillment_status` | `unfulfilled`, `partial`, `fulfilled` |

---

## Wishlists & abandoned carts

```
GET/POST       /commerce/stores/:storeId/wishlists
GET/DELETE     /commerce/stores/:storeId/wishlists/:wishlistId
POST/DELETE    /commerce/stores/:storeId/wishlists/:wishlistId/items
GET            /storefront/:storeId/wishlists/:shareToken
GET            /commerce/stores/:storeId/abandoned-carts
POST           /commerce/stores/:storeId/abandoned-carts/:cartId/recover
```

Wishlists support public share tokens so customers can share without logging in.

---

## Further reading

- [Payments](./payments.md) — configure providers and handle webhooks
- [Shipping](./shipping.md) — zones, rates, and fulfillment orders
- [Discounts](./discounts.md) — apply discount codes at checkout
- [Checkout links](../checkout-links.md) — shareable pre-filled payment URLs
