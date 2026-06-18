---
title: "Provider API keys"
description: "Step-by-step guide to getting your own API keys for every provider CartCrft integrates — payments, shipping, tax, notifications, search, and FX — and where to enter each one."
sidebar:
  label: "Provider API keys"
  order: 2
---

# Getting your API keys

CartCrft is **bring-your-own-keys (BYO)**. You supply your own provider
credentials, and CartCrft wires them into your store. We take a **0% GMV rake**
and charge **no transaction fees** — every provider relationship (and its
pricing) is a direct contract between you and that provider.

This guide walks through **every provider CartCrft integrates**: what each one
is for, how to obtain its key from the provider's own dashboard, how to handle
test/sandbox vs live credentials, exactly where to enter the key in CartCrft,
and a short security note for each.

---

## How BYO works

- **You own the relationship.** Your Stripe payouts land in your Stripe account;
  your Twilio bill comes from Twilio. CartCrft never sits in the money flow and
  never holds funds.
- **0% rake, no transaction fees.** CartCrft does not skim a percentage of GMV
  and does not add a per-transaction surcharge. You pay each provider their
  published rate, nothing more.
- **Keys are encrypted at rest.** Secrets you store per-store (payment webhook
  secrets, the semantic-search key, Twilio credentials, etc.) are encrypted with
  **AES-256-GCM** using the server's `AUTH_SECRETS_KEY`. They are never returned
  in plaintext after you save them. See [BYO Keys](./byo-keys.md) and
  [Security](./security.md) for the encryption details.
- **Two places keys live.** Most merchant-facing providers are configured
  **per-store** in the dashboard (or via the API). A few platform/infra
  providers are configured **once per deployment** via environment variables —
  these are relevant to self-host operators only.

---

## Quick reference

| Provider | Purpose | Where to get the key | Where to enter it in CartCrft |
|----------|---------|----------------------|-------------------------------|
| **Stripe** | Card payments (global) | Stripe Dashboard → Developers → API keys | Dashboard → **Store → Payments** |
| **Paystack** | Payments (Africa) | Paystack Dashboard → Settings → API Keys & Webhooks | Dashboard → **Store → Payments** |
| **Razorpay** | Payments (India) | Razorpay Dashboard → Settings → API Keys | Dashboard → **Store → Payments** |
| **Xendit** | Payments (SE Asia) | Xendit Dashboard → Settings → Developers → API Keys | Dashboard → **Store → Payments** |
| **Shippo** | Multi-carrier rates + labels | goshippo.com → Settings → API | API: `shipping-providers` (config `provider: shippo`) |
| **BobGo** | SA courier rates + labels | app.bobgo.co.za → Settings → API Keys | Dashboard → **Operations → Shipping → Providers** |
| **TaxJar** | Automated sales-tax calc | taxjar.com → Account → SmartCalcs API | Env: `TAXJAR_API_KEY` (self-host) |
| **AWS SES** | Transactional email | AWS Console → IAM + SES | Env: `AWS_SES_*` / `EMAIL_FROM` |
| **Twilio** | SMS / WhatsApp | console.twilio.com | Dashboard → **Store → Notifications** or env `TWILIO_*` |
| **OpenAI-compatible** | Semantic search embeddings | platform.openai.com → API keys | API: store `metadata.llm_provider` |
| **ExchangeRate-API** | Multi-currency FX refresh | exchangerate-api.com | Env: `EXCHANGE_RATE_API_KEY` (self-host) |

> **Dashboard nav note:** The sections referenced above match the live dashboard:
> **Payments**, **Notifications**, **Integrations**, **Customer Auth**, and
> **API Keys** live under the **Store** group; **Shipping** and **Tax** live
> under **Operations**.

---

## Payments

All four payment providers use the same BYO model: configure one or more per
store under **Store → Payments**, or via the
`POST /commerce/stores/:storeId/payment-providers` endpoint. The webhook router
uses each provider's `provider_reference` slug to route inbound events, so you
can run different providers for different stores. Provider clients live in
`backend/src/providers/payments/` and are thin `fetch`-based clients (no vendor
SDKs).

> Secret keys are returned only once on creation and are encrypted at rest. To
> rotate, delete and re-create (or `PUT` a fresh config).

### Stripe

**What it's for:** Card payments worldwide, via the PaymentIntent API.

**Get your keys:**

1. Sign in to the [Stripe Dashboard](https://dashboard.stripe.com).
2. Go to **Developers → API keys**.
3. Copy the **Secret key** — `sk_test_…` in test mode, `sk_live_…` in live mode.
   (Click **Reveal** for the live secret key.)
4. Optionally copy the **Publishable key** (`pk_test_…` / `pk_live_…`) for
   client-side completion of the PaymentIntent.
5. Go to **Developers → Webhooks → Add endpoint**, point it at your CartCrft
   webhook URL (below), and copy the **Signing secret** (`whsec_…`).

**Test vs live:** Use the toggle at the top of the Stripe Dashboard to switch
between **Test mode** and **Live mode** — each mode has its own keys and its own
webhook signing secret. Start with `sk_test_` keys, then add a second provider
config with your `sk_live_` keys when you go live.

**Where to enter it in CartCrft:** Dashboard → **Store → Payments** → **+ Add
Provider** → Stripe. Enter the **Secret key**, optional **Publishable key**, and
the **Webhook signing secret**.

**Webhook URL** to register in Stripe:

```
POST https://<your-host>/webhooks/<STORE_ID>/payment/stripe
```

Stripe events are verified with HMAC-SHA256 against the `stripe-signature`
header (with dual-secret fallback for rotation).

**Security note:** Never expose the secret key in client code — only the
publishable key belongs in the browser. Use a restricted/test key during
development.

### Paystack

**What it's for:** Payments across Africa (NGN, ZAR, GHS, USD) via redirect to
Paystack checkout.

**Get your keys:**

1. Sign in to the [Paystack Dashboard](https://dashboard.paystack.com).
2. Go to **Settings → API Keys & Webhooks**.
3. Copy the **Secret Key** — `sk_test_…` in test mode, `sk_live_…` in live mode.

**Test vs live:** Paystack exposes both a test and a live secret key on the same
page. Use `sk_test_` first; switch to `sk_live_` for production.

**Where to enter it in CartCrft:** Dashboard → **Store → Payments** → **+ Add
Provider** → Paystack. Enter the **Secret Key** and (recommended) a webhook
secret.

**Webhook URL** to register in Paystack:

```
POST https://<your-host>/webhooks/<STORE_ID>/payment/paystack
```

Paystack events are verified with HMAC-SHA512 against the
`x-paystack-signature` header.

**Security note:** The secret key grants full transaction access — keep it
server-side only and rotate it from the same Settings page if exposed.

### Razorpay

**What it's for:** Payments in India, via the Razorpay Orders API and
`Razorpay.js` frontend integration.

**Get your keys:**

1. Sign in to the [Razorpay Dashboard](https://dashboard.razorpay.com).
2. Go to **Settings → API Keys**.
3. Click **Generate Key** (or **Regenerate**). Copy the **Key ID** (`rzp_test_…`
   / `rzp_live_…`) and the **Key Secret** — the secret is shown **only once**.

**Test vs live:** Use the Test/Live toggle in the Razorpay Dashboard. Test keys
carry an `rzp_test_` prefix; live keys carry `rzp_live_`.

**Where to enter it in CartCrft:** Dashboard → **Store → Payments** → **+ Add
Provider** → Razorpay. Enter the **Key ID** and **Key Secret**.

**Webhook URL** to register in Razorpay:

```
POST https://<your-host>/webhooks/<STORE_ID>/payment/razorpay
```

Razorpay events are verified with HMAC-SHA256 against the
`x-razorpay-signature` header.

**Security note:** Capture the Key Secret immediately on generation (it is not
shown again). Store only the Key ID in any client context.

### Xendit

**What it's for:** Payments across Southeast Asia, via the Invoice API (customer
is redirected to a Xendit invoice URL).

**Get your keys:**

1. Sign in to the [Xendit Dashboard](https://dashboard.xendit.co).
2. Go to **Settings → Developers → API Keys**.
3. Click **Generate secret key**, grant it the required permissions, and copy
   the **Secret API key** (shown only once).
4. Under **Settings → Developers → Webhooks**, set a **webhook verification
   token** (callback token).

**Test vs live:** Xendit separates **Test** and **Live** modes; generate a key
in each mode as needed.

**Where to enter it in CartCrft:** Dashboard → **Store → Payments** → **+ Add
Provider** → Xendit. Enter the **Secret key** and the **callback/verification
token** as the webhook secret.

**Webhook URL** to register in Xendit:

```
POST https://<your-host>/webhooks/<STORE_ID>/payment/xendit
```

Xendit callbacks are verified by constant-time comparison of the
`x-callback-token` header.

**Security note:** Scope the secret key to only the permissions you need
(least-privilege) and keep the callback token secret — it is what proves an
inbound webhook genuinely came from Xendit.

---

## Shipping

Live carrier rates and label purchase are optional add-ons. A shipping provider
is stored as a provider entry with a `config.provider` slug
(`bobgo` / `shippo`) and a `config.api_key`. Provider clients live in
`backend/src/providers/shipping/`.

### Shippo

**What it's for:** Multi-carrier rate shopping and label purchase across many
global couriers via the Shippo aggregation API.

**Get your token:**

1. Sign in at [goshippo.com](https://goshippo.com).
2. Go to **Settings → API**.
3. Generate an API token. Shippo issues separate **Live** and **Test** tokens —
   the value CartCrft sends as `Authorization: ShippoToken <token>`.

**Test vs live:** Use the **Test** token while developing (test tokens don't
charge for labels), then switch to your **Live** token for production.

**Where to enter it in CartCrft:** Configure a shipping provider via the API
with the Shippo slug:

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_admin or JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Shippo",
    "type": "webhook",
    "config": { "provider": "shippo", "api_key": "shippo_live_..." }
  }' \
  "https://<your-host>/commerce/stores/<STORE_ID>/shipping-providers"
```

Once an active `shippo` provider exists, live Shippo rates are merged into the
rates returned by the checkout rate query. You can review configured providers
under Dashboard → **Operations → Shipping → Providers**.

**Security note:** Treat the Shippo token like a password — it can purchase
labels (which cost money). Use the Test token in non-production environments.

### BobGo

**What it's for:** Live South African courier rates and waybill/label generation
via BobGo's v2 API.

**Get your token:**

1. Sign in at the [BobGo Dashboard](https://app.bobgo.co.za).
2. Go to **Settings → API Keys**.
3. Generate an API key — used as a Bearer token
   (`Authorization: Bearer <token>`).

**Test vs live:** BobGo provides sandbox/test credentials for integration; use
those before switching to your production key.

**Where to enter it in CartCrft:** Dashboard → **Operations → Shipping →
Providers** → add/edit the **BobGo** provider. Enter the **API Key** (and
optional **Account ID**) in the BobGo configuration modal. This writes a
provider with `config.provider = "bobgo"` and `config.api_key`.

**Security note:** The key authorises courier bookings billed to your BobGo
account. Store it only in CartCrft (encrypted at rest), not in client code.

---

## Tax

### TaxJar

**What it's for:** Automated, address-accurate sales-tax calculation
(SmartCalcs). When a TaxJar key is present, CartCrft calls TaxJar to compute tax
at checkout; otherwise it falls back to your configured tax zones and rates.

**Get your token:**

1. Sign in at [taxjar.com](https://www.taxjar.com).
2. Go to **Account → SmartCalcs API** (API Access).
3. Generate/copy your **API token** — sent as `Authorization: Bearer <token>`.

**Test vs live:** TaxJar has a **sandbox** environment
(`api.sandbox.taxjar.com`) and a **live** environment (`api.taxjar.com`).
CartCrft selects the sandbox base URL when `TAXJAR_SANDBOX` is enabled.

**Where to enter it in CartCrft:** TaxJar is configured per **deployment** via
environment variables (self-host operators):

```bash
TAXJAR_API_KEY=<your-taxjar-api-token>
TAXJAR_SANDBOX=true   # use TaxJar sandbox; omit/false for live
```

The provider client is `backend/src/providers/tax/taxjar.ts`; wiring is in
`backend/src/lib/tax.ts`. Tax zones/rates that aren't provider-driven are
managed under Dashboard → **Operations → Tax**.

**Security note:** Keep `TAXJAR_API_KEY` in your secret manager / environment,
never in source control. Use the sandbox token in staging.

---

## Notifications

### AWS SES (email)

**What it's for:** Transactional email — account verification, magic links,
password resets, and order notifications. When SES isn't configured, CartCrft
falls back to a console mailer (prints to stdout) for local dev.

**Get your credentials:**

1. In the [AWS Console](https://console.aws.amazon.com/ses), open **Amazon
   SES** in your chosen region and **verify a sender identity** (a domain or a
   single email address).
2. If your account is in the SES sandbox, request **production access** to send
   to unverified recipients.
3. In **IAM**, create a user (or role) with a policy allowing `ses:SendEmail` /
   `ses:SendRawEmail`, then create an **access key** (Access key ID + Secret
   access key).

**Test vs live:** New SES accounts start in **sandbox** mode (you can only send
to verified addresses). Request production access before going live.

**Where to enter it in CartCrft:** Configured per **deployment** via
environment variables:

```bash
AWS_SES_REGION=us-east-1
AWS_SES_ACCESS_KEY_ID=AKIA...
AWS_SES_SECRET_ACCESS_KEY=...
EMAIL_FROM=CartCrft <noreply@example.com>
```

`EMAIL_FROM` accepts a `Display Name <address>` format and must be a verified
SES sender. The SES client signs requests with AWS Signature V4 directly (no AWS
SDK dependency). Email **notification providers** themselves are managed under
Dashboard → **Store → Notifications**.

**Security note:** Grant the IAM key only the SES send permissions it needs
(least-privilege), and rotate the access key periodically from IAM.

### Twilio (SMS / WhatsApp)

**What it's for:** Outbound SMS and WhatsApp notifications on commerce events
(order created, payment captured, shipment updates, etc.).

**Get your credentials:**

1. Sign in to the [Twilio Console](https://console.twilio.com).
2. From the Console dashboard, copy your **Account SID** and **Auth Token**.
3. Provision either a **Messaging Service SID** (recommended) **or** a **From
   number** (a Twilio phone number capable of SMS).
4. For WhatsApp, set up a **WhatsApp sender** (the Twilio Sandbox for WhatsApp
   in development, or an approved WhatsApp sender in production). Numbers are
   automatically `whatsapp:`-prefixed by CartCrft.

**Test vs live:** Use the **WhatsApp Sandbox** and Twilio test credentials while
developing; move to an approved sender and your live Account SID/Auth Token for
production.

**Where to enter it in CartCrft:**

- **Per-store (preferred):** Dashboard → **Store → Notifications** → add an
  **SMS** or **WhatsApp** provider. The provider's `config` carries
  `account_sid`, `auth_token`, and either `from_number` or
  `messaging_service_sid`. Per-store config overrides the global env values.
- **Per-deployment (fallback):** environment variables used when a provider has
  no per-store credentials:

```bash
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+1XXXXXXXXXX        # or use a Messaging Service instead
TWILIO_MESSAGING_SERVICE_SID=MG...     # takes precedence over From number
```

If a Messaging Service SID is set, it is used in place of the From number. The
provider client is `backend/src/providers/notifications/twilio.ts`.

**Security note:** The Auth Token is a master credential for your Twilio
account — prefer per-store config (encrypted at rest) over baking it into shared
env where possible, and rotate it from the Console if exposed.

---

## Search (optional)

### OpenAI-compatible embeddings

**What it's for:** Hybrid semantic + full-text product search. Without a key,
search falls back to Postgres `websearch_to_tsquery` full-text. With a key,
CartCrft embeds products with pgvector for semantic ranking.

**Get your key:**

1. Sign in at [platform.openai.com](https://platform.openai.com).
2. Go to **API keys → Create new secret key** and copy it (shown once).
3. Any **OpenAI-compatible `/v1/embeddings` endpoint** works — set a custom
   `base_url` to use a compatible provider instead.

**Test vs live:** This is BYO and **paid at cost** — you are billed by your
embeddings provider for usage. There is no separate sandbox; use a low-volume
key while testing.

**Where to enter it in CartCrft:** Store it in the store's `metadata.llm_provider`
via the API:

```bash
curl -s -X PUT \
  -H "Authorization: Bearer <cc_prv_ or JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "llm_provider": {
        "api_key": "<your-openai-or-compatible-key>",
        "model": "text-embedding-3-small",
        "base_url": "https://api.openai.com/v1"
      }
    }
  }' \
  "https://<your-host>/commerce/stores/<STORE_ID>"
```

The embedding dimension defaults to **1536** (OpenAI `text-embedding-3-small`),
matching the `vector(1536)` pgvector column. Once a key is configured, run the
embedding worker (`pnpm start worker`). See [BYO Keys](./byo-keys.md#llm-key-for-semantic-search)
for full details.

**Security note:** The key is AES-256-GCM encrypted at rest when
`AUTH_SECRETS_KEY` is set, and never returned in plaintext. Use a key scoped to
embeddings/usage limits if your provider supports it.

---

## Platform / infrastructure (self-host operators)

### ExchangeRate-API (multi-currency FX)

**What it's for:** Refreshing exchange rates for multi-currency pricing and (in
cloud builds) USD/ZAR invoicing.

**Get your key:**

1. Sign up at [exchangerate-api.com](https://www.exchangerate-api.com).
2. Copy your **API key** from the dashboard (a free tier is available).

**Where to enter it in CartCrft:** Configured per **deployment** via an
environment variable:

```bash
EXCHANGE_RATE_API_KEY=<your-key>
```

This drives the FX refresh in `backend/src/modules/exchange-rates/fx-refresh.ts`.
It is only required for multi-currency FX refresh / cloud billing — self-hosted
single-currency deployments can omit it.

**Security note:** Keep the key in your environment/secret store, not in version
control.

---

## Security & best practices

- **Use test/sandbox keys first.** Every payment and shipping provider above
  offers test credentials. Validate your full checkout, fulfilment, and refund
  flows on test keys before adding live ones. See the
  [Launch checklist](./guides/go-live.md).
- **Least privilege.** Scope keys to only the permissions they need (e.g.
  SES-send-only IAM keys, embeddings-scoped LLM keys, restricted Stripe keys).
- **Rotate keys.** Rotate provider keys periodically and immediately if one may
  be exposed. After rotating, re-save the provider config in CartCrft so the new
  value is re-encrypted. There is no automatic re-encryption on key change.
- **Never commit keys.** Keep environment-based keys
  (`TAXJAR_API_KEY`, `AWS_SES_*`, `TWILIO_*`, `EXCHANGE_RATE_API_KEY`,
  `AUTH_SECRETS_KEY`) in a secret manager — never in source control.
- **Prefer per-store config over global env where supported.** Per-store
  secrets (payments, Twilio, semantic search) are AES-256-GCM encrypted at rest
  and never re-returned. Reserve env vars for true platform-level providers.
- **Protect `AUTH_SECRETS_KEY`.** It is the master key that encrypts all stored
  secrets and is **required in production** — the server refuses to start
  without it. Generate one with `openssl rand -hex 32`. See
  [Security](./security.md) and [BYO Keys](./byo-keys.md#secret-encryption-auth_secrets_key).

> **Remember:** CartCrft never touches your funds. 0% rake, no transaction
> fees — you contract directly with each provider and keep the full relationship.
