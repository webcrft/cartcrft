---
title: "Discounts"
description: "Code-based and automatic discount rules — percentage, fixed, free shipping, BOGO, buy-X-get-Y, usage limits, and per-customer atomicity."
---

# Discounts

Cartcrft supports two discount surfaces: merchant-issued codes (`/discounts`) and
rule-based automatic discounts (`/auto-discounts`) that apply without a code.

---

## Code-based discounts

```
GET/POST         /commerce/stores/:storeId/discounts
POST             /commerce/stores/:storeId/discounts/validate
GET/PUT/DELETE   /commerce/stores/:storeId/discounts/:discountId
```

### Create a percentage discount

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "LAUNCH20",
    "type": "percentage",
    "value": "20",
    "usage_limit": 500,
    "once_per_customer": true,
    "starts_at": "2026-07-01T00:00:00Z"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/discounts"
```

### Validate a code before checkout

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_pub_>" \
  -H "Content-Type: application/json" \
  -d '{"code":"LAUNCH20","subtotal":"89.00","customer_id":"<uuid>"}' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/discounts/validate"
```

Returns the applicable amount — call this before rendering the checkout summary
so the customer sees the correct total.

---

## Discount types

| Type | Description |
|------|-------------|
| `percentage` | Percentage off the subtotal |
| `fixed` | Fixed amount off |
| `free_shipping` | Waives shipping cost |
| `bogo` | Buy one, get one |
| `buy_x_get_y` | Buy X units, get Y free |

---

## Automatic discounts

Automatic discounts apply without a code — useful for sale events and loyalty
tiers.

```
GET/POST       /commerce/stores/:storeId/auto-discounts
PUT/DELETE     /commerce/stores/:storeId/auto-discounts/:discountId
```

---

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `DISCOUNT_EXHAUSTED` | 422 | Usage cap reached |
| `DISCOUNT_ALREADY_USED` | 422 | Once-per-customer code already redeemed |

---

## Further reading

- [Orders & checkout](./orders-checkout.md) — applying discounts at checkout
- [B2B](./b2b.md) — customer-group pricing
