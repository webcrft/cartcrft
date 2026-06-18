/**
 * pricing.test.ts — Unit tests for the canonical FLAT pricing model.
 * No transaction fees, no overages. Limits are upgrade boundaries.
 */

import { describe, it, expect } from 'vitest';
import {
  PLANS,
  ANNUAL_MONTHS_BILLED,
  getPlan,
  computePlanPriceUsd,
  planFits,
  recommendPlan,
  annualSavingsUsd,
} from './pricing.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── Catalog ─────────────────────────────────────────────────────────────────────

describe('PLANS catalog', () => {
  it('has solo, studio, growth, scale', () => {
    expect(PLANS.map((p) => p.id)).toEqual(['solo', 'studio', 'growth', 'scale']);
  });

  it('only growth is popular', () => {
    expect(getPlan('growth').popular).toBe(true);
    expect(getPlan('solo').popular).toBeUndefined();
    expect(getPlan('studio').popular).toBeUndefined();
    expect(getPlan('scale').popular).toBeUndefined();
  });

  it('ANNUAL_MONTHS_BILLED is 10 (2 months free)', () => {
    expect(ANNUAL_MONTHS_BILLED).toBe(10);
  });
});

// ── getPlan ─────────────────────────────────────────────────────────────────────

describe('getPlan', () => {
  it('returns the requested plan', () => {
    expect(getPlan('solo').name).toBe('Solo');
    expect(getPlan('growth').name).toBe('Growth');
  });

  it('throws on unknown id', () => {
    // @ts-expect-error — intentionally passing an invalid id
    expect(() => getPlan('enterprise')).toThrow();
  });
});

// ── computePlanPriceUsd — monthly ────────────────────────────────────────────────

describe('computePlanPriceUsd (monthly)', () => {
  it('solo=9, studio=29, growth=79, scale=199', () => {
    expect(computePlanPriceUsd('solo', 'monthly').monthlyUsd).toBe(9);
    expect(computePlanPriceUsd('studio', 'monthly').monthlyUsd).toBe(29);
    expect(computePlanPriceUsd('growth', 'monthly').monthlyUsd).toBe(79);
    expect(computePlanPriceUsd('scale', 'monthly').monthlyUsd).toBe(199);
  });

  it('billed and perMonth equal monthlyUsd', () => {
    const p = computePlanPriceUsd('growth', 'monthly');
    expect(p.billedUsd).toBe(79);
    expect(p.perMonthUsd).toBe(79);
  });
});

// ── computePlanPriceUsd — annual ─────────────────────────────────────────────────

describe('computePlanPriceUsd (annual)', () => {
  it('solo billed=90, perMonth=round2(90/12)=7.5', () => {
    const p = computePlanPriceUsd('solo', 'annual');
    expect(p.billedUsd).toBe(90);
    expect(p.perMonthUsd).toBe(round2(90 / 12));
    expect(p.perMonthUsd).toBe(7.5);
  });

  it('growth billed=790, perMonth=65.83', () => {
    const p = computePlanPriceUsd('growth', 'annual');
    expect(p.billedUsd).toBe(790);
    expect(p.perMonthUsd).toBe(65.83);
  });
});

// ── annualSavingsUsd ─────────────────────────────────────────────────────────────

describe('annualSavingsUsd', () => {
  it('solo = 12*9 - 90 = 18', () => {
    expect(annualSavingsUsd('solo')).toBe(12 * 9 - 90);
    expect(annualSavingsUsd('solo')).toBe(18);
  });
});

// ── planFits ─────────────────────────────────────────────────────────────────────

describe('planFits', () => {
  it('growth fits 10 sites, 25000 orders', () => {
    expect(planFits(getPlan('growth'), 10, 25000)).toBe(true);
  });

  it('solo fails on sites (2 > 1)', () => {
    expect(planFits(getPlan('solo'), 2, 500)).toBe(false);
  });

  it('studio fails on orders (6000 > 5000)', () => {
    expect(planFits(getPlan('studio'), 3, 6000)).toBe(false);
  });
});

// ── recommendPlan ────────────────────────────────────────────────────────────────

describe('recommendPlan', () => {
  it('1 site, 500 orders → solo', () => {
    expect(recommendPlan(1, 500)?.id).toBe('solo');
  });

  it('2 sites, 500 orders → studio (solo 1-site limit fails)', () => {
    expect(recommendPlan(2, 500)?.id).toBe('studio');
  });

  it('1 site, 2000 orders → studio (solo 1k-order limit fails)', () => {
    expect(recommendPlan(1, 2000)?.id).toBe('studio');
  });

  it('3 sites, 5000 orders → studio', () => {
    expect(recommendPlan(3, 5000)?.id).toBe('studio');
  });

  it('10 sites, 25000 orders → growth', () => {
    expect(recommendPlan(10, 25000)?.id).toBe('growth');
  });

  it('26 sites, 500 orders → null (exceeds scale 25 sites)', () => {
    expect(recommendPlan(26, 500)).toBeNull();
  });
});
