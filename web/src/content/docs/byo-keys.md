---
title: "BYO Keys"
description: "Bring your own payment provider, LLM key for semantic search, and email provider — no platform credentials required."
sidebar:
  label: "BYO Keys"
  order: 1
---

# BYO Keys Guide

CartCrft has zero take rate. You bring your own payment provider credentials,
your own LLM key for semantic search, and optionally your own email provider.
No platform credentials required.

---

## Payment providers

Each store can have one or more payment provider configurations. The webhook
router uses the `provider_reference` slug to route inbound events to the right
provider — so you can run Stripe for some stores and Paystack for others.

### Configure a provider

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_ or JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Stripe",
    "provider_reference": "stripe",
    "config": {
      "secret_key": "sk_live_...",
      "publishable_key": "pk_live_..."
    },
    "webhook_secret": "whsec_..."
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/payment-providers"
```

The `webhook_secret` is encrypted at rest with AES-256-GCM (see below). The
`config` object is stored as plain JSON — put only non-secret config there, or
set `AUTH_SECRETS_KEY` to encrypt everything.

### Supported providers

| Provider | `provider_reference` | Notes |
|----------|---------------------|-------|
| Stripe | `stripe` | PaymentIntent API; `config.secret_key` + `config.publishable_key` |
| Paystack | `paystack` | Initialize transaction; `config.secret_key` |
| Razorpay | `razorpay` | Create order; `config.key_id` + `config.key_secret` |
| Xendit | `xendit` | Create invoice; `config.secret_key` |

Provider clients are in `backend/src/providers/payments/`. Each is a thin
`fetch`-based client — no vendor SDKs are imported, keeping the dependency tree
clean and the bundle small.

### Webhook URLs

Configure these URLs in your payment provider dashboard:

```
POST https://<your-host>/webhooks/<STORE_ID>/payment/<provider_reference>
PUT  https://<your-host>/webhooks/<STORE_ID>/payment/<provider_reference>
POST https://<your-host>/webhooks/<STORE_ID>/payment   (no ref — load by type)
```

The router automatically:
1. Verifies the signature using the provider-specific HMAC algorithm.
2. Rejects replays (event ID deduplication via `webhook_replay_guard`).
3. Rejects events with a timestamp older than 5 minutes (Stripe tolerance).
4. Records the event in `payment_provider_webhook_log`.
5. On successful payment: updates the payment record and auto-completes any
   pending checkout for the payment's `provider_reference`.

**Signature algorithms:**

| Provider | Algorithm | Header |
|----------|-----------|--------|
| Stripe | HMAC-SHA256, dual-secret fallback | `stripe-signature` |
| Paystack | HMAC-SHA512 | `x-paystack-signature` |
| Razorpay | HMAC-SHA256 | `x-razorpay-signature` |
| Xendit | constant-time compare | `x-callback-token` |

The tracking webhook (carrier push) lives at a separate path owned by the
shipping module:

```
POST https://<your-host>/webhooks/<STORE_ID>/tracking/<SHIPMENT_ID>
```

---

## LLM key for semantic search

Semantic search uses pgvector embeddings. By default (no LLM key) search falls
back to Postgres `websearch_to_tsquery` full-text. To enable hybrid
semantic + full-text ranking, store your LLM key in the store's metadata:

```bash
curl -s -X PUT \
  -H "Authorization: Bearer <cc_prv_ or JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "llm_provider": {
        "api_key": "<your-openai-or-compatible-api-key>",
        "model": "text-embedding-3-small"
      }
    }
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>"
```

The `llm_provider` field shape:

```typescript
{
  api_key: string;           // required — AES-256-GCM encrypted when AUTH_SECRETS_KEY set
  model?:  string;           // default: "text-embedding-3-small"
  base_url?: string;         // default: OpenAI endpoint; override for compatible providers
}
```

The field is stored in `stores.metadata` (jsonb). It is encrypted/decrypted via
`lib/secrets.ts` the same way payment webhook secrets are — if `AUTH_SECRETS_KEY`
is set the value is never stored in plaintext.

**Supported embedding models** — any OpenAI-compatible `/v1/embeddings` endpoint
works. The embedding dimension defaults to 1536 (OpenAI `text-embedding-3-small`).
The `pgvector` column is `vector(1536)`. If you use a model with a different
dimension, create a fresh store (dimension is fixed at schema time).

**Embedding worker** — once a key is configured, start the worker process:

```bash
pnpm dev worker   # or: pnpm start worker in production
```

The worker polls every 30 seconds and batch-embeds products where
`embedding IS NULL OR embedding_updated_at < updated_at`.

---

## Secret encryption (AUTH_SECRETS_KEY)

All provider secrets (`webhook_secret`, `api_key` in `llm_provider`, etc.) are
encrypted at rest with AES-256-GCM using the `AUTH_SECRETS_KEY` environment
variable.

**Generate a key:**

```bash
# 64-char hex (32 bytes)
openssl rand -hex 32

# or 44-char base64 (32 bytes)
openssl rand -base64 32
```

**Environment variable:**

```bash
AUTH_SECRETS_KEY=<64-char-hex-or-44-char-base64>
```

**Rules:**
- `AUTH_SECRETS_KEY` is **required** when `APP_ENV=production`. The server
  refuses to start without it in production.
- In development (no key set), secrets are stored in plaintext — fine for local
  dev, not for any shared environment.
- The encryption layout is `base64(nonce_12bytes || ciphertext || tag_16bytes)`.
  See `backend/src/lib/secrets.ts` for the implementation.

**Key rotation** — update `AUTH_SECRETS_KEY` and re-save each provider config
via `PUT /commerce/stores/:storeId/payment-providers/:providerId` to re-encrypt
with the new key. There is no automatic re-encryption on key change.

---

## Email provider (AWS SES)

Transactional emails (verification, magic link, password reset) use AWS SES when
configured, or a console mailer (prints to stdout) otherwise.

```bash
AWS_SES_REGION=us-east-1
AWS_SES_ACCESS_KEY_ID=AKIA...
AWS_SES_SECRET_ACCESS_KEY=...
EMAIL_FROM=Crft Goods <noreply@example.com>
```

The `EMAIL_FROM` value accepts a display-name format (`Name <addr>`). The SES
client uses Signature Version 4 directly (no AWS SDK dependency).

---

## Exchange rates (cloud billing)

The cloud billing layer uses live USD/ZAR exchange rates for invoicing. This
requires an API key from exchangerate-api.com:

```bash
EXCHANGE_RATE_API_KEY=<key>
```

This is only used by `cloud/billing/` and is not required for self-hosted
deployments without billing.
