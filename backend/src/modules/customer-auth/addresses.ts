/**
 * customer-auth/addresses.ts — storefront customer address-book service.
 *
 * Every function is scoped by BOTH store_id and customer_id and uses only
 * parameterised SQL. The customer_id is always the authenticated customer
 * (derived from request.customer in the route), never a path param, so a
 * customer can only ever touch their own rows.
 *
 * Backs public.customer_addresses (0001_commerce + 0039_customer_addresses).
 * The address field set mirrors the checkout/orders shipping_address jsonb
 * shape: name / first_name / last_name, address1(=line1) / address2(=line2),
 * city, province_code, postal_code, country_code, phone.
 */

import type pg from "pg";
import type { ReadDb } from "../../db/pool.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CustomerAddressRow {
  id: string;
  store_id: string;
  customer_id: string;
  label: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province_code: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
  is_default_shipping: boolean;
  is_default_billing: boolean;
  created_at: string;
  updated_at: string;
}

export interface AddressInput {
  label?: string | undefined;
  name?: string | undefined;
  first_name?: string | undefined;
  last_name?: string | undefined;
  company?: string | undefined;
  address1?: string | undefined;
  address2?: string | undefined;
  city?: string | undefined;
  province_code?: string | undefined;
  postal_code?: string | undefined;
  country_code?: string | undefined;
  phone?: string | undefined;
  is_default_shipping?: boolean | undefined;
  is_default_billing?: boolean | undefined;
}

export type DefaultKind = "shipping" | "billing";

// ── Column projection (line1/line2 aliased to address1/address2) ─────────────

const ADDRESS_COLS = `
  id::text,
  store_id::text,
  customer_id::text,
  label,
  name,
  first_name,
  last_name,
  company,
  line1 AS address1,
  line2 AS address2,
  city,
  province_code,
  postal_code,
  country_code,
  phone,
  is_default_shipping,
  is_default_billing,
  created_at,
  updated_at
`;

// ── List ────────────────────────────────────────────────────────────────────

export async function listAddresses(
  pool: ReadDb,
  storeId: string,
  customerId: string,
): Promise<CustomerAddressRow[]> {
  const { rows } = await pool.query<CustomerAddressRow>(
    `SELECT ${ADDRESS_COLS}
     FROM customer_addresses
     WHERE store_id = $1::uuid AND customer_id = $2::uuid
     ORDER BY is_default_shipping DESC, is_default_billing DESC, created_at ASC`,
    [storeId, customerId],
  );
  return rows;
}

// ── Get one (scoped) ────────────────────────────────────────────────────────

export async function getAddress(
  pool: ReadDb,
  storeId: string,
  customerId: string,
  addressId: string,
): Promise<CustomerAddressRow | null> {
  const { rows } = await pool.query<CustomerAddressRow>(
    `SELECT ${ADDRESS_COLS}
     FROM customer_addresses
     WHERE store_id = $1::uuid AND customer_id = $2::uuid AND id = $3::uuid`,
    [storeId, customerId, addressId],
  );
  return rows[0] ?? null;
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createAddress(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  input: AddressInput,
): Promise<CustomerAddressRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Verify the customer belongs to this store before inserting.
    const check = await client.query<{ id: string }>(
      `SELECT id::text FROM customers WHERE store_id = $1::uuid AND id = $2::uuid`,
      [storeId, customerId],
    );
    if (!check.rows[0]) {
      await client.query("ROLLBACK");
      throw new Error("customer not found");
    }

    const wantDefaultShipping = input.is_default_shipping ?? false;
    const wantDefaultBilling = input.is_default_billing ?? false;

    // Keep the partial-unique invariant: clear any existing default of the kinds
    // this new row will claim, before inserting it as the default.
    if (wantDefaultShipping) {
      await client.query(
        `UPDATE customer_addresses
         SET is_default_shipping = false, updated_at = now()
         WHERE store_id = $1::uuid AND customer_id = $2::uuid AND is_default_shipping`,
        [storeId, customerId],
      );
    }
    if (wantDefaultBilling) {
      await client.query(
        `UPDATE customer_addresses
         SET is_default_billing = false, updated_at = now()
         WHERE store_id = $1::uuid AND customer_id = $2::uuid AND is_default_billing`,
        [storeId, customerId],
      );
    }

    const { rows } = await client.query<CustomerAddressRow>(
      `INSERT INTO customer_addresses
         (store_id, customer_id, label, name, first_name, last_name, company,
          line1, line2, city, province_code, postal_code, country_code, phone,
          is_default_shipping, is_default_billing)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING ${ADDRESS_COLS}`,
      [
        storeId,
        customerId,
        input.label ?? null,
        input.name ?? null,
        input.first_name ?? null,
        input.last_name ?? null,
        input.company ?? null,
        input.address1 ?? null,
        input.address2 ?? null,
        input.city ?? null,
        input.province_code ?? null,
        input.postal_code ?? null,
        input.country_code ?? null,
        input.phone ?? null,
        wantDefaultShipping,
        wantDefaultBilling,
      ],
    );

    await client.query("COMMIT");
    const row = rows[0];
    if (!row) throw new Error("createAddress: no row returned");
    return row;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── Update ──────────────────────────────────────────────────────────────────

// Maps an AddressInput field name to its DB column (line1/line2 rename).
const COLUMN_FOR: Record<string, string> = {
  label: "label",
  name: "name",
  first_name: "first_name",
  last_name: "last_name",
  company: "company",
  address1: "line1",
  address2: "line2",
  city: "city",
  province_code: "province_code",
  postal_code: "postal_code",
  country_code: "country_code",
  phone: "phone",
};

export async function updateAddress(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  addressId: string,
  input: AddressInput,
): Promise<CustomerAddressRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the target row, scoped to this store + customer (IDOR guard).
    const existing = await client.query<{ id: string }>(
      `SELECT id::text FROM customer_addresses
       WHERE store_id = $1::uuid AND customer_id = $2::uuid AND id = $3::uuid
       FOR UPDATE`,
      [storeId, customerId, addressId],
    );
    if (!existing.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    // If this row is being promoted to a default, clear the sibling default of
    // that kind first to preserve the partial-unique invariant.
    if (input.is_default_shipping === true) {
      await client.query(
        `UPDATE customer_addresses
         SET is_default_shipping = false, updated_at = now()
         WHERE store_id = $1::uuid AND customer_id = $2::uuid
           AND is_default_shipping AND id <> $3::uuid`,
        [storeId, customerId, addressId],
      );
    }
    if (input.is_default_billing === true) {
      await client.query(
        `UPDATE customer_addresses
         SET is_default_billing = false, updated_at = now()
         WHERE store_id = $1::uuid AND customer_id = $2::uuid
           AND is_default_billing AND id <> $3::uuid`,
        [storeId, customerId, addressId],
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [storeId, customerId, addressId];

    for (const key of Object.keys(COLUMN_FOR)) {
      const val = (input as Record<string, unknown>)[key];
      if (val !== undefined) {
        params.push(val === "" ? null : val);
        sets.push(`${COLUMN_FOR[key]} = $${params.length}`);
      }
    }
    if (input.is_default_shipping !== undefined) {
      params.push(input.is_default_shipping);
      sets.push(`is_default_shipping = $${params.length}`);
    }
    if (input.is_default_billing !== undefined) {
      params.push(input.is_default_billing);
      sets.push(`is_default_billing = $${params.length}`);
    }

    let row: CustomerAddressRow;
    if (sets.length === 0) {
      const { rows } = await client.query<CustomerAddressRow>(
        `SELECT ${ADDRESS_COLS} FROM customer_addresses
         WHERE store_id = $1::uuid AND customer_id = $2::uuid AND id = $3::uuid`,
        [storeId, customerId, addressId],
      );
      row = rows[0]!;
    } else {
      sets.push("updated_at = now()");
      const { rows } = await client.query<CustomerAddressRow>(
        `UPDATE customer_addresses SET ${sets.join(", ")}
         WHERE store_id = $1::uuid AND customer_id = $2::uuid AND id = $3::uuid
         RETURNING ${ADDRESS_COLS}`,
        params,
      );
      row = rows[0]!;
    }

    await client.query("COMMIT");
    return row;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

export async function deleteAddress(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  addressId: string,
): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM customer_addresses
     WHERE store_id = $1::uuid AND customer_id = $2::uuid AND id = $3::uuid`,
    [storeId, customerId, addressId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Set default ─────────────────────────────────────────────────────────────

/**
 * Atomically make `addressId` the customer's default of the given kind:
 * unset every other default of that kind, then set this one. Returns the
 * updated row, or null if the address does not belong to this store+customer.
 */
export async function setDefault(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  addressId: string,
  kind: DefaultKind,
): Promise<CustomerAddressRow | null> {
  const col = kind === "shipping" ? "is_default_shipping" : "is_default_billing";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ id: string }>(
      `SELECT id::text FROM customer_addresses
       WHERE store_id = $1::uuid AND customer_id = $2::uuid AND id = $3::uuid
       FOR UPDATE`,
      [storeId, customerId, addressId],
    );
    if (!existing.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    // Unset the current default of this kind (everything except the target),
    // then set the target. Two statements avoid tripping the partial-unique
    // index mid-update.
    await client.query(
      `UPDATE customer_addresses
       SET ${col} = false, updated_at = now()
       WHERE store_id = $1::uuid AND customer_id = $2::uuid
         AND ${col} AND id <> $3::uuid`,
      [storeId, customerId, addressId],
    );
    const { rows } = await client.query<CustomerAddressRow>(
      `UPDATE customer_addresses
       SET ${col} = true, updated_at = now()
       WHERE store_id = $1::uuid AND customer_id = $2::uuid AND id = $3::uuid
       RETURNING ${ADDRESS_COLS}`,
      [storeId, customerId, addressId],
    );

    await client.query("COMMIT");
    return rows[0] ?? null;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── Admin read (support) ────────────────────────────────────────────────────

export async function listAddressesForCustomer(
  pool: ReadDb,
  storeId: string,
  customerId: string,
): Promise<CustomerAddressRow[]> {
  return listAddresses(pool, storeId, customerId);
}
