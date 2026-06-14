"""
Cartcrft Cloud — Merchant Scenarios
=====================================
Four GMV bands × two payment gateways = competitive cost comparison matrix.

GMV Bands:
  xsmall : $1,000/mo GMV  (~20 orders, avg order $50)
  small  : $10,000/mo GMV (~200 orders, avg order $50)
  mid    : $50,000/mo GMV (~500 orders, avg order $100)
  large  : $200,000/mo GMV (~2,000 orders, avg order $100)

For each scenario we compute total monthly platform cost to the MERCHANT:
  A) Cartcrft Cloud Starter ($79 flat + BYO Paystack/Stripe at cost)
  B) Cartcrft Cloud Scale ($199 flat + BYO Paystack/Stripe at cost)
  C) Shopify Basic ($39 + 2% GMV rake, Grow $105+1%, Advanced $299+0.5%)
  D) Medusa Cloud (Launch $99 / Scale $299, 0% rake + BYO gateway)
  E) Self-host Cartcrft ($0 software + ~$40-$300 infra + BYO gateway)

Gateway assumption: Paystack SA (2.9% + R1/order) for primary comparison;
Stripe (2.9% + $0.30/order) shown as secondary for international merchants.
"""

from decimal import Decimal
from costs import (
    merchant_paystack_cost_usd, PAYSTACK_MERCHANT_PCT,
    PAYSTACK_MERCHANT_FLAT_ZAR, STRIPE_MERCHANT_PCT, STRIPE_MERCHANT_FLAT_USD,
    SHOPIFY_PLANS, MEDUSA_PLANS, SELF_HOST, TIERS,
    zar_to_usd, USD_ZAR,
)

# ── Merchant scenarios ─────────────────────────────────────────────────────────
SCENARIOS = {
    'xsmall': {
        'label': 'X-Small',
        'gmv_usd': Decimal('1000'),
        'orders': 20,
        'avg_order_usd': Decimal('50'),
        'note': 'Early-stage store; hobbyist or launch phase',
    },
    'small': {
        'label': 'Small',
        'gmv_usd': Decimal('10000'),
        'orders': 200,
        'avg_order_usd': Decimal('50'),
        'note': 'Growing small business',
    },
    'mid': {
        'label': 'Mid',
        'gmv_usd': Decimal('50000'),
        'orders': 500,
        'avg_order_usd': Decimal('100'),
        'note': 'Established SMB',
    },
    'large': {
        'label': 'Large',
        'gmv_usd': Decimal('200000'),
        'orders': 2000,
        'avg_order_usd': Decimal('100'),
        'note': 'Mid-market retailer',
    },
}


def stripe_merchant_cost_usd(gmv_usd: Decimal, orders: int) -> Decimal:
    return STRIPE_MERCHANT_PCT * gmv_usd + STRIPE_MERCHANT_FLAT_USD * orders


def shopify_total_cost_usd(plan: str, gmv_usd: Decimal, gateway_cost_usd: Decimal) -> Decimal:
    """Shopify: plan fee + platform rake on GMV + merchant gateway cost.
    Note: If merchant uses Shopify Payments the rake is waived, but Shopify Payments
    is not available to SA merchants natively. We model the external-gateway path
    which adds the rake on top of the gateway cost."""
    plan_data = SHOPIFY_PLANS[plan]
    rake = plan_data['rake_pct'] * gmv_usd
    return plan_data['plan_usd'] + rake + gateway_cost_usd


def medusa_total_cost_usd(plan: str, gateway_cost_usd: Decimal) -> Decimal:
    """Medusa Cloud: plan fee + 0% rake + merchant gateway cost."""
    return MEDUSA_PLANS[plan]['plan_usd'] + gateway_cost_usd


def cartcrft_cloud_total_cost_usd(tier: str, gateway_cost_usd: Decimal) -> Decimal:
    """Cartcrft Cloud: flat fee + 0% rake + merchant gateway cost (BYO)."""
    return TIERS[tier]['price_usd'] + gateway_cost_usd


def self_host_total_cost_usd(infra_level: str, gateway_cost_usd: Decimal) -> Decimal:
    """Self-host: $0 software + infra + merchant gateway cost."""
    return SELF_HOST[infra_level]['infra_usd'] + gateway_cost_usd


def calc_scenario(scenario_key: str) -> dict:
    s = SCENARIOS[scenario_key]
    gmv = s['gmv_usd']
    orders = s['orders']

    # Merchant gateway costs (these go to the gateway provider, NOT to Cartcrft)
    paystack_cost = merchant_paystack_cost_usd(gmv, orders)
    stripe_cost = stripe_merchant_cost_usd(gmv, orders)

    # Cartcrft Cloud options (Paystack gateway)
    cc_starter_paystack = cartcrft_cloud_total_cost_usd('starter', paystack_cost)
    cc_scale_paystack   = cartcrft_cloud_total_cost_usd('scale', paystack_cost)

    # Shopify options (Paystack as external gateway → rake applies)
    sh_basic  = shopify_total_cost_usd('Basic',    gmv, paystack_cost)
    sh_grow   = shopify_total_cost_usd('Grow',     gmv, paystack_cost)
    sh_adv    = shopify_total_cost_usd('Advanced', gmv, paystack_cost)

    # Medusa Cloud options (Paystack gateway)
    med_launch = medusa_total_cost_usd('Launch', paystack_cost)
    med_scale  = medusa_total_cost_usd('Scale',  paystack_cost)

    # Self-host (minimal infra + Paystack gateway)
    sh_self_min  = self_host_total_cost_usd('minimal',  paystack_cost)
    sh_self_typ  = self_host_total_cost_usd('typical',  paystack_cost)

    return {
        'scenario': scenario_key,
        'label': s['label'],
        'gmv_usd': gmv,
        'orders': orders,
        'note': s['note'],
        'gateway': {
            'paystack_usd': paystack_cost,
            'stripe_usd': stripe_cost,
        },
        'cartcrft': {
            'starter_paystack': cc_starter_paystack,
            'scale_paystack':   cc_scale_paystack,
        },
        'shopify': {
            'basic':    sh_basic,
            'grow':     sh_grow,
            'advanced': sh_adv,
        },
        'medusa': {
            'launch': med_launch,
            'scale':  med_scale,
        },
        'self_host': {
            'minimal': sh_self_min,
            'typical': sh_self_typ,
        },
        # Savings vs Shopify Basic at this GMV
        'vs_shopify_basic_starter_savings': sh_basic - cc_starter_paystack,
        'shopify_rake_only': SHOPIFY_PLANS['Basic']['rake_pct'] * gmv,
    }
