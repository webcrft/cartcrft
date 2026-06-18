/**
 * pricing.ts — Canonical FLAT pricing — no transaction fees, no overages.
 *
 * Canonical FLAT pricing — no transaction fees, no overages. Limits are upgrade
 * boundaries. MIRRORED in web/src/site/marketing/pricingData.ts — keep in sync.
 *
 * Server-side source of truth for plan pricing. All functions are pure
 * (no side effects, no DB, no IO) — easily unit-tested.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type BillingPeriod = 'monthly' | 'annual';

export interface Plan {
  id: 'solo' | 'studio' | 'growth' | 'scale';
  name: string;
  monthlyUsd: number;
  sites: number;        // included site limit (upgrade boundary, NOT a per-site fee)
  orders: number;       // included orders/mo limit (upgrade boundary, NOT a per-order fee)
  seats: number;
  popular?: boolean | undefined;
}

// ── Catalog ───────────────────────────────────────────────────────────────────

export const PLANS: readonly Plan[] = [
  { id: 'solo',   name: 'Solo',   monthlyUsd: 9,   sites: 1,  orders: 1000,   seats: 1 },
  { id: 'studio', name: 'Studio', monthlyUsd: 29,  sites: 3,  orders: 5000,   seats: 3 },
  { id: 'growth', name: 'Growth', monthlyUsd: 79,  sites: 10, orders: 25000,  seats: 10, popular: true },
  { id: 'scale',  name: 'Scale',  monthlyUsd: 199, sites: 25, orders: 100000, seats: 25 },
];

export const ANNUAL_MONTHS_BILLED = 10; // annual billed = 10× monthly (2 months free)

// ── Internal helpers ────────────────────────────────────────────────────────────

/** Round a monetary value to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── getPlan ───────────────────────────────────────────────────────────────────

/** Returns the plan with the given id. Throws if unknown. */
export function getPlan(id: Plan['id']): Plan {
  const plan = PLANS.find((p) => p.id === id);
  if (!plan) {
    throw new Error(`Unknown plan id: ${id}`);
  }
  return plan;
}

// ── computePlanPriceUsd ─────────────────────────────────────────────────────────

/**
 * Compute the flat price for a plan at a given billing period.
 *
 *   monthly: billedUsd = monthlyUsd,                    perMonthUsd = monthlyUsd
 *   annual:  billedUsd = round2(monthlyUsd × 10),       perMonthUsd = round2(billedUsd / 12)
 */
export function computePlanPriceUsd(
  planId: Plan['id'],
  period: BillingPeriod,
): { monthlyUsd: number; billedUsd: number; perMonthUsd: number } {
  const plan = getPlan(planId);
  const monthlyUsd = plan.monthlyUsd;

  if (period === 'annual') {
    const billedUsd = round2(monthlyUsd * ANNUAL_MONTHS_BILLED);
    const perMonthUsd = round2(billedUsd / 12);
    return { monthlyUsd, billedUsd, perMonthUsd };
  }

  return { monthlyUsd, billedUsd: monthlyUsd, perMonthUsd: monthlyUsd };
}

// ── planFits ──────────────────────────────────────────────────────────────────

/**
 * True if a plan's included limits cover the requested site + order counts.
 * Sites < 1 are treated as 1, orders < 0 as 0.
 */
export function planFits(plan: Plan, sites: number, orders: number): boolean {
  const effectiveSites = sites < 1 ? 1 : sites;
  const effectiveOrders = orders < 0 ? 0 : orders;
  return effectiveSites <= plan.sites && effectiveOrders <= plan.orders;
}

// ── recommendPlan ───────────────────────────────────────────────────────────────

/**
 * The lowest-monthlyUsd plan whose included limits fit the requested counts,
 * or null if none fit (→ Enterprise / contact us).
 */
export function recommendPlan(sites: number, orders: number): Plan | null {
  let best: Plan | null = null;
  for (const plan of PLANS) {
    if (planFits(plan, sites, orders) && (best === null || plan.monthlyUsd < best.monthlyUsd)) {
      best = plan;
    }
  }
  return best;
}

// ── annualSavingsUsd ────────────────────────────────────────────────────────────

/**
 * Dollars saved per year by paying annually instead of monthly:
 *   12 × monthlyUsd − annual billedUsd.
 */
export function annualSavingsUsd(planId: Plan['id']): number {
  const monthly = computePlanPriceUsd(planId, 'monthly').monthlyUsd;
  const annual = computePlanPriceUsd(planId, 'annual').billedUsd;
  return round2(12 * monthly - annual);
}
