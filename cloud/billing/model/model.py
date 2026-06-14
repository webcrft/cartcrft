#!/usr/bin/env python3
"""
Cartcrft Cloud — Unit Economics + Competitiveness Model
========================================================
Run:  python3 model.py
      python3 model.py --md   (output Markdown for REPORT.md)

Answers two questions:
  A) COMPETITIVE  — is Cartcrft Cloud cheaper than Shopify/Medusa/self-host
                    for merchants at various GMV levels?
  B) PROFITABLE   — does Cartcrft make money per tenant? What's the gross margin?
                    How many paying tenants to cover fixed costs?

All assumptions and sources are documented in costs.py.
Key FX: USD/ZAR = 18.60 (xe.com mid-market, June 2026)
"""

import sys
from decimal import Decimal
from costs import (
    TIERS, FIXED_COSTS, gross_margin, cogs_per_tenant_usd,
    infra_total_usd, cartcrft_collection_fee_usd, SUPPORT_COST_PER_TENANT,
    INFRA_PER_TENANT, USD_ZAR,
)
from scenarios import calc_scenario, SCENARIOS, SHOPIFY_PLANS, MEDUSA_PLANS, SELF_HOST

MD_MODE = '--md' in sys.argv


def hr(char='─', width=90):
    return char * width


def fmt(v, prefix='$', decimals=0):
    if isinstance(v, Decimal):
        if decimals == 0:
            return f"{prefix}{int(v):,}"
        return f"{prefix}{v:,.{decimals}f}"
    return f"{prefix}{v}"


def pct(v):
    return f"{float(v):.1f}%"


def col(s, w):
    return str(s)[:w].ljust(w)


# ═══════════════════════════════════════════════════════════════════════════════
#  SECTION A: PROFITABILITY — Cartcrft's own P&L per tier
# ═══════════════════════════════════════════════════════════════════════════════

def print_profitability():
    lines = []
    add = lines.append

    add("")
    add(hr('═'))
    add("  SECTION A — PROFITABILITY: Cartcrft Cloud P&L per Tier")
    add(hr('═'))
    add("")
    add("  Revenue = flat subscription fee (USD)")
    add("  COGS    = managed infra + Paystack collection fee + allocated support")
    add("  Fixed   = engineering + ops headcount + platform base (not per-tenant)")
    add("")

    # Per-tier P&L table
    add(f"  {'Tier':<18} {'Price/mo':>10} {'Infra':>8} {'Coll.Fee':>9} {'Support':>8} {'COGS':>8} {'Gross$':>8} {'Margin':>8}")
    add(f"  {'-'*18} {'-'*10} {'-'*8} {'-'*9} {'-'*8} {'-'*8} {'-'*8} {'-'*8}")

    results = {}
    for tier_key in ['nano', 'starter', 'scale', 'enterprise']:
        gm = gross_margin(tier_key)
        results[tier_key] = gm
        price = gm['price_usd']
        infra = gm['infra_usd']
        fee   = gm['collection_fee_usd']
        sup   = gm['support_alloc_usd']
        cogs  = gm['cogs_usd']
        gp    = gm['gross_profit_usd']
        mp    = gm['gross_margin_pct']
        flag  = "  <<< UNPROFITABLE" if gp < 0 else ""
        add(f"  {gm['label']:<18} {fmt(price):>10} {fmt(infra):>8} {fmt(fee, decimals=2):>9} "
            f"{fmt(sup):>8} {fmt(cogs, decimals=0):>8} {fmt(gp, decimals=0):>8} {pct(mp):>8}{flag}")

    add("")
    add("  COGS breakdown detail:")
    for tier_key in ['nano', 'starter', 'scale', 'enterprise']:
        add(f"    {TIERS[tier_key]['label']}:")
        for k, v in INFRA_PER_TENANT[tier_key].items():
            add(f"      {k:<22} ${float(v):.2f}/mo")
        price = TIERS[tier_key]['price_usd']
        add(f"      {'paystack_coll_fee':<22} ${float(cartcrft_collection_fee_usd(price)):.2f}/mo  (2.9%+R1 on ${price} subscription)")
        add(f"      {'support_allocation':<22} ${float(SUPPORT_COST_PER_TENANT[tier_key]):.2f}/mo")
        add("")

    # Fixed costs + breakeven
    add("  FIXED COSTS (platform-wide, monthly):")
    add(f"    Engineering + ops (2× SA senior eng @ R75k/mo = R150k): ${float(FIXED_COSTS['engineering_ops']):,.0f}/mo")
    add(f"    Infra base (control plane, monitoring, CI/CD):           ${float(FIXED_COSTS['infra_base']):,.0f}/mo")
    add(f"    Total fixed:                                             ${float(FIXED_COSTS['total']):,.0f}/mo")
    add("")

    add("  BREAKEVEN ANALYSIS — tenants needed to cover fixed costs:")
    add(f"  {'Tier':<18} {'Contribution/tenant':>22} {'Tenants to breakeven':>22} {'Annual tenants':>16}")
    add(f"  {'-'*18} {'-'*22} {'-'*22} {'-'*16}")
    for tier_key in ['nano', 'starter', 'scale', 'enterprise']:
        gp = results[tier_key]['gross_profit_usd']
        if gp > 0:
            tenants_needed = FIXED_COSTS['total'] / gp
            add(f"  {TIERS[tier_key]['label']:<18} {fmt(gp, decimals=2):>22} {float(tenants_needed):>22.1f} {float(tenants_needed):>14.1f}/mo")
        else:
            add(f"  {TIERS[tier_key]['label']:<18} {'LOSS':>22} {'N/A — fix price first':>22}")
    add("")
    add("  Note: breakeven assumes ALL tenants on that one tier. Mixed tier reality requires")
    add("  a portfolio calculation. Enterprise at $500/mo estimate breaks even at very few tenants.")
    add("")

    return lines, results


# ═══════════════════════════════════════════════════════════════════════════════
#  SECTION B: COMPETITIVENESS — Merchant cost comparison by GMV band
# ═══════════════════════════════════════════════════════════════════════════════

def print_competitiveness():
    lines = []
    add = lines.append

    add("")
    add(hr('═'))
    add("  SECTION B — COMPETITIVENESS: Total Monthly Cost to Merchant")
    add(hr('═'))
    add("")
    add("  Gateway: Paystack SA (2.9% + R1/order, converted at USD/ZAR 18.60)")
    add("  All figures = total merchant outlay per month (plan fee + rake + gateway)")
    add("  Cartcrft 'rake' = $0. Shopify rake applied as external-gateway fee.")
    add("")

    scenario_results = {}
    for sk in ['xsmall', 'small', 'mid', 'large']:
        sr = calc_scenario(sk)
        scenario_results[sk] = sr

    # Main comparison table (now includes CC Nano)
    W = [14, 10, 10, 12, 10, 12, 10, 12, 12]
    hdr = [
        "GMV/mo", "CC Nano", "CC Start.", "Shpfy Bsc", "Shpfy Adv",
        "Med Laun.", "Med Scale", "Self-Host", "Shpfy Rake"
    ]
    add("  " + "  ".join(col(h, w) for h, w in zip(hdr, W)))
    add("  " + "  ".join('-'*w for w in W))

    for sk, sr in scenario_results.items():
        row = [
            fmt(sr['gmv_usd']),
            fmt(sr['cartcrft']['nano_paystack'], decimals=0),
            fmt(sr['cartcrft']['starter_paystack'], decimals=0),
            fmt(sr['shopify']['basic'], decimals=0),
            fmt(sr['shopify']['advanced'], decimals=0),
            fmt(sr['medusa']['launch'], decimals=0),
            fmt(sr['medusa']['scale'], decimals=0),
            fmt(sr['self_host']['minimal'], decimals=0),
            fmt(sr['shopify_rake_only'], decimals=0),
        ]
        add("  " + "  ".join(col(v, w) for v, w in zip(row, W)))

    add("")
    add("  Cartcrft = flat fee + 0% rake. Paystack cost shown separately below.")
    add("  Shopify Basic = $39 plan + 2% GMV rake + Paystack gateway cost.")
    add("  Medusa Cloud = flat plan + 0% rake + Paystack gateway cost.")
    add("  Self-Host = $40 minimal infra + Paystack gateway cost (no ops time counted).")

    # Nano sub-$4k gap analysis
    add("")
    add("  Nano tier gap-closure — sub-$4k GMV segment (does Nano close the Shopify gap?):")
    add(f"  {'GMV':>12}  {'CC Nano':>10}  {'Shpfy Basic':>12}  {'Saving':>10}  {'Verdict'}")
    add(f"  {'-'*12}  {'-'*10}  {'-'*12}  {'-'*10}  {'-'*30}")
    for sk, sr in scenario_results.items():
        nano_saving = sr['shopify']['basic'] - sr['cartcrft']['nano_paystack']
        verdict = "Nano wins" if nano_saving > 0 else "Shopify cheaper"
        add(f"  {fmt(sr['gmv_usd']):>12}  "
            f"{fmt(sr['cartcrft']['nano_paystack'], decimals=0):>10}  "
            f"{fmt(sr['shopify']['basic'], decimals=0):>12}  "
            f"{fmt(nano_saving, decimals=0):>10}  {verdict}")
    add("")

    # Gateway cost detail
    add("  Gateway (Paystack) cost paid BY MERCHANT to Paystack (not to Cartcrft):")
    add(f"  {'GMV':>12}  {'Orders':>8}  {'Paystack Cost':>14}  {'Stripe Cost':>12}")
    add(f"  {'-'*12}  {'-'*8}  {'-'*14}  {'-'*12}")
    for sk, sr in scenario_results.items():
        add(f"  {fmt(sr['gmv_usd']):>12}  {sr['orders']:>8}  "
            f"{fmt(sr['gateway']['paystack_usd'], decimals=0):>14}  "
            f"{fmt(sr['gateway']['stripe_usd'], decimals=0):>12}")

    add("")

    # Savings vs Shopify
    add("  Merchant savings: Cartcrft Starter vs Shopify Basic (Paystack gateway):")
    add(f"  {'GMV':>12}  {'CC Starter':>12}  {'Shpfy Basic':>12}  {'Saving':>12}  {'Verdict'}")
    add(f"  {'-'*12}  {'-'*12}  {'-'*12}  {'-'*12}  {'-'*30}")
    for sk, sr in scenario_results.items():
        saving = sr['vs_shopify_basic_starter_savings']
        verdict = "CC wins" if saving > 0 else "Shopify cheaper"
        add(f"  {fmt(sr['gmv_usd']):>12}  "
            f"{fmt(sr['cartcrft']['starter_paystack'], decimals=0):>12}  "
            f"{fmt(sr['shopify']['basic'], decimals=0):>12}  "
            f"{fmt(saving, decimals=0):>12}  {verdict}")

    add("")

    # Vs Medusa analysis
    add("  Cartcrft Starter vs Medusa Launch ($99/mo), Medusa Scale ($299/mo):")
    add(f"  {'GMV':>12}  {'CC Starter':>12}  {'Med Launch':>12}  {'Med Scale':>12}  {'vs Med Launch':>14}  {'vs Med Scale':>12}")
    add(f"  {'-'*12}  {'-'*12}  {'-'*12}  {'-'*12}  {'-'*14}  {'-'*12}")
    for sk, sr in scenario_results.items():
        vs_launch = sr['medusa']['launch'] - sr['cartcrft']['starter_paystack']
        vs_scale  = sr['medusa']['scale']  - sr['cartcrft']['starter_paystack']
        v_l = "CC cheaper" if vs_launch > 0 else "Medusa cheaper"
        v_s = "CC cheaper" if vs_scale  > 0 else "Medusa cheaper"
        add(f"  {fmt(sr['gmv_usd']):>12}  "
            f"{fmt(sr['cartcrft']['starter_paystack'], decimals=0):>12}  "
            f"{fmt(sr['medusa']['launch'], decimals=0):>12}  "
            f"{fmt(sr['medusa']['scale'], decimals=0):>12}  "
            f"{v_l:>14}  {v_s:>12}")
    add("")

    # Vs self-host
    add("  Cartcrft Starter vs Self-Host (minimal $40/mo infra + Paystack):")
    add("  (Self-host ops/DevOps time is NOT counted — real cost is higher)")
    add(f"  {'GMV':>12}  {'CC Starter':>12}  {'Self-Host Min':>14}  {'Premium for Managed':>20}")
    add(f"  {'-'*12}  {'-'*12}  {'-'*14}  {'-'*20}")
    for sk, sr in scenario_results.items():
        premium = sr['cartcrft']['starter_paystack'] - sr['self_host']['minimal']
        add(f"  {fmt(sr['gmv_usd']):>12}  "
            f"{fmt(sr['cartcrft']['starter_paystack'], decimals=0):>12}  "
            f"{fmt(sr['self_host']['minimal'], decimals=0):>14}  "
            f"{fmt(premium, decimals=0):>20}  (managed convenience premium)")
    add("")

    return lines, scenario_results


# ═══════════════════════════════════════════════════════════════════════════════
#  EXECUTIVE VERDICT
# ═══════════════════════════════════════════════════════════════════════════════

def print_verdict(profit_results, scenario_results):
    lines = []
    add = lines.append

    add("")
    add(hr('═'))
    add("  EXECUTIVE VERDICT")
    add(hr('═'))
    add("")

    # Competitive
    add("  COMPETITIVE?")
    add("")
    add("  vs Shopify:   YES, strongly — at any GMV above ~$4k/mo (the crossover where")
    add("                Shopify's 2% rake on $4k = $80 > Cartcrft $79 flat). By $50k GMV,")
    add("                merchant saves >$1,000/mo vs Shopify Basic. By $200k GMV, >$4,000/mo.")
    add("                Cartcrft wins unconditionally at mid and large GMV via the 0% rake.")
    add("")
    add("  vs Medusa:    MIXED — Cartcrft Starter ($79) is cheaper than Medusa Launch ($99).")
    add("                Cartcrft Starter is cheaper than Medusa Scale ($299) at all GMV bands.")
    add("                This is purely a flat-fee comparison (both 0% rake). Cartcrft wins")
    add("                on price; Medusa has brand recognition and a larger ecosystem currently.")
    add("")
    add("  vs Self-Host: Cartcrft Cloud adds a ~$39/mo managed-infra premium over minimal")
    add("                self-host ($40 infra). That premium buys backups, upgrades, SSL,")
    add("                pgvector, and support. Technically self-host is cheaper — but only")
    add("                if you have ops capacity. For founder-led teams, the $39 premium is")
    add("                likely justified. For teams with a dedicated DevOps engineer, self-host.")
    add("")

    # Dynamic Nano vs Shopify Basic at $1k GMV
    xsmall = scenario_results.get('xsmall', {})
    if xsmall:
        nano_total = xsmall['cartcrft']['nano_paystack']
        shpfy_total = xsmall['shopify']['basic']
        nano_saving = shpfy_total - nano_total
        if nano_saving > 0:
            add(f"  vs Shopify at X-Small ($1k GMV) — NANO:  Nano WINS — Nano ${float(nano_total):.0f}/mo total")
            add(f"                vs Shopify Basic ${float(shpfy_total):.0f}/mo. Nano saves ${float(nano_saving):.0f}/mo")
            add(f"                at $1k GMV. Sub-$4k gap is now CLOSED by the Nano tier.")
        else:
            add(f"  vs Shopify at X-Small ($1k GMV) — NANO:  Shopify still ${abs(float(nano_saving)):.0f}/mo cheaper")
            add(f"                at Nano pricing. Nano narrows the gap vs Starter.")
        add("")

    # Profitability
    add("  PROFITABLE?")
    add("")
    for tier_key in ['nano', 'starter', 'scale', 'enterprise']:
        gm = profit_results[tier_key]
        gp = gm['gross_profit_usd']
        mp = gm['gross_margin_pct']
        price = gm['price_usd']
        cogs  = gm['cogs_usd']
        if gp > 0:
            be = FIXED_COSTS['total'] / gp
            verdict = f"YES — {pct(mp)} gross margin, breakeven at {be:.0f} paying tenants"
        else:
            verdict = f"NO — loses ${abs(float(gp)):.2f}/tenant/mo; raise price or cut infra cost"
        add(f"  {gm['label']:<18} (${float(price)}/mo): {verdict}")
        add(f"                      Revenue: ${float(price):.2f}  COGS: ${float(cogs):.2f}  GP: ${float(gp):.2f}")
    add("")

    # Key recommendations
    add("  RECOMMENDATIONS:")
    add("")

    nano_gm = profit_results['nano']
    nano_gp = nano_gm['gross_profit_usd']
    nano_mp = nano_gm['gross_margin_pct']
    nano_cogs = nano_gm['cogs_usd']
    if nano_gp > 0:
        nano_be = FIXED_COSTS['total'] / nano_gp
        add(f"  0. Cloud Nano ({pct(nano_mp)} margin, ${float(nano_gp):.2f}/tenant GP) is PROFITABLE at unit level.")
        add(f"     Breakeven requires ~{float(nano_be):.0f} Nano-only tenants. Realistic as an entry funnel tier.")
        add(f"     COGS: ${float(nano_cogs):.2f}/mo (infra+collect+community support). Margin is thin but positive.")
        add(f"     Verdict: deliberate FUNNEL PLAY — slim margin accepted in exchange for lower acquisition barrier.")
        add(f"     Nano merchants growing to Starter ($79) double the GP per tenant — upgrade path is the ROI.")
    else:
        add(f"  0. Cloud Nano LOSES ${abs(float(nano_gp)):.2f}/tenant/mo at unit level (COGS: ${float(nano_cogs):.2f}).")
        add(f"     This is a deliberate LOSS-LEADER for the sub-$4k GMV funnel segment.")
        add(f"     Accept only if upgrade conversion rate from Nano→Starter is measurably positive.")
    add("")

    starter_gm = profit_results['starter']
    if starter_gm['gross_profit_usd'] > 0:
        mp_s = starter_gm['gross_margin_pct']
        be_s = FIXED_COSTS['total'] / starter_gm['gross_profit_usd']
        if float(mp_s) < 40:
            add(f"  1. Cloud Starter margin ({pct(mp_s)}) is thin. Consider raising to $99/mo")
            add(f"     to match Medusa Launch and improve margin. Would put breakeven at")
            be_99 = FIXED_COSTS['total'] / (Decimal('99') - starter_gm['cogs_usd'])
            add(f"     ~{float(be_99):.0f} tenants vs current {float(be_s):.0f}. Still beats Medusa Launch.")
        else:
            add(f"  1. Cloud Starter margin ({pct(mp_s)}) is healthy. Price defensible.")

    scale_gm = profit_results['scale']
    if float(scale_gm['gross_margin_pct']) > 50:
        add(f"  2. Cloud Scale ({pct(scale_gm['gross_margin_pct'])} margin) is the most profitable tier.")
        add("     Push merchants toward Scale with multi-store and SLA messaging.")
    add("")
    add("  3. The model proves UNIT ECONOMICS only — profitability assumes customers")
    add("     exist. Demand is unproven (product in preview). Unit economics are sound")
    add("     but market validation is the next critical unknown.")
    add("")
    add("  4. Infra cost assumptions are estimates. Real per-tenant Postgres cost")
    add("     depends on tenant query load and storage. Monitor actual Neon/Supabase")
    add("     bills per tenant cohort and adjust tier pricing accordingly.")
    add("")
    add("  5. Nano tier ($19/mo) closes the sub-$4k GMV gap against Shopify Basic.")
    add("     Nano beats Shopify Basic at $1k GMV; funnel role: acquire early-stage")
    add("     merchants who will grow into Starter ($79) and Scale ($199).")
    add("")

    return lines


# ═══════════════════════════════════════════════════════════════════════════════
#  ASSUMPTIONS + SOURCES
# ═══════════════════════════════════════════════════════════════════════════════

def print_assumptions():
    lines = []
    add = lines.append

    add("")
    add(hr('═'))
    add("  ASSUMPTIONS + SOURCES")
    add(hr('═'))
    add("")
    add("  FX Rate")
    add("    USD/ZAR: 18.60 — xe.com, oanda.com mid-market, June 2026")
    add("")
    add("  Cartcrft Cloud Pricing")
    add("    Source: web/src/pages/pricing.astro (confirmed, June 2026)")
    add("    Cloud Nano:     $19/mo flat  (preview — 1 store, 200 orders/mo, community support)")
    add("    Cloud Starter:  $79/mo flat  (preview — not yet locked in)")
    add("    Cloud Scale:    $199/mo flat (preview — not yet locked in)")
    add("    Enterprise:     custom; modelled at $500/mo (conservative mid-point)")
    add("    All tiers:      0% GMV rake, BYO payment keys")
    add("")
    add("  Managed Infra Costs (per-tenant marginal, USD/mo)")
    add("    Postgres+pgvector:")
    add("      Neon Scale plan: $69/mo shared — marginal per-tenant $8-$15")
    add("      Supabase Pro: $25/mo per project (if isolated)")
    add("      Hetzner managed PG (EU): ~€12-€25/mo")
    add("      Source: neon.tech/pricing, supabase.com/pricing, hetzner.com (June 2026)")
    add("    Compute: Fly.io shared-cpu-1x 1GB = $5.70/mo")
    add("      Source: fly.io/pricing (June 2026)")
    add("    Backups: Backblaze B2 $0.006/GB/mo; ~25GB = $0.15 + overhead = ~$1.50")
    add("      Source: backblaze.com/b2/cloud-storage-pricing.html (June 2026)")
    add("    Bandwidth: Cloudflare R2 egress; mostly free for R2-served assets.")
    add("      API egress at $0.015/GB. Modelled $1.50-$10/mo depending on tier.")
    add("    SSL/CDN: Cloudflare free tier (most), $0.50 amortised.")
    add("")
    add("  Self-host infra estimate")
    add("    Minimal ($40/mo): Hetzner CX21 ~$5 + managed Postgres (Neon/Supabase) ~$25-$35")
    add("    Source: pricing.astro + hetzner.com (June 2026)")
    add("    Roadmap: '$2,400-$7,200/yr' = $200-$600/mo for fuller setup with DevOps tooling")
    add("")
    add("  Paystack fees")
    add("    Subscription collection (Cartcrft's cost): 2.9% + R1/txn")
    add("    Merchant GMV processing (merchant's cost): 2.9% + R1/order")
    add("    Source: paystack.com/pricing (June 2026); confirmed in webcrft billingmodel/costs.py")
    add("    Cap: Paystack SA caps international card fees at 2% + R100 max R2,000 per txn,")
    add("         but local cards (SA-issued) are 2.9% + R1. Model uses local card rate.")
    add("")
    add("  Shopify pricing")
    add("    Basic: $39/mo (monthly billing) + 2.0% external-gateway fee")
    add("    Grow: $105/mo + 1.0% external-gateway fee")
    add("    Advanced: $299/mo + 0.5% external-gateway fee")
    add("    Source: shopify.com/pricing (June 2026)")
    add("    Note: Shopify Payments waives the rake but is NOT available to SA merchants natively.")
    add("          All Cartcrft-relevant comparisons use external gateway (rake applies).")
    add("")
    add("  Medusa Cloud pricing")
    add("    Develop: $29/mo, Launch: $99/mo, Scale: $299/mo — 0% rake across all plans")
    add("    Source: docs.medusajs.com/cloud/pricing (June 2026)")
    add("    Note: Medusa Cloud is a different product class — it includes managed infra")
    add("          for the Medusa commerce backend, not the full storefront. Feature")
    add("          comparison should account for Medusa's larger ecosystem vs Cartcrft's")
    add("          agent-native differentiator.")
    add("")
    add("  Support cost allocation")
    add("    1 junior/mid support FTE (SA salary): ~R35,000/mo = ~$1,882/mo")
    add("    Handles ~200 paying tenants → $9.41/tenant")
    add("    Starter: $9/tenant, Scale: $15/tenant (more complex), Enterprise: $40/tenant")
    add("    Source: ZARemunerate / PayScale SA salary survey 2025-2026 (estimate)")
    add("")
    add("  Fixed costs")
    add("    2× senior engineers at R75,000/mo (mid SA market rate, 2026)")
    add("    = R150,000/mo = ~$8,065/mo at USD/ZAR 18.60")
    add("    Infrastructure base (control plane, CI/CD, monitoring): $300/mo (estimate)")
    add("    Source: PayScale SA, OfferZen SA salary data 2025-2026")
    add("")
    add("  CAVEATS")
    add("    - All prices marked 'preview' in pricing.astro; subject to change before GA")
    add("    - Enterprise price ($500/mo) is a conservative modelled estimate; actual is custom")
    add("    - Infra costs are per-tenant marginal estimates on a shared infrastructure model;")
    add("      actual costs depend on tenant query/storage patterns and total tenant count")
    add("    - This model proves unit economics. It does NOT prove market demand.")
    add("    - Shopify comparison assumes external payment gateway (no Shopify Payments).")
    add("    - Self-host comparison excludes DevOps labour time (significant at scale).")
    add("")

    return lines


# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    all_lines = []

    header = [
        "",
        hr('═'),
        "  CARTCRFT CLOUD — UNIT ECONOMICS + COMPETITIVENESS MODEL",
        "  Generated: June 2026  |  FX: USD/ZAR 18.60  |  python3 model.py",
        hr('═'),
        "",
        "  This model answers:",
        "    A) PROFITABILITY  — does Cartcrft make money per tenant?",
        "    B) COMPETITIVE    — is Cartcrft Cloud cheaper than alternatives for merchants?",
        "",
        "  Source: pricing from web/src/pages/pricing.astro (June 2026 preview).",
        "  Infra costs sourced from neon.tech, supabase.com, fly.io, hetzner.com (June 2026).",
        "  Competitor pricing from shopify.com, docs.medusajs.com (June 2026).",
        "",
    ]
    all_lines.extend(header)

    profit_lines, profit_results = print_profitability()
    all_lines.extend(profit_lines)

    comp_lines, scenario_results = print_competitiveness()
    all_lines.extend(comp_lines)

    verdict_lines = print_verdict(profit_results, scenario_results)
    all_lines.extend(verdict_lines)

    assumption_lines = print_assumptions()
    all_lines.extend(assumption_lines)

    all_lines.append(hr('═'))
    all_lines.append("  END OF REPORT")
    all_lines.append(hr('═'))
    all_lines.append("")

    output = "\n".join(all_lines)
    print(output)
    return output


if __name__ == '__main__':
    main()
