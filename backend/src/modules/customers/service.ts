/**
 * customers/service.ts — SQL-backed customer management service.
 *
 * All functions take an explicit `pool` argument (injected from tests) plus
 * a `storeId` for RLS/scoping. Returns typed results; no HTTP concerns here.
 */

import type pg from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CustomerRow {
  id: string;
  store_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  is_admin: boolean;
  is_active: boolean;
  is_blocked: boolean;
  blocked_reason: string | null;
  email_verified: boolean;
  sign_in_count: number;
  last_sign_in_at: string | null;
  failed_login_attempts: number;
  locked_until: string | null;
  auth_provider: string;
  tags: string[];
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerDetail extends CustomerRow {
  addresses: AddressRow[];
  order_count: number;
  total_spend: string;
}

export interface AddressRow {
  id: string;
  customer_id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country_code: string | null;
  phone: string | null;
  is_default: boolean;
  created_at: string;
}

export interface CreateCustomerInput {
  email: string;
  first_name?: string | undefined;
  last_name?: string | undefined;
  display_name?: string | undefined;
  phone?: string | undefined;
  is_admin?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
  password_hash?: string | undefined;
}

export interface UpdateCustomerInput {
  email?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
  display_name?: string | undefined;
  phone?: string | undefined;
  is_admin?: boolean | undefined;
  is_active?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface AddressInput {
  first_name?: string | undefined;
  last_name?: string | undefined;
  company?: string | undefined;
  address1?: string | undefined;
  address2?: string | undefined;
  city?: string | undefined;
  province?: string | undefined;
  zip?: string | undefined;
  country_code?: string | undefined;
  phone?: string | undefined;
  is_default?: boolean | undefined;
}

// ── Column list ───────────────────────────────────────────────────────────────

const CUSTOMER_COLS = `
  c.id::text,
  c.store_id::text,
  c.email,
  c.first_name,
  c.last_name,
  c.display_name,
  c.avatar_url,
  c.phone,
  coalesce(c.is_admin, false) as is_admin,
  coalesce(c.is_active, true) as is_active,
  coalesce(c.is_blocked, false) as is_blocked,
  c.blocked_reason,
  coalesce(c.email_verified, false) as email_verified,
  coalesce(c.sign_in_count, 0) as sign_in_count,
  c.last_sign_in_at,
  coalesce(c.failed_login_attempts, 0) as failed_login_attempts,
  c.locked_until,
  c.auth_provider,
  coalesce(c.tags, '{}') as tags,
  c.metadata,
  c.created_at,
  c.updated_at
`;

// ── List customers ────────────────────────────────────────────────────────────

export async function listCustomers(
  pool: pg.Pool,
  storeId: string,
  opts: { limit?: number; offset?: number; q?: string }
): Promise<{ customers: CustomerRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;
  const q = opts.q?.trim() ?? "";

  const params: unknown[] = [storeId];
  let whereExtra = "";

  if (q) {
    params.push(`%${q}%`);
    whereExtra = ` AND (c.email ILIKE $${params.length} OR c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length})`;
  }

  const countRes = await pool.query<{ total: string }>(
    `SELECT count(*)::text as total FROM customers c WHERE c.store_id = $1::uuid${whereExtra}`,
    params
  );
  const total = parseInt(countRes.rows[0]?.total ?? "0", 10);

  params.push(limit, offset);
  const { rows } = await pool.query<CustomerRow>(
    `SELECT ${CUSTOMER_COLS}
     FROM customers c
     WHERE c.store_id = $1::uuid${whereExtra}
     ORDER BY c.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { customers: rows, total };
}

// ── Get single customer ───────────────────────────────────────────────────────

export async function getCustomer(
  pool: pg.Pool,
  storeId: string,
  customerId: string
): Promise<CustomerDetail | null> {
  const { rows } = await pool.query<CustomerRow>(
    `SELECT ${CUSTOMER_COLS}
     FROM customers c
     WHERE c.store_id = $1::uuid AND c.id = $2::uuid`,
    [storeId, customerId]
  );
  const row = rows[0];
  if (!row) return null;

  const addrRes = await pool.query<AddressRow>(
    `SELECT id::text, customer_id::text, first_name, last_name, company,
            address1, address2, city, province, zip, country_code, phone,
            is_default, created_at
     FROM customer_addresses
     WHERE customer_id = $1::uuid
     ORDER BY is_default DESC, created_at ASC`,
    [customerId]
  );

  const spendRes = await pool.query<{ order_count: string; total_spend: string }>(
    `SELECT count(*)::text as order_count,
            coalesce(sum(total_price), 0)::text as total_spend
     FROM orders
     WHERE customer_id = $1::uuid AND store_id = $2::uuid
       AND status NOT IN ('cancelled', 'failed')`,
    [customerId, storeId]
  );

  return {
    ...row,
    addresses: addrRes.rows,
    order_count: parseInt(spendRes.rows[0]?.order_count ?? "0", 10),
    total_spend: spendRes.rows[0]?.total_spend ?? "0",
  };
}

// ── Create customer ───────────────────────────────────────────────────────────

export async function createCustomer(
  pool: pg.Pool,
  storeId: string,
  body: CreateCustomerInput
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers
       (store_id, email, first_name, last_name, display_name, phone,
        is_admin, metadata, password_hash)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id::text`,
    [
      storeId,
      body.email.toLowerCase().trim(),
      body.first_name ?? null,
      body.last_name ?? null,
      body.display_name ?? null,
      body.phone ?? null,
      body.is_admin ?? false,
      body.metadata ? JSON.stringify(body.metadata) : null,
      body.password_hash ?? null,
    ]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("createCustomer: no id returned");
  return id;
}

// ── Update customer ───────────────────────────────────────────────────────────

export async function updateCustomer(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  body: UpdateCustomerInput
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [storeId, customerId];

  function addSet(col: string, val: unknown) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }

  if (body.email !== undefined) addSet("email", body.email.toLowerCase().trim());
  if (body.first_name !== undefined) addSet("first_name", body.first_name || null);
  if (body.last_name !== undefined) addSet("last_name", body.last_name || null);
  if (body.display_name !== undefined) addSet("display_name", body.display_name || null);
  if (body.phone !== undefined) addSet("phone", body.phone || null);
  if (body.is_admin !== undefined) addSet("is_admin", body.is_admin);
  if (body.is_active !== undefined) addSet("is_active", body.is_active);
  if (body.metadata !== undefined) addSet("metadata", JSON.stringify(body.metadata));

  if (sets.length === 0) return true;
  sets.push("updated_at = now()");

  const res = await pool.query(
    `UPDATE customers SET ${sets.join(", ")}
     WHERE store_id = $1::uuid AND id = $2::uuid`,
    params
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Delete customer ───────────────────────────────────────────────────────────

export async function deleteCustomer(
  pool: pg.Pool,
  storeId: string,
  customerId: string
): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM customers WHERE store_id = $1::uuid AND id = $2::uuid`,
    [storeId, customerId]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Block / unblock ───────────────────────────────────────────────────────────

export async function blockCustomer(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  reason: string
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE customers
     SET is_blocked = true, blocked_reason = $3, updated_at = now()
     WHERE store_id = $1::uuid AND id = $2::uuid`,
    [storeId, customerId, reason || null]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function unblockCustomer(
  pool: pg.Pool,
  storeId: string,
  customerId: string
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE customers
     SET is_blocked = false, blocked_reason = null, updated_at = now()
     WHERE store_id = $1::uuid AND id = $2::uuid`,
    [storeId, customerId]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Addresses ────────────────────────────────────────────────────────────────

export async function addCustomerAddress(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  body: AddressInput
): Promise<string> {
  // Verify customer belongs to store
  const check = await pool.query<{ id: string }>(
    `SELECT id::text FROM customers WHERE store_id = $1::uuid AND id = $2::uuid`,
    [storeId, customerId]
  );
  if (!check.rows[0]) throw new Error("customer not found");

  if (body.is_default) {
    await pool.query(
      `UPDATE customer_addresses SET is_default = false WHERE customer_id = $1::uuid`,
      [customerId]
    );
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customer_addresses
       (customer_id, first_name, last_name, company, address1, address2,
        city, province, zip, country_code, phone, is_default)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id::text`,
    [
      customerId,
      body.first_name ?? null,
      body.last_name ?? null,
      body.company ?? null,
      body.address1 ?? null,
      body.address2 ?? null,
      body.city ?? null,
      body.province ?? null,
      body.zip ?? null,
      body.country_code ?? null,
      body.phone ?? null,
      body.is_default ?? false,
    ]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("addCustomerAddress: no id returned");
  return id;
}

export async function deleteCustomerAddress(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  addressId: string
): Promise<boolean> {
  // Verify customer belongs to store
  const check = await pool.query<{ id: string }>(
    `SELECT id::text FROM customers WHERE store_id = $1::uuid AND id = $2::uuid`,
    [storeId, customerId]
  );
  if (!check.rows[0]) return false;

  const res = await pool.query(
    `DELETE FROM customer_addresses WHERE customer_id = $1::uuid AND id = $2::uuid`,
    [customerId, addressId]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export async function listCustomerTags(
  pool: pg.Pool,
  storeId: string,
  customerId: string
): Promise<string[]> {
  const { rows } = await pool.query<{ tags: string[] }>(
    `SELECT coalesce(tags, '{}') as tags
     FROM customers
     WHERE store_id = $1::uuid AND id = $2::uuid`,
    [storeId, customerId]
  );
  return rows[0]?.tags ?? [];
}

export async function setCustomerTags(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  tags: string[]
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE customers SET tags = $3::text[], updated_at = now()
     WHERE store_id = $1::uuid AND id = $2::uuid`,
    [storeId, customerId, tags]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function listAuditLog(
  pool: pg.Pool,
  storeId: string,
  opts: { customerId?: string | undefined; event?: string | undefined; limit?: number | undefined }
): Promise<unknown[]> {
  const limit = Math.min(opts.limit ?? 50, 500);
  const params: unknown[] = [storeId];
  const wheres: string[] = ["store_id = $1::uuid"];

  if (opts.customerId) {
    params.push(opts.customerId);
    wheres.push(`customer_id = $${params.length}::uuid`);
  }
  if (opts.event) {
    params.push(opts.event);
    wheres.push(`event = $${params.length}`);
  }

  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, customer_id::text, event,
            ip_address::text, user_agent, data, created_at
     FROM customer_audit_log
     WHERE ${wheres.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

// ── Store ownership ───────────────────────────────────────────────────────────

export async function storeOwnedByOrg(
  pool: pg.Pool,
  storeId: string,
  orgId: string
): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM stores
       WHERE id = $1::uuid AND organization_id = $2::uuid
     ) as exists`,
    [storeId, orgId]
  );
  return rows[0]?.exists ?? false;
}
