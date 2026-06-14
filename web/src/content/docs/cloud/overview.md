---
title: Cartcrft Cloud Overview
description: Managed Cartcrft hosting — zero-downtime deploys, automated backups, and flat-fee pricing with 0% GMV rake.
---

> **Cloud is in preview.** Pricing and feature availability are illustrative and subject to change. [Join the waitlist](mailto:hello@webcrft.systems?subject=Cloud+waitlist) to be notified before billing starts.

## What is Cartcrft Cloud?

Cartcrft Cloud is the managed-hosting layer on top of the MIT core. You get the same open-source codebase — running on infrastructure Webcrft Systems operates, maintains, and upgrades for you.

Key properties:

- **Flat monthly fee** — $79–$199/mo, no GMV percentage, ever.
- **Managed Postgres + pgvector** — included in the plan; we handle backups, PITR, and upgrades.
- **Zero-downtime deploys** — your store stays up during Cartcrft version upgrades.
- **0% rake** — Stripe, Paystack, Razorpay, and Xendit credentials are yours. Payments go directly between your store and your provider.

## Self-host vs Cloud

| | Self-host (MIT) | Cloud |
|---|---|---|
| Software cost | $0 | $79–$199/mo flat |
| Infra cost | ~$20–$60/mo (you manage) | Included |
| GMV rake | 0% | 0% |
| Backups | You manage | Automatic daily |
| Upgrades | You manage | Zero-downtime, automatic |
| Support | Community (GitHub) | Email (next business day) |

See [Cloud vs Self-host](/cloud-vs-selfhost/) for the full comparison.

## Plans

| Plan | Monthly | Stores | Seats |
|---|---|---|---|
| Cloud Starter | $79 | 1 | 3 |
| Cloud Scale | $199 | 5 | 10 |
| Enterprise | Custom | Unlimited | Custom |

All plans are billed in USD via Paystack or Stripe. See [Billing & Pricing](/cloud/billing/) for details on the billing model, invoicing, and USD→ZAR conversion.

## Getting started

1. [Sign up](/dashboard/onboarding) and connect your store.
2. Configure your payment provider credentials (Paystack is the default for South Africa).
3. Your store is live — the same API, the same SDK, the same MCP server.

See the [Cloud Onboarding guide](/cloud/onboarding/) for step-by-step instructions.
