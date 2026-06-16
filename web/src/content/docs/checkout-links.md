---
title: "Embedded checkout & cart links"
description: "Create a prefilled shareable payment link, host the /pay/:token checkout page, and embed it as an iframe on any site. Grounded in the checkout-links module and the hosted CheckoutApp."
---

# Embedded checkout & cart links

Checkout links let you generate a shareable URL that takes a customer directly
to a pre-populated, hosted checkout — no storefront code required. They work for
one-off payment requests, wholesale invoicing, influencer codes, or any scenario
where you want to send a customer a link to buy specific products.

The module is implemented in `backend/src/modules/checkout-links/`. The hosted
checkout page is `web/src/checkout/CheckoutApp.tsx`.

---

## How it works

1. Your backend calls `POST /commerce/stores/:storeId/checkout-links` with the
   desired line items (and optional customer email, success/cancel URLs, and
   expiry).
2. CartCrft returns a `token` (`cl_<random>`, 24 random bytes) and a hosted URL
   (`/pay/<token>`).
3. Share the URL with the customer. When they open it, the hosted page resolves
   the link, shows a branded checkout summary, and lets them pay.
4. On payment, the same webhook → order path as native checkout fires — no
   separate reconciliation needed.

The token is the capability: the public endpoints never accept a caller-supplied
store ID, so the token cannot leak or mutate cross-store data.

---

## Create a link

Requires `cc_prv_` write-tier or a management JWT.

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_ or JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "line_items": [
      { "variant_id": "<uuid>", "quantity": 2 },
      { "variant_id": "<uuid>", "quantity": 1 }
    ],
    "customer_email": "alice@example.com",
    "success_url": "https://yoursite.com/thank-you",
    "cancel_url":  "https://yoursite.com/store",
    "expires_at":  "2026-12-31T23:59:59Z"
  }' \
  "http://localhost:8080/commerce/stores/<STORE_ID>/checkout-links"
```

Response (201):

```json
{
  "id":    "<uuid>",
  "token": "cl_<random>",
  "url":   "https://pay.cartcrft.dev/pay/cl_<random>"
}
```

All fields except `line_items` are optional:
- Omit `customer_email` to let the customer enter their email on the payment
  page.
- Omit `success_url` / `cancel_url` to use the store's defaults.
- Omit `expires_at` for a non-expiring link.

---

## List and void links

```bash
# List links (filterable by status: open | completed | expired | void)
GET /commerce/stores/:storeId/checkout-links?status=open&limit=50&offset=0

# Void an open link (makes it uncollectable)
POST /commerce/stores/:storeId/checkout-links/:linkId/void
```

Link statuses:

| Status | Meaning |
|--------|---------|
| `open` | Available for payment |
| `completed` | Payment succeeded; order created |
| `expired` | Past `expires_at` |
| `void` | Manually voided by the merchant |

---

## Public endpoints (token as capability)

These endpoints require no auth header — the token is the bearer.

### Resolve a link

```bash
GET /storefront/checkout-links/:token
```

Returns the full checkout summary the hosted page uses to render:

```json
{
  "token": "cl_...",
  "status": "open",
  "store": { "name": "Acme Store" },
  "line_items": [
    {
      "variant_id": "...",
      "qty": 2,
      "unit_price": "49.99",
      "line_total": "99.98",
      "title": "Widget Pro — Large / Blue",
      "sku": "WGT-LG-BLU"
    }
  ],
  "totals": {
    "subtotal": "99.98",
    "tax_total": "15.00",
    "shipping_total": "0.00",
    "total": "114.98",
    "currency": "USD"
  }
}
```

### Start a payment session

```bash
POST /storefront/checkout-links/:token/start-payment
Content-Type: application/json

{ "email": "alice@example.com" }   # optional if set on the link
```

This call builds a real cart and checkout from the link's snapshot, then
initiates a payment session with the store's first active provider. The response
shape depends on the provider:

**Paystack**
```json
{
  "provider": "paystack",
  "authorization_url": "https://checkout.paystack.com/...",
  "reference": "ref_...",
  "checkout_id": "<uuid>"
}
```
Redirect the browser to `authorization_url`.

**Xendit**
```json
{
  "provider": "xendit",
  "invoice_url": "https://checkout.xendit.co/...",
  "invoice_id": "<uuid>",
  "checkout_id": "<uuid>"
}
```
Redirect the browser to `invoice_url`.

**Stripe**
```json
{
  "provider": "stripe",
  "client_secret": "pi_..._secret_...",
  "payment_intent_id": "pi_...",
  "checkout_id": "<uuid>"
}
```
Pass `client_secret` to the Stripe.js `confirmPayment()` call in your frontend.

**Razorpay**
```json
{
  "provider": "razorpay",
  "order_id": "order_...",
  "amount": 11498,
  "currency": "INR",
  "key_id": "rzp_live_...",
  "checkout_id": "<uuid>"
}
```
Pass these fields to `new Razorpay({ key: key_id, order_id, amount, currency })`.

Errors:
- `404` — token not found or link is not `open`
- `409 LINK_NOT_OPEN` — link has already been completed, expired, or voided
- `422 VALIDATION_ERROR` — invalid line items or missing required email
- `501 PROVIDER_NOT_CONFIGURED` — no active payment provider on this store

---

## Hosted checkout page — /pay/:token

![CartCrft hosted checkout — branded payment page](/screenshots/checkout.png)

*The hosted checkout page: store-branded, no storefront code required. Customers land here directly from the shareable link.*

The hosted page (`/pay/<token>`) is a self-contained React app that:

1. Calls `GET /storefront/checkout-links/:token` to load the store branding,
   line items, and totals.
2. Renders a clean checkout card: store name + CartCrft mark, line-item list,
   totals, an email field (if no email was pre-filled), and a Pay button.
3. On Pay, calls `POST .../start-payment` and redirects the browser to the
   provider URL.

---

## Iframe embed mode

Append `?embed=1` to the hosted URL to render a compact, shadow-less card
suitable for an iframe:

```html
<iframe
  src="https://pay.cartcrft.dev/pay/cl_xxxxx?embed=1"
  style="width:100%;max-width:480px;height:640px;border:0;border-radius:14px"
  title="Checkout"
  allow="payment">
</iframe>
```

In embed mode, provider redirects break out of the iframe via `window.top` so
the customer leaves the iframe for the provider's payment page, then returns to
`success_url` or `cancel_url`.

The hosted domain is configured via the `PUBLIC_CHECKOUT_BASE` environment
variable (defaults to the current origin in development).

---

## Security notes

- The `cl_` token is 24 random bytes (192 bits of entropy) — effectively
  unguessable.
- The public resolve and start-payment endpoints derive the store from the token
  row only — they never accept a caller-supplied `store_id`.
- Merchant write and list endpoints are RLS-gated to the org (enforced by the
  `storeAuthWrite` middleware and migration 0028).
- Voiding a link immediately makes it uncollectable; any in-flight payment
  session from a voided link will fail at the webhook reconciliation step.

---

## Further reading

- Payment provider setup: [byo-keys.md](./byo-keys.md)
- Full commerce API: [commerce.md](./commerce.md)
- OAuth apps for third-party integrations: [oauth-apps.md](./oauth-apps.md)
