/**
 * modules/superadmin/service.ts — Cross-tenant queries for the platform operator.
 *
 * IMPORTANT: every function here runs via getPool() WITHOUT setRequestCtx().
 * That means queries execute as the owner role (BYPASSRLS) and intentionally
 * see across ALL organizations/stores/customers. This is the super-admin's
 * god-mode read path. Access control + audit is enforced by requireSuperAdmin
 * and the route handlers (which call auditRequest()).
 *
 * Cartcrft has no `organizations` table — organization_id is a plain uuid on
 * stores. "Orgs" are therefore derived by aggregating stores grouped by
 * organization_id.
 *
 * Cloud billing tables (billing_subscriptions, billing_invoices, …) only exist
 * when the cloud migrations are applied. Every billing read is guarded with
 * to_regclass() so the OSS/base schema degrades gracefully to null/zero.
 */

import { getPool } from "../../db/pool.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns true if a table exists in the current search_path. */
async function tableExists(name: string): Promise<boolean> {
  const { rows } = await getPool().query<{ reg: string | null }>(
    `SELECT to_regclass($1) AS reg`,
    [name]
  );
  return rows[0]?.reg != null;
}

function likeParam(q: string | undefined): string | null {
  if (!q || q.trim() === "") return null;
  return `%${q.trim()}%`;
}

// ── Orgs (derived from stores.organization_id) ───────────────────────────────

export interface OrgSummary {
  organizationId: string;
  storeCount: number;
  orderCount: number;
  gmv: string;
  firstStoreCreatedAt: string | null;
}

export async function listOrgs(opts: { search?: string | undefined; limit?: number | undefined; offset?: number | undefined }): Promise<{ items: OrgSummary[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const search = likeParam(opts.search);

  // total distinct orgs
  const totalRes = await pool.query<{ count: string }>(
    `SELECT count(DISTINCT organization_id)::text AS count
       FROM stores
      WHERE ($1::text IS NULL OR organization_id::text ILIKE $1)`,
    [search]
  );

  const { rows } = await pool.query<{
    organization_id: string;
    store_count: string;
    order_count: string;
    gmv: string;
    first_store_created_at: string | null;
  }>(
    `SELECT s.organization_id::text AS organization_id,
            count(DISTINCT s.id)::text AS store_count,
            count(o.id)::text AS order_count,
            coalesce(sum(o.total), 0)::text AS gmv,
            min(s.created_at)::text AS first_store_created_at
       FROM stores s
       LEFT JOIN orders o ON o.store_id = s.id
      WHERE ($1::text IS NULL OR s.organization_id::text ILIKE $1)
      GROUP BY s.organization_id
      ORDER BY min(s.created_at) DESC
      LIMIT $2 OFFSET $3`,
    [search, limit, offset]
  );

  return {
    total: Number(totalRes.rows[0]?.count ?? 0),
    items: rows.map((r) => ({
      organizationId: r.organization_id,
      storeCount: Number(r.store_count),
      orderCount: Number(r.order_count),
      gmv: r.gmv,
      firstStoreCreatedAt: r.first_store_created_at,
    })),
  };
}

export interface OrgDetail {
  organizationId: string;
  stores: Array<{ id: string; name: string; slug: string; isActive: boolean; takenDownAt: string | null; createdAt: string }>;
  customerCount: number;
  orderCount: number;
  gmv: string;
  billing: BillingStatus | null;
}

export interface BillingStatus {
  subscriptionStatus: string | null;
  tierId: string | null;
  currentPeriodEnd: string | null;
  outstandingAmountCents: number | null;
}

async function getBillingForOrg(orgId: string): Promise<BillingStatus | null> {
  if (!(await tableExists("billing_subscriptions"))) return null;
  const { rows } = await getPool().query<{
    status: string;
    tier_id: string;
    current_period_end: string | null;
    outstanding_amount_cents: number;
  }>(
    `SELECT status, tier_id::text, current_period_end::text, outstanding_amount_cents
       FROM billing_subscriptions
      WHERE organization_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId]
  );
  const r = rows[0];
  if (!r) return { subscriptionStatus: null, tierId: null, currentPeriodEnd: null, outstandingAmountCents: null };
  return {
    subscriptionStatus: r.status,
    tierId: r.tier_id,
    currentPeriodEnd: r.current_period_end,
    outstandingAmountCents: r.outstanding_amount_cents,
  };
}

export async function getOrgDetail(orgId: string): Promise<OrgDetail | null> {
  const pool = getPool();
  const storesRes = await pool.query<{
    id: string;
    name: string;
    slug: string;
    is_active: boolean;
    taken_down_at: string | null;
    created_at: string;
  }>(
    `SELECT id::text, name, slug, is_active, taken_down_at::text, created_at::text
       FROM stores WHERE organization_id = $1::uuid ORDER BY created_at ASC`,
    [orgId]
  );
  if (storesRes.rows.length === 0) return null;

  const aggRes = await pool.query<{ customer_count: string; order_count: string; gmv: string }>(
    `SELECT
       (SELECT count(*) FROM customers c JOIN stores s ON s.id = c.store_id WHERE s.organization_id = $1::uuid)::text AS customer_count,
       (SELECT count(*) FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.organization_id = $1::uuid)::text AS order_count,
       (SELECT coalesce(sum(o.total),0) FROM orders o JOIN stores s ON s.id = o.store_id WHERE s.organization_id = $1::uuid)::text AS gmv`,
    [orgId]
  );
  const agg = aggRes.rows[0]!;
  const billing = await getBillingForOrg(orgId);

  return {
    organizationId: orgId,
    stores: storesRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      isActive: r.is_active,
      takenDownAt: r.taken_down_at,
      createdAt: r.created_at,
    })),
    customerCount: Number(agg.customer_count),
    orderCount: Number(agg.order_count),
    gmv: agg.gmv,
    billing,
  };
}

// ── Stores (all orgs) ────────────────────────────────────────────────────────

export interface StoreListItem {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  currency: string;
  isActive: boolean;
  takenDownAt: string | null;
  orderCount: number;
  gmv: string;
  createdAt: string;
}

export async function listStores(opts: { search?: string | undefined; orgId?: string | undefined; active?: boolean | undefined; limit?: number | undefined; offset?: number | undefined }): Promise<{ items: StoreListItem[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const search = likeParam(opts.search);
  const orgId = opts.orgId ?? null;
  const active = opts.active ?? null;

  const totalRes = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM stores s
      WHERE ($1::text IS NULL OR s.name ILIKE $1 OR s.slug ILIKE $1 OR s.id::text ILIKE $1)
        AND ($2::uuid IS NULL OR s.organization_id = $2::uuid)
        AND ($3::boolean IS NULL OR s.is_active = $3::boolean)`,
    [search, orgId, active]
  );

  const { rows } = await pool.query<{
    id: string;
    organization_id: string;
    name: string;
    slug: string;
    currency: string;
    is_active: boolean;
    taken_down_at: string | null;
    order_count: string;
    gmv: string;
    created_at: string;
  }>(
    `SELECT s.id::text, s.organization_id::text, s.name, s.slug, s.currency,
            s.is_active, s.taken_down_at::text,
            count(o.id)::text AS order_count,
            coalesce(sum(o.total),0)::text AS gmv,
            s.created_at::text
       FROM stores s
       LEFT JOIN orders o ON o.store_id = s.id
      WHERE ($1::text IS NULL OR s.name ILIKE $1 OR s.slug ILIKE $1 OR s.id::text ILIKE $1)
        AND ($2::uuid IS NULL OR s.organization_id = $2::uuid)
        AND ($3::boolean IS NULL OR s.is_active = $3::boolean)
      GROUP BY s.id
      ORDER BY s.created_at DESC
      LIMIT $4 OFFSET $5`,
    [search, orgId, active, limit, offset]
  );

  return {
    total: Number(totalRes.rows[0]?.count ?? 0),
    items: rows.map((r) => ({
      id: r.id,
      organizationId: r.organization_id,
      name: r.name,
      slug: r.slug,
      currency: r.currency,
      isActive: r.is_active,
      takenDownAt: r.taken_down_at,
      orderCount: Number(r.order_count),
      gmv: r.gmv,
      createdAt: r.created_at,
    })),
  };
}

export async function getStoreDetail(storeId: string): Promise<Record<string, unknown> | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT s.id::text, s.organization_id::text AS organization_id, s.name, s.slug, s.currency,
            s.timezone, s.country_code, s.email, s.domain, s.is_active,
            s.taken_down_at::text AS taken_down_at, s.taken_down_reason, s.created_at::text AS created_at,
            (SELECT count(*) FROM products p WHERE p.store_id = s.id)::int AS product_count,
            (SELECT count(*) FROM customers c WHERE c.store_id = s.id)::int AS customer_count,
            (SELECT count(*) FROM orders o WHERE o.store_id = s.id)::int AS order_count,
            (SELECT coalesce(sum(o.total),0) FROM orders o WHERE o.store_id = s.id)::text AS gmv
       FROM stores s WHERE s.id = $1::uuid`,
    [storeId]
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

// ── Customers (all stores) ───────────────────────────────────────────────────

export interface CustomerListItem {
  id: string;
  storeId: string;
  organizationId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: string;
}

export async function listCustomers(opts: { search?: string | undefined; storeId?: string | undefined; limit?: number | undefined; offset?: number | undefined }): Promise<{ items: CustomerListItem[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const search = likeParam(opts.search);
  const storeId = opts.storeId ?? null;

  const totalRes = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM customers c
      WHERE ($1::text IS NULL OR c.email ILIKE $1)
        AND ($2::uuid IS NULL OR c.store_id = $2::uuid)`,
    [search, storeId]
  );

  const { rows } = await pool.query<{
    id: string;
    store_id: string;
    organization_id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    created_at: string;
  }>(
    `SELECT c.id::text, c.store_id::text, s.organization_id::text AS organization_id,
            c.email, c.first_name, c.last_name, c.created_at::text
       FROM customers c JOIN stores s ON s.id = c.store_id
      WHERE ($1::text IS NULL OR c.email ILIKE $1)
        AND ($2::uuid IS NULL OR c.store_id = $2::uuid)
      ORDER BY c.created_at DESC
      LIMIT $3 OFFSET $4`,
    [search, storeId, limit, offset]
  );

  return {
    total: Number(totalRes.rows[0]?.count ?? 0),
    items: rows.map((r) => ({
      id: r.id,
      storeId: r.store_id,
      organizationId: r.organization_id,
      email: r.email,
      firstName: r.first_name,
      lastName: r.last_name,
      createdAt: r.created_at,
    })),
  };
}

// ── System analytics ─────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  totalOrgs: number;
  totalStores: number;
  totalCustomers: number;
  totalOrders: number;
  gmv: string;
  revenueCents: number | null;
  activeStores30d: number;
  newStores30d: number;
  newOrders30d: number;
  newCustomers30d: number;
}

export async function analyticsOverview(): Promise<AnalyticsOverview> {
  const pool = getPool();
  const { rows } = await pool.query<{
    total_orgs: string;
    total_stores: string;
    total_customers: string;
    total_orders: string;
    gmv: string;
    active_stores_30d: string;
    new_stores_30d: string;
    new_orders_30d: string;
    new_customers_30d: string;
  }>(
    `SELECT
       (SELECT count(DISTINCT organization_id) FROM stores)::text AS total_orgs,
       (SELECT count(*) FROM stores)::text AS total_stores,
       (SELECT count(*) FROM customers)::text AS total_customers,
       (SELECT count(*) FROM orders)::text AS total_orders,
       (SELECT coalesce(sum(total),0) FROM orders)::text AS gmv,
       (SELECT count(DISTINCT o.store_id) FROM orders o WHERE o.created_at >= now() - interval '30 days')::text AS active_stores_30d,
       (SELECT count(*) FROM stores WHERE created_at >= now() - interval '30 days')::text AS new_stores_30d,
       (SELECT count(*) FROM orders WHERE created_at >= now() - interval '30 days')::text AS new_orders_30d,
       (SELECT count(*) FROM customers WHERE created_at >= now() - interval '30 days')::text AS new_customers_30d`
  );
  const r = rows[0]!;

  // Revenue from cloud billing (paid invoices) when present.
  let revenueCents: number | null = null;
  if (await tableExists("billing_invoices")) {
    const rev = await pool.query<{ total: string }>(
      `SELECT coalesce(sum(total_cents),0)::text AS total FROM billing_invoices WHERE status = 'paid'`
    );
    revenueCents = Number(rev.rows[0]?.total ?? 0);
  }

  return {
    totalOrgs: Number(r.total_orgs),
    totalStores: Number(r.total_stores),
    totalCustomers: Number(r.total_customers),
    totalOrders: Number(r.total_orders),
    gmv: r.gmv,
    revenueCents,
    activeStores30d: Number(r.active_stores_30d),
    newStores30d: Number(r.new_stores_30d),
    newOrders30d: Number(r.new_orders_30d),
    newCustomers30d: Number(r.new_customers_30d),
  };
}

export interface TimeseriesPoint {
  bucket: string;
  orders: number;
  gmv: string;
  newCustomers: number;
}

export async function analyticsTimeseries(opts: { days?: number | undefined; interval?: "day" | "week" | "month" | undefined }): Promise<TimeseriesPoint[]> {
  const pool = getPool();
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const interval = opts.interval ?? "day";
  const trunc = interval === "month" ? "month" : interval === "week" ? "week" : "day";

  // Orders + GMV per bucket, left-joined onto a generated calendar so empty
  // buckets still appear. Single pass, index-friendly (orders.created_at).
  const { rows } = await pool.query<{ bucket: string; orders: string; gmv: string; new_customers: string }>(
    `WITH buckets AS (
       SELECT generate_series(
         date_trunc($2, now() - ($1 || ' days')::interval),
         date_trunc($2, now()),
         ('1 ' || $2)::interval
       ) AS bucket
     ),
     ord AS (
       SELECT date_trunc($2, created_at) AS bucket, count(*) AS orders, coalesce(sum(total),0) AS gmv
         FROM orders WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY 1
     ),
     cust AS (
       SELECT date_trunc($2, created_at) AS bucket, count(*) AS new_customers
         FROM customers WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY 1
     )
     SELECT b.bucket::text AS bucket,
            coalesce(ord.orders,0)::text AS orders,
            coalesce(ord.gmv,0)::text AS gmv,
            coalesce(cust.new_customers,0)::text AS new_customers
       FROM buckets b
       LEFT JOIN ord ON ord.bucket = b.bucket
       LEFT JOIN cust ON cust.bucket = b.bucket
      ORDER BY b.bucket ASC`,
    [String(days), trunc]
  );

  return rows.map((r) => ({
    bucket: r.bucket,
    orders: Number(r.orders),
    gmv: r.gmv,
    newCustomers: Number(r.new_customers),
  }));
}

export interface SystemHealth {
  db: "ok" | "error";
  poolTotal: number;
  poolIdle: number;
  poolWaiting: number;
  migrationVersion: string | null;
  migrationCount: number;
  analyticsEvents24h: number | null;
}

export async function systemHealth(): Promise<SystemHealth> {
  const pool = getPool();
  let db: "ok" | "error" = "ok";
  let migrationVersion: string | null = null;
  let migrationCount = 0;
  let analyticsEvents24h: number | null = null;

  try {
    if (await tableExists("schema_migrations")) {
      const mig = await pool.query<{ name: string; count: string }>(
        `SELECT name, (SELECT count(*)::text FROM schema_migrations) AS count
           FROM schema_migrations ORDER BY name DESC LIMIT 1`
      );
      migrationVersion = mig.rows[0]?.name ?? null;
      migrationCount = Number(mig.rows[0]?.count ?? 0);
    }
    if (await tableExists("analytics_events")) {
      const ev = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM analytics_events WHERE timestamp >= now() - interval '24 hours'`
      );
      analyticsEvents24h = Number(ev.rows[0]?.count ?? 0);
    }
  } catch {
    db = "error";
  }

  return {
    db,
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    poolWaiting: pool.waitingCount,
    migrationVersion,
    migrationCount,
    analyticsEvents24h,
  };
}

// ── Tenant management ────────────────────────────────────────────────────────

export async function takedownStore(storeId: string, reason: string): Promise<boolean> {
  const res = await getPool().query(
    `UPDATE stores
        SET taken_down_at = now(), taken_down_reason = $2, is_active = false, updated_at = now()
      WHERE id = $1::uuid`,
    [storeId, reason]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function restoreStore(storeId: string): Promise<boolean> {
  const res = await getPool().query(
    `UPDATE stores
        SET taken_down_at = NULL, taken_down_reason = NULL, is_active = true, updated_at = now()
      WHERE id = $1::uuid`,
    [storeId]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Suspend = soft takedown with a distinct reason marker (kept separate per spec). */
export async function suspendStore(storeId: string, reason: string): Promise<boolean> {
  const res = await getPool().query(
    `UPDATE stores
        SET is_active = false, taken_down_at = now(),
            taken_down_reason = $2, updated_at = now()
      WHERE id = $1::uuid`,
    [storeId, `suspended: ${reason}`]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Audit log (operator's own trail) ─────────────────────────────────────────

export async function listAuditLog(opts: { superAdminId?: string | undefined; action?: string | undefined; limit?: number | undefined; offset?: number | undefined }): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;
  const adminId = opts.superAdminId ?? null;
  const action = opts.action ?? null;

  const totalRes = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM super_admin_audit_log
      WHERE ($1::uuid IS NULL OR super_admin_id = $1::uuid)
        AND ($2::text IS NULL OR action = $2::text)`,
    [adminId, action]
  );

  const { rows } = await pool.query(
    `SELECT id::text, super_admin_id::text AS super_admin_id, action, target_type, target_id,
            ip, user_agent, data, created_at::text AS created_at
       FROM super_admin_audit_log
      WHERE ($1::uuid IS NULL OR super_admin_id = $1::uuid)
        AND ($2::text IS NULL OR action = $2::text)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [adminId, action, limit, offset]
  );

  return { total: Number(totalRes.rows[0]?.count ?? 0), items: rows as Array<Record<string, unknown>> };
}
