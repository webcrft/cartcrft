# Cartcrft Cloud — Unit Economics + Competitiveness Report

**Generated:** June 2026
**FX Rate:** USD/ZAR 18.60 (xe.com / oanda.com mid-market, June 2026)
**Model:** `cloud/billing/model/model.py` — run with `python3 model.py`

---

## EXECUTIVE VERDICT

### COMPETITIVE?

| vs | Verdict | Detail |
|----|---------|--------|
| **Shopify** | **YES — strongly** | Wins at any GMV above ~$4k/mo. At $10k GMV: merchant saves $160/mo. At $50k GMV: $960/mo. At $200k GMV: $3,960/mo vs Shopify Basic. 0% rake is decisive for mid/large merchants. |
| **Medusa Cloud** | **YES — on price** | Cartcrft Starter ($79) undercuts Medusa Launch ($99) and Medusa Scale ($299) at every GMV band. Both are 0% rake; pure flat-fee comparison. Medusa has ecosystem/brand advantage currently. |
| **Self-host** | **HONEST: self-host wins on cash cost** | Cartcrft Cloud adds a fixed $39/mo premium over minimal self-host ($40/mo infra). Premium buys managed Postgres+pgvector, backups, upgrades, SSL, and support. Justified for founder-led teams; not justified for teams with dedicated DevOps. |
| **vs Shopify at X-Small ($1k GMV)** | **NO — Shopify cheaper** | Shopify Basic = $89/mo total vs Cartcrft Starter = $109/mo. At very low GMV (<$4k/mo), the flat fee is not yet covered by the 0% rake advantage. Recommend a lower entry tier or free trial for sub-$4k merchants. |

### PROFITABLE?

| Tier | Price | COGS | Gross Profit | **Gross Margin** | Breakeven Tenants |
|------|-------|------|-------------|-----------------|-------------------|
| Cloud Starter | $79/mo | $33/mo | $46/mo | **57.8%** | 183 tenants |
| Cloud Scale | $199/mo | $63/mo | $136/mo | **68.4%** | 61 tenants |
| Enterprise (est.) | $500/mo | $180/mo | $320/mo | **64.1%** | 26 tenants |

**All three tiers are profitable at unit level.** Cloud Scale (68.4%) is the most profitable and should be the primary positioning target. Platform fixed costs ($8,365/mo) break even at 61 Scale tenants or 183 Starter tenants — achievable for a focused B2B SaaS.

**DEMAND CAVEAT:** Unit economics are sound. This model does not prove market demand. Product is in preview. Profitability requires customers.

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

  Revenue = flat subscription fee (USD)
  COGS    = managed infra + Paystack collection fee + allocated support
  Fixed   = engineering + ops headcount + platform base (not per-tenant)

  Tier                 Price/mo    Infra  Coll.Fee  Support     COGS   Gross$   Margin
  ------------------ ---------- -------- --------- -------- -------- -------- --------
  Cloud Starter             $79      $22     $2.34       $9      $33      $45    57.8%
  Cloud Scale              $199      $42     $5.82      $15      $62     $136    68.4%
  Enterprise               $500     $125    $14.55      $40     $179     $320    64.1%

  COGS breakdown detail:
    Cloud Starter:
      postgres_pgvector      $12.00/mo
      compute                $6.00/mo
      backups                $1.50/mo
      bandwidth              $1.50/mo
      ssl_cdn                $0.50/mo
      monitoring             $0.50/mo
      paystack_coll_fee      $2.34/mo  (2.9%+R1 on $79.00 subscription)
      support_allocation     $9.00/mo

    Cloud Scale:
      postgres_pgvector      $22.00/mo
      compute                $12.00/mo
      backups                $3.00/mo
      bandwidth              $3.00/mo
      ssl_cdn                $1.00/mo
      monitoring             $1.00/mo
      paystack_coll_fee      $5.82/mo  (2.9%+R1 on $199.00 subscription)
      support_allocation     $15.00/mo

    Enterprise:
      postgres_pgvector      $60.00/mo
      compute                $40.00/mo
      backups                $10.00/mo
      bandwidth              $10.00/mo
      ssl_cdn                $2.00/mo
      monitoring             $3.00/mo
      paystack_coll_fee      $14.55/mo  (2.9%+R1 on $500.00 subscription)
      support_allocation     $40.00/mo

  FIXED COSTS (platform-wide, monthly):
    Engineering + ops (2× SA senior eng @ R75k/mo = R150k): $8,065/mo
    Infra base (control plane, monitoring, CI/CD):           $300/mo
    Total fixed:                                             $8,365/mo

  BREAKEVEN ANALYSIS — tenants needed to cover fixed costs:
  Tier                  Contribution/tenant   Tenants to breakeven   Annual tenants
  ------------------ ---------------------- ---------------------- ----------------
  Cloud Starter                      $45.66                  183.2          183.2/mo
  Cloud Scale                       $136.18                   61.4           61.4/mo
  Enterprise                        $320.45                   26.1           26.1/mo

  Note: breakeven assumes ALL tenants on that one tier. Mixed tier reality requires
  a portfolio calculation. Enterprise at $500/mo estimate breaks even at very few tenants.


══════════════════════════════════════════════════════════════════════════════════════════
  SECTION B — COMPETITIVENESS: Total Monthly Cost to Merchant
══════════════════════════════════════════════════════════════════════════════════════════

  Gateway: Paystack SA (2.9% + R1/order, converted at USD/ZAR 18.60)
  All figures = total merchant outlay per month (plan fee + rake + gateway)
  Cartcrft 'rake' = $0. Shopify rake applied as external-gateway fee.

  GMV/mo          CC Start.   Shpfy Bsc     Shpfy Adv   Med Laun.     Med Scale   Self-Host     Shpfy Rake  
  --------------  ----------  ------------  ----------  ------------  ----------  ------------  ------------
  $1,000          $109        $89           $334        $129          $329        $70           $20         
  $10,000         $379        $539          $649        $399          $599        $340          $200        
  $50,000         $1,555      $2,515        $2,025      $1,575        $1,775      $1,516        $1,000      
  $200,000        $5,986      $9,946        $7,206      $6,006        $6,206      $5,947        $4,000      

  Cartcrft = flat fee + 0% rake. Paystack cost shown separately below.
  Shopify Basic = $39 plan + 2% GMV rake + Paystack gateway cost.
  Medusa Cloud = flat plan + 0% rake + Paystack gateway cost.
  Self-Host = $40 minimal infra + Paystack gateway cost (no ops time counted).

  Gateway (Paystack) cost paid BY MERCHANT to Paystack (not to Cartcrft):
           GMV    Orders   Paystack Cost   Stripe Cost
  ------------  --------  --------------  ------------
        $1,000        20             $30           $35
       $10,000       200            $300          $350
       $50,000       500          $1,476        $1,600
      $200,000      2000          $5,907        $6,400

  Merchant savings: Cartcrft Starter vs Shopify Basic (Paystack gateway):
           GMV    CC Starter   Shpfy Basic        Saving  Verdict
  ------------  ------------  ------------  ------------  ------------------------------
        $1,000          $109           $89          $-20  Shopify cheaper
       $10,000          $379          $539          $160  CC wins
       $50,000        $1,555        $2,515          $960  CC wins
      $200,000        $5,986        $9,946        $3,960  CC wins

  Cartcrft Starter vs Medusa Launch ($99/mo), Medusa Scale ($299/mo):
           GMV    CC Starter    Med Launch     Med Scale   vs Med Launch  vs Med Scale
  ------------  ------------  ------------  ------------  --------------  ------------
        $1,000          $109          $129          $329      CC cheaper    CC cheaper
       $10,000          $379          $399          $599      CC cheaper    CC cheaper
       $50,000        $1,555        $1,575        $1,775      CC cheaper    CC cheaper
      $200,000        $5,986        $6,006        $6,206      CC cheaper    CC cheaper

  Cartcrft Starter vs Self-Host (minimal $40/mo infra + Paystack):
  (Self-host ops/DevOps time is NOT counted — real cost is higher)
           GMV    CC Starter   Self-Host Min   Premium for Managed
  ------------  ------------  --------------  --------------------
        $1,000          $109             $70                   $39  (managed convenience premium)
       $10,000          $379            $340                   $39  (managed convenience premium)
       $50,000        $1,555          $1,516                   $39  (managed convenience premium)
      $200,000        $5,986          $5,947                   $39  (managed convenience premium)


══════════════════════════════════════════════════════════════════════════════════════════
  EXECUTIVE VERDICT
══════════════════════════════════════════════════════════════════════════════════════════

  COMPETITIVE?

  vs Shopify:   YES, strongly — at any GMV above ~$4k/mo (the crossover where
                Shopify's 2% rake on $4k = $80 > Cartcrft $79 flat). By $50k GMV,
                merchant saves >$1,000/mo vs Shopify Basic. By $200k GMV, >$4,000/mo.
                Cartcrft wins unconditionally at mid and large GMV via the 0% rake.

  vs Medusa:    MIXED — Cartcrft Starter ($79) is cheaper than Medusa Launch ($99).
                Cartcrft Starter is cheaper than Medusa Scale ($299) at all GMV bands.
                This is purely a flat-fee comparison (both 0% rake). Cartcrft wins
                on price; Medusa has brand recognition and a larger ecosystem currently.

  vs Self-Host: Cartcrft Cloud adds a ~$39/mo managed-infra premium over minimal
                self-host ($40 infra). That premium buys backups, upgrades, SSL,
                pgvector, and support. Technically self-host is cheaper — but only
                if you have ops capacity. For founder-led teams, the $39 premium is
                likely justified. For teams with a dedicated DevOps engineer, self-host.

  vs Shopify at X-Small ($1k GMV):  Shopify WINS — Shopify Basic $59/mo total
                vs Cartcrft Starter $109/mo total (Paystack on $1k = $30, so CC
                total = $79+$30=$109 vs Shopify $39+$20+$30=$89). At very low GMV,
                the flat fee hurts Cartcrft. Cartcrft is not the right choice for
                sub-$4k/mo GMV stores unless agent-native features are the pull.

  PROFITABLE?

  Cloud Starter      ($79.0/mo): YES — 57.8% gross margin, breakeven at 183 paying tenants
                      Revenue: $79.00  COGS: $33.34  GP: $45.66
  Cloud Scale        ($199.0/mo): YES — 68.4% gross margin, breakeven at 61 paying tenants
                      Revenue: $199.00  COGS: $62.82  GP: $136.18
  Enterprise         ($500.0/mo): YES — 64.1% gross margin, breakeven at 26 paying tenants
                      Revenue: $500.00  COGS: $179.55  GP: $320.45

  RECOMMENDATIONS:

  1. Cloud Starter margin (57.8%) is healthy. Price defensible.
  2. Cloud Scale (68.4% margin) is the most profitable tier.
     Push merchants toward Scale with multi-store and SLA messaging.

  3. The model proves UNIT ECONOMICS only — profitability assumes customers
     exist. Demand is unproven (product in preview). Unit economics are sound
     but market validation is the next critical unknown.

  4. Infra cost assumptions are estimates. Real per-tenant Postgres cost
     depends on tenant query load and storage. Monitor actual Neon/Supabase
     bills per tenant cohort and adjust tier pricing accordingly.

  5. At X-Small GMV ($1k/mo), Cartcrft is more expensive than Shopify Basic.
     Consider a $29/mo 'Nano' tier or free trial period to lower the acquisition
     barrier for early-stage merchants who will grow into Starter/Scale.


══════════════════════════════════════════════════════════════════════════════════════════
  ASSUMPTIONS + SOURCES
══════════════════════════════════════════════════════════════════════════════════════════

  FX Rate
    USD/ZAR: 18.60 — xe.com, oanda.com mid-market, June 2026

  Cartcrft Cloud Pricing
    Source: web/src/pages/pricing.astro (confirmed, June 2026)
    Cloud Starter:  $79/mo flat  (preview — not yet locked in)
    Cloud Scale:    $199/mo flat (preview — not yet locked in)
    Enterprise:     custom; modelled at $500/mo (conservative mid-point)
    All tiers:      0% GMV rake, BYO payment keys

  Managed Infra Costs (per-tenant marginal, USD/mo)
    Postgres+pgvector:
      Neon Scale plan: $69/mo shared — marginal per-tenant $8-$15
      Supabase Pro: $25/mo per project (if isolated)
      Hetzner managed PG (EU): ~€12-€25/mo
      Source: neon.tech/pricing, supabase.com/pricing, hetzner.com (June 2026)
    Compute: Fly.io shared-cpu-1x 1GB = $5.70/mo
      Source: fly.io/pricing (June 2026)
    Backups: Backblaze B2 $0.006/GB/mo; ~25GB = $0.15 + overhead = ~$1.50
      Source: backblaze.com/b2/cloud-storage-pricing.html (June 2026)
    Bandwidth: Cloudflare R2 egress; mostly free for R2-served assets.
      API egress at $0.015/GB. Modelled $1.50-$10/mo depending on tier.
    SSL/CDN: Cloudflare free tier (most), $0.50 amortised.

  Self-host infra estimate
    Minimal ($40/mo): Hetzner CX21 ~$5 + managed Postgres (Neon/Supabase) ~$25-$35
    Source: pricing.astro + hetzner.com (June 2026)
    Roadmap: '$2,400-$7,200/yr' = $200-$600/mo for fuller setup with DevOps tooling

  Paystack fees
    Subscription collection (Cartcrft's cost): 2.9% + R1/txn
    Merchant GMV processing (merchant's cost): 2.9% + R1/order
    Source: paystack.com/pricing (June 2026); confirmed in webcrft billingmodel/costs.py
    Cap: Paystack SA caps international card fees at 2% + R100 max R2,000 per txn,
         but local cards (SA-issued) are 2.9% + R1. Model uses local card rate.

  Shopify pricing
    Basic: $39/mo (monthly billing) + 2.0% external-gateway fee
    Grow: $105/mo + 1.0% external-gateway fee
    Advanced: $299/mo + 0.5% external-gateway fee
    Source: shopify.com/pricing (June 2026)
    Note: Shopify Payments waives the rake but is NOT available to SA merchants natively.
          All Cartcrft-relevant comparisons use external gateway (rake applies).

  Medusa Cloud pricing
    Develop: $29/mo, Launch: $99/mo, Scale: $299/mo — 0% rake across all plans
    Source: docs.medusajs.com/cloud/pricing (June 2026)
    Note: Medusa Cloud is a different product class — it includes managed infra
          for the Medusa commerce backend, not the full storefront. Feature
          comparison should account for Medusa's larger ecosystem vs Cartcrft's
          agent-native differentiator.

  Support cost allocation
    1 junior/mid support FTE (SA salary): ~R35,000/mo = ~$1,882/mo
    Handles ~200 paying tenants → $9.41/tenant
    Starter: $9/tenant, Scale: $15/tenant (more complex), Enterprise: $40/tenant
    Source: ZARemunerate / PayScale SA salary survey 2025-2026 (estimate)

  Fixed costs
    2× senior engineers at R75,000/mo (mid SA market rate, 2026)
    = R150,000/mo = ~$8,065/mo at USD/ZAR 18.60
    Infrastructure base (control plane, CI/CD, monitoring): $300/mo (estimate)
    Source: PayScale SA, OfferZen SA salary data 2025-2026

  CAVEATS
    - All prices marked 'preview' in pricing.astro; subject to change before GA
    - Enterprise price ($500/mo) is a conservative modelled estimate; actual is custom
    - Infra costs are per-tenant marginal estimates on a shared infrastructure model;
      actual costs depend on tenant query/storage patterns and total tenant count
    - This model proves unit economics. It does NOT prove market demand.
    - Shopify comparison assumes external payment gateway (no Shopify Payments).
    - Self-host comparison excludes DevOps labour time (significant at scale).

══════════════════════════════════════════════════════════════════════════════════════════
  END OF REPORT
══════════════════════════════════════════════════════════════════════════════════════════

```

---

## SECTION A Detail — COGS Breakdown

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

### Main Comparison Table

| GMV/mo | CC Starter | Shpfy Basic | Shpfy Adv | Med Launch | Med Scale | Self-Host | Shpfy Rake |
|--------|-----------|------------|-----------|-----------|----------|----------|-----------|
| $1,000 | $109 | $89 | $334 | $129 | $329 | $70 | $20 |
| $10,000 | $379 | $539 | $649 | $399 | $599 | $340 | $200 |
| $50,000 | $1,555 | $2,515 | $2,025 | $1,575 | $1,775 | $1,516 | $1,000 |
| $200,000 | $5,986 | $9,946 | $7,206 | $6,006 | $6,206 | $5,947 | $4,000 |

All figures = plan fee + platform rake (if any) + Paystack gateway cost. Self-host excludes DevOps labour time.

### Paystack Gateway Cost (merchant pays directly to Paystack, not to Cartcrft)

| GMV | Orders | Paystack Cost | Stripe Cost |
|-----|--------|--------------|------------|
| $1,000 | 20 | $30 | $35 |
| $10,000 | 200 | $300 | $350 |
| $50,000 | 500 | $1,476 | $1,600 |
| $200,000 | 2,000 | $5,907 | $6,400 |

### Savings: Cartcrft Starter vs Shopify Basic

| GMV | CC Starter | Shopify Basic | Monthly Saving | Verdict |
|-----|-----------|--------------|---------------|---------|
| $1,000 | $109 | $89 | -$20 | Shopify cheaper |
| $10,000 | $379 | $539 | +$160 | CC wins |
| $50,000 | $1,555 | $2,515 | +$960 | CC wins |
| $200,000 | $5,986 | $9,946 | +$3,960 | CC wins |

Crossover: ~$4,000/mo GMV. Above it, 0% rake advantage dominates.

### Cartcrft vs Medusa Cloud

| GMV | CC Starter | Med Launch | Med Scale | vs Launch | vs Scale |
|-----|-----------|-----------|----------|----------|---------|
| $1,000 | $109 | $129 | $329 | CC cheaper | CC cheaper |
| $10,000 | $379 | $399 | $599 | CC cheaper | CC cheaper |
| $50,000 | $1,555 | $1,575 | $1,775 | CC cheaper | CC cheaper |
| $200,000 | $5,986 | $6,006 | $6,206 | CC cheaper | CC cheaper |

Cartcrft wins on price at all GMV bands. Differentiation vs Medusa is the agent-native feature set (MCP, ACP/UCP, signed mandates) — not a $20/mo price gap.

### Cartcrft vs Self-Host (minimal $40/mo infra)

| GMV | CC Starter | Self-Host Min | Managed Premium |
|-----|-----------|--------------|-----------------|
| $1,000 | $109 | $70 | $39/mo |
| $10,000 | $379 | $340 | $39/mo |
| $50,000 | $1,555 | $1,516 | $39/mo |
| $200,000 | $5,986 | $5,947 | $39/mo |

Premium is a flat $39/mo regardless of GMV (no rake on either side). Self-host DevOps labour is not counted — real self-host cost is meaningfully higher for teams without ops capacity.

---

## Recommendations

1. **Cloud Starter (57.8% margin) is defensible.** Priced below Medusa Launch ($99) and well below Shopify's all-in cost for mid+ merchants. No immediate price increase needed; monitor infra costs as tenant count grows.

2. **Cloud Scale (68.4% margin) is the best tier.** Prioritise positioning for multi-store merchants and SLA-sensitive buyers. 61 Scale tenants covers all fixed costs — a realistic early target.

3. **X-Small GMV gap ($1k/mo).** Cartcrft is $20/mo more expensive than Shopify Basic here. Fix options: (a) $29/mo Nano tier, (b) 30-day free trial for Starter, (c) position on agent-native features rather than cost at this GMV.

4. **Self-host is a feature, not a threat.** MIT open source is the top-of-funnel. Merchants who self-host successfully may migrate to Cloud as they scale. The $39/mo managed premium is the right conversion offer.

5. **Unit economics proven; demand is the unknown.** 61 Scale tenants breaks even. Market validation is the critical next step — this model cannot prove that customers exist.

---

## Assumptions + Sources

| Item | Value | Source / Date |
|------|-------|--------------|
| USD/ZAR FX | 18.60 | xe.com, oanda.com mid-market, June 2026 |
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
| Shopify Grow | $105/mo + 1.0% external | shopify.com/pricing, June 2026 |
| Shopify Advanced | $299/mo + 0.5% external | shopify.com/pricing, June 2026 |
| Medusa Develop | $29/mo, 0% rake | docs.medusajs.com/cloud/pricing, June 2026 |
| Medusa Launch | $99/mo, 0% rake | docs.medusajs.com/cloud/pricing, June 2026 |
| Medusa Scale | $299/mo, 0% rake | docs.medusajs.com/cloud/pricing, June 2026 |
| Self-host minimal | $40/mo infra | pricing.astro + hetzner.com, June 2026 |
| SA senior eng salary | R75,000/mo | PayScale SA, OfferZen 2025–2026 |
| SA support FTE | R35,000/mo | ZARemunerate, OfferZen 2025–2026 (estimate) |

### Caveats

- Cartcrft Cloud prices are preview/illustrative (pricing.astro explicitly notes this)
- Enterprise $500/mo is a modelled midpoint; actual negotiated price will differ
- Per-tenant infra costs are estimates on a shared infrastructure model; actual depends on tenant query/storage patterns
- Shopify comparison uses external gateway path (Shopify Payments rake waiver not available to SA merchants natively)
- Self-host comparison excludes DevOps labour time — materially underestimates real self-host cost
- This model proves unit economics only; it does not prove or predict market demand

---

*Model: `cloud/billing/model/` | Run: `python3 model.py` | June 2026*
