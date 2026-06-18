/**
 * back-in-stock/service.ts — Back-in-stock notification subscriptions.
 *
 * A shopper subscribes to an out-of-stock variant; when it is restocked the
 * worker (worker.ts → processRestocks) emails them ONCE and marks the
 * subscription notified.
 *
 * Public API:
 *   subscribe(storeId, { variantId, customerId?, email? })  — idempotent
 *   listSubscriptions(storeId, { customerId? })
 *   cancel(storeId, subId, customerId?)
 *   processRestocks(storeId?, deps?)                          — worker tick
 *
 * All SQL is parameterized. Tenant queries scope by store_id; the worker uses
 * the owner connection (getPool) and joins through products for store scoping.
 */

import type pg from "pg";
import { config } from "../../config/config.js";
import { getPool, getReadDb, withTx } from "../../db/pool.js";
import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import type { Mailer } from "../../lib/mailer/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubscribeInput {
  variantId: string;
  customerId?: string | undefined;
  email?: string | undefined;
}

export interface Subscription {
  id: string;
  store_id: string;
  variant_id: string;
  customer_id: string | null;
  email: string | null;
  status: string;
  last_known_on_hand: number | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Injectable dependencies for the worker tick (mailer + clock are spy-able). */
export interface ProcessRestocksDeps {
  mailer?: Mailer | undefined;
  clock?: Clock | undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Total on-hand for a variant across all warehouses. Returns 0 when the variant
 * has no inventory rows. Uses quantity_on_hand (physical stock) — a restock that
 * raises on-hand above 0 is what re-enables purchase.
 */
async function totalOnHand(
  client: pg.PoolClient,
  variantId: string
): Promise<number> {
  const { rows } = await client.query<{ on_hand: string | null }>(
    `SELECT COALESCE(SUM(il.quantity_on_hand), 0)::text AS on_hand
       FROM inventory_levels il
      WHERE il.variant_id = $1::uuid`,
    [variantId]
  );
  return Number(rows[0]?.on_hand ?? "0");
}

// ── subscribe ───────────────────────────────────────────────────────────────

/**
 * Create (or re-activate) an active subscription for a subscriber on a variant.
 * Idempotent on the dedup key (store, variant, customer|email): a repeat
 * subscribe upserts the existing row back to 'active' rather than inserting a
 * duplicate. Captures the variant's current total on-hand as last_known_on_hand
 * so the worker only fires on a genuine out-of-stock → in-stock transition.
 */
export async function subscribe(
  storeId: string,
  input: SubscribeInput
): Promise<{ id: string; status: string }> {
  if (!input.customerId && !input.email) {
    throw new Error("subscribe requires a customerId or email");
  }

  return withTx(async (client) => {
    const onHand = await totalOnHand(client, input.variantId);

    const { rows } = await client.query<{ id: string; status: string }>(
      `INSERT INTO back_in_stock_subscriptions
         (store_id, variant_id, customer_id, email, status, last_known_on_hand)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'active', $5)
       ON CONFLICT (store_id, variant_id, (coalesce(customer_id::text, email)))
       DO UPDATE SET status = 'active',
                     notified_at = NULL,
                     last_known_on_hand = EXCLUDED.last_known_on_hand,
                     updated_at = now()
       RETURNING id::text, status`,
      [
        storeId,
        input.variantId,
        input.customerId ?? null,
        input.email ?? null,
        onHand,
      ]
    );
    const row = rows[0]!;
    return { id: row.id, status: row.status };
  });
}

// ── listSubscriptions ─────────────────────────────────────────────────────

export async function listSubscriptions(
  storeId: string,
  opts: { customerId?: string | undefined } = {}
): Promise<Subscription[]> {
  const db = getReadDb();
  const args: unknown[] = [storeId];
  let filter = "";
  if (opts.customerId) {
    args.push(opts.customerId);
    filter = ` AND customer_id = $2::uuid`;
  }
  const { rows } = await db.query<Subscription>(
    `SELECT id::text, store_id::text, variant_id::text, customer_id::text,
            email, status, last_known_on_hand, notified_at, created_at, updated_at
       FROM back_in_stock_subscriptions
      WHERE store_id = $1::uuid${filter}
      ORDER BY created_at DESC`,
    args
  );
  return rows;
}

// ── cancel ───────────────────────────────────────────────────────────────

/**
 * Cancel a subscription. When customerId is supplied the row must belong to that
 * customer (storefront customers can only cancel their own). Returns true when a
 * row was cancelled.
 */
export async function cancel(
  storeId: string,
  subId: string,
  customerId?: string | undefined
): Promise<boolean> {
  return withTx(async (client) => {
    const args: unknown[] = [storeId, subId];
    let ownerFilter = "";
    if (customerId) {
      args.push(customerId);
      ownerFilter = ` AND customer_id = $3::uuid`;
    }
    const { rowCount } = await client.query(
      `UPDATE back_in_stock_subscriptions
          SET status = 'cancelled', updated_at = now()
        WHERE store_id = $1::uuid
          AND id = $2::uuid
          AND status <> 'cancelled'${ownerFilter}`,
      args
    );
    return (rowCount ?? 0) > 0;
  });
}

// ── processRestocks (worker tick) ────────────────────────────────────────────

interface RestockRow {
  id: string;
  store_id: string;
  variant_id: string;
  customer_id: string | null;
  email: string | null;
  last_known_on_hand: number | null;
  on_hand: number;
  customer_email: string | null;
  product_title: string | null;
  variant_title: string | null;
}

/**
 * Worker tick: find ACTIVE subscriptions whose variant's total on-hand
 * transitioned from <=0 (snapshot in last_known_on_hand, treating NULL as <=0)
 * to >0 (current), notify each subscriber exactly once, and mark them notified.
 *
 * Idempotent:
 *   - notified/cancelled rows are excluded (status = 'active' filter).
 *   - last_known_on_hand is REFRESHED every tick for rows that did NOT fire, so
 *     a subscribe made while in stock never spuriously notifies, and a variant
 *     that stays in stock is not re-evaluated as a transition.
 *   - notify-once: after firing the row is status='notified' and never re-fires.
 *
 * The mailer is injectable via deps for tests; defaults to the module mailer set
 * by the worker. Returns the number of notifications sent.
 */
export async function processRestocks(
  storeId?: string,
  deps: ProcessRestocksDeps = {}
): Promise<number> {
  const clock = deps.clock ?? new SystemClock();
  const mailer = deps.mailer ?? _mailer;
  const now = clock.now();

  const pool = getPool();

  const args: unknown[] = [];
  let storeFilter = "";
  if (storeId) {
    args.push(storeId);
    storeFilter = ` AND s.store_id = $1::uuid`;
  }

  // Current total on-hand per variant computed in a correlated subquery so each
  // active subscription gets its variant's live stock alongside its snapshot.
  const { rows } = await pool.query<RestockRow>(
    `SELECT s.id::text                 AS id,
            s.store_id::text           AS store_id,
            s.variant_id::text         AS variant_id,
            s.customer_id::text        AS customer_id,
            s.email                    AS email,
            s.last_known_on_hand       AS last_known_on_hand,
            COALESCE((SELECT SUM(il.quantity_on_hand) FROM inventory_levels il
                       WHERE il.variant_id = s.variant_id), 0)::int AS on_hand,
            cu.email                   AS customer_email,
            p.title                    AS product_title,
            pv.title                   AS variant_title
       FROM back_in_stock_subscriptions s
       JOIN product_variants pv ON pv.id = s.variant_id
       JOIN products p          ON p.id  = pv.product_id
       LEFT JOIN customers cu   ON cu.id = s.customer_id
      WHERE s.status = 'active'${storeFilter}`,
    args
  );

  let sent = 0;
  for (const row of rows) {
    const prev = row.last_known_on_hand ?? 0;
    const restocked = prev <= 0 && row.on_hand > 0;

    if (!restocked) {
      // Refresh the snapshot so a later genuine transition is detected and an
      // in-stock subscribe never fires on the next tick.
      if (prev !== row.on_hand) {
        await pool.query(
          `UPDATE back_in_stock_subscriptions
              SET last_known_on_hand = $2, updated_at = now()
            WHERE id = $1::uuid AND status = 'active'`,
          [row.id, row.on_hand]
        );
      }
      continue;
    }

    const recipient = row.email ?? row.customer_email;
    if (!recipient) {
      // No deliverable address (customer without email) — mark notified anyway so
      // we don't re-scan it forever; nothing to send.
      await pool.query(
        `UPDATE back_in_stock_subscriptions
            SET status = 'notified', notified_at = $2, last_known_on_hand = $3, updated_at = now()
          WHERE id = $1::uuid AND status = 'active'`,
        [row.id, now, row.on_hand]
      );
      continue;
    }

    try {
      if (mailer) {
        await sendBackInStockEmail(mailer, {
          to: recipient,
          storeId: row.store_id,
          variantId: row.variant_id,
          productTitle: row.product_title,
          variantTitle: row.variant_title,
        });
      } else {
        console.warn("[back-in-stock] no mailer configured — marking notified without sending");
      }
      // Mark notified only after a successful send (or no-mailer no-op). A claim
      // guard (status = 'active') makes the update idempotent under concurrency.
      await pool.query(
        `UPDATE back_in_stock_subscriptions
            SET status = 'notified', notified_at = $2, last_known_on_hand = $3, updated_at = now()
          WHERE id = $1::uuid AND status = 'active'`,
        [row.id, now, row.on_hand]
      );
      sent++;
    } catch (err) {
      // Leave the row active so the next tick retries. Refresh snapshot is NOT
      // done here so the transition still registers next time.
      console.error(
        "[back-in-stock] failed to notify subscription",
        row.id,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return sent;
}

// ── Email ────────────────────────────────────────────────────────────────────

interface BackInStockEmailOpts {
  to: string;
  storeId: string;
  variantId: string;
  productTitle: string | null;
  variantTitle: string | null;
}

async function sendBackInStockEmail(
  mailer: Mailer,
  opts: BackInStockEmailOpts
): Promise<void> {
  const name =
    (opts.productTitle ?? "An item you wanted") +
    (opts.variantTitle ? ` — ${opts.variantTitle}` : "");
  const shopUrl = `${config.FRONTEND_URL}/storefront/${opts.storeId}`;
  const fromEmail = config.EMAIL_FROM ?? "hello@cartcrft.dev";

  const bodyHtml = `
<p>Good news — it's back!</p>
<p><strong>${escapeHtml(name)}</strong> is back in stock. Grab it before it's gone again.</p>
<p><a href="${shopUrl}">Shop now →</a></p>
<p style="color:#888;font-size:12px;">
  You're receiving this because you asked to be notified when this item was restocked.
</p>
`.trim();

  const bodyText = `Good news — it's back!

${name} is back in stock. Grab it before it's gone again.

Shop now: ${shopUrl}
`.trim();

  await mailer.send({
    to: opts.to,
    fromName: "CartCrft",
    fromEmail,
    subject: `Back in stock: ${name}`,
    bodyHtml,
    bodyText,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Module mailer (set by the worker at startup) ─────────────────────────────

let _mailer: Mailer | null = null;

/** Set the default mailer used by processRestocks when deps.mailer is absent. */
export function setBackInStockMailer(mailer: Mailer): void {
  _mailer = mailer;
}
