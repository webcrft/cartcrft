/**
 * subscriptions/service.ts — SQL-backed subscription plans and subscriptions.
 *
 * Key behaviors:
 *  - Plans: CRUD with interval/interval_count/trial_days
 *  - Create subscription: calculates trial period if trial_days > 0
 *  - Pause/Resume: status transitions; resume recalculates next_billing_at
 *  - Cancel: sets cancelled_at + cancel_reason; status = 'cancelled'
 *  - Bill: creates an order for the current period using Clock.now() so
 *    billingsim time compression works. Advances current_period_* and
 *    next_billing_at. Records subscription_orders link.
 *  - Past-due: if billing fails (caught by caller), sets status = 'past_due'
 *
 * The `clock` parameter defaults to SystemClock but can be overridden in
 * tests via SimClock injection.
 */

import { getPool, withTx } from "../../db/pool.js";
import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import type {
  SubscriptionPlan,
  CreateSubscriptionPlanInput,
  UpdateSubscriptionPlanInput,
  Subscription,
  CreateSubscriptionInput,
  BillSubscriptionResult,
} from "./types.js";

// ── Next billing date ─────────────────────────────────────────────────────────

/**
 * Calculate the next billing date from a given start time, interval, and count.
 * Mirrors nextBillingDate() from commerce_subscriptions.go.
 */
export function nextBillingDate(
  from: Date,
  interval: string,
  count: number
): Date {
  const d = new Date(from);
  switch (interval) {
    case "day":
      d.setDate(d.getDate() + count);
      break;
    case "week":
      d.setDate(d.getDate() + 7 * count);
      break;
    case "month":
      d.setMonth(d.getMonth() + count);
      break;
    case "year":
      d.setFullYear(d.getFullYear() + count);
      break;
    default:
      d.setMonth(d.getMonth() + 1);
  }
  return d;
}

// ── Subscription Plans ────────────────────────────────────────────────────────

export async function listSubscriptionPlans(
  storeId: string
): Promise<SubscriptionPlan[]> {
  const pool = getPool();
  const { rows } = await pool.query<SubscriptionPlan>(
    `SELECT id::text, store_id::text, name, interval, interval_count, trial_days, is_active, created_at
     FROM subscription_plans WHERE store_id = $1::uuid ORDER BY name`,
    [storeId]
  );
  return rows;
}

export async function getSubscriptionPlan(
  storeId: string,
  planId: string
): Promise<SubscriptionPlan | null> {
  const pool = getPool();
  const { rows } = await pool.query<SubscriptionPlan>(
    `SELECT id::text, store_id::text, name, interval, interval_count, trial_days, is_active, created_at
     FROM subscription_plans WHERE id = $1::uuid AND store_id = $2::uuid`,
    [planId, storeId]
  );
  return rows[0] ?? null;
}

export async function createSubscriptionPlan(
  storeId: string,
  input: CreateSubscriptionPlanInput
): Promise<string> {
  const pool = getPool();
  const intervalCount = Math.max(1, input.interval_count ?? 1);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO subscription_plans (store_id, name, interval, interval_count, trial_days, is_active)
     VALUES ($1::uuid, $2, $3, $4, COALESCE($5, 0), COALESCE($6, true)) RETURNING id::text`,
    [storeId, input.name, input.interval, intervalCount, input.trial_days ?? null, input.is_active ?? null]
  );
  if (!rows[0]) throw new Error("createSubscriptionPlan: no row returned");
  return rows[0].id;
}

export async function updateSubscriptionPlan(
  storeId: string,
  planId: string,
  input: UpdateSubscriptionPlanInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE subscription_plans SET
       name       = COALESCE($3, name),
       trial_days = COALESCE($4, trial_days),
       is_active  = COALESCE($5, is_active)
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [planId, storeId, input.name ?? null, input.trial_days ?? null, input.is_active ?? null]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteSubscriptionPlan(
  storeId: string,
  planId: string
): Promise<void> {
  const pool = getPool();
  // Soft-delete: mark inactive (plans may have active subscriptions)
  await pool.query(
    `UPDATE subscription_plans SET is_active = false
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [planId, storeId]
  );
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export async function listSubscriptions(
  storeId: string,
  opts: {
    status?: string | undefined;
    customer_id?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
): Promise<{ subscriptions: unknown[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions: string[] = ["s.store_id = $1::uuid"];
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.status) {
    conditions.push(`s.status = $${argN++}`);
    args.push(opts.status);
  }
  if (opts.customer_id) {
    conditions.push(`s.customer_id = $${argN++}::uuid`);
    args.push(opts.customer_id);
  }

  const where = conditions.join(" AND ");
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE ${where}`,
    args
  );
  const total = parseInt(countRows[0]?.count ?? "0", 10);

  const { rows } = await pool.query(
    `SELECT s.id::text, s.store_id::text, s.customer_id::text, s.plan_id::text,
            s.status, s.current_period_start, s.current_period_end, s.next_billing_at,
            s.trial_ends_at, s.cancelled_at, s.cancel_reason, s.created_at, s.updated_at,
            sp.name AS plan_name, sp.interval, sp.interval_count
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE ${where}
     ORDER BY s.created_at DESC LIMIT $${argN} OFFSET $${argN + 1}`,
    [...args, limit, offset]
  );
  return { subscriptions: rows, total };
}

export async function getSubscription(
  storeId: string,
  subId: string
): Promise<Subscription | null> {
  const pool = getPool();
  const { rows } = await pool.query<Subscription>(
    `SELECT s.id::text, s.store_id::text, s.customer_id::text, s.plan_id::text,
            s.status, s.current_period_start, s.current_period_end,
            s.next_billing_at, s.trial_ends_at, s.cancelled_at, s.cancel_reason,
            s.created_at, s.updated_at,
            sp.name AS plan_name, sp.interval, sp.interval_count
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE s.id = $1::uuid AND s.store_id = $2::uuid`,
    [subId, storeId]
  );
  if (!rows[0]) return null;
  const sub = rows[0];

  const { rows: itemRows } = await pool.query(
    `SELECT si.id::text, si.subscription_id::text, si.variant_id::text,
            si.quantity, si.price::text,
            pv.sku, p.title AS product_title
     FROM subscription_items si
     JOIN product_variants pv ON pv.id = si.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE si.subscription_id = $1::uuid`,
    [subId]
  );
  sub.items = itemRows;

  const { rows: orderRows } = await pool.query(
    `SELECT so.order_id::text, so.billing_period, o.order_number, o.total::text, o.created_at
     FROM subscription_orders so
     JOIN orders o ON o.id = so.order_id
     WHERE so.subscription_id = $1::uuid ORDER BY so.billing_period DESC LIMIT 10`,
    [subId]
  );
  sub.orders = orderRows;

  return sub;
}

export async function createSubscription(
  storeId: string,
  input: CreateSubscriptionInput,
  clock: Clock = new SystemClock()
): Promise<{ id: string; status: string; next_billing_at: Date }> {
  const pool = getPool();

  // Load plan
  const { rows: planRows } = await pool.query<{
    interval: string;
    interval_count: number;
    trial_days: number;
  }>(
    `SELECT interval, interval_count, trial_days FROM subscription_plans
     WHERE id = $1::uuid AND store_id = $2::uuid AND is_active = true`,
    [input.plan_id, storeId]
  );
  if (!planRows[0]) {
    const e = new Error("subscription plan not found or inactive");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }
  const { interval, interval_count: intervalCount, trial_days: trialDays } = planRows[0];

  const now = clock.now();
  let trialEndsAt: Date | null = null;
  let periodStart = now;

  if (trialDays > 0) {
    trialEndsAt = new Date(now);
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);
    periodStart = trialEndsAt;
  }

  const periodEnd = nextBillingDate(periodStart, interval, intervalCount);
  const nextBilling = periodEnd;
  const status = trialDays > 0 ? "trialing" : "active";

  return withTx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO subscriptions
         (store_id, customer_id, plan_id, status,
          current_period_start, current_period_end, next_billing_at, trial_ends_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8) RETURNING id::text`,
      [storeId, input.customer_id, input.plan_id, status, periodStart, periodEnd, nextBilling, trialEndsAt]
    );
    if (!rows[0]) throw new Error("createSubscription: no row returned");
    const subId = rows[0].id;

    if (input.items && input.items.length > 0) {
      for (const item of input.items) {
        const qty = Math.max(1, item.quantity ?? 1);
        await client.query(
          `INSERT INTO subscription_items (subscription_id, variant_id, quantity, price)
           VALUES ($1::uuid, $2::uuid, $3, $4::numeric)`,
          [subId, item.variant_id, qty, item.price]
        );
      }
    }

    return { id: subId, status, next_billing_at: nextBilling };
  });
}

export async function pauseSubscription(
  storeId: string,
  subId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE subscriptions SET status = 'paused', updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND status IN ('active', 'trialing')`,
    [subId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

export async function resumeSubscription(
  storeId: string,
  subId: string,
  clock: Clock = new SystemClock()
): Promise<{ next_billing_at: Date } | null> {
  const pool = getPool();

  // Load plan info
  const { rows: planRows } = await pool.query<{
    interval: string;
    interval_count: number;
  }>(
    `SELECT sp.interval, sp.interval_count
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE s.id = $1::uuid AND s.store_id = $2::uuid AND s.status = 'paused'`,
    [subId, storeId]
  );
  if (!planRows[0]) return null;

  const { interval, interval_count: intervalCount } = planRows[0];
  const nextBilling = nextBillingDate(clock.now(), interval, intervalCount);

  const { rowCount } = await pool.query(
    `UPDATE subscriptions SET status = 'active', next_billing_at = $3, updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [subId, storeId, nextBilling]
  );
  if ((rowCount ?? 0) === 0) return null;
  return { next_billing_at: nextBilling };
}

export async function cancelSubscription(
  storeId: string,
  subId: string,
  cancelReason?: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE subscriptions
     SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND status NOT IN ('cancelled', 'expired')`,
    [subId, storeId, cancelReason ?? null]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Bill a subscription — creates an order for the current period, links it via
 * subscription_orders, and advances the period dates using clock.now().
 *
 * If billing fails (e.g., payment error caught by caller), the caller should
 * call setSubscriptionPastDue() to mark it as past_due and record the attempt.
 */
export async function billSubscription(
  storeId: string,
  subId: string,
  clock: Clock = new SystemClock()
): Promise<BillSubscriptionResult> {
  const pool = getPool();

  // Load subscription and plan — must be active
  const { rows: subRows } = await pool.query<{
    customer_id: string;
    interval: string;
    interval_count: number;
  }>(
    `SELECT s.customer_id::text, sp.interval, sp.interval_count
     FROM subscriptions s
     JOIN subscription_plans sp ON sp.id = s.plan_id
     WHERE s.id = $1::uuid AND s.store_id = $2::uuid AND s.status = 'active'`,
    [subId, storeId]
  );
  if (!subRows[0]) {
    const e = new Error("subscription not found or not active");
    (e as NodeJS.ErrnoException).code = "INVALID_TRANSITION";
    throw e;
  }
  const { customer_id: customerId, interval, interval_count: intervalCount } = subRows[0];

  // Get items total
  const { rows: sumRows } = await pool.query<{ subtotal: string }>(
    `SELECT COALESCE(SUM(price * quantity), 0)::text AS subtotal
     FROM subscription_items WHERE subscription_id = $1::uuid`,
    [subId]
  );
  const subtotal = sumRows[0]?.subtotal ?? "0";

  const { rows: storeRows } = await pool.query<{ currency: string }>(
    `SELECT currency FROM stores WHERE id = $1::uuid`,
    [storeId]
  );
  const currency = storeRows[0]?.currency ?? "USD";

  // Billing period count (1-based)
  const { rows: periodRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM subscription_orders WHERE subscription_id = $1::uuid`,
    [subId]
  );
  const billingPeriod = parseInt(periodRows[0]?.count ?? "0", 10) + 1;

  return withTx(async (client) => {
    const { rows: numRows } = await client.query<{ next_order_number: string }>(
      `SELECT next_order_number($1::uuid)`,
      [storeId]
    );
    const orderNumber = numRows[0]?.next_order_number ?? "ORDER-1";

    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, order_number, status, financial_status, fulfillment_status,
          currency, subtotal, total, source_name)
       VALUES ($1::uuid, $2::uuid, $3, 'open', 'pending', 'unfulfilled', $4, $5::numeric, $5::numeric, 'subscription')
       RETURNING id::text`,
      [storeId, customerId, orderNumber, currency, subtotal]
    );
    if (!orderRows[0]) throw new Error("billSubscription: failed to create order");
    const orderId = orderRows[0].id;

    // Insert order lines from subscription items
    await client.query(
      `INSERT INTO order_lines (order_id, variant_id, title, sku, quantity, price, total)
       SELECT $1::uuid, si.variant_id,
              COALESCE(pv.title, p.title, 'Subscription item'),
              COALESCE(pv.sku, ''),
              si.quantity, si.price, si.price * si.quantity
       FROM subscription_items si
       JOIN product_variants pv ON pv.id = si.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE si.subscription_id = $2::uuid`,
      [orderId, subId]
    );

    await client.query(
      `INSERT INTO subscription_orders (subscription_id, order_id, billing_period)
       VALUES ($1::uuid, $2::uuid, $3)`,
      [subId, orderId, billingPeriod]
    );

    // Advance period using clock.now()
    const now = clock.now();
    const nextBilling = nextBillingDate(now, interval, intervalCount);

    await client.query(
      `UPDATE subscriptions SET
         current_period_start = $2,
         current_period_end   = $3,
         next_billing_at      = $3,
         updated_at           = now()
       WHERE id = $1::uuid`,
      [subId, now, nextBilling]
    );

    return {
      order_id: orderId,
      order_number: orderNumber,
      billing_period: billingPeriod,
      next_billing_at: nextBilling,
    };
  });
}

/**
 * Mark a subscription as past_due after a failed billing attempt.
 * Records the attempt in subscription_billing_attempts if the table exists.
 */
export async function setSubscriptionPastDue(
  storeId: string,
  subId: string,
  errorMessage: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE subscriptions SET status = 'past_due', updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND status = 'active'`,
    [subId, storeId]
  );
  // Best-effort: record the failed billing attempt
  try {
    await pool.query(
      `INSERT INTO subscription_billing_attempts (subscription_id, error_message)
       VALUES ($1::uuid, $2)`,
      [subId, errorMessage]
    );
  } catch {
    // Table may not exist; ignore
  }
}
