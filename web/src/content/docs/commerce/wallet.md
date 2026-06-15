---
title: "Wallet — gift cards & store credit"
description: "Gift card issuance and redemption, and per-customer store credit ledger with full transaction log."
---

# Wallet — gift cards & store credit

The wallet module covers two complementary balance types: gift cards (opaque
codes with a shared balance) and store credit (per-customer credit ledger with
full transaction history).

---

## Gift cards

Gift cards are identified by opaque codes. Look up a code, check the balance, and
partially redeem at checkout.

```
GET/POST     /commerce/stores/:storeId/gift-cards
POST         /commerce/stores/:storeId/gift-cards/lookup
GET/POST     /commerce/stores/:storeId/gift-cards/:giftCardId/disable
```

### Issue a gift card

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{"initial_value": "50.00", "currency": "USD"}' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/gift-cards"
```

### Look up a code

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_pub_>" \
  -H "Content-Type: application/json" \
  -d '{"code": "GIFT-XXXX-YYYY"}' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/gift-cards/lookup"
```

Returns `{ code, balance, currency, status }`.

---

## Store credit

Per-customer credit balance with a full ledger of issue, adjust, and consume
transactions.

```
GET     /commerce/stores/:storeId/customers/:customerId/credits
POST    /commerce/stores/:storeId/customers/:customerId/credits/issue
POST    /commerce/stores/:storeId/customers/:customerId/credits/adjust
GET     /commerce/stores/:storeId/customers/:customerId/credits/transactions
```

### Issue credit

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{"amount": "15.00", "reason": "loyalty_reward"}' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/customers/<CUSTOMER_ID>/credits/issue"
```

---

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `INSUFFICIENT_CREDIT` | 422 | Customer credit balance too low for the transaction |
| `WALLET_NOT_FOUND` | 404 | Credit wallet does not exist for this customer |

---

## Further reading

- [Returns](./returns.md) — issue store credit on return resolution
- [Discounts](./discounts.md) — code-based promotions
- [Customers](./customers.md) — customer account management
