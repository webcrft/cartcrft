---
title: "Shipping"
description: "Shipping zones, carrier rates, collection points, fulfillment orders, and shipment tracking."
---

# Shipping

Cartcrft ships with a full zone-and-rate shipping system plus collection points
(click-and-collect), live-rate providers (BobGo), shipment records, and tracking
events. A public webhook at `/webhooks/:storeId/tracking/:shipmentId` accepts
carrier tracking updates.

---

## Zones and rates

```
GET/POST/PUT/DELETE  /commerce/stores/:storeId/shipping-zones
GET/POST/PUT/DELETE  /commerce/stores/:storeId/shipping-zones/:zoneId/rates
GET                  /commerce/stores/:storeId/shipping-rates/available
GET/POST/DELETE      /commerce/stores/:storeId/shipping-providers
```

### Create a flat rate zone

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "US Standard",
    "countries": ["US"],
    "rates": [
      { "name": "Standard", "price": "7.99" },
      { "name": "Free over $100", "price": "0.00", "min_order_subtotal": "100.00" }
    ]
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/shipping-zones"
```

### Get available rates at checkout

```bash
GET /commerce/stores/:storeId/shipping-rates/available?cart_id=<uuid>&country=US
```

Returns the list of rates applicable to the cart's destination — render these for
the customer to choose.

---

## Collection points (click-and-collect)

```
GET/POST/PUT/DELETE  /commerce/stores/:storeId/collection-points
```

---

## Shipments and fulfillment

```
GET/POST/PUT   /commerce/stores/:storeId/orders/:orderId/shipments
GET            /orders/:orderId/shipments/:shipmentId/tracking
GET/POST       /commerce/stores/:storeId/orders/:orderId/fulfillment-orders
PUT            /commerce/stores/:storeId/fulfillment-orders/:foId
```

### Create a shipment

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "tracking_number": "1Z999AA10123456784",
    "carrier": "UPS",
    "line_items": [{ "line_item_id": "<uuid>", "quantity": 1 }]
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/orders/<ORDER_ID>/shipments"
```

### Inbound tracking webhook

```
POST /webhooks/:storeId/tracking/:shipmentId
```

Carriers post tracking updates here. Cartcrft appends events to the shipment's
tracking history and can fire store notification webhooks on status changes.

---

## Further reading

- [Orders & checkout](./orders-checkout.md) — fulfillment status on orders
- [Returns](./returns.md) — return shipments and RMA flows
- [Inventory](./inventory.md) — warehouse and stock management
