/**
 * exchange-rates/service.ts — Read-side FX rate service for storefronts.
 *
 * PRESENTMENT ONLY: these rates power *display* conversion (showing local prices
 * to a shopper). They never change the settlement/charge currency — orders are
 * always created and charged in the store's base currency. See lib/fx-convert.ts.
 *
 * The exchange_rates table stores USD-base snapshots (base='USD', rates jsonb,
 * fetched_at) written by fx-refresh.ts. This service reads the newest snapshot
 * (RLS-scoped via getReadDb) and shapes it for the public storefront endpoint.
 */

import { getReadDb } from "../../db/pool.js";
import { getLatestRates } from "../../lib/fx-convert.js";

export interface StoreExchangeRates {
  /** ISO 4217 base currency of the snapshot (USD for the current worker). */
  base: string;
  /** target ISO 4217 → rate relative to base (1 base = N target). */
  rates: Record<string, number>;
  /** snapshot fetch time (ISO string) or null when no snapshot exists. */
  fetched_at: string | null;
  /** Store's own (settlement) currency — the base for any presentment conversion. */
  store_currency: string;
  /** Whether the store has opted into presentment/display currency conversion. */
  conversion_enabled: boolean;
  /** Convenience: sorted list of target currency codes available in the snapshot. */
  currencies: string[];
}

/**
 * Load the latest FX snapshot for a store's storefront.
 *
 * Returns the USD-base rate map, the store's own currency, and the list of
 * available target currencies. IDOR-safe: the store row is fetched by id and the
 * read runs through the RLS-scoped read path.
 *
 * Returns null when the store does not exist (or is not visible to the caller).
 */
export async function getStoreExchangeRates(
  storeId: string
): Promise<StoreExchangeRates | null> {
  const db = getReadDb();

  const { rows: storeRows } = await db.query<{
    currency: string;
    enable_currency_conversion: boolean;
  }>(
    `SELECT currency, enable_currency_conversion
       FROM stores
      WHERE id = $1::uuid`,
    [storeId]
  );
  const store = storeRows[0];
  if (!store) return null;

  const latest = await getLatestRates(db);

  return {
    base: latest.base,
    rates: latest.rates,
    fetched_at: latest.fetchedAt ? latest.fetchedAt.toISOString() : null,
    store_currency: store.currency,
    conversion_enabled: store.enable_currency_conversion,
    currencies: Object.keys(latest.rates).sort(),
  };
}
