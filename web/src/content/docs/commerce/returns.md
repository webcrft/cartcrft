---
title: "Returns & RMA"
description: "Return requests, refund, exchange, store-credit, and repair flows with optional restock."
---

# Returns & RMA

The returns module handles post-purchase return requests (RMAs). Merchants can
resolve a return as a refund, exchange, store credit, or repair. Restock is
optional and inventory is adjusted when enabled.

---

## Endpoints

```
GET/POST         /commerce/stores/:storeId/returns
GET              /commerce/stores/:storeId/returns/:returnId
PUT              /commerce/stores/:storeId/returns/:returnId
GET/POST         /commerce/stores/:storeId/orders/:orderId/returns
GET/POST         /commerce/stores/:storeId/returns/:returnId/events
```

---

## Create a return request

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "<uuid>",
    "reason": "defective",
    "items": [
      { "line_item_id": "<uuid>", "quantity": 1 }
    ],
    "resolution": "refund",
    "restock": true
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/returns"
```

---

## Resolution types

| Resolution | Description |
|------------|-------------|
| `refund` | Payment refund to original method |
| `exchange` | Replacement item(s) |
| `store_credit` | Credit added to customer wallet |
| `repair` | Item sent for repair and returned |

---

## Return events

The `/events` sub-resource provides a timeline of status changes — useful for
customer-facing return tracking.

---

## Further reading

- [Orders & checkout](./orders-checkout.md) — orders that returns reference
- [Wallet](./wallet.md) — store credit issued on return resolution
- [Payments](./payments.md) — refund endpoint
