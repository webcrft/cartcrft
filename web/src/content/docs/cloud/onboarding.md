---
title: Cloud Onboarding
description: Connect your store to Cartcrft Cloud — step-by-step guide from sign-up to first sale.
---

> **Cloud is in preview.** The onboarding flow is under active development. [Join the waitlist](mailto:hello@webcrft.systems?subject=Cloud+waitlist) to be notified when it opens.

## Overview

Cartcrft Cloud onboarding takes you from a fresh account to a fully-configured store in four stages:

1. **Account setup** — create your account, verify your email, choose a plan.
2. **Store provisioning** — Cartcrft provisions a managed Postgres instance and deploys the backend.
3. **Agent surface configuration** — configure your MCP server, connect payment providers, set up semantic search (optional).
4. **Go live** — your store is reachable at your custom domain over HTTPS.

## Step 1 — Account setup

1. Click **Sign up** in the top nav (or go to [/dashboard/onboarding](/dashboard/onboarding)).
2. Enter your email. You'll receive a verification link.
3. Choose **Cloud Starter** or **Cloud Scale**. You can upgrade later.
4. Enter your payment method (Paystack for SA merchants; Stripe for international).

Your card is not charged until provisioning completes and you confirm.

## Step 2 — Store provisioning

After payment confirmation, Cartcrft automatically:

- Creates a managed Postgres 16 + pgvector instance in your chosen region.
- Runs the latest schema migration.
- Seeds with a demo store (optional — you can skip seeding for a clean start).
- Issues your `cc_pub_` (storefront) and `cc_prv_` (admin) API keys.

Provisioning typically takes under 5 minutes. You'll receive an email when it's ready.

## Step 3 — Agent surface configuration

### Connect a payment provider

1. Go to **Dashboard → Payment Providers**.
2. Click **Add provider** and select Paystack (recommended for ZAR billing) or Stripe.
3. Paste your provider's API keys. Keys are encrypted with AES-256-GCM at rest.
4. Enable **Test mode** for development; switch to **Live** when ready.

### Enable semantic search (optional)

1. Go to **Dashboard → Settings → Semantic Search**.
2. Paste your OpenAI-compatible embeddings API key.
3. Run **Reindex catalog** to embed existing products.

### Configure your MCP server

Your store's MCP endpoint is available immediately at:

```
https://<your-store>.cartcrft.cloud/mcp/<storeId>
```

Point any MCP-capable agent at this URL with your `cc_pub_` key. See [Agent-native](/agent-native/) for agent connection instructions.

## Step 4 — Custom domain

1. Go to **Dashboard → Settings → Domains**.
2. Add your domain (e.g. `api.mystore.com`).
3. Add a `CNAME` record pointing to `edge.cartcrft.cloud`.
4. SSL is provisioned automatically via Let's Encrypt within minutes.

## Migrating from self-host

If you have an existing self-hosted Cartcrft instance:

1. Export your database: `pg_dump -Fc mydb > mydb.dump`
2. Contact support at [hello@webcrft.systems](mailto:hello@webcrft.systems?subject=Cloud+migration) with your account ID to initiate a managed import.
3. We'll coordinate a maintenance window and import your dump into the managed instance.

No data format changes are required — the cloud backend runs the same schema as the open-source release.

## Support

- **Email** — [hello@webcrft.systems](mailto:hello@webcrft.systems)
- **GitHub Issues** — [github.com/webcrftsystems/cartcrft](https://github.com/webcrftsystems/cartcrft)
- **Dashboard → Support** — available on Cloud Scale and Enterprise.
