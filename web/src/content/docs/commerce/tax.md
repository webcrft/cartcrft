---
title: "Tax"
description: "Tax categories, zones, and rate configuration — static rate tables applied at checkout."
---

# Tax

CartCrft uses static tax rate tables: tax categories classify what you sell,
tax zones pair a geographic region with rates, and the combination is applied at
checkout time.

> **No external tax provider** — CartCrft computes tax from your configured zones
> and rates. If you need real-time tax via TaxJar or Avalara, those are planned
> integrations.

---

## Tax categories

Tax categories define the type of goods (physical, digital, food, etc.).

```
GET/POST/DELETE  /commerce/stores/:storeId/tax-categories
```

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Digital goods", "code": "DIGITAL"}' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/tax-categories"
```

---

## Tax zones

Tax zones define the geographic region(s) a set of rates applies to.

```
GET/POST/PUT/DELETE  /commerce/stores/:storeId/tax-zones
```

---

## Rates

Rates live under a zone. Set `inclusive: true` for tax-inclusive pricing.

```
GET/POST/PUT/DELETE  /commerce/stores/:storeId/tax-zones/:zoneId/rates
```

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "US Sales Tax",
    "rate": "0.0875",
    "inclusive": false,
    "tax_category_id": "<uuid>"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/tax-zones/<ZONE_ID>/rates"
```

---

## How checkout uses tax

At checkout, the backend matches the order's shipping destination country/region
against the configured zones, then applies the applicable rate for the product's
tax category. The result is stored as `tax_total` on the checkout and order.

---

## Further reading

- [Orders & checkout](./orders-checkout.md) — where tax is applied
- [Shipping](./shipping.md) — destination determines zone
