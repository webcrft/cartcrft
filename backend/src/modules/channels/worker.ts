/**
 * channels/worker.ts — Background job that pushes catalog → external sales
 * channels (Google Shopping today).
 *
 * Each tick (default: 10 min):
 *   1. listActiveChannelSyncs() — every (store, channel) with is_active=true.
 *   2. runChannelSync(store, channel) for each — load config + credentials, push
 *      products via the registered connector, upsert channel_sync_items, update
 *      last_synced_at/last_status.
 *
 * A distributed worker lock (mirrors recovery/marketing) prevents multiple
 * replicas from double-pushing in the same window. runChannelSync is itself
 * graceful (records last_status='error' instead of throwing), so one bad store
 * never stops the tick. Clock-injected for SimClock parity.
 *
 * Usage (main.ts worker mode):
 *   const stopChannelSync = startChannelSyncWorkerJob({});
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { acquireLock, releaseLock } from "../../lib/workerlock.js";
import { listActiveChannelSyncs, runChannelSync } from "./service.js";

const CHANNEL_LOCK_NAME = "channel-sync-worker";
const CHANNEL_LOCK_TTL_MS = 15 * 60 * 1000; // > default 10-min tick interval

export interface ChannelSyncWorkerOpts {
  clock?: Clock;
  /** Interval between ticks in ms. Default: 10 minutes. */
  intervalMs?: number;
  /** Initial delay before the first tick in ms. Default: 10s. */
  initialDelayMs?: number;
}

/** Start the channel-sync worker job. Returns a stop function. */
export function startChannelSyncWorkerJob(opts: ChannelSyncWorkerOpts): () => void {
  // Clock reserved for future scheduling (e.g. per-store sync cadence); the
  // distributed lock + DB-driven discovery already make ticks idempotent.
  const _clock: Clock = opts.clock ?? new SystemClock();
  void _clock;
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
  const initialDelayMs = opts.initialDelayMs ?? 10_000;

  let stopped = false;

  const tick = async () => {
    if (stopped) return;

    let lockToken: string | null = null;
    try {
      lockToken = await acquireLock(CHANNEL_LOCK_NAME, CHANNEL_LOCK_TTL_MS);
    } catch (err) {
      console.warn(
        "[channel-sync-worker] could not acquire lock (skipping tick):",
        err instanceof Error ? err.message : String(err)
      );
      if (!stopped) setTimeout(() => void tick(), intervalMs);
      return;
    }
    if (!lockToken) {
      // Another replica holds the lock — skip this tick cleanly.
      if (!stopped) setTimeout(() => void tick(), intervalMs);
      return;
    }

    try {
      const targets = await listActiveChannelSyncs();
      let synced = 0;
      let errored = 0;
      for (const t of targets) {
        if (stopped) break;
        const result = await runChannelSync(t.storeId, t.channel);
        synced += result.synced;
        errored += result.errored;
      }
      if (synced > 0 || errored > 0) {
        console.log(
          `[channel-sync-worker] pushed ${synced} product(s), ${errored} error(s) across ${targets.length} channel(s)`
        );
      }
    } catch (err) {
      console.error("[channel-sync-worker] error during tick:", err);
    } finally {
      try {
        await releaseLock(CHANNEL_LOCK_NAME, lockToken);
      } catch (err) {
        console.warn(
          "[channel-sync-worker] lock release failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    if (!stopped) {
      setTimeout(() => void tick(), intervalMs);
    }
  };

  const initial = setTimeout(() => void tick(), initialDelayMs);

  return () => {
    stopped = true;
    clearTimeout(initial);
    console.log("[channel-sync-worker] stopped");
  };
}
