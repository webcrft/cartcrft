---
title: Quotas & Tiers
description: Resource limits and quotas for Cartcrft Cloud plans — storage, compute, stores, and API rate limits.
---

> **Preview.** Quota numbers are illustrative and subject to change before GA.

## Plan quotas

| Resource | Cloud Starter | Cloud Scale | Enterprise |
|---|---|---|---|
| Stores | 1 | 5 | Custom |
| Team seats (admin dashboard) | 3 | 10 | Custom |
| Postgres storage | 10 GB | 50 GB | Custom |
| pgvector dimensions | 1536 (OpenAI compat.) | 1536 | Custom |
| API rate limit (per store) | 500 req/min | 2,000 req/min | Custom |
| MCP connections | 50 concurrent | 200 concurrent | Custom |
| Webhook endpoints | 20 | 100 | Custom |
| Products | Unlimited | Unlimited | Unlimited |
| Orders/month | Unlimited | Unlimited | Unlimited |
| Backup retention | 7 days | 30 days | Custom |

## Compute

Cartcrft Cloud runs your store on shared compute in GCP `us-central1` (primary) and `af-south1` (South Africa — available on Cloud Scale and Enterprise). Region selection is configured during onboarding.

## Storage overage

If your Postgres storage exceeds the plan limit, your store continues to run — you are not automatically cut off. Overage is billed at **$0.25/GB/month** and appears on your next invoice. You can upgrade your plan at any time to avoid overage fees.

## API rate limits

Rate limits are enforced per store per minute. Exceeding the limit returns `429 Too Many Requests` with a `Retry-After` header. Limits reset every 60 seconds on a rolling window.

For burst-heavy workloads (e.g. agent swarms, catalog imports), contact support to discuss a temporary limit increase.

## MCP connection limits

Each concurrent MCP session (SSE connection) counts against the limit. Connections are closed after 30 minutes of inactivity. If you need more concurrent agent connections, upgrade to Cloud Scale or contact Enterprise sales.

## Requesting a quota increase

For Cloud Scale and Enterprise, quota increases can be requested by emailing [hello@webcrft.systems](mailto:hello@webcrft.systems?subject=Quota+increase+request) with your account ID and the resource you need increased.
