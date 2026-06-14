---
title: Billing & Pricing
description: How Cartcrft Cloud billing works — USD flat fees, Paystack or Stripe payment, and USD→ZAR invoicing.
---

> **Preview pricing.** Numbers are illustrative and not yet locked in. Waitlist members will be notified of final pricing before any billing starts.

## Billing model

Cartcrft Cloud charges a **flat monthly subscription fee** — no percentage of your GMV, ever.

| Plan | Monthly (USD) | Annual (USD, ~17% off) |
|---|---|---|
| Cloud Starter | $79 | $790 |
| Cloud Scale | $199 | $1,990 |
| Enterprise | Custom | Custom |

### What's included

Every Cloud plan includes:

- Managed Postgres 16 + pgvector (storage allocation varies by plan)
- Automated daily backups + point-in-time recovery
- Zero-downtime Cartcrft version upgrades
- Managed SSL + custom domain support
- Email support (response times vary by plan)

### What's NOT included (you pay at cost, directly)

- **Payment processing** — Stripe, Paystack, Razorpay, Xendit. You hold the contract; you pay their fees directly. Cartcrft never handles or touches payment funds.
- **LLM / embeddings keys** — if you enable semantic search, you supply your own OpenAI-compatible key. You pay that provider directly.

## Payment methods

Cloud subscriptions are paid via:

- **Paystack** — recommended for South African merchants; supports local card, EFT, and bank transfer.
- **Stripe** — for international merchants.

You'll be prompted to choose at checkout.

## USD → ZAR invoicing

Subscription prices are set in USD. Invoices are issued in ZAR at the prevailing exchange rate at the time of billing (Paystack's published rate or Stripe's rate, depending on your payment method). The USD amount is the contractual reference.

**Example** (illustrative, not a live rate):

> Cloud Starter at $79 USD. If the billing rate is R18.50/USD, your invoice shows **ZAR 1,461.50** for that month.

Exchange rates fluctuate; budget in USD for predictability.

## Invoices and receipts

- Invoices are emailed to the account owner after each successful payment.
- PDF receipts are available in the Dashboard under **Billing → Invoices**.
- VAT: Cartcrft Cloud invoices include VAT where required by law (South Africa: 15% VAT applies to B2B digital services; consult your accountant).

## Cancellation and refunds

- Cancel any time from **Dashboard → Billing → Plan**. Your subscription stays active until the end of the paid period.
- Refunds are not issued for partial months (unless required by applicable law).
- On cancellation, your data is retained for 30 days, then permanently deleted.

## Upgrading / downgrading

Plan changes take effect immediately. Proration is applied to the next invoice.

## Enterprise billing

Enterprise customers can negotiate:

- Annual invoicing in USD or ZAR
- Purchase order (PO) billing
- Custom payment terms

Contact [hello@webcrft.systems](mailto:hello@webcrft.systems?subject=Enterprise+billing).
