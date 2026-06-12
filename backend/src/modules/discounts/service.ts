/**
 * discounts/service.ts — SQL-backed discount CRUD service.
 *
 * Covers:
 *  - discount_codes: list, get, create, update, delete, validate
 *  - automatic_discounts: list, get, create, update, delete
 *
 * No business logic in routes — this module owns the SQL.
 * All IDs are uuid text. Money fields are string in responses.
 */

import { getPool } from "../../db/pool.js";
import type {
  DiscountCode,
  AutoDiscount,
  CreateDiscountInput,
  UpdateDiscountInput,
  CreateAutoDiscountInput,
  UpdateAutoDiscountInput,
  ValidateDiscountResult,
} from "./types.js";

// ── Column list helpers ────────────────────────────────────────────────────────

const DISCOUNT_CODE_COLS = `
  id::text,
  store_id::text,
  code,
  type,
  value::text,
  min_order_total::text,
  min_qty,
  max_discount::text,
  max_uses,
  uses_count,
  once_per_customer,
  applies_to,
  applies_to_ids::text[],
  metadata,
  starts_at,
  ends_at,
  is_active,
  created_by::text,
  created_at,
  updated_at
`;

const AUTO_DISCOUNT_COLS = `
  id::text,
  store_id::text,
  title,
  type,
  value::text,
  min_order_total::text,
  min_qty,
  max_discount::text,
  max_uses,
  uses_count,
  once_per_customer,
  applies_to,
  applies_to_ids::text[],
  customer_eligibility,
  eligible_ids::text[],
  allow_stacking,
  priority,
  metadata,
  starts_at,
  ends_at,
  is_active,
  created_by::text,
  created_at,
  updated_at
`;

// ── Discount Codes ─────────────────────────────────────────────────────────────

/** List all discount codes for a store. */
export async function listDiscounts(
  storeId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<DiscountCode[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const { rows } = await pool.query<DiscountCode>(
    `SELECT ${DISCOUNT_CODE_COLS}
     FROM discount_codes
     WHERE store_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]
  );
  return rows;
}

/** Get a single discount code by id. Returns null if not found or wrong store. */
export async function getDiscount(
  storeId: string,
  discountId: string
): Promise<DiscountCode | null> {
  const pool = getPool();
  const { rows } = await pool.query<DiscountCode>(
    `SELECT ${DISCOUNT_CODE_COLS}
     FROM discount_codes
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [discountId, storeId]
  );
  return rows[0] ?? null;
}

/**
 * Create a discount code.
 * Returns the created discount's id.
 * Throws { code: "DUPLICATE_CODE" } on unique conflict.
 */
export async function createDiscount(
  storeId: string,
  input: CreateDiscountInput
): Promise<string> {
  const pool = getPool();
  const code = input.code.trim().toUpperCase();

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO discount_codes
         (store_id, code, type, value, min_order_total, min_qty, max_discount,
          max_uses, once_per_customer, applies_to, applies_to_ids, metadata,
          starts_at, ends_at, is_active, created_by)
       VALUES
         ($1::uuid, $2, $3, $4::numeric, $5::numeric, $6, $7::numeric,
          $8, $9, $10, $11::uuid[], $12,
          $13::timestamptz, $14::timestamptz, $15, $16::uuid)
       RETURNING id::text`,
      [
        storeId,
        code,
        input.type,
        input.value ?? null,
        input.min_order_total ?? null,
        input.min_qty ?? null,
        input.max_discount ?? null,
        input.max_uses ?? null,
        input.once_per_customer ?? false,
        input.applies_to ?? "order",
        input.applies_to_ids && input.applies_to_ids.length > 0
          ? `{${input.applies_to_ids.join(",")}}`
          : "{}",
        JSON.stringify(input.metadata ?? {}),
        input.starts_at ?? null,
        input.ends_at ?? null,
        input.is_active ?? true,
        input.created_by ?? null,
      ]
    );
    const row = rows[0];
    if (!row) throw new Error("createDiscount: no row returned");
    return row.id;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      const e = new Error(`discount code "${input.code}" already exists in this store`);
      (e as NodeJS.ErrnoException).code = "DUPLICATE_CODE";
      throw e;
    }
    throw err;
  }
}

/**
 * Update a discount code.
 * Returns false if not found or wrong store.
 */
export async function updateDiscount(
  storeId: string,
  discountId: string,
  input: UpdateDiscountInput
): Promise<boolean> {
  const pool = getPool();

  // Build dynamic SET clause
  const sets: string[] = [];
  const params: unknown[] = [discountId, storeId];
  let p = 3;

  function addSet(col: string, val: unknown, cast = "") {
    sets.push(`${col} = $${p}${cast}`);
    params.push(val);
    p++;
  }

  if (input.code !== undefined) addSet("code", input.code.trim().toUpperCase());
  if (input.type !== undefined) addSet("type", input.type);
  if ("value" in input) addSet("value", input.value, "::numeric");
  if ("min_order_total" in input) addSet("min_order_total", input.min_order_total, "::numeric");
  if ("min_qty" in input) addSet("min_qty", input.min_qty);
  if ("max_discount" in input) addSet("max_discount", input.max_discount, "::numeric");
  if ("max_uses" in input) addSet("max_uses", input.max_uses);
  if (input.once_per_customer !== undefined) addSet("once_per_customer", input.once_per_customer);
  if (input.applies_to !== undefined) addSet("applies_to", input.applies_to);
  if (input.applies_to_ids !== undefined) {
    const arr =
      input.applies_to_ids.length > 0
        ? `{${input.applies_to_ids.join(",")}}`
        : "{}";
    addSet("applies_to_ids", arr, "::uuid[]");
  }
  if (input.metadata !== undefined) addSet("metadata", JSON.stringify(input.metadata));
  if ("starts_at" in input) addSet("starts_at", input.starts_at, "::timestamptz");
  if ("ends_at" in input) addSet("ends_at", input.ends_at, "::timestamptz");
  if (input.is_active !== undefined) addSet("is_active", input.is_active);

  if (sets.length === 0) return true; // nothing to update

  sets.push("updated_at = now()");

  try {
    const { rowCount } = await pool.query(
      `UPDATE discount_codes
       SET ${sets.join(", ")}
       WHERE id = $1::uuid AND store_id = $2::uuid`,
      params
    );
    return (rowCount ?? 0) > 0;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      const e = new Error(`discount code already exists in this store`);
      (e as NodeJS.ErrnoException).code = "DUPLICATE_CODE";
      throw e;
    }
    throw err;
  }
}

/** Delete a discount code. Returns false if not found or wrong store. */
export async function deleteDiscount(
  storeId: string,
  discountId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM discount_codes WHERE id = $1::uuid AND store_id = $2::uuid`,
    [discountId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Validate a discount code.
 *
 * Returns null (caller sends 404) when:
 *  - code not found / wrong store
 *  - is_active = false
 *  - starts_at > now() or ends_at < now()
 *  - max_uses exceeded
 *
 * Returns null with code "ONCE_PER_CUSTOMER" (caller sends 404 per spec)
 * when once_per_customer=true and customer has already used it.
 *
 * On success returns ValidateDiscountResult with optional computed_amount.
 */
export async function validateDiscount(
  storeId: string,
  opts: {
    code: string;
    customer_id?: string | undefined;
    order_total?: string | undefined;
  }
): Promise<{ result: ValidateDiscountResult } | { reason: string } | null> {
  const pool = getPool();
  const code = opts.code.trim().toUpperCase();

  const { rows } = await pool.query<DiscountCode>(
    `SELECT ${DISCOUNT_CODE_COLS}
     FROM discount_codes
     WHERE store_id = $1::uuid
       AND UPPER(code) = $2
       AND is_active = true
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at IS NULL OR ends_at > now())`,
    [storeId, code]
  );

  const dc = rows[0];
  if (!dc) return null;

  // Check max_uses
  if (dc.max_uses !== null && dc.uses_count >= dc.max_uses) {
    return null;
  }

  // Check once_per_customer
  if (dc.once_per_customer && opts.customer_id) {
    const { rows: usageRows } = await pool.query<{ found: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM discount_usages
         WHERE discount_id = $1::uuid AND customer_id = $2::uuid
       ) AS found`,
      [dc.id, opts.customer_id]
    );
    if (usageRows[0]?.found === true) {
      return { reason: "ONCE_PER_CUSTOMER" };
    }
  }

  // Compute discount amount if order_total provided
  let computed_amount: string | null = null;
  if (opts.order_total && dc.type === "percentage" && dc.value !== null) {
    const pct = parseFloat(dc.value) / 100;
    const total = parseFloat(opts.order_total);
    let amount = total * pct;
    if (dc.max_discount !== null) {
      const cap = parseFloat(dc.max_discount);
      if (amount > cap) amount = cap;
    }
    computed_amount = amount.toFixed(2);
  } else if (opts.order_total && dc.type === "fixed_amount" && dc.value !== null) {
    let amount = parseFloat(dc.value);
    const total = parseFloat(opts.order_total);
    if (amount > total) amount = total;
    computed_amount = amount.toFixed(2);
  } else if (dc.type === "free_shipping") {
    computed_amount = null; // shipping value is context-dependent
  }

  return {
    result: {
      discount_id: dc.id,
      code: dc.code,
      type: dc.type,
      value: dc.value,
      computed_amount,
      max_discount: dc.max_discount,
      applies_to: dc.applies_to,
      applies_to_ids: dc.applies_to_ids,
      min_order_total: dc.min_order_total,
      min_qty: dc.min_qty,
      once_per_customer: dc.once_per_customer,
      metadata: dc.metadata,
    },
  };
}

// ── Automatic Discounts ────────────────────────────────────────────────────────

/** List all automatic discounts for a store. */
export async function listAutoDiscounts(
  storeId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<AutoDiscount[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const { rows } = await pool.query<AutoDiscount>(
    `SELECT ${AUTO_DISCOUNT_COLS}
     FROM automatic_discounts
     WHERE store_id = $1::uuid
     ORDER BY priority DESC, created_at DESC
     LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]
  );
  return rows;
}

/** Get a single automatic discount by id. Returns null if not found or wrong store. */
export async function getAutoDiscount(
  storeId: string,
  discountId: string
): Promise<AutoDiscount | null> {
  const pool = getPool();
  const { rows } = await pool.query<AutoDiscount>(
    `SELECT ${AUTO_DISCOUNT_COLS}
     FROM automatic_discounts
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [discountId, storeId]
  );
  return rows[0] ?? null;
}

/**
 * Create an automatic discount.
 * Returns the created discount's id.
 */
export async function createAutoDiscount(
  storeId: string,
  input: CreateAutoDiscountInput
): Promise<string> {
  const pool = getPool();

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO automatic_discounts
       (store_id, title, type, value, min_order_total, min_qty, max_discount,
        max_uses, once_per_customer, applies_to, applies_to_ids,
        customer_eligibility, eligible_ids, allow_stacking, priority,
        metadata, starts_at, ends_at, is_active, created_by)
     VALUES
       ($1::uuid, $2, $3, $4::numeric, $5::numeric, $6, $7::numeric,
        $8, $9, $10, $11::uuid[],
        $12, $13::uuid[], $14, $15,
        $16, $17::timestamptz, $18::timestamptz, $19, $20::uuid)
     RETURNING id::text`,
    [
      storeId,
      input.title.trim(),
      input.type,
      input.value ?? null,
      input.min_order_total ?? null,
      input.min_qty ?? null,
      input.max_discount ?? null,
      input.max_uses ?? null,
      input.once_per_customer ?? false,
      input.applies_to ?? "order",
      input.applies_to_ids && input.applies_to_ids.length > 0
        ? `{${input.applies_to_ids.join(",")}}`
        : "{}",
      input.customer_eligibility ?? "all",
      input.eligible_ids && input.eligible_ids.length > 0
        ? `{${input.eligible_ids.join(",")}}`
        : "{}",
      input.allow_stacking ?? false,
      input.priority ?? 0,
      JSON.stringify(input.metadata ?? {}),
      input.starts_at ?? null,
      input.ends_at ?? null,
      input.is_active ?? true,
      input.created_by ?? null,
    ]
  );
  const row = rows[0];
  if (!row) throw new Error("createAutoDiscount: no row returned");
  return row.id;
}

/**
 * Update an automatic discount.
 * Returns false if not found or wrong store.
 */
export async function updateAutoDiscount(
  storeId: string,
  discountId: string,
  input: UpdateAutoDiscountInput
): Promise<boolean> {
  const pool = getPool();

  const sets: string[] = [];
  const params: unknown[] = [discountId, storeId];
  let p = 3;

  function addSet(col: string, val: unknown, cast = "") {
    sets.push(`${col} = $${p}${cast}`);
    params.push(val);
    p++;
  }

  if (input.title !== undefined) addSet("title", input.title.trim());
  if (input.type !== undefined) addSet("type", input.type);
  if ("value" in input) addSet("value", input.value, "::numeric");
  if ("min_order_total" in input) addSet("min_order_total", input.min_order_total, "::numeric");
  if ("min_qty" in input) addSet("min_qty", input.min_qty);
  if ("max_discount" in input) addSet("max_discount", input.max_discount, "::numeric");
  if ("max_uses" in input) addSet("max_uses", input.max_uses);
  if (input.once_per_customer !== undefined) addSet("once_per_customer", input.once_per_customer);
  if (input.applies_to !== undefined) addSet("applies_to", input.applies_to);
  if (input.applies_to_ids !== undefined) {
    const arr =
      input.applies_to_ids.length > 0
        ? `{${input.applies_to_ids.join(",")}}`
        : "{}";
    addSet("applies_to_ids", arr, "::uuid[]");
  }
  if (input.customer_eligibility !== undefined) addSet("customer_eligibility", input.customer_eligibility);
  if (input.eligible_ids !== undefined) {
    const arr =
      input.eligible_ids.length > 0
        ? `{${input.eligible_ids.join(",")}}`
        : "{}";
    addSet("eligible_ids", arr, "::uuid[]");
  }
  if (input.allow_stacking !== undefined) addSet("allow_stacking", input.allow_stacking);
  if (input.priority !== undefined) addSet("priority", input.priority);
  if (input.metadata !== undefined) addSet("metadata", JSON.stringify(input.metadata));
  if ("starts_at" in input) addSet("starts_at", input.starts_at, "::timestamptz");
  if ("ends_at" in input) addSet("ends_at", input.ends_at, "::timestamptz");
  if (input.is_active !== undefined) addSet("is_active", input.is_active);

  if (sets.length === 0) return true;

  sets.push("updated_at = now()");

  const { rowCount } = await pool.query(
    `UPDATE automatic_discounts
     SET ${sets.join(", ")}
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    params
  );
  return (rowCount ?? 0) > 0;
}

/** Delete an automatic discount. Returns false if not found or wrong store. */
export async function deleteAutoDiscount(
  storeId: string,
  discountId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM automatic_discounts WHERE id = $1::uuid AND store_id = $2::uuid`,
    [discountId, storeId]
  );
  return (rowCount ?? 0) > 0;
}
