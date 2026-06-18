/**
 * abandoned-checkout/service.ts — Abandoned-CHECKOUT recovery email service.
 *
 * Distinct from abandoned-CART recovery (modules/recovery): this targets
 * checkouts that were STARTED (checkouts.status = 'pending') but never
 * completed. A shopper who reached the checkout/payment step is a higher-intent
 * recovery target than one who only filled a cart, so they get their own
 * single-send recovery email pointing back at the checkout to resume payment.
 *
 * processAbandonedCheckouts(now, deps?) — find stale pending checkouts that
 * have a contact email (checkouts.email or the linked customer's email) and
 * have NOT been notified yet (recovery_notified_at IS NULL), send one recovery
 * email per checkout, then stamp recovery_notified_at = now (idempotent — sends
 * once). Mailer + Clock are injectable via deps for tests; SQL is parameterized.
 *
 * The worker reads on the owner/BYPASSRLS path (plain getPool()) exactly like
 * the abandoned-cart recovery worker — store scoping is carried on each row.
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { getPool } from "../../db/pool.js";
import type { Mailer } from "../../lib/mailer/index.js";
import { config } from "../../config/config.js";

// ── Defaults ───────────────────────────────────────────────────────────────

/** A pending checkout is "abandoned" once it has been idle this long. */
export const DEFAULT_ABANDONED_CHECKOUT_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Max checkouts processed per worker tick (bounds work + mail volume). */
export const DEFAULT_ABANDONED_CHECKOUT_BATCH = 100;

// ── Injectable mailer singleton (set by worker registration) ─────────────────

let _mailer: Mailer | null = null;

export function setAbandonedCheckoutMailer(m: Mailer): void {
  _mailer = m;
}

export function getAbandonedCheckoutMailer(): Mailer | null {
  return _mailer;
}

// ── Dependency injection surface ─────────────────────────────────────────────

export interface ProcessAbandonedCheckoutsDeps {
  mailer?: Mailer;
  clock?: Clock;
  /** Idle threshold in ms before a pending checkout is eligible. */
  thresholdMs?: number;
  /** Max rows to process this tick. */
  batchSize?: number;
}

interface AbandonedCheckoutCandidate {
  checkout_id: string;
  store_id: string;
  customer_id: string | null;
  email: string;
  currency: string;
  total: string;
}

// ── Worker job ───────────────────────────────────────────────────────────────

/**
 * processAbandonedCheckouts — scan for stale pending checkouts with a contact
 * email that have not been notified, send one recovery email each, stamp
 * recovery_notified_at. Returns the number of emails sent.
 *
 * Eligibility:
 *   - checkouts.status = 'pending'   (NOT completed / abandoned)
 *   - checkouts.updated_at < now - thresholdMs
 *   - a contact email exists (checkouts.email OR the linked customer's email)
 *   - recovery_notified_at IS NULL   (idempotency — send exactly once)
 *
 * @param now   the current instant (also accepts a Clock or deps for ergonomics)
 * @param deps  injectable mailer/clock/threshold/batch
 */
export async function processAbandonedCheckouts(
  now?: Date,
  deps: ProcessAbandonedCheckoutsDeps = {}
): Promise<number> {
  const clock = deps.clock ?? new SystemClock();
  const mailer = deps.mailer ?? _mailer;
  const thresholdMs = deps.thresholdMs ?? DEFAULT_ABANDONED_CHECKOUT_THRESHOLD_MS;
  const batchSize = deps.batchSize ?? DEFAULT_ABANDONED_CHECKOUT_BATCH;
  const at = now ?? clock.now();

  if (!mailer) {
    console.warn("[abandoned-checkout] no mailer configured — skipping job");
    return 0;
  }

  const pool = getPool();
  const cutoff = new Date(at.getTime() - thresholdMs);

  // Find stale pending checkouts with a resolvable contact email that have not
  // yet been notified. Email is the checkout's own email, falling back to the
  // linked customer's email.
  const { rows: candidates } = await pool.query<AbandonedCheckoutCandidate>(
    `SELECT
       ch.id::text          AS checkout_id,
       ch.store_id::text    AS store_id,
       ch.customer_id::text AS customer_id,
       COALESCE(ch.email, cu.email) AS email,
       ch.currency          AS currency,
       ch.total::text       AS total
     FROM checkouts ch
     LEFT JOIN customers cu ON cu.id = ch.customer_id
     WHERE ch.status = 'pending'
       AND ch.recovery_notified_at IS NULL
       AND ch.updated_at < $1
       AND COALESCE(ch.email, cu.email) IS NOT NULL
     ORDER BY ch.updated_at ASC
     LIMIT $2`,
    [cutoff, batchSize]
  );

  let sent = 0;
  for (const candidate of candidates) {
    try {
      // Claim the row first (idempotent guard): only the tick that flips
      // recovery_notified_at from NULL → now sends the email. A concurrent tick
      // (e.g. a replica that slipped past the lock) cannot double-send because
      // the conditional UPDATE matches at most once.
      const { rowCount } = await pool.query(
        // (checkouts has a BEFORE UPDATE set_updated_at trigger, so updated_at
        // is bumped to now() here — that's harmless: recovery_notified_at is the
        // idempotency guard, not updated_at, and the row is now ineligible.)
        `UPDATE checkouts
            SET recovery_notified_at = $1,
                recovery_email_count = recovery_email_count + 1
          WHERE id = $2::uuid
            AND status = 'pending'
            AND recovery_notified_at IS NULL`,
        [at, candidate.checkout_id]
      );
      if ((rowCount ?? 0) === 0) {
        // Already claimed/notified or no longer pending — skip.
        continue;
      }

      await sendRecoveryEmail(mailer, {
        storeId: candidate.store_id,
        checkoutId: candidate.checkout_id,
        email: candidate.email,
        currency: candidate.currency,
        total: candidate.total,
      });

      sent++;
    } catch (err) {
      console.error(
        `[abandoned-checkout] error processing checkout ${candidate.checkout_id}:`,
        err
      );
      // Surface errors in tests so failures aren't silently swallowed.
      if (process.env["APP_ENV"] === "test") throw err;
    }
  }

  return sent;
}

// ── Admin read (optional helper; no route registered this wave) ───────────────

export interface AbandonedCheckoutRow {
  id: string;
  store_id: string;
  email: string | null;
  currency: string;
  total: string;
  updated_at: Date;
  recovery_notified_at: Date | null;
  recovery_email_count: number;
}

/**
 * listAbandonedCheckouts — admin read of pending checkouts for a store, newest
 * idle first. Exposed for callers/tests; no HTTP route is wired this wave (that
 * would require editing app.ts).
 */
export async function listAbandonedCheckouts(
  storeId: string,
  limit = 100
): Promise<AbandonedCheckoutRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<AbandonedCheckoutRow>(
    `SELECT id::text, store_id::text, email, currency, total::text,
            updated_at, recovery_notified_at, recovery_email_count
       FROM checkouts
      WHERE store_id = $1::uuid
        AND status = 'pending'
      ORDER BY updated_at ASC
      LIMIT $2`,
    [storeId, limit]
  );
  return rows;
}

// ── Email builder ─────────────────────────────────────────────────────────────

interface RecoveryEmailOpts {
  storeId: string;
  checkoutId: string;
  email: string;
  currency: string;
  total: string;
}

async function sendRecoveryEmail(
  mailer: Mailer,
  opts: RecoveryEmailOpts
): Promise<void> {
  // Resume link: the storefront checkout page for this checkout. Mirrors the
  // back-in-stock storefront-URL convention (there is no public token-based
  // resume primitive for a raw checkout row, unlike checkout_links' /pay/<token>).
  const resumeUrl = `${config.FRONTEND_URL}/storefront/${opts.storeId}/checkout/${opts.checkoutId}`;
  const fromEmail = config.EMAIL_FROM ?? "hello@cartcrft.dev";
  const totalLabel = `${opts.currency} ${opts.total}`;

  const bodyHtml = `
<p>Hi there,</p>
<p>You started checking out but didn't finish. Your order (total ${escapeHtml(totalLabel)}) is still waiting.</p>
<p><a href="${resumeUrl}">Complete your checkout →</a></p>
<p style="color:#888;font-size:12px;">
  If you no longer wish to complete this purchase, simply ignore this message.
</p>
`.trim();

  const bodyText = `Hi,

You started checking out but didn't finish. Your order (total ${totalLabel}) is still waiting.

Complete your checkout: ${resumeUrl}
`.trim();

  await mailer.send({
    to: opts.email,
    fromName: "CartCrft",
    fromEmail,
    subject: "Complete your checkout",
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
