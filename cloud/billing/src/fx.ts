/**
 * fx.ts — USD→ZAR exchange rate helpers
 *
 * Ported from:
 *   webcrft-mono/backend/internal/handlers/commerce_currency.go  (loadExchangeRates)
 *   webcrft-mono/backend/cmd/server/main.go                      (fetchExchangeRates)
 *   webcrft-mono/backend/internal/handlers/domains.go            (getUSDRate)
 *
 * exchange_rates table (from backend migration 0004_platform.sql):
 *   id, base char(3) default 'USD', rates jsonb, fetched_at timestamptz
 *
 * API: https://v6.exchangerate-api.com/v6/<key>/latest/USD
 *   → { result: 'success', conversion_rates: { ZAR: 18.52, ... } }
 */

import type pg from 'pg';
import type { Clock } from './clock.js';

// ── Staleness guard ───────────────────────────────────────────────────────────

/** Rate is considered stale after 6 hours (matches webcrft 2×/day refresh). */
const RATE_STALE_MS = 6 * 60 * 60 * 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FxRate {
  /** ZAR per 1 USD, e.g. 18.5234 */
  zarPerUsd: number;
  /** When the rate row was inserted into exchange_rates */
  fetchedAt: Date;
}

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Read the most recent USD→ZAR rate from the exchange_rates table.
 *
 * Returns null if:
 *   - no row exists in exchange_rates
 *   - the ZAR key is missing from the rates jsonb
 *   - the row is older than RATE_STALE_MS (staleness guard)
 *
 * The staleness guard is a safety net: callers should run refreshExchangeRates
 * periodically (worker job). A stale rate returns null so the engine can decide
 * whether to proceed or abort.
 *
 * @param pool   pg.Pool connected to the database
 * @param clock  Clock for staleness comparison (injectable for testing)
 */
export async function getUsdZarRate(
  pool: pg.Pool,
  clock: Clock,
): Promise<FxRate | null> {
  const { rows } = await pool.query<{ rates: string; fetched_at: Date }>(
    `SELECT rates, fetched_at
       FROM exchange_rates
      WHERE base = 'USD'
      ORDER BY fetched_at DESC
      LIMIT 1`,
  );

  if (rows.length === 0) return null;

  const row = rows[0]!;
  const fetchedAt = row.fetched_at instanceof Date ? row.fetched_at : new Date(row.fetched_at);

  // Staleness guard
  if (clock.now().getTime() - fetchedAt.getTime() > RATE_STALE_MS) {
    return null;
  }

  let ratesObj: Record<string, unknown>;
  try {
    ratesObj =
      typeof row.rates === 'string'
        ? (JSON.parse(row.rates) as Record<string, unknown>)
        : (row.rates as Record<string, unknown>);
  } catch {
    return null;
  }

  const zarVal = ratesObj['ZAR'];
  const zarPerUsd =
    typeof zarVal === 'number'
      ? zarVal
      : typeof zarVal === 'string'
        ? parseFloat(zarVal)
        : NaN;

  if (!isFinite(zarPerUsd) || zarPerUsd <= 0) return null;

  return { zarPerUsd, fetchedAt };
}

/**
 * Convert a USD amount (in cents) to ZAR cents using an exact rate.
 *
 * Uses integer-cent math with ceiling rounding (never under-charges).
 * The result is the ZAR amount in cents (integer).
 *
 * @param usdCents  USD amount in cents (e.g. 2900 = $29.00)
 * @param zarPerUsd Exchange rate (e.g. 18.5234)
 * @returns ZAR amount in cents (integer, ceiling-rounded)
 */
export function convertUsdCentsToZar(usdCents: number, zarPerUsd: number): number {
  if (usdCents <= 0 || zarPerUsd <= 0) return 0;
  // usdCents / 100 → USD amount; * zarPerUsd → ZAR amount; * 100 → ZAR cents
  const zarCentsExact = usdCents * zarPerUsd;
  return Math.ceil(zarCentsExact);
}

/**
 * Convenience: convert USD dollar amount (numeric) to ZAR cents.
 * e.g. convertUsdToZar(29.00, 18.52) → 5371 (ZAR cents = R53.71)
 */
export function convertUsdToZarCents(usdAmount: number, zarPerUsd: number): number {
  if (usdAmount <= 0 || zarPerUsd <= 0) return 0;
  return Math.ceil(usdAmount * zarPerUsd * 100);
}

// ── Refresh worker job ────────────────────────────────────────────────────────

/**
 * Fetch fresh exchange rates from exchangerate-api.com and store in exchange_rates.
 * Purges rows older than 90 days (mirrors Go behaviour).
 *
 * Called by the billing worker on its refresh interval (every 2 hours).
 *
 * @param pool    pg.Pool
 * @param apiKey  EXCHANGE_RATE_API_KEY env var
 * @returns Number of currencies stored, or throws on API error.
 */
export async function refreshExchangeRates(pool: pg.Pool, apiKey: string): Promise<number> {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('EXCHANGE_RATE_API_KEY is not configured');
  }

  const url = `https://v6.exchangerate-api.com/v6/${apiKey.trim()}/latest/USD`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);

  let data: Record<string, unknown>;
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw new Error(`exchangerate-api: HTTP ${res.status}`);
    }
    data = (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }

  if (data['result'] !== 'success') {
    throw new Error('exchangerate-api: API did not return success');
  }

  const allRates = (data['conversion_rates'] as Record<string, number>) ?? {};

  // Only store the subset of currencies we track (mirrors Go trackedCurrencies).
  const tracked = [
    'ZAR', 'NGN', 'USD', 'GHS', 'KES', 'XOF', 'EGP',
    'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'INR',
    'MXN', 'SGD', 'HKD', 'NZD', 'SEK', 'NOK', 'PLN', 'BWP',
    'TRY', 'AED', 'KRW', 'THB', 'IDR', 'PHP', 'PKR', 'BDT',
  ];

  const rates: Record<string, number> = {};
  for (const code of tracked) {
    if (code in allRates) {
      rates[code] = allRates[code]!;
    }
  }

  await pool.query(
    `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
    [JSON.stringify(rates)],
  );
  // Purge stale rows older than 90 days (mirrors Go).
  await pool.query(
    `DELETE FROM exchange_rates WHERE fetched_at < now() - interval '90 days'`,
  );

  return Object.keys(rates).length;
}
