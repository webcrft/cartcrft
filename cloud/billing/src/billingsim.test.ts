/**
 * billingsim unit tests
 *
 * Mirrors the semantics validated in webcrft-mono/backend/internal/billingsim/:
 *   - Real-day default (24 h) when sim is disabled or config is absent
 *   - Sim-day override when both billingSimEnabled=true and billingSimDaySeconds>0
 *   - Cycle = 30 × dayDuration
 *   - Zero / negative billingSimDaySeconds falls back to real day
 *   - isSimEnabled guard
 */

import { describe, it, expect } from 'vitest';
import {
  type BillingSimConfig,
  dayDuration,
  cycleDuration,
  dayDurationSeconds,
  isSimEnabled,
} from './billingsim.js';

const REAL_DAY_MS = 24 * 60 * 60 * 1_000;
const CYCLE_DAYS  = 30;

// ── helpers ──────────────────────────────────────────────────────────────────

function simCfg(daySeconds: number): BillingSimConfig {
  return { billingSimEnabled: true, billingSimDaySeconds: daySeconds };
}

function disabledCfg(daySeconds = 60): BillingSimConfig {
  return { billingSimEnabled: false, billingSimDaySeconds: daySeconds };
}

// ── dayDuration ───────────────────────────────────────────────────────────────

describe('dayDuration', () => {
  it('returns real 24h when config is null', () => {
    expect(dayDuration(null)).toBe(REAL_DAY_MS);
  });

  it('returns real 24h when config is undefined', () => {
    expect(dayDuration(undefined)).toBe(REAL_DAY_MS);
  });

  it('returns real 24h when billingSimEnabled=false', () => {
    expect(dayDuration(disabledCfg(10))).toBe(REAL_DAY_MS);
  });

  it('returns real 24h when billingSimDaySeconds=0', () => {
    expect(dayDuration(simCfg(0))).toBe(REAL_DAY_MS);
  });

  it('returns real 24h when billingSimDaySeconds<0', () => {
    expect(dayDuration(simCfg(-1))).toBe(REAL_DAY_MS);
    expect(dayDuration(simCfg(-100))).toBe(REAL_DAY_MS);
  });

  it('returns sim day when enabled and daySeconds=1 (fastest sim)', () => {
    expect(dayDuration(simCfg(1))).toBe(1_000);
  });

  it('returns sim day when enabled and daySeconds=60 (1 minute per day)', () => {
    expect(dayDuration(simCfg(60))).toBe(60_000);
  });

  it('returns sim day when enabled and daySeconds=3600 (1 hour per day)', () => {
    expect(dayDuration(simCfg(3600))).toBe(3_600_000);
  });

  it('returns sim day when enabled and daySeconds=86400 (real day = real day, identity)', () => {
    expect(dayDuration(simCfg(86400))).toBe(REAL_DAY_MS);
  });

  it('simulation disabled overrides non-zero daySeconds', () => {
    // billingSimEnabled=false must ALWAYS return real day regardless of daySeconds
    const cfg = disabledCfg(1);
    expect(dayDuration(cfg)).toBe(REAL_DAY_MS);
  });
});

// ── cycleDuration ─────────────────────────────────────────────────────────────

describe('cycleDuration', () => {
  it('real cycle = 30 real days', () => {
    expect(cycleDuration(null)).toBe(CYCLE_DAYS * REAL_DAY_MS);
  });

  it('sim cycle = 30 × sim day', () => {
    const dayS = 60; // 1 minute = 1 sim day
    expect(cycleDuration(simCfg(dayS))).toBe(CYCLE_DAYS * dayS * 1_000);
  });

  it('sim cycle with 1-second day = 30 seconds', () => {
    expect(cycleDuration(simCfg(1))).toBe(30_000);
  });

  it('disabled sim → cycle = 30 real days', () => {
    expect(cycleDuration(disabledCfg(1))).toBe(CYCLE_DAYS * REAL_DAY_MS);
  });

  it('cycle is exactly 30× dayDuration for any config', () => {
    const cfgs: (BillingSimConfig | null)[] = [
      null,
      simCfg(1),
      simCfg(60),
      simCfg(3600),
      simCfg(0),
      simCfg(-5),
      disabledCfg(10),
    ];
    for (const cfg of cfgs) {
      expect(cycleDuration(cfg)).toBe(CYCLE_DAYS * dayDuration(cfg));
    }
  });
});

// ── dayDurationSeconds ────────────────────────────────────────────────────────

describe('dayDurationSeconds', () => {
  it('real day = 86400 seconds', () => {
    expect(dayDurationSeconds(null)).toBe(86_400);
  });

  it('sim day of 60 s = 60 seconds', () => {
    expect(dayDurationSeconds(simCfg(60))).toBe(60);
  });
});

// ── isSimEnabled ──────────────────────────────────────────────────────────────

describe('isSimEnabled', () => {
  it('false for null', () => {
    expect(isSimEnabled(null)).toBe(false);
  });

  it('false for undefined', () => {
    expect(isSimEnabled(undefined)).toBe(false);
  });

  it('false when billingSimEnabled=false', () => {
    expect(isSimEnabled(disabledCfg(60))).toBe(false);
  });

  it('false when billingSimDaySeconds=0', () => {
    expect(isSimEnabled(simCfg(0))).toBe(false);
  });

  it('false when billingSimDaySeconds<0', () => {
    expect(isSimEnabled(simCfg(-1))).toBe(false);
  });

  it('true when both enabled and daySeconds>0', () => {
    expect(isSimEnabled(simCfg(1))).toBe(true);
    expect(isSimEnabled(simCfg(60))).toBe(true);
    expect(isSimEnabled(simCfg(86400))).toBe(true);
  });
});

// ── edge: zero/negative billingSimDaySeconds always falls back ────────────────

describe('zero/negative billingSimDaySeconds fallback', () => {
  const edgeCases = [0, -1, -60, -86400];

  for (const s of edgeCases) {
    it(`billingSimDaySeconds=${s} → real day`, () => {
      const cfg = simCfg(s);
      expect(dayDuration(cfg)).toBe(REAL_DAY_MS);
      expect(cycleDuration(cfg)).toBe(CYCLE_DAYS * REAL_DAY_MS);
      expect(isSimEnabled(cfg)).toBe(false);
    });
  }
});
