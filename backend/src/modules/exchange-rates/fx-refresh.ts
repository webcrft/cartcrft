/**
 * exchange-rates/fx-refresh.ts — Background job to refresh exchange rates.
 *
 * Fetches the latest USD-base rates from the ExchangeRate-API v6
 * (https://v6.exchangerate-api.com) and upserts them into the exchange_rates
 * table.  No-ops gracefully when EXCHANGE_RATE_API_KEY is absent.
 *
 * Parity with webcrft-mono:
 *   The Go implementation (main.go:fetchExchangeRates / "exchange-rates" cron)
 *   uses the same ExchangeRate-API v6 endpoint, inserts into exchange_rates with
 *   base='USD', and prunes rows older than 90 days.  Tracked currencies list is
 *   identical.  The Go cron runs every 2 hours; we default to 2 hours as well.
 *
 * Idempotency:
 *   Each run always inserts a new snapshot row (like the Go version).  The
 *   pruning step deletes rows older than 90 days to bound table growth.
 *   If two replicas race, they each insert a row — benign duplicates with the
 *   same rates within the same 2-hour window.
 *
 * Usage (in runWorker):
 *   const stop = startFxRefreshJob({ apiKey: config.EXCHANGE_RATE_API_KEY });
 *   // ... later:
 *   stop();
 */

import { getPool } from "../../db/pool.js";

/** ISO 4217 currency codes to track (mirrors webcrft-mono trackedCurrencies). */
const TRACKED_CURRENCIES = [
  "ZAR", "EUR", "AUD", "GBP", "CAD", "JPY", "CNY", "CHF", "INR", "BRL",
  "NGN", "KES", "MXN", "SGD", "HKD", "NZD", "SEK", "NOK", "PLN", "BWP",
  "TRY", "EGP", "AED", "KRW", "THB", "IDR", "PHP", "PKR", "BDT", "GHS",
];

/**
 * Internal config bag — holds mutable overrides.
 * Tests mutate this object (not the exported reference) so changes are visible
 * inside buildApiUrl without relying on ESM live-binding reassignment.
 */
const _cfg = { apiUrlOverride: null as string | null };

/**
 * Base URL override for ExchangeRate-API v6 — set in tests to point at a
 * local mock server.  Assign via `FxRefreshModule.EXCHANGE_RATE_API_URL_OVERRIDE = ...`
 * in the test file (which mutates the re-exported accessor below).
 *
 * We expose this as a get/set pair on an object so the internal buildApiUrl
 * always reads the current value, even across ESM module boundaries.
 */
export const fxTestConfig = _cfg;

/**
 * Convenience re-export for tests: assign FxRefreshModule.EXCHANGE_RATE_API_URL_OVERRIDE
 * to update the override.  Because ESM named exports are live bindings we also
 * expose a typed getter/setter at the module level; tests may use either style.
 */
export function setFxApiUrlOverride(url: string | null): void {
  _cfg.apiUrlOverride = url;
}

function buildApiUrl(apiKey: string): string {
  if (_cfg.apiUrlOverride) return _cfg.apiUrlOverride;
  return `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`;
}

export interface FxRefreshOpts {
  /** EXCHANGE_RATE_API_KEY — skip if absent. */
  apiKey?: string | undefined;
  /** Interval between refreshes in ms. Default: 2 hours. */
  intervalMs?: number;
  /** Initial delay before the first fetch in ms. Default: 30 000. */
  initialDelayMs?: number;
}

export interface FxRefreshResult {
  ok: boolean;
  currencies: number;
  message?: string;
}

/**
 * Perform a single exchange-rate refresh cycle.
 * Exported for direct invocation in tests.
 */
export async function runFxRefresh(apiKey: string): Promise<FxRefreshResult> {
  const url = buildApiUrl(apiKey);

  let data: Record<string, unknown>;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return { ok: false, currencies: 0, message: `upstream HTTP ${res.status}` };
    }
    data = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      currencies: 0,
      message: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (data["result"] !== "success") {
    return { ok: false, currencies: 0, message: "API result != success" };
  }

  const allRates = (data["conversion_rates"] ?? {}) as Record<string, unknown>;
  const rates: Record<string, number> = {};
  for (const code of TRACKED_CURRENCIES) {
    const v = allRates[code];
    if (typeof v === "number") rates[code] = v;
  }

  const pool = getPool();
  // Insert new snapshot
  await pool.query(
    `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
    [JSON.stringify(rates)]
  );
  // Prune old rows (mirrors Go: delete rows older than 90 days)
  await pool.query(
    `DELETE FROM exchange_rates WHERE fetched_at < now() - interval '90 days'`
  );

  return { ok: true, currencies: Object.keys(rates).length };
}

/**
 * Start the FX refresh background job.
 *
 * Returns a stop function for graceful shutdown.
 */
export function startFxRefreshJob(opts: FxRefreshOpts = {}): () => void {
  const { apiKey, intervalMs = 2 * 60 * 60 * 1000, initialDelayMs = 30_000 } = opts;

  if (!apiKey) {
    console.log(
      "[fx-refresh] EXCHANGE_RATE_API_KEY not set — exchange-rate refresh disabled"
    );
    return () => { /* no-op */ };
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runFxRefresh(apiKey);
      if (result.ok) {
        console.log(`[fx-refresh] upserted ${result.currencies} currencies`);
      } else {
        console.warn(`[fx-refresh] refresh failed: ${result.message ?? "unknown"}`);
      }
    } catch (err) {
      console.error("[fx-refresh] unexpected error:", err);
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  timer = setTimeout(() => void tick(), initialDelayMs);
  console.log(
    `[fx-refresh] started (interval=${intervalMs}ms, initialDelay=${initialDelayMs}ms)`
  );

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    console.log("[fx-refresh] stopped");
  };
}
