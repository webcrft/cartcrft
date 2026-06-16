---
title: "Customers"
description: "Customer accounts, admin CRUD, tags, audit log, saved addresses, and customer groups."
---

# Customers

CartCrft provides per-store customer management: CRUD, tagging, blocking, saved
addresses, audit log, and invite dispatch. Customer authentication (login, OAuth,
magic links, sessions) is covered in [Customer identity & accounts](../identity.md).

---

## Admin customer endpoints

```
GET/POST         /commerce/stores/:storeId/customers
GET/PUT/DELETE   /commerce/stores/:storeId/customers/:customerId
POST             /commerce/stores/:storeId/customers/:customerId/block
POST             /commerce/stores/:storeId/customers/:customerId/unblock
GET/PUT          /commerce/stores/:storeId/customers/:customerId/tags
GET              /commerce/stores/:storeId/customers/:customerId/audit-log
POST             /commerce/stores/:storeId/customers/:customerId/invite
POST/DELETE      /commerce/stores/:storeId/customers/:customerId/addresses
```

### List customers

```bash
curl -s \
  -H "Authorization: Bearer <cc_prv_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/customers?limit=50&offset=0"
```

---

## Customer groups

Customer groups enable segment-specific price lists, discounts, and B2B rules.

```
GET/POST         /commerce/stores/:storeId/customer-groups
GET/PUT/DELETE   /commerce/stores/:storeId/customer-groups/:groupId
POST/DELETE      /commerce/stores/:storeId/customer-groups/:groupId/members/:customerId
```

---

## Customer auth (storefront)

The auth module lives under `/commerce/stores/:storeId/auth/...` and supports:
email/password, magic links, password reset, and social sign-in via Google,
Microsoft, and Discord OAuth.

See [Customer identity & accounts](../identity.md) for the full auth reference.

---

## Further reading

- [Customer identity & accounts](../identity.md) — full storefront auth reference
- [B2B](./b2b.md) — companies, credit, and wholesale purchasing
- [Discounts](./discounts.md) — segment-specific promotions
