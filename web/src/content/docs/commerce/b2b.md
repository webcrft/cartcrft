---
title: "B2B — companies, credit, quotes"
description: "B2B companies, credit lines, net-terms purchasing, quotes/RFQ lifecycle, and purchase orders."
---

# B2B — companies, credit, quotes

The B2B module models wholesale and corporate purchasing: companies, credit
limits, net-terms, quotes, and purchase orders. Members of a company share a
credit line and access to company pricing.

---

## Companies

A company is a buying organisation. Customers can be linked as members, gaining
access to the company's credit, price lists, and purchase order workflow.

```
GET/POST         /commerce/stores/:storeId/companies
GET/PUT/DELETE   /commerce/stores/:storeId/companies/:companyId
GET/POST/DELETE  /commerce/stores/:storeId/companies/:companyId/customers
```

### Create a company

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corp",
    "credit_limit": "10000.00",
    "payment_terms": "net_30"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/companies"
```

---

## Customer groups

Customer groups enable segment-specific pricing and discount rules.

```
GET/POST         /commerce/stores/:storeId/customer-groups
GET/PUT/DELETE   /commerce/stores/:storeId/customer-groups/:groupId
POST/DELETE      /commerce/stores/:storeId/customer-groups/:groupId/members/:customerId
```

---

## Quotes (RFQ)

Quotes model a request-for-quotation lifecycle: `draft → sent → accepted/rejected`.

```
GET/POST   /commerce/stores/:storeId/quotes
GET/PUT    /commerce/stores/:storeId/quotes/:quoteId
POST       /commerce/stores/:storeId/quotes/:quoteId/send
POST       /commerce/stores/:storeId/quotes/:quoteId/accept
POST       /commerce/stores/:storeId/quotes/:quoteId/reject
```

---

## Purchase orders

POs let companies reference their own PO number against a Cartcrft order.

```
GET/POST   /commerce/stores/:storeId/purchase-orders
GET/PUT    /commerce/stores/:storeId/purchase-orders/:poId
POST       /commerce/stores/:storeId/orders/:orderId/purchase-order
```

---

## Further reading

- [Customers](./customers.md) — customer accounts and groups
- [Discounts](./discounts.md) — group-specific pricing
- [Payments](./payments.md) — net-terms and credit billing
