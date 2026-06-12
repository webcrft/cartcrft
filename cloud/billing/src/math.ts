/**
 * math.ts — Pure billing math functions
 *
 * Ported from webcrft-mono/backend/tests/suites/billing_math.go.
 * All functions are pure (no side effects, no DB) — easily unit-tested.
 *
 * Functions:
 *   calcOverageCost       — cost of overages (ceiling rounding per 1k units)
 *   shouldAutoTopup       — threshold trigger logic
 *   walletCoversOverage   — whether a balance covers an overage charge
 *   calcProration         — proration cents when billing day changes
 *   nextBillingAnchorAfter      — next calendar anchor after `now`
 *   previousBillingAnchorBefore — most recent anchor before `now`
 *   clampBillingDay       — clamp to [1, last-day-of-month]
 *   validateTopupAmount   — R10 minimum check (1000 ZAR cents)
 */

// ── Billing timezone ──────────────────────────────────────────────────────────

export const BILLING_TIMEZONE = 'Africa/Johannesburg';

// ── calcOverageCost ───────────────────────────────────────────────────────────

/**
 * Calculate the cost (in ZAR cents) for overages.
 *
 * Formula: ceil(overUnits × ratePerK / 1000)
 *   - 0 if overUnits <= 0 or ratePerK <= 0
 *   - Ceiling rounding: 1 unit always costs at least 1 cent
 *
 * This matches Go billing_math.go calcOverageCost semantics.
 *
 * @param overUnits  Number of units over quota
 * @param ratePerK   Cost in ZAR cents per 1000 units
 * @returns ZAR cents (integer, ceiling-rounded)
 */
export function calcOverageCost(overUnits: number, ratePerK: number): number {
  if (overUnits <= 0 || ratePerK <= 0) return 0;
  return Math.ceil((overUnits * ratePerK) / 1000);
}

// ── shouldAutoTopup ───────────────────────────────────────────────────────────

/**
 * Returns true when the wallet balance is below the threshold.
 * balance < threshold → trigger topup.
 * balance >= threshold → no topup.
 * Either ≤ 0 → no topup (threshold=0 means disabled).
 */
export function shouldAutoTopup(balance: number, threshold: number): boolean {
  if (threshold <= 0) return false;
  return balance < threshold;
}

// ── walletCoversOverage ───────────────────────────────────────────────────────

/**
 * Returns true if the wallet balance is sufficient to cover an overage charge.
 *
 * cost = calcOverageCost(overUnits, ratePerK)
 * covers = walletBalance >= cost
 */
export function walletCoversOverage(
  walletBalance: number,
  overUnits: number,
  ratePerK: number,
): boolean {
  const cost = calcOverageCost(overUnits, ratePerK);
  return walletBalance >= cost;
}

// ── Billing day helpers ───────────────────────────────────────────────────────

/** Returns the number of days in a given month (1-indexed). */
function lastDayOfMonth(year: number, month: number): number {
  // month: 1..12 → Date(year, month, 0) = last day of month
  return new Date(year, month, 0).getDate();
}

/**
 * Clamp a preferred billing day to [1, last-day-of-month].
 * E.g. day=31, Feb → 28 (or 29 in leap year).
 */
export function clampBillingDay(day: number, year: number, month: number): number {
  if (day < 1) day = 1;
  if (day > 31) day = 31;
  const maxDay = lastDayOfMonth(year, month);
  return Math.min(day, maxDay);
}

/**
 * Returns the next billing anchor date after `now` in SAST (Africa/Johannesburg).
 * If this month's anchor is already in the past, moves to next month.
 *
 * Mirrors: nextBillingAnchorAfter in billing.go
 */
export function nextBillingAnchorAfter(now: Date, preferredDay: number): Date {
  // Use Intl to compute SAST date parts
  const fmt = new Intl.DateTimeFormat('en-ZA', {
    timeZone: BILLING_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = fmt.formatToParts(now);
  const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10); // 1-indexed
  const day = clampBillingDay(preferredDay, year, month);

  // Build target in SAST
  const target = sastMidnight(year, month, day);

  if (target > now) return target;

  // Roll to next month
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const nextDay = clampBillingDay(preferredDay, nextYear, nextMonth);
  return sastMidnight(nextYear, nextMonth, nextDay);
}

/**
 * Returns the most recent billing anchor strictly before `ref` in SAST.
 * If this month's anchor is >= ref, moves to previous month.
 *
 * Mirrors: previousBillingAnchorBefore in billing.go
 */
export function previousBillingAnchorBefore(ref: Date, preferredDay: number): Date {
  const fmt = new Intl.DateTimeFormat('en-ZA', {
    timeZone: BILLING_TIMEZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = fmt.formatToParts(ref);
  const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
  const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10);
  const day = clampBillingDay(preferredDay, year, month);

  const target = sastMidnight(year, month, day);

  if (target < ref) return target;

  // Roll to previous month
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevDay = clampBillingDay(preferredDay, prevYear, prevMonth);
  return sastMidnight(prevYear, prevMonth, prevDay);
}

// ── calcProration ─────────────────────────────────────────────────────────────

export interface ProrationResult {
  newDue: Date;
  prorationCents: number;
}

/**
 * Calculate proration when changing the billing day anchor.
 *
 * Algorithm (mirrors billing_math.go calcProration):
 *   1. newDue = nextAnchorAfter(now, newDay)
 *   2. If newDue <= oldDue → push newDue = nextAnchorAfter(oldDue, newDay)
 *      (never charge earlier than what they already paid for)
 *   3. prorationCents = round(priceCents × extraDays / 30, truncate)
 *      where extraDays = min(newDue - oldDue in days, 30)
 *   4. If priceCents = 0 or newDue <= oldDue → prorationCents = 0
 *
 * @param now         Current time
 * @param oldDue      Current period end
 * @param newDay      Desired new billing day (1–31)
 * @param priceCents  Monthly plan price in ZAR cents
 */
export function calcProration(
  now: Date,
  oldDue: Date,
  newDay: number,
  priceCents: number,
): ProrationResult {
  let newDue = nextBillingAnchorAfter(now, newDay);

  if (newDue <= oldDue) {
    newDue = nextBillingAnchorAfter(oldDue, newDay);
  }

  let prorationCents = 0;
  if (priceCents > 0 && newDue > oldDue) {
    let extraDays = (newDue.getTime() - oldDue.getTime()) / (24 * 60 * 60 * 1_000);
    if (extraDays > 30) extraDays = 30;
    prorationCents = Math.floor(priceCents * extraDays / 30);
  }

  return { newDue, prorationCents };
}

// ── Wallet top-up validation ──────────────────────────────────────────────────

/** Minimum top-up amount: R10 = 1000 ZAR cents. */
export const MIN_TOPUP_CENTS = 1000;

/**
 * Returns true if the topup amount meets the minimum requirement.
 * Minimum is R10 (1000 cents).
 */
export function validateTopupAmount(amountCents: number): boolean {
  return amountCents >= MIN_TOPUP_CENTS;
}

// ── formatWalletAmount ────────────────────────────────────────────────────────

/**
 * Format a wallet balance in cents as "R<amount> <currency>".
 * e.g. formatWalletAmount(2000, 'ZAR') → 'R20.00 ZAR'
 */
export function formatWalletAmount(cents: number, currency?: string): string {
  const cur = currency || 'ZAR';
  return `R${(cents / 100).toFixed(2)} ${cur}`;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Build a Date for midnight SAST on (year, month, day).
 * month is 1-indexed. Returns UTC Date.
 */
function sastMidnight(year: number, month: number, day: number): Date {
  // Africa/Johannesburg is UTC+2 (no DST).
  // Midnight SAST = UTC 22:00 the prior day.
  const SAST_OFFSET_MINUTES = 120; // UTC+2
  const localMs =
    Date.UTC(year, month - 1, day, 0, 0, 0, 0) - SAST_OFFSET_MINUTES * 60 * 1_000;
  return new Date(localMs);
}
