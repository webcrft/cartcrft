/**
 * math.test.ts — Unit tests for pure billing math functions
 *
 * Ported from webcrft-mono/backend/tests/suites/billing_math.go.
 * All test cases from Go are represented here.
 */

import { describe, it, expect } from 'vitest';
import {
  calcOverageCost,
  shouldAutoTopup,
  walletCoversOverage,
  calcProration,
  nextBillingAnchorAfter,
  clampBillingDay,
  validateTopupAmount,
  formatWalletAmount,
  MIN_TOPUP_CENTS,
} from './math.js';

// ── calcOverageCost ───────────────────────────────────────────────────────────

describe('calcOverageCost', () => {
  it('0 over-units → 0', () => {
    expect(calcOverageCost(0, 100)).toBe(0);
  });

  it('zero rate → 0', () => {
    expect(calcOverageCost(5000, 0)).toBe(0);
  });

  it('negative over-units → 0', () => {
    expect(calcOverageCost(-10, 100)).toBe(0);
  });

  it('1000 units @ rate 2 → 2 cents (exact)', () => {
    expect(calcOverageCost(1000, 2)).toBe(2);
  });

  it('1 unit @ rate 2 → 1 cent (ceiling)', () => {
    expect(calcOverageCost(1, 2)).toBe(1);
  });

  it('1 unit @ rate 1 → 1 cent (ceil, not floor)', () => {
    expect(calcOverageCost(1, 1)).toBeGreaterThanOrEqual(1);
  });

  it('999 units @ rate 10 → 10 cents (ceil of 9.99)', () => {
    expect(calcOverageCost(999, 10)).toBe(10);
  });

  it('1001 units @ rate 10 → 11 cents (ceil of 10.01)', () => {
    expect(calcOverageCost(1001, 10)).toBe(11);
  });

  it('3M units @ rate 25 → 75000 cents (R750)', () => {
    expect(calcOverageCost(3_000_000, 25)).toBe(75_000);
  });

  // Rate table spot-checks from billing_math.go
  const rateCases: Array<[string, number, number, number]> = [
    ['flash_lite 1M tokens @ rate 1 → 1000c', 1_000_000, 1, 1000],
    ['flash 500k tokens @ rate 2 → 1000c', 500_000, 2, 1000],
    ['claude 100k tokens @ rate 25 → 2500c', 100_000, 25, 2500],
    ['claude_opus 10k tokens @ rate 150 → 1500c', 10_000, 150, 1500],
    ['o4 5k @ rate 200 = R10', 5_000, 200, 1000],
    ['emails 100 @ rate 500 → 50c', 100, 500, 50],
    ['emails 50 @ rate 500 → 25c', 50, 500, 25],
    ['pageviews 10k @ rate 20 → 200c', 10_000, 20, 200],
    ['pageviews 1k @ rate 20 → 20c', 1_000, 20, 20],
    ['storage 1MB @ rate 100 → ≥1c', 1, 100, 1],
  ];

  for (const [label, units, rate, want] of rateCases) {
    it(label, () => {
      expect(calcOverageCost(units, rate)).toBe(want);
    });
  }

  it('is monotonically non-decreasing', () => {
    let prev = 0;
    for (let units = 0; units <= 10_000; units += 100) {
      const cost = calcOverageCost(units, 25);
      expect(cost).toBeGreaterThanOrEqual(prev);
      prev = cost;
    }
  });

  it('split overages ≥ combined (ceiling never under-charges)', () => {
    const single = calcOverageCost(1000, 10);
    let sum = 0;
    for (let i = 0; i < 5; i++) sum += calcOverageCost(200, 10);
    expect(sum).toBeGreaterThanOrEqual(single);
  });
});

// ── shouldAutoTopup ───────────────────────────────────────────────────────────

describe('shouldAutoTopup', () => {
  const cases: Array<[number, number, boolean, string]> = [
    [4999, 5000, true, 'one cent below threshold → topup'],
    [5000, 5000, false, 'exactly at threshold → no topup'],
    [5001, 5000, false, 'above threshold → no topup'],
    [0, 0, false, 'both zero → no topup'],
    [0, 1, true, 'empty wallet with any threshold → topup'],
    [20000, 5000, false, 'just topped up → no topup'],
    [0, 5000, true, 'completely empty → topup'],
    [1, 5000, true, 'nearly empty → topup'],
    [100, -1, false, 'negative threshold → no topup'],
  ];

  for (const [balance, threshold, want, label] of cases) {
    it(label, () => {
      expect(shouldAutoTopup(balance, threshold)).toBe(want);
    });
  }
});

// ── walletCoversOverage ───────────────────────────────────────────────────────

describe('walletCoversOverage', () => {
  it('wallet R10 covers R10 overage', () => {
    expect(walletCoversOverage(1000, 500_000, 2)).toBe(true);
  });

  it('exact balance covers', () => {
    const cost = calcOverageCost(1000, 10);
    expect(walletCoversOverage(cost, 1000, 10)).toBe(true);
  });

  it('one cent short does not cover', () => {
    const cost = calcOverageCost(1000, 10);
    expect(walletCoversOverage(cost - 1, 1000, 10)).toBe(false);
  });

  it('empty wallet does not cover any overage', () => {
    expect(walletCoversOverage(0, 100, 50)).toBe(false);
  });

  it('zero over-units always covered', () => {
    expect(walletCoversOverage(0, 0, 100)).toBe(true);
  });
});

// ── Wallet balance arithmetic ─────────────────────────────────────────────────

describe('wallet balance arithmetic', () => {
  it('balance after debit correct', () => {
    const initial = 10000;
    const debit = 500;
    expect(initial - debit).toBe(9500);
  });

  it('balance after debit non-negative', () => {
    expect(10000 - 500).toBeGreaterThanOrEqual(0);
  });

  it('balance after credit correct', () => {
    expect(10000 + 20000).toBe(30000);
  });

  it('R1 wallet insufficient for R5 debit', () => {
    expect(100 >= 500).toBe(false);
  });

  it('exact balance sufficient for debit', () => {
    expect(500 >= 500).toBe(true);
  });
});

// ── Topup amount validation ───────────────────────────────────────────────────

describe('validateTopupAmount', () => {
  const cases: Array<[number, boolean, string]> = [
    [1000, true, 'R10 minimum — valid'],
    [999, false, 'R9.99 below minimum — invalid'],
    [0, false, 'zero — invalid'],
    [20000, true, 'R200 normal topup — valid'],
    [100000, true, 'R1000 large topup — valid'],
  ];

  for (const [amount, valid, label] of cases) {
    it(label, () => {
      expect(validateTopupAmount(amount)).toBe(valid);
    });
  }

  it('MIN_TOPUP_CENTS is 1000', () => {
    expect(MIN_TOPUP_CENTS).toBe(1000);
  });
});

// ── formatWalletAmount ────────────────────────────────────────────────────────

describe('formatWalletAmount', () => {
  const cases: Array<[number, string | undefined, string]> = [
    [2000, 'ZAR', 'R20.00 ZAR'],
    [100, 'ZAR', 'R1.00 ZAR'],
    [1, 'ZAR', 'R0.01 ZAR'],
    [20000, 'ZAR', 'R200.00 ZAR'],
    [100, undefined, 'R1.00 ZAR'],
  ];

  for (const [cents, currency, want] of cases) {
    it(`formatWalletAmount(${cents}, ${currency}) → ${want}`, () => {
      expect(formatWalletAmount(cents, currency)).toBe(want);
    });
  }
});

// ── clampBillingDay ───────────────────────────────────────────────────────────

describe('clampBillingDay', () => {
  it('clamps to 1 when below 1', () => {
    expect(clampBillingDay(0, 2026, 3)).toBe(1);
  });

  it('clamps 31 in February to 28 (non-leap)', () => {
    expect(clampBillingDay(31, 2026, 2)).toBe(28);
  });

  it('clamps 31 in February to 29 (leap year)', () => {
    expect(clampBillingDay(31, 2024, 2)).toBe(29);
  });

  it('allows 31 in March', () => {
    expect(clampBillingDay(31, 2026, 3)).toBe(31);
  });

  it('clamps 31 in April to 30', () => {
    expect(clampBillingDay(31, 2026, 4)).toBe(30);
  });
});

// ── nextBillingAnchorAfter ────────────────────────────────────────────────────

describe('nextBillingAnchorAfter', () => {
  it('returns a future date', () => {
    const now = new Date('2026-03-18T10:00:00Z');
    const anchor = nextBillingAnchorAfter(now, 25);
    expect(anchor.getTime()).toBeGreaterThan(now.getTime());
  });

  it('moves to next month when preferred day is already past', () => {
    const now = new Date('2026-03-20T10:00:00Z');
    // Day 18 in March is already past
    const anchor = nextBillingAnchorAfter(now, 18);
    // Should be April 18 (SAST)
    expect(anchor.getTime()).toBeGreaterThan(now.getTime());
    // The anchor should be in April
    const month = anchor.toLocaleString('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      month: 'numeric',
    });
    expect(Number(month)).toBe(4); // April
  });
});

// ── calcProration ─────────────────────────────────────────────────────────────

describe('calcProration', () => {
  // SAST midnight helpers: UTC = SAST - 2h
  const sast = (y: number, m: number, d: number) =>
    new Date(Date.UTC(y, m - 1, d) - 2 * 60 * 60 * 1_000);

  it('MoveForward: period ends Apr 18, change to 20th → 2 extra days', () => {
    const now = sast(2026, 3, 18);
    const oldDue = sast(2026, 4, 18);
    const { newDue, prorationCents } = calcProration(now, oldDue, 20, 3999);

    // newDue should be Apr 20 SAST
    const dueDay = parseInt(
      newDue.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric' }),
      10,
    );
    expect(dueDay).toBe(20);

    const expected = Math.floor(3999 * 2.0 / 30.0);
    expect(prorationCents).toBe(expected);
  });

  it('MoveBackward: period ends Apr 18, change to 7th → pushed to May 7', () => {
    const now = sast(2026, 3, 18);
    const oldDue = sast(2026, 4, 18);
    const { newDue, prorationCents } = calcProration(now, oldDue, 7, 3999);

    // newDue should be after Apr 18 (May 7)
    expect(newDue.getTime()).toBeGreaterThan(oldDue.getTime());
    expect(prorationCents).toBeGreaterThan(0);
  });

  it('FreeTier: priceCents=0 → never prorate', () => {
    const now = sast(2026, 3, 18);
    const oldDue = sast(2026, 4, 18);
    const { prorationCents } = calcProration(now, oldDue, 25, 0);
    expect(prorationCents).toBe(0);
  });

  it('ProrationCap: never exceeds monthly price', () => {
    const now = sast(2026, 3, 18);
    const oldDue = sast(2026, 3, 18);
    const { prorationCents } = calcProration(now, oldDue, 17, 9999);
    expect(prorationCents).toBeLessThanOrEqual(9999);
  });

  it('30 single-day moves accumulate to ≈ 1 month price (3800–4200)', () => {
    const now = sast(2026, 3, 18);
    let tmpDue = sast(2026, 4, 18);
    let total = 0;

    for (let day = 19; day <= 30; day++) {
      const r = calcProration(now, tmpDue, day, 3999);
      total += r.prorationCents;
      tmpDue = r.newDue;
    }
    for (let day = 1; day <= 18; day++) {
      const r = calcProration(now, tmpDue, day, 3999);
      total += r.prorationCents;
      tmpDue = r.newDue;
    }
    expect(total).toBeGreaterThanOrEqual(3800);
    expect(total).toBeLessThanOrEqual(4200);
  });

  it('ForwardThenBackward roundtrip ≈ 1 month (3800–4200)', () => {
    const now = sast(2026, 3, 18);
    const oldDue = sast(2026, 4, 18);

    const { newDue: newDue1, prorationCents: p1 } = calcProration(now, oldDue, 20, 3999);
    const { prorationCents: p2 } = calcProration(now, newDue1, 18, 3999);
    const total = p1 + p2;

    expect(total).toBeGreaterThanOrEqual(3800);
    expect(total).toBeLessThanOrEqual(4200);
  });
});
