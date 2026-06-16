---
title: "Cloud vs Self-host"
description: "MIT core vs the cloud/ layer — what the cloud tier adds, licensing split, and what you get when self-hosting."
sidebar:
  label: "Cloud vs Self-host"
  order: 3
---

# Cloud vs Self-Host

Cartcrft is designed so that self-hosting requires nothing from `cloud/`. This
document explains the licensing split, what the cloud layer adds, and what you
get when you self-host.

---

## Licensing

| Directory | License | Summary |
|-----------|---------|---------|
| Everything except `cloud/` | **MIT** | Use, modify, distribute freely |
| `cloud/` | **Cartcrft Cloud License v1.0** | Source-visible; development/testing free; production requires written agreement with WebCrft |

The MIT core is the product. `cloud/` is metering + billing + tenant
provisioning for the hosted cartcrft.com service only.

**Self-hosting Cartcrft never requires `cloud/`.**

The cloud license follows the GitLab EE / Elastic model: you can read the code,
run it locally for development and CI, and submit contributions — but you cannot
run it in production or offer it as a service without a commercial agreement.

Contact `legal@webcrft.io` for production cloud license enquiries.

---

## Self-host completeness guarantee

The MIT core (`backend/`, `admin/`, `sdk/`, `mcp/`) is complete and opinionated
about not having any gaps that require cloud. Specifically:

- All 105+ schema tables, migrations, and RLS policies ship in `backend/migrations/`.
- All 160+ REST endpoints ship in `backend/src/`.
- The MCP server, ACP adapter, semantic search, and mandate chain are MIT.
- BYO payment providers (Stripe / Paystack / Razorpay / Xendit) are MIT.
- BYO LLM key for semantic search is MIT.
- The admin dashboard (`admin/`) is MIT.
- The generated TypeScript SDK (`sdk/`) is MIT.

You can run a production Cartcrft store without ever opening the `cloud/`
directory.

---

## What `cloud/` adds

The cloud layer (`cloud/billing/`, `@cartcrft/cloud-billing`) is exclusively for
the cartcrft.com hosted service:

| Feature | Detail |
|---------|--------|
| **Tenant provisioning** | Org/instance lifecycle, quota enforcement (orders/month metering) |
| **Billing plans** | Tier definitions, subscription lifecycle (upgrade/downgrade/cancel/renew/proration) |
| **Paystack rails** | Card connect, 3DS charges, webhook handler (`POST /webhooks/billing`) |
| **USD → ZAR pricing** | Price book in USD; charges executed in ZAR via `exchange_rates` table with per-invoice FX snapshots |
| **Wallet + top-ups** | Cloud wallet, vouchers, top-up flow |
| **Invoices** | Invoice + line item records with immutable FX snapshots for auditability |
| **Dead-letter queue** | Billing queue with 3-attempt retry and dead-letter table |
| **billingsim** | Simulated time for billing tests (`BILLING_SIM_DAY_SECONDS`) |

The cloud package is mounted conditionally via `CARTCRFT_CLOUD=1`:

```typescript
// backend/src/http/app.ts (approximate)
if (process.env.CARTCRFT_CLOUD) {
  const { billingWebhookPlugin } = await import('@cartcrft/cloud-billing');
  await app.register(billingWebhookPlugin, { prefix: '/webhooks/billing' });
}
```

When `CARTCRFT_CLOUD` is not set the server compiles and runs without the cloud
package entirely.

---

## Self-hosting checklist

1. Postgres 16+ with `pgvector` (see [quickstart.md](./quickstart.md))
2. `pnpm install && pnpm migrate` — applies all MIT migrations
3. `pnpm seed` — optional demo catalog
4. Set `AUTH_SECRETS_KEY` (required in production)
5. Configure a payment provider via `POST /commerce/stores/:storeId/payment-providers`
   (see [byo-keys.md](./byo-keys.md))
6. Point payment provider dashboard at `POST /webhooks/<STORE_ID>/payment/<providerRef>`
7. Optional: configure LLM key for semantic search
8. Optional: run `pnpm start worker` for embedding indexing

`docker compose up` wraps steps 1–4 in a single command (see [docs/self-host.md](./self-host.md)).

---

## Cloud vs self-host feature comparison

| Feature | Self-host (MIT) | Cloud |
|---------|----------------|-------|
| Full REST API (160+ endpoints) | Yes | Yes |
| MCP server | Yes | Yes |
| Semantic search (BYO LLM key) | Yes | Yes |
| ACP adapter | Yes | Yes |
| Signed agent mandates | Yes | Yes |
| Admin dashboard | Yes | Yes |
| Generated TypeScript SDK | Yes | Yes |
| BYO payment providers | Yes | Yes |
| Tenant provisioning | No (single tenant) | Yes |
| Usage quotas + metering | No | Yes |
| Managed billing (Paystack USD→ZAR) | No | Yes |
| billingsim time compression | Dev only | CI |
| SLA / support | Community | Paid |
