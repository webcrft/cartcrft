---
title: "Inventory"
description: "Warehouses, stock levels, FEFO lot tracking, serial numbers, suppliers, and reorder points."
---

# Inventory

CartCrft tracks stock across multiple warehouses with FEFO (first-expiry, first-out)
lot allocation, serial numbers, and a full adjustment audit trail. All routes are
under `/commerce/stores/:storeId/...`.

---

## Concepts

| Concept | Description |
|---------|-------------|
| Warehouses | Physical or virtual stock locations |
| Inventory levels | On-hand, reserved, and available counts per variant × warehouse |
| Lots | Batch/lot tracking with expiry dates; FEFO allocation at fulfillment |
| Serials | One-to-one serial numbers on individual units |
| Suppliers | Vendor records linked to purchase and restock workflows |

---

## Warehouses

```
GET/POST         /commerce/stores/:storeId/warehouses
PUT/DELETE       /commerce/stores/:storeId/warehouses/:warehouseId
```

---

## Stock levels

```
GET   /commerce/stores/:storeId/inventory
POST  /commerce/stores/:storeId/inventory/set
POST  /commerce/stores/:storeId/inventory/adjust
GET   /commerce/stores/:storeId/inventory/adjustments
```

### Set a level

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "variant_id": "<uuid>",
    "warehouse_id": "<uuid>",
    "on_hand": 50
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/inventory/set"
```

### Adjust a level

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "variant_id": "<uuid>",
    "warehouse_id": "<uuid>",
    "delta": -5,
    "reason": "damaged"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/inventory/adjust"
```

---

## Lot tracking (FEFO)

Lots record batch numbers and expiry dates. The fulfillment engine allocates
lots in FEFO order — the soonest-expiring lot is reserved first.

```
GET/POST       /commerce/stores/:storeId/inventory/lots
PUT/DELETE     /commerce/stores/:storeId/inventory/lots/:lotId
```

---

## Serial numbers

```
GET/POST   /commerce/stores/:storeId/inventory/serials
GET/PUT    /commerce/stores/:storeId/inventory/serials/:serialId
```

---

## Suppliers

```
GET/POST/PUT/DELETE  /commerce/stores/:storeId/suppliers
```

---

## Inventory errors

| Code | HTTP | Meaning |
|------|------|---------|
| `INSUFFICIENT_INVENTORY` | 422 | Not enough stock to fulfil the line |

---

## Further reading

- [Products & catalog](./products.md) — creating products and variants
- [Orders & checkout](./orders-checkout.md) — inventory decremented at checkout
- [Shipping](./shipping.md) — fulfillment orders and warehouse split
