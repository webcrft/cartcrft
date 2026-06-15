---
title: "Digital products"
description: "File delivery for digital products — time-limited, download-count-limited tokens served via a public storefront endpoint."
---

# Digital products

Digital products are catalog items with type `digital`. Files are attached
through the products module (`/products/:productId/digital-files`). The delivery
module issues time-limited, download-count-limited tokens and redirects customers
to the file URL.

---

## Attach a file to a product

First, set the product type to `digital` (or `subscription` that delivers a
digital asset):

```bash
# Attach a digital file to an existing product
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Ebook PDF",
    "url": "https://cdn.example.com/files/ebook-v2.pdf",
    "size_bytes": 4200000
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/products/<PRODUCT_ID>/digital-files"
```

---

## Issue download links

After a customer purchases a digital product, issue download tokens:

```
GET/POST  /commerce/stores/:storeId/orders/:orderId/download-links
```

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "line_item_id": "<uuid>",
    "expires_in_hours": 48,
    "max_downloads": 3
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/orders/<ORDER_ID>/download-links"
```

Response includes `download_url` — send this to the customer.

---

## Public download endpoint

```
GET /storefront/:storeId/downloads/:token
```

The public endpoint validates token expiry and `max_downloads` counter, then
302-redirects to the file URL. No auth header required — the token is the
capability.

---

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `DOWNLOAD_LIMIT_EXCEEDED` | 422 | Token has reached its `max_downloads` count |
| `LINK_EXPIRED` | 410 | Token has passed its expiry time |

---

## Further reading

- [Products & catalog](./products.md) — attaching files (`digital-files` sub-resource)
- [Orders & checkout](./orders-checkout.md) — the order that triggers delivery
