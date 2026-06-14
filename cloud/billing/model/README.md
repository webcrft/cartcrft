# Cartcrft Cloud — Unit Economics + Competitiveness Model

Python financial model answering two questions: is Cartcrft Cloud **competitive**
and is it **profitable**?

## Run

```bash
cd cloud/billing/model
python3 model.py
```

Outputs a full tabular report to stdout. Redirect to a file if needed:

```bash
python3 model.py > output.txt
```

## Files

| File | Purpose |
|------|---------|
| `costs.py` | Infrastructure cost constants, tier definitions, FX, Paystack collection fee, P&L helpers |
| `scenarios.py` | Merchant GMV scenarios (xsmall/small/mid/large), competitive cost comparison functions |
| `model.py` | Report generator — runs profitability + competitiveness analysis, prints tables |
| `REPORT.md` | Captured report output with executive verdict, tables, assumptions, and sources |

## Model Structure

**Section A — Profitability:**
- Cartcrft's own P&L per tier (Starter/Scale/Enterprise)
- Revenue = flat subscription fee
- COGS = managed infra (Postgres+pgvector, compute, backups, bandwidth, SSL, monitoring) + Paystack subscription-collection fee + allocated support
- Fixed costs = 2× SA engineers + platform base
- Breakeven tenant count per tier

**Section B — Competitiveness:**
- Total monthly cost to the MERCHANT at 4 GMV bands ($1k/$10k/$50k/$200k)
- Compared across: Cartcrft Cloud, Shopify (Basic/Grow/Advanced), Medusa Cloud (Launch/Scale), self-hosted Cartcrft
- Paystack SA gateway (2.9% + R1/order) as primary; Stripe as secondary

## Key Assumptions

- FX: USD/ZAR 18.60 (xe.com, June 2026)
- Pricing from `web/src/pages/pricing.astro` (June 2026, preview)
- Infra: shared multi-tenant model; per-tenant marginal costs from neon.tech, supabase.com, fly.io, hetzner.com (June 2026)
- Shopify: external gateway path (rake applies; Shopify Payments not available to SA merchants natively)
- Medusa Cloud: docs.medusajs.com/cloud/pricing (June 2026)
- Self-host: $40/mo minimal infra (DevOps labour excluded)
- All caveats documented in `costs.py` and `REPORT.md`
