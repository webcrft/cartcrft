/**
 * bookings/ical-pull.ts — Scheduled iCal pull worker.
 *
 * Today the iCal import path (importICalFeed) only runs from a pasted payload
 * (POST .../ical-feeds/:feedId/import). This worker periodically selects import
 * feeds with a remote URL that are due for a sync, fetches each feed's remote
 * `url`, and runs the existing importICalFeed() apply path to create/update
 * booking availability blocks. importICalFeed() also advances last_synced_at and
 * records ical_sync_runs rows.
 *
 * A feed is "due" when:
 *   direction = 'import' AND is_active AND url IS NOT NULL
 *   AND (last_synced_at IS NULL
 *        OR last_synced_at + (sync_interval_minutes * interval '1 minute') <= now())
 *
 * Multi-replica safety:
 *   Wrapped in acquireLock/releaseLock (workerlock.ts) so only one replica pulls
 *   feeds in a given tick window — mirrors recovery/worker.ts. importICalFeed()
 *   also advances last_synced_at, so a feed won't be re-pulled until its interval
 *   elapses again, which is the correctness backstop.
 *
 * Remote fetch is injectable for tests via setIcalFetchForTesting().
 *
 * Usage (in runWorker):
 *   const stop = startIcalPullWorkerJob({ clock });
 *   // ... later:
 *   stop();
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { getPool } from "../../db/pool.js";
import { acquireLock, releaseLock } from "../../lib/workerlock.js";
import { importICalFeed } from "./ota.js";

const ICAL_PULL_LOCK_NAME = "ical-pull-worker";
const ICAL_PULL_LOCK_TTL_MS = 6 * 60 * 1000; // slightly longer than the default poll interval

// ── Injectable fetch (for tests) ─────────────────────────────────────────────

type FetchFn = typeof fetch;

let _icalFetch: FetchFn = (...args) => fetch(...args);

/**
 * Override the fetch used to pull remote iCal feeds. Pass null to restore the
 * real global fetch. Test-only.
 */
export function setIcalFetchForTesting(fn: FetchFn | null): void {
  _icalFetch = fn ?? ((...args) => fetch(...args));
}

// ── Due-feed selection ───────────────────────────────────────────────────────

interface DueFeed {
  id: string;
  resource_id: string;
  url: string;
}

/**
 * Select import feeds that are active, have a remote URL, and are due for a sync.
 */
async function selectDueImportFeeds(now: Date, limit = 100): Promise<DueFeed[]> {
  const pool = getPool();
  const { rows } = await pool.query<DueFeed>(
    `SELECT id::text, resource_id::text, url
     FROM ical_feeds
     WHERE direction = 'import'
       AND is_active = true
       AND url IS NOT NULL
       AND (
         last_synced_at IS NULL
         OR last_synced_at + (sync_interval_minutes * interval '1 minute') <= $1
       )
     ORDER BY last_synced_at ASC NULLS FIRST
     LIMIT $2`,
    [now, limit]
  );
  return rows;
}

// ── Single pull (exported for direct test ticks) ─────────────────────────────

export interface IcalPullResult {
  feeds_checked: number;
  feeds_synced: number;
  feeds_failed: number;
}

/**
 * Run a single pull pass: select due import feeds, fetch each remote URL, and
 * apply the iCal payload via importICalFeed(). Errors per feed are recorded on
 * the feed (last_error) and skipped — they don't abort the pass.
 */
export async function runIcalPullPass(now: Date): Promise<IcalPullResult> {
  const pool = getPool();
  const due = await selectDueImportFeeds(now);

  let synced = 0;
  let failed = 0;

  for (const feed of due) {
    try {
      const resp = await _icalFetch(feed.url, {
        method: "GET",
        headers: {
          Accept: "text/calendar, text/plain, */*",
          "User-Agent": "Cartcrft-iCal-Pull/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${feed.url}`);
      }
      const icalText = await resp.text();
      await importICalFeed(feed.resource_id, feed.id, icalText);
      synced++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ical-pull] feed=${feed.id} pull failed: ${msg}`);
      // Record the error + advance last_synced_at so a failing feed doesn't
      // get retried every tick (it will be retried after sync_interval_minutes).
      try {
        await pool.query(
          `UPDATE ical_feeds
           SET last_error = $2, last_synced_at = now(), updated_at = now()
           WHERE id = $1::uuid`,
          [feed.id, msg.slice(0, 500)]
        );
      } catch (markErr) {
        console.error(`[ical-pull] could not record error for feed=${feed.id}:`, markErr);
      }
    }
  }

  return { feeds_checked: due.length, feeds_synced: synced, feeds_failed: failed };
}

// ── Worker job ───────────────────────────────────────────────────────────────

export interface IcalPullWorkerOpts {
  clock?: Clock;
  /** Interval between scans in ms. Default: 5 minutes. */
  intervalMs?: number;
  /** Initial delay before the first tick, in ms. Default: 5 000 (5 s). */
  initialDelayMs?: number;
}

/**
 * Start the scheduled iCal pull worker job.
 * Returns a stop function for graceful shutdown.
 */
export function startIcalPullWorkerJob(opts: IcalPullWorkerOpts = {}): () => void {
  const clock = opts.clock ?? new SystemClock();
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000; // 5 minutes
  const initialDelayMs = opts.initialDelayMs ?? 5_000;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;

    // Acquire a distributed advisory lock so multi-replica deploys don't
    // double-pull the same feeds in the same tick window. importICalFeed's
    // advancement of last_synced_at is the correctness safety net; the lock is
    // an efficiency guard that prevents redundant work.
    let lockToken: string | null = null;
    try {
      lockToken = await acquireLock(ICAL_PULL_LOCK_NAME, ICAL_PULL_LOCK_TTL_MS);
    } catch (err) {
      console.warn("[ical-pull] could not acquire lock (skipping tick):", err instanceof Error ? err.message : String(err));
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
      return;
    }
    if (!lockToken) {
      // Another replica holds the lock — skip this tick cleanly.
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
      return;
    }

    try {
      const result = await runIcalPullPass(clock.now());
      if (result.feeds_synced > 0 || result.feeds_failed > 0) {
        console.log(
          `[ical-pull] checked ${result.feeds_checked} feed(s): ` +
          `${result.feeds_synced} synced, ${result.feeds_failed} failed`
        );
      }
    } catch (err) {
      console.error("[ical-pull] pass error:", err);
    } finally {
      try {
        await releaseLock(ICAL_PULL_LOCK_NAME, lockToken);
      } catch (err) {
        console.warn("[ical-pull] lock release failed:", err instanceof Error ? err.message : String(err));
      }
    }

    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
    }
  };

  timer = setTimeout(() => void tick(), initialDelayMs);
  console.log(
    `[ical-pull] started (interval=${intervalMs}ms, initialDelay=${initialDelayMs}ms)`
  );

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    console.log("[ical-pull] stopped");
  };
}
