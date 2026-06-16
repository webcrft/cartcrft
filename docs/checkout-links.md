# Checkout Links

Shareable, pre-filled payment links — a hosted checkout page you can send over
email, WhatsApp, or a QR code, or embed as an iframe on any site. **No storefront
code required.** The link's token *is* the capability: anyone who holds it can pay,
and nothing else.

Useful for social selling, invoices, "pay this link" flows, pop-ups, and embedding
a single product's checkout on a marketing page.

---

## How it works

1. The merchant creates a link from one or more `line_items` (variant + quantity).
   CartCrft snapshots the items and returns an unguessable token (`cl_<24 random
   bytes>`) and a hosted URL: `<PUBLIC_CHECKOUT_BASE>/pay/<token>`.
2. The buyer opens the URL. The hosted page resolves the link (totals, currency,
   store branding) with **no authentication** — the token is the only credential.
3. On pay, the page calls `start-payment`, which builds a real cart + checkout from
   the snapshot, starts a provider session with the store's first active payment
   provider, and returns a provider-shaped payload to complete payment.
4. The order is finalised by the **same inbound webhook path as native checkout** —
   so reconciliation, inventory decrement, and discounts behave identically.

The public endpoints look the link up **by token only** and derive the store from
the row; they never accept a caller-supplied `store_id`, so a token cannot leak or
mutate cross-store data. Merchant endpoints are RLS org-gated like every other
tenant table (migration `0028`).

---

## Merchant API

All merchant endpoints require a `cc_prv_` key or JWT (`storeAuthWrite`) and are
mounted under `/commerce/stores/:storeId/checkout-links`.

### Create a link

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_ or JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "line_items": [
      { "variant_id": "<VARIANT_UUID>", "quantity": 1 }
    ],
    "customer_email": "buyer@example.com",
    "success_url": "https://yourbrand.com/thanks",
    "cancel_url": "https://yourbrand.com/cart",
    "expires_at": "2026-12-31T23:59:59Z"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/checkout-links"
```

```json
{ "id": "<LINK_UUID>", "token": "cl_xxxxxxxx", "url": "<PUBLIC_CHECKOUT_BASE>/pay/cl_xxxxxxxx" }
```

`customer_email`, `success_url`, `cancel_url`, and `expires_at` are all optional.
`line_items` requires at least one entry.

### List links

```bash
curl -s -H "Authorization: Bearer <cc_prv_ or JWT>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/checkout-links?status=open&limit=50"
```

Query params: `limit` (1–200), `offset`, `status` (`open` | `completed` | `expired` | `void`).
Each returned link includes its hosted `url`.

### Void a link

```bash
curl -s -X POST -H "Authorization: Bearer <cc_prv_ or JWT>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/checkout-links/<LINK_ID>/void"
```

Returns `404` if the link is not found or is no longer open.

---

## Public API (no auth — the token is the capability)

### Resolve a link

```bash
curl -s "http://localhost:3000/storefront/checkout-links/<TOKEN>"
```

Returns the line-item snapshot, totals, currency, and store branding for the hosted
page to render. `404 NOT_FOUND` if the token is unknown.

### Start payment

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{ "email": "buyer@example.com" }' \
  "http://localhost:3000/storefront/checkout-links/<TOKEN>/start-payment"
```

Builds the cart + checkout, resolves the store's first active provider (by
`position`, then `created_at`), and returns a provider-shaped payload plus the
`checkout_id`:

| Provider | Payload fields |
|----------|----------------|
| Stripe   | `client_secret`, `payment_intent_id` |
| Paystack | `authorization_url`, `reference` (requires `email`) |
| Razorpay | `order_id`, `amount`, `currency`, `key_id` |
| Xendit   | `invoice_url`, `invoice_id` |

`email` is optional in the body unless the link already carries one — except for
**Paystack**, which requires a customer email (provide it on the link or in the form).

#### Error codes

| Status | Code | When |
|--------|------|------|
| `404` | `NOT_FOUND` | token unknown |
| `409` | `LINK_NOT_OPEN` | link is completed, expired, or voided |
| `422` | `VALIDATION_ERROR` | bad input (e.g. Paystack without an email) |
| `501` | `PROVIDER_NOT_CONFIGURED` | store has no active provider, or the provider type has no hosted session |

---

## Embedding

The hosted page also serves a compact iframe mode at `/pay/<token>?embed=1`:

```html
<iframe
  src="<PUBLIC_CHECKOUT_BASE>/pay/cl_xxxxxxxx?embed=1"
  style="width:100%;max-width:480px;height:640px;border:0;border-radius:14px"
  title="Checkout"
  allow="payment">
</iframe>
```

The provider redirect (Paystack `authorization_url`, Stripe, or Xendit invoice)
breaks out of the iframe to the provider's domain via `window.top`, then returns to
the link's `success_url` / `cancel_url`.

---

## Configuration

| Env | Purpose |
|-----|---------|
| `PUBLIC_CHECKOUT_BASE` | Origin used to build the `/pay/<token>` URL returned by create/list (e.g. `https://pay.yourbrand.com`). Defaults to empty (relative path). |

Payment provider credentials are configured per store — see
[byo-keys.md](./byo-keys.md). The link reuses the same `create*Session` machinery as
native checkout, so anything you can pay natively, you can pay via a link.

---

## See also

- [byo-keys.md](./byo-keys.md) — configure Stripe / Paystack / Razorpay / Xendit
- [api-overview.md](./api-overview.md) — auth tiers, error envelope, money encoding
- [parity-endpoints.md](./parity-endpoints.md) — full endpoint table
