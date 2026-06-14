"""
Cartcrft Cloud — Infrastructure Costs & Unit Economics
=======================================================
Currency: USD (primary pricing currency for Cartcrft Cloud)
  USD/ZAR = 18.60  (mid-market, June 2026 — xe.com, oanda.com)
            Paystack ZAR billing matters for the collection fee on subscriptions.

CARTCRFT CLOUD ARCHITECTURE (from pricing.astro + roadmap):
  • Open-source MIT backend (Postgres + pgvector, MCP, BYO keys)
  • Cloud layer = managed Postgres + pgvector, compute, backups, SSL, upgrades
  • BYO payment keys — merchants pay Stripe/Paystack directly at cost
  • Cartcrft revenue = flat subscription fee ONLY (0% GMV rake)
  • Cartcrft charges subscriptions via Paystack (ZAR) or Stripe — fee is on the
    subscription collection, not on merchant GMV

PRICING TIERS (from web/src/pages/pricing.astro, June 2026 — preview/illustrative):
  Free/Open-Source  : $0/mo  (self-host MIT, not a cloud revenue line)
  Cloud Starter     : $79/mo flat
  Cloud Scale       : $199/mo flat
  Enterprise        : custom (modelled at $500/mo as conservative mid-point estimate)

INFRA COST ASSUMPTIONS (per-tenant marginal monthly, sourced June 2026):
  Managed Postgres + pgvector (Neon/Supabase/Hetzner managed PG):
    - Neon Scale: $69/mo for a shared project (sunk); marginal per-tenant ~$8-$15
    - Supabase Pro: $25/mo per project; Supabase shared multi-tenant model
    - Hetzner managed PG (EU): ~€12-€25/mo for a small dedicated instance
    - We model a SHARED multi-tenant Postgres approach (cheaper for Starter;
      Scale gets more dedicated resources)
    Source: neon.tech/pricing, supabase.com/pricing, hetzner.com (June 2026)

  Compute (API server for managed routing/webhooks/admin):
    - Fly.io shared-cpu-1x 1GB: $5.70/mo (autostop/autostart)
    - Hetzner CX21: ~€4.55/mo = ~$5/mo
    Source: fly.io/pricing, hetzner.com (June 2026)

  Bandwidth/egress: Cloudflare R2 or Hetzner — ~$0.015/GB outbound
  Backups: object storage (Backblaze B2 or Hetzner) — ~$0.006/GB/mo
  SSL/CDN: Cloudflare free tier for most; $0.50/mo amortised per tenant

  Self-host roadmap note: "$2,400–$7,200/yr" ($200–$600/mo) is for a FULL
  production setup with DevOps tooling. Our managed tenants share infra,
  so marginal cost per tenant is far lower.

PAYSTACK SUBSCRIPTION COLLECTION FEE:
  Paystack SA: 2.9% + R1/transaction on card charges
  Applied to the subscription billing (Cartcrft's revenue, NOT merchant GMV)
  USD→ZAR at billing time; R1 flat ≈ $0.054 at 18.60 ZAR/USD
  Source: paystack.com/pricing (June 2026), confirmed in webcrft billingmodel/costs.py

MERCHANT PAYMENT PROCESSING (BYO — NOT Cartcrft's cost):
  Paystack SA: 2.9% + R1/txn on merchant GMV (merchant pays directly)
  Stripe global: 2.9% + $0.30/txn (merchant pays directly)
  These appear only in the merchant cost comparison, not Cartcrft's P&L.

SUPPORT COST ALLOCATION:
  Estimated 1 support FTE (junior/mid, SA salary) handles ~200 paying tenants
  FTE cost: ~R35,000/mo = ~$1,882/mo → $9.41/tenant at 200 tenants
  Allocated proportionally: Starter $9, Scale $15, Enterprise $40 (more hands-on)
  This is a variable allocation assumption — flag as sensitive.

FIXED COSTS (platform-level, not per-tenant):
  Engineering + ops headcount: 2 FTE minimum to run cloud service
  SA senior engineer: ~R75,000/mo × 2 = R150,000/mo = ~$8,065/mo
  Infrastructure base (shared control plane, monitoring, CI/CD): ~$300/mo
  Total fixed: ~$8,365/mo
  Breakeven in paying tenants computed below.
"""

from decimal import Decimal

# ── FX ────────────────────────────────────────────────────────────────────────
USD_ZAR = Decimal('18.60')   # xe.com mid-market, June 2026
ZAR_USD = Decimal('1') / USD_ZAR

def usd_to_zar(v): return Decimal(str(v)) * USD_ZAR
def zar_to_usd(v): return Decimal(str(v)) * ZAR_USD

# ── Paystack subscription collection fee (applied to Cartcrft's own subscription revenue) ──
PAYSTACK_PCT = Decimal('0.029')          # 2.9%
PAYSTACK_FLAT_ZAR = Decimal('1.0')       # R1 per transaction
PAYSTACK_FLAT_USD = zar_to_usd('1.0')   # ~$0.054

# ── Cartcrft Cloud tiers (from pricing.astro, June 2026 preview) ───────────────
TIERS = {
    'starter': {
        'label': 'Cloud Starter',
        'price_usd': Decimal('79.00'),
        'stores': 1,
        'seats': 3,
        'support': 'Email (next business day)',
        'sla': None,
    },
    'scale': {
        'label': 'Cloud Scale',
        'price_usd': Decimal('199.00'),
        'stores': 5,
        'seats': 10,
        'support': 'Priority email',
        'sla': '99.9% monthly uptime',
    },
    'enterprise': {
        'label': 'Enterprise',
        'price_usd': Decimal('500.00'),   # conservative estimate; actual is custom
        'stores': 99,
        'seats': 999,
        'support': 'Dedicated',
        'sla': 'Custom',
        'note': 'Modelled at $500/mo — actual price is negotiated custom',
    },
}

# ── Per-tenant marginal INFRA costs (USD/month) ────────────────────────────────
# Starter: shared multi-tenant Postgres cluster (Neon/Supabase shared)
#   + small compute slice + backups + SSL
# Scale:   more dedicated compute + storage allocation + priority infra queue
# Enterprise: dedicated or near-dedicated resources

INFRA_PER_TENANT = {
    'starter': {
        'postgres_pgvector': Decimal('12.00'),   # Neon/Supabase shared marginal
        'compute': Decimal('6.00'),              # Fly.io shared-cpu-1x slice
        'backups': Decimal('1.50'),              # B2/R2 daily backups ~25GB
        'bandwidth': Decimal('1.50'),            # ~100GB egress at $0.015/GB
        'ssl_cdn': Decimal('0.50'),              # Cloudflare (mostly free)
        'monitoring': Decimal('0.50'),           # Grafana/Uptime Robot amortised
    },
    'scale': {
        'postgres_pgvector': Decimal('22.00'),   # more resources, 5 stores
        'compute': Decimal('12.00'),             # higher compute allocation
        'backups': Decimal('3.00'),              # more stores → more backup data
        'bandwidth': Decimal('3.00'),            # higher egress for 5 stores
        'ssl_cdn': Decimal('1.00'),
        'monitoring': Decimal('1.00'),
    },
    'enterprise': {
        'postgres_pgvector': Decimal('60.00'),   # near-dedicated, custom schema
        'compute': Decimal('40.00'),             # dedicated compute
        'backups': Decimal('10.00'),
        'bandwidth': Decimal('10.00'),
        'ssl_cdn': Decimal('2.00'),
        'monitoring': Decimal('3.00'),
    },
}

# ── Support cost allocation per tenant (USD/month) ─────────────────────────────
SUPPORT_COST_PER_TENANT = {
    'starter': Decimal('9.00'),
    'scale': Decimal('15.00'),
    'enterprise': Decimal('40.00'),
}

# ── Fixed platform costs (USD/month) ─────────────────────────────────────────
FIXED_COSTS = {
    'engineering_ops': Decimal('8065.00'),  # 2× SA senior eng at R75k/mo = R150k = ~$8,065
    'infra_base': Decimal('300.00'),         # control plane, monitoring, CI/CD
    'total': Decimal('8365.00'),
}

# ── Competitor pricing (from pricing.astro sources, June 2026) ─────────────────
# Shopify
SHOPIFY_PLANS = {
    'Basic':    {'plan_usd': Decimal('39'), 'rake_pct': Decimal('0.020')},  # 2% external gateway fee
    'Grow':     {'plan_usd': Decimal('105'), 'rake_pct': Decimal('0.010')}, # 1% external gateway fee
    'Advanced': {'plan_usd': Decimal('299'), 'rake_pct': Decimal('0.005')}, # 0.5% external gateway fee
}

# Medusa Cloud (from pricing.astro / docs.medusajs.com/cloud/pricing, June 2026)
MEDUSA_PLANS = {
    'Develop': {'plan_usd': Decimal('29'),  'rake_pct': Decimal('0')},
    'Launch':  {'plan_usd': Decimal('99'),  'rake_pct': Decimal('0')},
    'Scale':   {'plan_usd': Decimal('299'), 'rake_pct': Decimal('0')},
}

# Self-host Cartcrft (merchant manages own infra)
SELF_HOST = {
    'minimal': {
        'infra_usd': Decimal('40'),  # Hetzner CX21 ~$5 + Neon/Supabase ~$25-$35
        'note': 'Minimal: small VPS + managed Postgres. No DevOps tooling.',
    },
    'typical': {
        'infra_usd': Decimal('100'),
        'note': 'Typical: VPS + managed PG + backups + monitoring. Some DevOps time.',
    },
    'full': {
        'infra_usd': Decimal('300'),  # middle of $200-$600/mo roadmap range
        'note': 'Full: production-grade with DevOps tooling. From roadmap $2,400-$7,200/yr.',
    },
}

# Merchant payment processing (BYO — the MERCHANT pays, not Cartcrft)
PAYSTACK_MERCHANT_PCT = Decimal('0.029')   # 2.9% of GMV
PAYSTACK_MERCHANT_FLAT_ZAR = Decimal('1.0')  # R1 per order
STRIPE_MERCHANT_PCT = Decimal('0.029')     # 2.9% of GMV
STRIPE_MERCHANT_FLAT_USD = Decimal('0.30') # $0.30 per order


def merchant_paystack_cost_usd(gmv_usd: Decimal, orders: int) -> Decimal:
    """What the MERCHANT pays to Paystack on their GMV. Not Cartcrft's cost."""
    flat_total_usd = zar_to_usd(PAYSTACK_MERCHANT_FLAT_ZAR * orders)
    return PAYSTACK_MERCHANT_PCT * gmv_usd + flat_total_usd


def cartcrft_collection_fee_usd(subscription_price_usd: Decimal) -> Decimal:
    """Paystack fee Cartcrft pays to COLLECT the subscription from the merchant.
    Applied to Cartcrft's subscription revenue (USD billed, collected in ZAR)."""
    return PAYSTACK_PCT * subscription_price_usd + PAYSTACK_FLAT_USD


def infra_total_usd(tier: str) -> Decimal:
    return sum(INFRA_PER_TENANT[tier].values())


def cogs_per_tenant_usd(tier: str) -> Decimal:
    """Total COGS per tenant: infra + collection fee + allocated support."""
    price = TIERS[tier]['price_usd']
    collection_fee = cartcrft_collection_fee_usd(price)
    infra = infra_total_usd(tier)
    support = SUPPORT_COST_PER_TENANT[tier]
    return infra + collection_fee + support


def gross_margin(tier: str) -> dict:
    price = TIERS[tier]['price_usd']
    cogs = cogs_per_tenant_usd(tier)
    gp = price - cogs
    margin_pct = (gp / price * 100) if price > 0 else Decimal('-999')
    infra = infra_total_usd(tier)
    collection_fee = cartcrft_collection_fee_usd(price)
    support = SUPPORT_COST_PER_TENANT[tier]
    return {
        'tier': tier,
        'label': TIERS[tier]['label'],
        'price_usd': price,
        'infra_usd': infra,
        'collection_fee_usd': collection_fee,
        'support_alloc_usd': support,
        'cogs_usd': cogs,
        'gross_profit_usd': gp,
        'gross_margin_pct': margin_pct,
    }
