/**
 * recovery/service.ts — Abandoned-cart recovery email service.
 *
 * Responsibilities:
 *  1. Worker job: scan for carts that are active + older than threshold, upsert
 *     an abandoned_carts row with recovery_token, send one recovery email per
 *     cart (idempotent: skip if last_notified_at is set).
 *  2. getCartByRecoveryToken — public; resolves a token → cart + lines.
 *  3. markRecoveredAt — called when a recovered cart completes checkout.
 *  4. resendRecoveryEmail — admin; re-send the email for an existing
 *     abandoned_carts row.
 *
 * Clock-injected so SimClock works in tests.
 */

import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import { getPool } from "../../db/pool.js";
import type { Mailer } from "../../lib/mailer/index.js";
import { config } from "../../config/config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AbandonedCartRow {
  id: string;
  store_id: string;
  cart_id: string;
  customer_id: string | null;
  email: string | null;
  abandoned_at: Date;
  recovery_token: string;
  recovered_at: Date | null;
  recovery_order_id: string | null;
  last_notified_at: Date | null;
  notification_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface RecoveryCart {
  id: string;
  store_id: string;
  currency: string;
  status: string;
  lines: RecoveryCartLine[];
}

export interface RecoveryCartLine {
  id: string;
  variant_id: string;
  quantity: number;
  price: string;
  sku: string | null;
  variant_title: string | null;
  product_title: string | null;
}

// ── Default threshold: 1 hour ─────────────────────────────────────────────────

export const DEFAULT_ABANDONED_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// ── Singleton mailer (set by worker registration) ────────────────────────────

let _mailer: Mailer | null = null;

export function setMailer(m: Mailer): void {
  _mailer = m;
}

export function getMailer(): Mailer | null {
  return _mailer;
}

// ── Worker job ────────────────────────────────────────────────────────────────

/**
 * processAbandonedCarts — find eligible abandoned carts, upsert recovery rows,
 * send one email per cart (idempotent).
 *
 * Eligibility:
 *   - carts.status = 'active'
 *   - carts.updated_at < now() - thresholdMs
 *   - An email is obtainable (customer.email or checkout's email field, stored
 *     via the checkout's contact_email or customers.email)
 *   - No email sent yet (last_notified_at IS NULL in abandoned_carts) —
 *     prevents re-sending on subsequent worker runs.
 */
export async function processAbandonedCarts(opts: {
  clock?: Clock;
  mailer?: Mailer;
  thresholdMs?: number;
}): Promise<number> {
  const clock = opts.clock ?? new SystemClock();
  const mailer = opts.mailer ?? _mailer;
  const thresholdMs = opts.thresholdMs ?? DEFAULT_ABANDONED_THRESHOLD_MS;

  if (!mailer) {
    console.warn("[recovery] no mailer configured — skipping recovery job");
    return 0;
  }

  const pool = getPool();
  const now = clock.now();
  const cutoff = new Date(now.getTime() - thresholdMs);

  // Find active carts older than the threshold that have an email available.
  // Email comes from: customers.email (if customer is attached) OR
  // checkouts.contact_email (if a checkout was started).
  const { rows: candidates } = await pool.query<{
    cart_id: string;
    store_id: string;
    customer_id: string | null;
    email: string | null;
  }>(
    `SELECT
       c.id::text         AS cart_id,
       c.store_id::text   AS store_id,
       c.customer_id::text AS customer_id,
       COALESCE(cu.email, ch.email) AS email
     FROM carts c
     LEFT JOIN customers cu ON cu.id = c.customer_id
     LEFT JOIN LATERAL (
       SELECT email FROM checkouts
       WHERE cart_id = c.id AND email IS NOT NULL
       ORDER BY created_at DESC LIMIT 1
     ) ch ON true
     WHERE c.status = 'active'
       AND c.updated_at < $1
       AND COALESCE(cu.email, ch.email) IS NOT NULL`,
    [cutoff]
  );

  let sent = 0;
  for (const candidate of candidates) {
    try {
      const token = await upsertAbandonedCart(
        candidate.store_id,
        candidate.cart_id,
        candidate.customer_id,
        candidate.email!
      );
      if (token === null) {
        // Already notified — skip
        continue;
      }

      // Fetch cart lines for the email body
      const cart = await getCartByRecoveryToken(candidate.store_id, token);
      if (!cart) continue;

      await sendRecoveryEmail(mailer, {
        storeId: candidate.store_id,
        cartId: candidate.cart_id,
        email: candidate.email!,
        recoveryToken: token,
        lines: cart.lines,
        currency: cart.currency,
        now,
      });

      // Mark last_notified_at
      await pool.query(
        `UPDATE abandoned_carts
         SET last_notified_at = $1, notification_count = notification_count + 1, updated_at = $1
         WHERE cart_id = $2::uuid`,
        [now, candidate.cart_id]
      );

      sent++;
    } catch (err) {
      console.error(`[recovery] error processing cart ${candidate.cart_id}:`, err);
      // Re-throw in test mode so tests can see errors
      if (process.env["APP_ENV"] === "test") throw err;
    }
  }

  return sent;
}

/**
 * Upsert an abandoned_carts row.
 * Returns the recovery_token if this is the first time (last_notified_at IS NULL).
 * Returns null if we already sent an email (idempotent — don't spam).
 */
export async function upsertAbandonedCart(
  storeId: string,
  cartId: string,
  customerId: string | null,
  email: string
): Promise<string | null> {
  const pool = getPool();

  // Upsert the row; on conflict (cart_id) update email/customer if not set.
  const { rows } = await pool.query<{
    recovery_token: string;
    last_notified_at: Date | null;
  }>(
    `INSERT INTO abandoned_carts (store_id, cart_id, customer_id, email)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
     ON CONFLICT (cart_id) DO UPDATE
       SET customer_id      = COALESCE(EXCLUDED.customer_id, abandoned_carts.customer_id),
           email            = COALESCE(EXCLUDED.email, abandoned_carts.email),
           updated_at       = now()
     RETURNING recovery_token, last_notified_at`,
    [storeId, cartId, customerId, email]
  );

  const row = rows[0];
  if (!row) return null;

  // If we already notified, return null so caller skips sending.
  if (row.last_notified_at !== null) return null;

  return row.recovery_token;
}

// ── Public: resolve token → cart ─────────────────────────────────────────────

export async function getCartByRecoveryToken(
  storeId: string,
  token: string
): Promise<RecoveryCart | null> {
  const pool = getPool();

  const { rows: acRows } = await pool.query<{ cart_id: string }>(
    `SELECT cart_id::text FROM abandoned_carts
     WHERE recovery_token = $1 AND store_id = $2::uuid`,
    [token, storeId]
  );
  if (!acRows[0]) return null;
  const cartId = acRows[0].cart_id;

  const { rows: cartRows } = await pool.query<{
    id: string;
    store_id: string;
    currency: string;
    status: string;
  }>(
    `SELECT id::text, store_id::text, currency, status
     FROM carts WHERE id = $1::uuid AND store_id = $2::uuid`,
    [cartId, storeId]
  );
  if (!cartRows[0]) return null;
  const cart = cartRows[0];

  const { rows: lineRows } = await pool.query<RecoveryCartLine>(
    `SELECT cl.id::text, cl.variant_id::text,
            cl.quantity, cl.price::text, cl.metadata,
            pv.sku, pv.title AS variant_title, p.title AS product_title
     FROM cart_lines cl
     JOIN product_variants pv ON pv.id = cl.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE cl.cart_id = $1::uuid
     ORDER BY cl.created_at`,
    [cartId]
  );

  return {
    id: cart.id,
    store_id: cart.store_id,
    currency: cart.currency,
    status: cart.status,
    lines: lineRows,
  };
}

// ── Admin: resend recovery email ──────────────────────────────────────────────

export async function resendRecoveryEmail(
  storeId: string,
  abandonedCartId: string,
  mailer?: Mailer
): Promise<{ ok: boolean; message: string }> {
  const pool = getPool();
  const { rows } = await pool.query<AbandonedCartRow>(
    `SELECT id::text, store_id::text, cart_id::text, customer_id::text,
            email, recovery_token, recovered_at, notification_count,
            last_notified_at, abandoned_at, created_at, updated_at
     FROM abandoned_carts
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [abandonedCartId, storeId]
  );
  const row = rows[0];
  if (!row) {
    const e = new Error("abandoned cart not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }

  // Check mailer AFTER confirming the row exists (so NOT_FOUND beats RESEND_FAILED)
  const m = mailer ?? _mailer;
  if (!m) {
    return { ok: false, message: "no mailer configured" };
  }

  if (!row.email) {
    return { ok: false, message: "no email address for this abandoned cart" };
  }

  const cart = await getCartByRecoveryToken(storeId, row.recovery_token);
  if (!cart) {
    return { ok: false, message: "cart no longer exists" };
  }

  const now = new Date();
  await sendRecoveryEmail(m, {
    storeId,
    cartId: row.cart_id,
    email: row.email,
    recoveryToken: row.recovery_token,
    lines: cart.lines,
    currency: cart.currency,
    now,
  });

  // Increment notification_count + last_notified_at
  await pool.query(
    `UPDATE abandoned_carts
     SET last_notified_at = $1, notification_count = notification_count + 1, updated_at = $1
     WHERE id = $2::uuid AND store_id = $3::uuid`,
    [now, abandonedCartId, storeId]
  );

  return { ok: true, message: "recovery email sent" };
}

// ── Mark recovered_at (call after checkout completes for a recovered cart) ─────

export async function markAbandonedCartRecovered(
  storeId: string,
  cartId: string,
  orderId?: string | null
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE abandoned_carts
     SET recovered_at = now(),
         recovery_order_id = $3::uuid,
         updated_at = now()
     WHERE cart_id = $1::uuid
       AND store_id = $2::uuid
       AND recovered_at IS NULL`,
    [cartId, storeId, orderId ?? null]
  );
  return (rowCount ?? 0) > 0;
}

// ── Email builder ─────────────────────────────────────────────────────────────

interface RecoveryEmailOpts {
  storeId: string;
  cartId: string;
  email: string;
  recoveryToken: string;
  lines: RecoveryCartLine[];
  currency: string;
  now: Date;
}

async function sendRecoveryEmail(
  mailer: Mailer,
  opts: RecoveryEmailOpts
): Promise<void> {
  const recoveryUrl = `${config.FRONTEND_URL}/cart/recover/${opts.recoveryToken}`;

  const itemsHtml = opts.lines
    .map(
      (l) =>
        `<li>${l.product_title ?? "Product"}` +
        (l.variant_title ? ` — ${l.variant_title}` : "") +
        ` × ${l.quantity} @ ${opts.currency} ${l.price}</li>`
    )
    .join("\n");

  const itemsText = opts.lines
    .map(
      (l) =>
        `- ${l.product_title ?? "Product"}` +
        (l.variant_title ? ` (${l.variant_title})` : "") +
        ` x${l.quantity} @ ${opts.currency} ${l.price}`
    )
    .join("\n");

  const bodyHtml = `
<p>Hi there,</p>
<p>You left some items in your cart. Come back and complete your purchase!</p>
<ul>
${itemsHtml}
</ul>
<p><a href="${recoveryUrl}">Resume your cart →</a></p>
<p style="color:#888;font-size:12px;">
  If you no longer wish to receive these emails, simply ignore this message.
</p>
`.trim();

  const bodyText = `Hi,

You left some items in your cart. Come back and complete your purchase!

${itemsText}

Resume your cart: ${recoveryUrl}
`.trim();

  const fromEmail = config.EMAIL_FROM ?? "hello@cartcrft.dev";

  await mailer.send({
    to: opts.email,
    fromName: "Cartcrft",
    fromEmail,
    subject: "You left something behind",
    bodyHtml,
    bodyText,
  });
}
