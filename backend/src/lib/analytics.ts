/**
 * lib/analytics.ts — AnalyticsSink interface + Postgres implementation.
 *
 * AnalyticsSink is a thin abstraction over the analytics_events table.
 * The pg sink writes directly; a no-op sink is used when the table is absent
 * or when the module is not wired.
 *
 * Standard ecommerce event names (matches webcrft analytics_ecommerce.go):
 *   product_viewed, add_to_cart, remove_from_cart,
 *   checkout_started, order_completed, order_refunded
 *
 * Track only — no query API here (queries live in analytics routes).
 */

import { getPool } from "../db/pool.js";

// ── Interface ──────────────────────────────────────────────────────────────────

export interface AnalyticsSink {
  /**
   * Record an analytics event.
   * Fire-and-forget: implementations swallow errors internally.
   */
  track(opts: TrackOpts): void;
}

export interface TrackOpts {
  /** Store UUID — used to look up or derive a synthetic site_id. */
  storeId: string;
  /** e.g. "product_viewed", "order_completed" */
  eventName: string;
  /** Additional properties stored as JSONB. */
  properties?: Record<string, unknown> | undefined;
}

// ── No-op sink ─────────────────────────────────────────────────────────────────

export class NoopAnalyticsSink implements AnalyticsSink {
  track(_opts: TrackOpts): void {
    // intentionally empty
  }
}

// ── Postgres sink ──────────────────────────────────────────────────────────────

/**
 * PgAnalyticsSink writes events to the analytics_events table.
 *
 * The Go source routes events via site_id (stores → sites join). In Cartcrft
 * there is no sites table, so we use store_id directly as the partition key by
 * storing it in both the site_id column (cast to UUID) and properties.store_id.
 * If the analytics_events table does not exist (migrations not applied) the
 * error is silently swallowed so boot is unaffected.
 */
export class PgAnalyticsSink implements AnalyticsSink {
  track(opts: TrackOpts): void {
    // fire-and-forget — run asynchronously, never block callers
    void this.#write(opts);
  }

  async #write(opts: TrackOpts): Promise<void> {
    try {
      const pool = getPool();
      const props = { store_id: opts.storeId, ...opts.properties };
      await pool.query(
        `INSERT INTO analytics_events
           (site_id, session_id, event_type, event_name, properties, timestamp)
         VALUES ($1::uuid, gen_random_uuid(), 'ecommerce', $2, $3::jsonb, now())`,
        [opts.storeId, opts.eventName, JSON.stringify(props)]
      );
    } catch (err) {
      // swallow — analytics must never crash the main path
      console.warn("analytics: failed to write event", err);
    }
  }
}

// ── Module-level singleton ─────────────────────────────────────────────────────

let _sink: AnalyticsSink = new NoopAnalyticsSink();

/** Replace the module-level sink. Call once at startup or in tests. */
export function setAnalyticsSink(sink: AnalyticsSink): void {
  _sink = sink;
}

/** Get the current analytics sink. */
export function getAnalyticsSink(): AnalyticsSink {
  return _sink;
}

/**
 * Convenience: fire an ecommerce event using the module-level sink.
 * All callers should use this rather than accessing the sink directly.
 */
export function trackEcommerce(
  storeId: string,
  eventName: string,
  properties?: Record<string, unknown> | undefined
): void {
  _sink.track({ storeId, eventName, ...(properties !== undefined ? { properties } : {}) });
}
