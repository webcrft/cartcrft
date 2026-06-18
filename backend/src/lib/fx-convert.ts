/**
 * lib/fx-convert.ts — Presentment (display-only) FX conversion helpers.
 *
 * IMPORTANT DESIGN PRINCIPLE — PRESENTMENT ONLY:
 *   Nothing in this file changes the settlement/charge currency. Orders are
 *   always created and charged in the store's BASE currency. These helpers exist
 *   purely to compute *display* values so a storefront can show local prices.
 *   Callers must NEVER replace the real base-currency amounts with the converted
 *   ones — they attach the converted values alongside the originals.
 *
 * Rate table shape:
 *   The exchange_rates table stores snapshots with base='USD' and a jsonb `rates`
 *   map of { "EUR": 0.92, "GBP": 0.79, ... } — each value is "1 USD = N target".
 *   rateFor() derives the base→target rate, computing a cross-rate when the
 *   store's base currency is not USD.
 *
 * Defensive contract:
 *   When a needed rate is missing, rateFor() returns null and the caller falls
 *   back to the base amounts (no conversion, no presentment block). This keeps
 *   the storefront safe when the FX worker has not populated a currency yet.
 */

/**
 * A minimal `.query()` surface — satisfied by pg.Pool, pg.PoolClient, and the
 * ReadDb façade from db/pool.ts. We accept the result loosely (`rows` only) so a
 * single signature covers all of them without union-overload ambiguity.
 */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: R[] }>;
}

/** The newest exchange_rates snapshot, normalised for in-process use. */
export interface LatestRates {
  /** ISO 4217 base currency of the snapshot (always 'USD' for the current worker). */
  base: string;
  /** Map of target ISO 4217 code → rate relative to base (1 base = N target). */
  rates: Record<string, number>;
  /** When the snapshot was fetched, or null when no snapshot exists. */
  fetchedAt: Date | null;
}

/**
 * Read the newest exchange_rates row.
 *
 * Returns an empty rate table (base='USD', rates={}, fetchedAt=null) when the
 * table has no rows yet — callers treat an empty table as "no conversion".
 *
 * Accepts anything with a `.query()` method (pg.Pool / ReadDb), so the public
 * endpoint can pass an RLS-scoped getReadDb() handle.
 */
export async function getLatestRates(
  pool: Queryable
): Promise<LatestRates> {
  const { rows } = await pool.query<{
    base: string;
    rates: Record<string, number> | null;
    fetched_at: Date | string | null;
  }>(
    `SELECT base, rates, fetched_at
       FROM exchange_rates
      ORDER BY fetched_at DESC
      LIMIT 1`
  );

  const row = rows[0];
  if (!row) {
    return { base: "USD", rates: {}, fetchedAt: null };
  }

  const fetchedAt =
    row.fetched_at == null
      ? null
      : row.fetched_at instanceof Date
        ? row.fetched_at
        : new Date(row.fetched_at);

  return {
    base: (row.base ?? "USD").toUpperCase(),
    rates: row.rates ?? {},
    fetchedAt,
  };
}

/**
 * Resolve the conversion rate from `base` → `target` against a USD-keyed table.
 *
 * The table stores "1 tableBase = rates[code] code" (tableBase is 'USD' for the
 * current worker). Cases:
 *   - target === base               → 1 (identity; no conversion needed)
 *   - base === tableBase            → rates[target]            (direct)
 *   - target === tableBase          → 1 / rates[base]          (inverse)
 *   - otherwise (cross-rate)        → rates[target] / rates[base]
 *
 * Returns null (defensive) when any required leg is missing or non-positive, so
 * the caller can fall back to the base currency without converting.
 */
export function rateFor(
  rates: Record<string, number>,
  base: string,
  target: string,
  tableBase = "USD"
): number | null {
  const b = base.toUpperCase();
  const t = target.toUpperCase();
  const tb = tableBase.toUpperCase();

  if (t === b) return 1;

  // Direct: store base IS the table base (USD) → read target leg straight off.
  if (b === tb) {
    const r = rates[t];
    return typeof r === "number" && r > 0 ? r : null;
  }

  // Inverse: target IS the table base → invert the base leg.
  if (t === tb) {
    const rb = rates[b];
    return typeof rb === "number" && rb > 0 ? 1 / rb : null;
  }

  // Cross-rate via the table base: (1 base = rates[target]/rates[base] target).
  const rb = rates[b];
  const rt = rates[t];
  if (typeof rb === "number" && rb > 0 && typeof rt === "number" && rt > 0) {
    return rt / rb;
  }
  return null;
}

/**
 * Convert a base-currency amount to a presentment amount and format it as a
 * 2-decimal string (money-as-decimal-string convention).
 *
 * Pure: takes the already-resolved base→target rate (see rateFor) so it has no
 * dependency on the table shape. Accepts the amount as a string or number.
 */
export function convertMoney(
  amountBaseCurrency: string | number,
  baseToTargetRate: number
): string {
  const amount =
    typeof amountBaseCurrency === "number"
      ? amountBaseCurrency
      : parseFloat(amountBaseCurrency);
  const value = (Number.isFinite(amount) ? amount : 0) * baseToTargetRate;
  // Round half-up at 2dp via integer cents to avoid IEEE-754 drift.
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return rounded.toFixed(2);
}
