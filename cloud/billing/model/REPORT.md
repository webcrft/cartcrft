# Cartcrft Cloud — Unit Economics + Competitiveness Report

**Generated:** June 2026 (updated with Nano tier, C-10e)
**FX Rate:** USD/ZAR 18.60 (xe.com / oanda.com mid-market, June 2026)
**Model:** `cloud/billing/model/model.py` — run with `python3 model.py`

---

## EXECUTIVE VERDICT

### COMPETITIVE?

| vs | Verdict | Detail |
|----|---------|--------|
| **Shopify** | **YES — strongly** | Wins at any GMV above ~$4k/mo. At $10k GMV: merchant saves $160/mo. At $50k GMV: $960/mo. At $200k GMV: $3,960/mo vs Shopify Basic. 0% rake is decisive for mid/large merchants. |
| **Shopify at sub-$4k GMV (Nano)** | **YES — Nano closes the gap** | Cloud Nano ($19/mo) costs $49/mo total at $1k GMV (Paystack incl.) vs Shopify Basic $89/mo. Nano saves $40/mo at $1k GMV. Sub-$4k gap is **CLOSED**. |
| **Medusa Cloud** | **YES — on price** | Cartcrft Starter ($79) undercuts Medusa Launch ($99) and Medusa Scale ($299) at every GMV band. Both are 0% rake; pure flat-fee comparison. Medusa has ecosystem/brand advantage currently. |
| **Self-host** | **HONEST: self-host wins on cash cost** | Cartcrft Cloud adds a fixed $39/mo premium over minimal self-host ($40/mo infra). Premium buys managed Postgres+pgvector, backups, upgrades, SSL, and support. Justified for founder-led teams; not justified for teams with dedicated DevOps. |
| **vs Shopify at X-Small ($1k GMV) — Starter** | **NO — Shopify cheaper (Starter)** | Shopify Basic = $89/mo total vs Cartcrft Starter = $109/mo. Starter not competitive sub-$4k. That gap is now addressed by the Nano tier at $19/mo. |

### PROFITABLE?

| Tier | Price | COGS | Gross Profit | **Gross Margin** | Breakeven Tenants | Verdict |
|------|-------|------|-------------|-----------------|-------------------|---------|
| Cloud Nano | $19/mo | $17.10/mo | $1.90/mo | **10.0%** | 4,414 tenants | Funnel play — thin but positive margin |
| Cloud Starter | $79/mo | $33/mo | $46/mo | **57.8%** | 183 tenants | Profitable |
| Cloud Scale | $199/mo | $63/mo | $136/mo | **68.4%** | 61 tenants | Profitable |
| Enterprise (est.) | $500/mo | $180/mo | $320/mo | **64.1%** | 26 tenants | Profitable |

**All four tiers are profitable at unit level.** Nano's 10% margin is deliberately thin — it is a **funnel tier**, not a profit centre. The $1.90/tenant GP is the floor; the real ROI comes from upgrade conversion (Nano → Starter doubles GP per tenant). Cloud Scale (68.4%) is the most profitable and should be the primary positioning target.

**DEMAND CAVEAT:** Unit economics are sound. This model does not prove market demand. Product is in preview. Profitability requires customers.

---

## Nano Tier — C-10e Decision Record

### Price chosen: $19/mo

**Rationale:**
- Below $29 (Medusa Develop) — Cartcrft undercuts Medusa's entry cloud tier
- At $19, Nano total ($19 + Paystack $30 at $1k GMV = **$49/mo**) beats Shopify Basic ($89/mo) by **$40/mo**
- COGS at $19: $17.10/mo → $1.90 gross profit, 10.0% margin — positive, not a loss-leader
- The $19–$29 range was proposed; $19 chosen for maximum sub-$4k competitive impact and to stay clearly below Medusa Develop ($29)

### Limits
- 1 store, 1 team seat
- 200 orders/month cap (above this: upgrade prompt to Starter)
- Community support only (GitHub Issues) — no email SLA
- 0% GMV rake, BYO payment keys (same as all tiers)
- Managed Postgres + pgvector (shared nano slice), daily backups, SSL

### Does it close the sub-$4k GMV gap?

**YES — definitively.**

| GMV | CC Nano (total) | Shopify Basic (total) | Saving | Verdict |
|-----|-----------------|----------------------|--------|---------|
| $1,000 | $49 | $89 | **+$40** | Nano wins |
| $10,000 | $319 | $539 | **+$220** | Nano wins |
| $50,000 | $1,495 | $2,515 | **+$1,020** | Nano wins |
| $200,000 | $5,926 | $9,946 | **+$4,020** | Nano wins |

(Totals include Paystack gateway cost to merchant. Shopify total = plan $39 + 2% rake + Paystack.)

Nano beats Shopify Basic at every GMV band. The previous gap existed because Starter's $79 flat fee wasn't recovered by 0% rake savings until ~$4k GMV. Nano's $19 flat resolves this entirely.

### Is it profitable or a deliberate loss-leader?

**Profitable — but deliberately thin.** Verdict: **FUNNEL PLAY**.

- Unit economics: $19 revenue – $17.10 COGS = $1.90 GP (10.0% margin)
- COGS breakdown: $7 Postgres + $3 compute + $0.75 backups + $0.75 bandwidth + $0.50 SSL + $0.50 monitoring + $0.60 Paystack collection fee + $4 community support = $17.10
- Breakeven on fixed costs: 4,414 Nano-only tenants (not realistic as sole tier)
- **Strategic role:** acquire sub-$4k GMV merchants who will grow. When a Nano merchant upgrades to Starter, GP jumps from $1.90 → $45.66. A 5% Nano→Starter conversion rate means Nano's true contribution is 0.05 × $45.66 = $2.28/Nano tenant/mo in LTV equivalent — already better than the $1.90 direct GP.
- Accept this margin: Nano is not expected to cover fixed costs alone. It feeds the funnel.

---

## Full Model Output

```
══════════════════════════════════════════════════════════════════════════════════════════
  CARTCRFT CLOUD — UNIT ECONOMICS + COMPETITIVENESS MODEL
  Generated: June 2026  |  FX: USD/ZAR 18.60  |  python3 model.py
══════════════════════════════════════════════════════════════════════════════════════════

  This model answers:
    A) PROFITABILITY  — does Cartcrft make money per tenant?
    B) COMPETITIVE    — is Cartcrft Cloud cheaper than alternatives for merchants?

  Source: pricing from web/src/pages/pricing.astro (June 2026 preview).
  Infra costs sourced from neon.tech, supabase.com, fly.io, hetzner.com (June 2026).
  Competitor pricing from shopify.com, docs.medusajs.com (June 2026).


══════════════════════════════════════════════════════════════════════════════════════════
  SECTION A — PROFITABILITY: Cartcrft Cloud P&L per Tier
══════════════════════════════════════════════════════════════════════════════════════════

  Tier                 Price/mo    Infra  Coll.Fee  Support     COGS   Gross$   Margin
  ------------------ ---------- -------- --------- -------- -------- -------- --------
  Cloud Nano                $19      $12     $0.60       $4      $17       $1    10.0%
  Cloud Starter             $79      $22     $2.34       $9      $33      $45    57.8%
  Cloud Scale              $199      $42     $5.82      $15      $62     $136    68.4%
  Enterprise               $500     $125    $14.55      $40     $179     $320    64.1%

  BREAKEVEN ANALYSIS — tenants needed to cover fixed costs:
  Tier                  Contribution/tenant   Tenants to breakeven
  ------------------ ---------------------- ----------------------
  Cloud Nano                          $1.90                 4413.7
  Cloud Starter                      $45.66                  183.2
  Cloud Scale                       $136.18                   61.4
  Enterprise                        $320.45                   26.1


══════════════════════════════════════════════════════════════════════════════════════════
  SECTION B — COMPETITIVENESS: Total Monthly Cost to Merchant
══════════════════════════════════════════════════════════════════════════════════════════

  GMV/mo          CC Nano     CC Start.   Shpfy Bsc     Shpfy Adv   Med Laun.     Med Scale   Self-Host     Shpfy Rake
  --------------  ----------  ----------  ------------  ----------  ------------  ----------  ------------  ------------
  $1,000          $49         $109        $89           $334        $129          $329        $70           $20
  $10,000         $319        $379        $539          $649        $399          $599        $340          $200
  $50,000         $1,495      $1,555      $2,515        $2,025      $1,575        $1,775      $1,516        $1,000
  $200,000        $5,926      $5,986      $9,946        $7,206      $6,006        $6,206      $5,947        $4,000

  Nano tier gap-closure — sub-$4k GMV segment:
           GMV     CC Nano   Shpfy Basic      Saving  Verdict
  ------------  ----------  ------------  ----------  ------------------------------
        $1,000         $49           $89         $40  Nano wins
       $10,000        $319          $539        $220  Nano wins
       $50,000      $1,495        $2,515      $1,020  Nano wins
      $200,000      $5,926        $9,946      $4,020  Nano wins

  Merchant savings: Cartcrft Starter vs Shopify Basic:
           GMV    CC Starter   Shpfy Basic        Saving  Verdict
  ------------  ------------  ------------  ------------  ------------------------------
        $1,000          $109           $89          $-20  Shopify cheaper (use Nano)
       $10,000          $379          $539          $160  CC wins
       $50,000        $1,555        $2,515          $960  CC wins
      $200,000        $5,986        $9,946        $3,960  CC wins


══════════════════════════════════════════════════════════════════════════════════════════
  EXECUTIVE VERDICT
══════════════════════════════════════════════════════════════════════════════════════════

  vs Shopify at X-Small ($1k GMV) — NANO:  Nano WINS — Nano $49/mo total
                vs Shopify Basic $89/mo. Nano saves $40/mo
                at $1k GMV. Sub-$4k gap is now CLOSED by the Nano tier.

  PROFITABLE?

  Cloud Nano         ($19.0/mo): YES — 10.0% gross margin, breakeven at 4414 paying tenants
                      Revenue: $19.00  COGS: $17.10  GP: $1.90
  Cloud Starter      ($79.0/mo): YES — 57.8% gross margin, breakeven at 183 paying tenants
                      Revenue: $79.00  COGS: $33.34  GP: $45.66
  Cloud Scale        ($199.0/mo): YES — 68.4% gross margin, breakeven at 61 paying tenants
                      Revenue: $199.00  COGS: $62.82  GP: $136.18
  Enterprise         ($500.0/mo): YES — 64.1% gross margin, breakeven at 26 paying tenants
                      Revenue: $500.00  COGS: $179.55  GP: $320.45

  RECOMMENDATIONS:

  0. Cloud Nano (10.0% margin, $1.90/tenant GP) is PROFITABLE at unit level.
     Breakeven requires ~4414 Nano-only tenants. Realistic as an entry funnel tier.
     COGS: $17.10/mo (infra+collect+community support). Margin is thin but positive.
     Verdict: deliberate FUNNEL PLAY — slim margin in exchange for lower acquisition barrier.
     Nano merchants growing to Starter ($79) 24x the GP per tenant — upgrade path is the ROI.

  1. Cloud Starter margin (57.8%) is healthy. Price defensible.
  2. Cloud Scale (68.4% margin) is the most profitable tier.
  3. Unit economics proven; demand is the unknown.
  4. Monitor actual Neon/Supabase bills per tenant cohort.
  5. Nano tier ($19/mo) closes the sub-$4k GMV gap against Shopify Basic.

══════════════════════════════════════════════════════════════════════════════════════════
  END OF REPORT
══════════════════════════════════════════════════════════════════════════════════════════
```

---

## SECTION A Detail — COGS Breakdown

### Cloud Nano ($19/mo)

| Cost Item | $/mo | Notes |
|-----------|------|-------|
| Postgres + pgvector | $7.00 | Neon shared nano slice (very light load) |
| Compute | $3.00 | Fly.io fractional cpu-1x |
| Backups | $0.75 | B2 ~10GB daily |
| Bandwidth | $0.75 | ~50GB API egress |
| SSL/CDN | $0.50 | Cloudflare free tier |
| Monitoring | $0.50 | Shared Grafana, amortised |
| Paystack collection fee | $0.60 | 2.9% + R1 on $19 subscription |
| Support allocation | $4.00 | Community only; high-volume low-touch assumption |
| **Total COGS** | **$17.10** | |
| **Gross Profit** | **$1.90** | **10.0% margin** |

### Cloud Starter ($79/mo)

| Cost Item | $/mo | Notes |
|-----------|------|-------|
| Postgres + pgvector | $12.00 | Neon/Supabase shared multi-tenant marginal |
| Compute | $6.00 | Fly.io shared-cpu-1x slice |
| Backups | $1.50 | B2/R2 daily backups ~25GB |
| Bandwidth | $1.50 | ~100GB API egress at $0.015/GB |
| SSL/CDN | $0.50 | Cloudflare free tier |
| Monitoring | $0.50 | Grafana/Uptime Robot amortised |
| Paystack collection fee | $2.34 | 2.9% + R1 on $79 subscription |
| Support allocation | $9.00 | 1 FTE / 200 tenants prorated |
| **Total COGS** | **$33.34** | |
| **Gross Profit** | **$45.66** | **57.8% margin** |

### Cloud Scale ($199/mo)

| Cost Item | $/mo | Notes |
|-----------|------|-------|
| Postgres + pgvector | $22.00 | More resources for 5 stores |
| Compute | $12.00 | Higher compute allocation |
| Backups | $3.00 | More stores, more backup data |
| Bandwidth | $3.00 | Higher egress for 5 stores |
| SSL/CDN | $1.00 | |
| Monitoring | $1.00 | |
| Paystack collection fee | $5.82 | 2.9% + R1 on $199 subscription |
| Support allocation | $15.00 | Priority email tier |
| **Total COGS** | **$62.82** | |
| **Gross Profit** | **$136.18** | **68.4% margin** |

### Enterprise ($500/mo — modelled estimate; actual is custom)

| Cost Item | $/mo |
|-----------|------|
| Postgres + pgvector | $60.00 |
| Compute | $40.00 |
| Backups | $10.00 |
| Bandwidth | $10.00 |
| SSL/CDN | $2.00 |
| Monitoring | $3.00 |
| Paystack collection fee | $14.55 |
| Support allocation | $40.00 |
| **Total COGS** | **$179.55** |
| **Gross Profit** | **$320.45** | **64.1% margin** |

---

## SECTION B Detail — Merchant Cost Comparison

### Main Comparison Table (including Nano)

| GMV/mo | CC Nano | CC Starter | Shpfy Basic | Shpfy Adv | Med Launch | Med Scale | Self-Host | Shpfy Rake |
|--------|---------|-----------|------------|-----------|-----------|----------|----------|-----------|
| $1,000 | $49 | $109 | $89 | $334 | $129 | $329 | $70 | $20 |
| $10,000 | $319 | $379 | $539 | $649 | $399 | $599 | $340 | $200 |
| $50,000 | $1,495 | $1,555 | $2,515 | $2,025 | $1,575 | $1,775 | $1,516 | $1,000 |
| $200,000 | $5,926 | $5,986 | $9,946 | $7,206 | $6,006 | $6,206 | $5,947 | $4,000 |

All figures = plan fee + platform rake (if any) + Paystack gateway cost. Self-host excludes DevOps labour time.

### Savings: Cartcrft Starter vs Shopify Basic

| GMV | CC Starter | Shopify Basic | Monthly Saving | Verdict |
|-----|-----------|--------------|---------------|---------|
| $1,000 | $109 | $89 | -$20 | Shopify cheaper (use Nano) |
| $10,000 | $379 | $539 | +$160 | CC wins |
| $50,000 | $1,555 | $2,515 | +$960 | CC wins |
| $200,000 | $5,986 | $9,946 | +$3,960 | CC wins |

Crossover: ~$4,000/mo GMV. Above it, 0% rake advantage dominates. Below it, use Nano.

### Cartcrft vs Medusa Cloud

| GMV | CC Starter | Med Launch | Med Scale | vs Launch | vs Scale |
|-----|-----------|-----------|----------|----------|---------|
| $1,000 | $109 | $129 | $329 | CC cheaper | CC cheaper |
| $10,000 | $379 | $399 | $599 | CC cheaper | CC cheaper |
| $50,000 | $1,555 | $1,575 | $1,775 | CC cheaper | CC cheaper |
| $200,000 | $5,986 | $6,006 | $6,206 | CC cheaper | CC cheaper |

### Cartcrft vs Self-Host (minimal $40/mo infra)

| GMV | CC Starter | Self-Host Min | Managed Premium |
|-----|-----------|--------------|-----------------|
| $1,000 | $109 | $70 | $39/mo |
| $10,000 | $379 | $340 | $39/mo |
| $50,000 | $1,555 | $1,516 | $39/mo |
| $200,000 | $5,986 | $5,947 | $39/mo |

---

## Recommendations

1. **Cloud Nano ($19/mo) closes the sub-$4k GMV gap.** Nano beats Shopify Basic by $40/mo at $1k GMV. Margin is thin (10%) but positive — treat as a funnel tier, not a profit centre. Monitor upgrade conversion rate Nano→Starter closely.

2. **Cloud Starter (57.8% margin) is defensible.** Priced below Medusa Launch ($99) and well below Shopify's all-in cost for mid+ merchants.

3. **Cloud Scale (68.4% margin) is the best tier.** 61 Scale tenants covers all fixed costs — a realistic early target.

4. **Self-host is a feature, not a threat.** MIT open source is the top-of-funnel. Merchants who self-host successfully may migrate to Cloud Nano then Starter as they scale.

5. **Unit economics proven; demand is the unknown.** Market validation is the critical next step.

---

## Assumptions + Sources

| Item | Value | Source / Date |
|------|-------|--------------|
| USD/ZAR FX | 18.60 | xe.com, oanda.com mid-market, June 2026 |
| Cloud Nano | $19/mo flat (preview) | web/src/pages/pricing.astro, June 2026 (C-10e) |
| Cloud Starter | $79/mo flat (preview) | web/src/pages/pricing.astro, June 2026 |
| Cloud Scale | $199/mo flat (preview) | web/src/pages/pricing.astro, June 2026 |
| Enterprise | $500/mo (modelled estimate) | pricing.astro custom pricing, June 2026 |
| Neon marginal | ~$8–$15/tenant/mo | neon.tech/pricing, June 2026 |
| Supabase Pro | $25/mo per project | supabase.com/pricing, June 2026 |
| Fly.io compute | $5.70/mo shared-cpu-1x | fly.io/pricing, June 2026 |
| Backblaze B2 | $0.006/GB/mo | backblaze.com/b2, June 2026 |
| Paystack (collect.) | 2.9% + R1/txn | paystack.com/pricing, June 2026 |
| Paystack (merchant) | 2.9% + R1/order | paystack.com/pricing, June 2026 |
| Shopify Basic | $39/mo + 2.0% external | shopify.com/pricing, June 2026 |
| Medusa Develop | $29/mo, 0% rake | docs.medusajs.com/cloud/pricing, June 2026 |
| Medusa Launch | $99/mo, 0% rake | docs.medusajs.com/cloud/pricing, June 2026 |
| Medusa Scale | $299/mo, 0% rake | docs.medusajs.com/cloud/pricing, June 2026 |
| Self-host minimal | $40/mo infra | pricing.astro + hetzner.com, June 2026 |
| SA senior eng salary | R75,000/mo | PayScale SA, OfferZen 2025–2026 |
| SA support FTE | R35,000/mo | ZARemunerate, OfferZen 2025–2026 (estimate) |

### Caveats

- Cartcrft Cloud prices are preview/illustrative (pricing.astro explicitly notes this)
- Enterprise $500/mo is a modelled midpoint; actual negotiated price will differ
- Per-tenant infra costs are estimates on a shared infrastructure model
- Shopify comparison uses external gateway path (Shopify Payments not available to SA merchants)
- Self-host comparison excludes DevOps labour time
- This model proves unit economics only; it does not prove or predict market demand
- Nano 200 orders/mo cap is a product limit; COGS assumes very light compute/storage

---

*Model: `cloud/billing/model/` | Run: `python3 model.py` | June 2026 | Updated: C-10e Nano tier*
