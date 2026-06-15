---
title: "Payments"
description: "BYO payment providers (Stripe, Paystack, Razorpay, Xendit), webhook routing, capture, refund, and GA4 server-side events."
---

# Payments

Cartcrft uses a bring-your-own-keys model: you configure your own Stripe,
Paystack, Razorpay, or Xendit credentials per store. No platform fee — your
provider processes payments directly.

Credentials are stored **AES-256-GCM encrypted** at rest using `AUTH_SECRETS_KEY`
and are never re-returned after creation. See [BYO Keys](../byo-keys.md) for setup.

---

## Supported providers

| Provider | Region focus | Notes |
|----------|-------------|-------|
| **Stripe** | Global | PaymentIntent flow; supports `client_secret` frontend completion |
| **Paystack** | Africa (NGN, ZAR, GHS, USD) | Redirect to Paystack checkout |
| **Razorpay** | India | Razorpay.js frontend integration |
| **Xendit** | Southeast Asia | Invoice URL redirect |

---

## Configure a provider

Requires `cc_prv_` with `commerce:admin` scope or a management JWT.

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_admin>" \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "secret_key": "sk_live_...",
    "webhook_secret": "whsec_..."
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/payment-providers"
```

The key is returned only once on creation. To rotate, delete and re-create.

---

## Payment endpoints

```
GET/POST       /commerce/stores/:storeId/orders/:orderId/payments
POST           /orders/:orderId/payments/:paymentId/capture
POST           /orders/:orderId/payments/:paymentId/refund
GET/POST/DELETE /commerce/stores/:storeId/payment-providers
```

### Refund

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_admin>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": "29.99",
    "reason": "customer_request",
    "restock": true
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/orders/<ORDER_ID>/payments/<PAYMENT_ID>/refund"
```

`restock: true` automatically returns inventory. Refund reasons:
`customer_request`, `defective`, `not_received`, `other`.

---

## Inbound webhooks

The webhook router at `/webhooks/:storeId/...` accepts signed events from all
four providers and confirms payments atomically. Replay protection is built in
(idempotency on provider event IDs).

| Path | Provider |
|------|----------|
| `/webhooks/:storeId/stripe` | Stripe |
| `/webhooks/:storeId/paystack` | Paystack |
| `/webhooks/:storeId/razorpay` | Razorpay |
| `/webhooks/:storeId/xendit` | Xendit |

---

## GA4 server-side events

When a `google_analytics_4` tracking pixel is configured for the store, a GA4
Measurement Protocol `purchase` event fires automatically on payment capture.

```
GET/POST/DELETE  /commerce/stores/:storeId/tracking-pixels
```

---

## Error codes

| Code | HTTP | Meaning |
|------|------|---------|
| `PROVIDER_NOT_CONFIGURED` | 501 | No active payment provider for this store |
| `INVALID_AMOUNT` | 400 | Amount is not a valid positive decimal |

---

## Further reading

- [BYO Keys](../byo-keys.md) — detailed per-provider setup instructions
- [Orders & checkout](./orders-checkout.md) — checkout flow
- [Checkout links](../checkout-links.md) — payment links without a storefront
