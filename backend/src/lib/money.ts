/**
 * lib/money.ts — Integer-cents money helpers.
 *
 * Ported from webcrft-mono/backend/internal/handlers/commerce_checkout.go
 * (currencyExponent, toMinorUnits) and commerce_money_precision.go
 * semantics.
 *
 * Key rule: all arithmetic is done in integer cents to avoid IEEE-754 drift.
 * DB stores numeric(15,2) which is fine; the API sends strings; internal
 * calculations multiply to cents (integer), round, and divide.
 *
 * Usage:
 *   round2(x)              — round float to 2 decimal places
 *   toCents(amount)        — multiply by 100, Math.round → integer cents
 *   fromCents(cents)       — divide by 100, round to 2dp
 *   currencyExponent(cur)  — 0, 2, or 3 depending on currency
 *   toMinorUnits(amount, cur) — integer minor units for gateway APIs
 */

/**
 * Returns the number of fractional digits for a currency.
 * Default is 2 (cents); zero-decimal and three-decimal currencies are explicit.
 * Mirrors commerce_checkout.go currencyExponent().
 */
export function currencyExponent(cur: string): number {
  switch (cur.toUpperCase()) {
    // Zero-decimal currencies
    case "JPY":
    case "KRW":
    case "HUF":
    case "ISK":
    case "VND":
    case "CLP":
    case "PYG":
    case "RWF":
    case "UGX":
    case "VUV":
    case "XAF":
    case "XOF":
    case "XPF":
    case "KMF":
    case "GNF":
    case "BIF":
    case "DJF":
      return 0;
    // Three-decimal currencies
    case "BHD":
    case "IQD":
    case "JOD":
    case "KWD":
    case "LYD":
    case "OMR":
    case "TND":
      return 3;
    default:
      return 2;
  }
}

/**
 * Convert a decimal amount to integer minor units (e.g. cents).
 * Uses Math.round (banker-safe for positive numbers).
 * Mirrors commerce_checkout.go toMinorUnits().
 */
export function toMinorUnits(amount: number, cur: string): number {
  const exp = currencyExponent(cur);
  return Math.round(amount * Math.pow(10, exp));
}

/**
 * Round a number to 2 decimal places using Math.round.
 * Matches Go's math.Round(x*100)/100 pattern.
 */
export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Convert a decimal amount to integer cents (for internal arithmetic).
 * Always uses exponent 2 regardless of currency — use for subtotals/totals
 * that are already in the currency's major unit with 2dp.
 */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Convert integer cents back to a decimal amount with 2dp.
 */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Add two money amounts safely (via cents).
 */
export function moneyAdd(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

/**
 * Subtract two money amounts safely (via cents).
 */
export function moneySub(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}
