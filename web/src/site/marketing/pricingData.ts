/**
 * pricingData.ts — Shared pricing source of truth for the marketing surface.
 * (Named pricingData to avoid a case-insensitive-filesystem collision with the
 * sibling page component Pricing.tsx.)
 *
 * The PLANS catalog below is a MIRROR of cloud/billing/src/pricing.ts —
 * keep these numbers identical. The pricing math (computePlanPriceUsd,
 * planFits, recommendPlan) matches the canonical server model.
 *
 * PURE FLAT model: every plan is one flat monthly price. There are NO
 * transaction fees, NO GMV rake, and NO per-unit overages. The limits each
 * plan carries (sites, orders/mo, seats) are upgrade BOUNDARIES — they decide
 * WHICH tier you need, they are never charged per unit. Annual billing bills 10
 * months (2 months free). Bring your own payment keys. Pricing is USD; other
 * currencies shown on the marketing site are indicative conversions, USD is the
 * billed reference.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type BillingPeriod = 'monthly' | 'annual'

export interface Plan {
  id: 'solo' | 'studio' | 'growth' | 'scale'
  name: string
  monthlyUsd: number
  sites: number
  orders: number
  seats: number
  popular?: boolean
}

// ── Catalog (mirror of cloud/billing/src/pricing.ts — keep numbers identical) ──

export const PLANS: Plan[] = [
  { id: 'solo', name: 'Solo', monthlyUsd: 9, sites: 1, orders: 1000, seats: 1 },
  { id: 'studio', name: 'Studio', monthlyUsd: 29, sites: 3, orders: 5000, seats: 3 },
  { id: 'growth', name: 'Growth', monthlyUsd: 79, sites: 10, orders: 25000, seats: 10, popular: true },
  { id: 'scale', name: 'Scale', monthlyUsd: 199, sites: 25, orders: 100000, seats: 25 },
]

export const ANNUAL_MONTHS_BILLED = 10 // annual = 10× monthly (2 months free)

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Round a monetary value to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Returns the plan with the given id. Throws if unknown. */
export function getPlan(id: Plan['id']): Plan {
  const plan = PLANS.find((p) => p.id === id)
  if (!plan) throw new Error(`Unknown plan id: ${id}`)
  return plan
}

// ── computePlanPriceUsd ───────────────────────────────────────────────────────

export interface PlanPrice {
  monthlyUsd: number
  billedUsd: number
  perMonthUsd: number
}

/**
 * Compute the flat price for a plan at a given billing period. The price never
 * depends on sites or orders — those are upgrade boundaries, not meters.
 *   monthly: billedUsd = monthlyUsd, perMonthUsd = monthlyUsd
 *   annual:  billedUsd = monthlyUsd × 10, perMonthUsd = round2(billedUsd / 12)
 * All monetary outputs rounded to 2 decimals.
 */
export function computePlanPriceUsd(planId: Plan['id'], period: BillingPeriod): PlanPrice {
  const plan = getPlan(planId)
  const monthlyUsd = round2(plan.monthlyUsd)

  if (period === 'annual') {
    const billedUsd = round2(monthlyUsd * ANNUAL_MONTHS_BILLED)
    const perMonthUsd = round2(billedUsd / 12)
    return { monthlyUsd, billedUsd, perMonthUsd }
  }

  return { monthlyUsd, billedUsd: monthlyUsd, perMonthUsd: monthlyUsd }
}

// ── planFits ──────────────────────────────────────────────────────────────────

/**
 * Whether a plan's boundaries cover the given usage:
 *   sites  <= plan.sites  (sites < 1 are treated as 1)
 *   orders <= plan.orders (orders < 0 are treated as 0)
 */
export function planFits(plan: Plan, sites: number, orders: number): boolean {
  const s = sites < 1 ? 1 : Math.ceil(sites)
  const o = orders < 0 ? 0 : Math.ceil(orders)
  return s <= plan.sites && o <= plan.orders
}

// ── recommendPlan ─────────────────────────────────────────────────────────────

/**
 * Returns the lowest-priced Plan whose boundaries fit the given usage, or null
 * when usage exceeds every plan (caller should route to Enterprise).
 */
export function recommendPlan(sites: number, orders: number): Plan | null {
  const fitting = PLANS.filter((p) => planFits(p, sites, orders))
  if (fitting.length === 0) return null
  return fitting.reduce((best, p) => (p.monthlyUsd < best.monthlyUsd ? p : best), fitting[0]!)
}

// ── Currencies ────────────────────────────────────────────────────────────────

export interface Currency {
  code: string
  symbol: string
  locale: string
}

export const CURRENCIES: Currency[] = [
  { code: 'USD', symbol: '$', locale: 'en-US' },
  { code: 'EUR', symbol: '€', locale: 'de-DE' },
  { code: 'GBP', symbol: '£', locale: 'en-GB' },
  { code: 'ZAR', symbol: 'R', locale: 'en-ZA' },
  { code: 'AUD', symbol: 'A$', locale: 'en-AU' },
  { code: 'CAD', symbol: 'C$', locale: 'en-CA' },
  { code: 'INR', symbol: '₹', locale: 'en-IN' },
  { code: 'NGN', symbol: '₦', locale: 'en-NG' },
  { code: 'BRL', symbol: 'R$', locale: 'pt-BR' },
  { code: 'AED', symbol: 'AED', locale: 'en-AE' },
  { code: 'SGD', symbol: 'S$', locale: 'en-SG' },
  { code: 'JPY', symbol: '¥', locale: 'ja-JP' },
]

/**
 * Bundled USD-base FX snapshot (indicative, approx mid-2026). Used as a
 * fallback so SSR/prerender and offline render sensible prices; live rates
 * are fetched at runtime by useFxRates.
 */
export const FALLBACK_RATES: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  ZAR: 18.4,
  AUD: 1.52,
  CAD: 1.37,
  INR: 83.2,
  NGN: 1480,
  BRL: 5.4,
  AED: 3.67,
  SGD: 1.35,
  JPY: 156,
}

/** Currencies that have no minor unit — never show decimals. */
const ZERO_DECIMAL_CODES = new Set(['JPY'])

/**
 * Convert a USD amount to the target currency via `rate` and format it for
 * display. Keeps output clean: no decimals for JPY or for totals ≥ 100; cents
 * preserved for smaller values where they matter.
 */
export function formatMoney(amountUsd: number, rate: number, currency: Currency): string {
  const value = amountUsd * rate
  const zeroDecimal = ZERO_DECIMAL_CODES.has(currency.code)
  const showCents = !zeroDecimal && Math.abs(value) < 100 && !Number.isInteger(value)
  const digits = zeroDecimal ? 0 : showCents ? 2 : 0

  try {
    return new Intl.NumberFormat(currency.locale, {
      style: 'currency',
      currency: currency.code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  } catch {
    // Some runtimes/currencies may reject Intl currency formatting — fall back
    // to the bundled symbol so we never throw on the marketing surface.
    const rounded = digits === 0 ? Math.round(value) : Math.round(value * 100) / 100
    return `${currency.symbol}${rounded.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`
  }
}
