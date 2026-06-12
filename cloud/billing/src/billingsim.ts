/**
 * billingsim — Cartcrft Cloud billing time simulation
 *
 * Faithful TypeScript port of webcrft-mono/backend/internal/billingsim/simulation.go
 *
 * Behaviour:
 *   dayDuration(cfg)   → 24 h real time, UNLESS cfg.billingSimEnabled &&
 *                         cfg.billingSimDaySeconds > 0, in which case
 *                         billingSimDaySeconds real seconds = 1 billing day.
 *   cycleDuration(cfg) → 30 × dayDuration(cfg)   (one billing cycle = 30 days)
 *
 * The config interface is a *structural* subset — no import from backend internals.
 * Anything that has { billingSimEnabled, billingSimDaySeconds } satisfies it,
 * including the full backend Config object.
 */

/** Milliseconds in a real calendar day. */
const REAL_DAY_MS = 24 * 60 * 60 * 1_000;

/** Days in one billing cycle. */
const CYCLE_DAYS = 30;

/**
 * Minimal config shape required by billingsim.
 *
 * Compatible with the backend Config type (same field names as the env vars
 * BILLING_SIM_ENABLED / BILLING_SIM_DAY_SECONDS). You can pass the full backend
 * Config or any object with these two fields.
 */
export interface BillingSimConfig {
  /** BILLING_SIM_ENABLED: when true, use billingSimDaySeconds as the day length. */
  billingSimEnabled: boolean;
  /** BILLING_SIM_DAY_SECONDS: one simulated billing day = this many real seconds. */
  billingSimDaySeconds: number;
}

/**
 * Returns the effective billing-day duration in milliseconds.
 *
 * - Simulation only activates when BOTH billingSimEnabled=true AND
 *   billingSimDaySeconds > 0.  Either condition being false/absent falls back
 *   to the real 24-hour day.
 * - A null/undefined config also returns the real day (safe default).
 *
 * @param cfg  BillingSimConfig (or null/undefined for real time)
 * @returns    Duration of one billing day in milliseconds
 */
export function dayDuration(cfg: BillingSimConfig | null | undefined): number {
  if (cfg == null || !cfg.billingSimEnabled) {
    return REAL_DAY_MS;
  }
  if (cfg.billingSimDaySeconds <= 0) {
    return REAL_DAY_MS;
  }
  return cfg.billingSimDaySeconds * 1_000;
}

/**
 * Returns the effective billing-cycle duration in milliseconds.
 * Always 30 × dayDuration(cfg).
 *
 * @param cfg  BillingSimConfig (or null/undefined for real time)
 * @returns    Duration of one billing cycle in milliseconds
 */
export function cycleDuration(cfg: BillingSimConfig | null | undefined): number {
  return CYCLE_DAYS * dayDuration(cfg);
}

/**
 * Returns the effective billing-day duration as a fractional number of real seconds.
 * Convenience helper for logging / display.
 */
export function dayDurationSeconds(cfg: BillingSimConfig | null | undefined): number {
  return dayDuration(cfg) / 1_000;
}

/**
 * Returns true when billing simulation is active (both flag set and day > 0).
 * Use this to guard simulation-only code paths.
 */
export function isSimEnabled(cfg: BillingSimConfig | null | undefined): boolean {
  return cfg != null && cfg.billingSimEnabled && cfg.billingSimDaySeconds > 0;
}
