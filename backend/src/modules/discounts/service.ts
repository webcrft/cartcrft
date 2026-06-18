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

import type pg from "pg";
import { getPool, getReadDb } from "../../db/pool.js";
import { round2 } from "../../lib/money.js";
import type {
  DiscountCode,
  AutoDiscount,
  CreateDiscountInput,
  UpdateDiscountInput,
  CreateAutoDiscountInput,
  UpdateAutoDiscountInput,
  ValidateDiscountResult,
  DiscountType,
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
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
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
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
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
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
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
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
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
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
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

// ── Discount EXECUTION engine (T2.7 / Wave 3.1) ─────────────────────────────────
//
// Everything below is the *execution* path: given the cart contents it decides
// which discounts actually apply and by how much.  It is consumed by:
//   - checkout/service.ts  → preview totals at create/update time (read pool)
//   - checkout/complete.ts  → authoritative recompute inside the completion tx
//
// Design notes:
//   • Pure-ish: the engine takes already-loaded cart lines + a small set of
//     SQL lookups (scope membership), so it can run on either a read pool or a
//     transaction client.  The caller passes the pg client.
//   • Money: all arithmetic via round2 (matches the rest of the checkout path).
//   • A discount NEVER exceeds the eligible subtotal / shipping it targets, and
//     the aggregate order discount never exceeds the order subtotal.
//   • BOGO / buy_x_get_y rule parameters live in `metadata` (the schema comment
//     on discount_codes documents this).  Convention:
//        metadata.buy_quantity     (X, default 1)
//        metadata.get_quantity     (Y, default 1)
//        metadata.get_discount_pct (percent off the discounted units, default 100)
//     For every X qualifying units purchased, the cheapest Y qualifying units
//     get get_discount_pct% off.  `bogo` is buy_x_get_y with X=Y=1, pct=100
//     unless metadata overrides.

/** A cart line as the discount engine needs to see it. */
export interface DiscountCartLine {
  variant_id: string;
  product_id: string;
  qty: number;
  /** Unit price (major units, 2dp). */
  price: number;
}

/** One applied discount, mirrors the checkout `discount_lines` JSON shape plus internals. */
export interface AppliedDiscountLine {
  /** Discount code (empty string for automatic discounts). */
  code: string;
  /** Human label — code for code discounts, title for automatic. */
  title: string;
  type: DiscountType;
  /** Amount taken off the order subtotal (>= 0). free_shipping contributes 0 here. */
  amount: number;
  /** True when this is an automatic (codeless) discount. */
  automatic: boolean;
  /** True when this discount zeroes shipping (free_shipping type). */
  free_shipping: boolean;
}

export interface ComputeDiscountsResult {
  /** Total taken off subtotal across all applied discounts. */
  discountTotal: number;
  /** Shipping after free-shipping discounts (<= input shipping). */
  shippingTotal: number;
  /** Whether any applied discount granted free shipping. */
  freeShipping: boolean;
  /** Applied discount lines (for persistence + display). */
  lines: AppliedDiscountLine[];
}

/** Common, type-erased shape shared by discount_codes + automatic_discounts. */
interface DiscountRule {
  id: string;
  code: string | null; // null for automatic
  title: string; // code or title
  type: DiscountType;
  value: number | null;
  min_order_total: number | null;
  min_qty: number | null;
  max_discount: number | null;
  applies_to: string;
  applies_to_ids: string[];
  allow_stacking: boolean;
  priority: number;
  metadata: Record<string, unknown>;
  automatic: boolean;
}

function num(v: string | null): number | null {
  return v === null ? null : parseFloat(v);
}

function metaInt(meta: Record<string, unknown>, key: string, fallback: number): number {
  const raw = meta[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Resolve which cart lines a rule's applies_to scope targets.
 * Returns the subset of lines covered by the rule (the whole cart for `order`).
 *
 * - order                  → all lines
 * - specific_products      → lines whose product_id ∈ applies_to_ids
 * - specific_collections   → lines whose product is in any collection ∈ applies_to_ids
 * - anything else (customer scoping) → all lines (customer eligibility handled separately)
 */
async function linesInScope(
  client: pg.PoolClient | pg.Pool,
  rule: DiscountRule,
  lines: DiscountCartLine[]
): Promise<DiscountCartLine[]> {
  if (rule.applies_to === "order" || rule.applies_to_ids.length === 0) {
    if (rule.applies_to === "specific_products" || rule.applies_to === "specific_collections") {
      // Scoped rule with no ids configured → matches nothing.
      return [];
    }
    return lines;
  }

  if (rule.applies_to === "specific_products") {
    const ids = new Set(rule.applies_to_ids);
    return lines.filter((l) => ids.has(l.product_id));
  }

  if (rule.applies_to === "specific_collections") {
    const productIds = [...new Set(lines.map((l) => l.product_id))];
    if (productIds.length === 0) return [];
    const { rows } = await client.query<{ product_id: string }>(
      `SELECT DISTINCT product_id::text
       FROM product_collections
       WHERE product_id = ANY($1::uuid[]) AND collection_id = ANY($2::uuid[])`,
      [productIds, rule.applies_to_ids]
    );
    const matched = new Set(rows.map((r) => r.product_id));
    return lines.filter((l) => matched.has(l.product_id));
  }

  // customer_group / specific_customers etc. — product scope is the whole cart.
  return lines;
}

function sumLines(lines: DiscountCartLine[]): number {
  return lines.reduce((acc, l) => acc + l.price * l.qty, 0);
}

function totalQty(lines: DiscountCartLine[]): number {
  return lines.reduce((acc, l) => acc + l.qty, 0);
}

/**
 * Compute the buy_x_get_y / bogo discount amount for a set of in-scope lines.
 *
 * Expands lines into per-unit prices, sorts ascending, and for every X units
 * bought grants get_discount_pct% off the cheapest Y units (capped at the
 * number of remaining cheapest units).  Returns the rounded discount amount.
 */
function computeBuyXGetY(
  scopeLines: DiscountCartLine[],
  buyQty: number,
  getQty: number,
  getPct: number
): number {
  if (buyQty < 1 || getQty < 1 || getPct <= 0) return 0;

  // Expand to per-unit prices.
  const units: number[] = [];
  for (const l of scopeLines) {
    for (let i = 0; i < l.qty; i++) units.push(l.price);
  }
  if (units.length === 0) return 0;

  // Cheapest units are the ones discounted.
  units.sort((a, b) => a - b);

  // Number of complete "buy X" groups → each yields up to getQty discounted units.
  const groupSize = buyQty + getQty;
  const groups = Math.floor(units.length / groupSize);
  if (groups < 1) return 0;

  const discountedUnitCount = Math.min(groups * getQty, units.length);

  let amount = 0;
  for (let i = 0; i < discountedUnitCount; i++) {
    amount += units[i]! * (getPct / 100);
  }
  return round2(amount);
}

/**
 * Apply a single rule to the cart and return the discount it produces.
 *
 * Returns null when the rule does not apply (min thresholds, empty scope, …).
 * For free_shipping, amount is 0 and free_shipping=true.
 */
async function applyRule(
  client: pg.PoolClient | pg.Pool,
  rule: DiscountRule,
  lines: DiscountCartLine[],
  subtotal: number
): Promise<AppliedDiscountLine | null> {
  // Order-level gating thresholds use the FULL cart subtotal / qty.
  if (rule.min_order_total !== null && subtotal < rule.min_order_total) return null;
  if (rule.min_qty !== null && totalQty(lines) < rule.min_qty) return null;

  const scope = await linesInScope(client, rule, lines);
  if (scope.length === 0) return null;
  const scopeSubtotal = round2(sumLines(scope));

  let amount = 0;
  let freeShipping = false;

  switch (rule.type) {
    case "percentage": {
      if (rule.value !== null) {
        amount = scopeSubtotal * (rule.value / 100);
        if (rule.max_discount !== null) amount = Math.min(amount, rule.max_discount);
      }
      break;
    }
    case "fixed_amount": {
      if (rule.value !== null) amount = Math.min(rule.value, scopeSubtotal);
      break;
    }
    case "free_shipping": {
      freeShipping = true;
      amount = 0;
      break;
    }
    case "bogo": {
      const buyQty = metaInt(rule.metadata, "buy_quantity", 1);
      const getQty = metaInt(rule.metadata, "get_quantity", 1);
      const getPct = metaInt(rule.metadata, "get_discount_pct", 100);
      amount = computeBuyXGetY(scope, buyQty, getQty, getPct);
      if (rule.max_discount !== null) amount = Math.min(amount, rule.max_discount);
      break;
    }
    case "buy_x_get_y": {
      const buyQty = metaInt(rule.metadata, "buy_quantity", 1);
      const getQty = metaInt(rule.metadata, "get_quantity", 1);
      const getPct = metaInt(rule.metadata, "get_discount_pct", 100);
      amount = computeBuyXGetY(scope, buyQty, getQty, getPct);
      if (rule.max_discount !== null) amount = Math.min(amount, rule.max_discount);
      break;
    }
    default:
      amount = 0;
  }

  amount = round2(Math.max(0, Math.min(amount, scopeSubtotal)));

  // A rule that produces neither a subtotal discount nor free shipping is a no-op.
  if (amount === 0 && !freeShipping) return null;

  return {
    code: rule.code ?? "",
    title: rule.title,
    type: rule.type,
    amount,
    automatic: rule.automatic,
    free_shipping: freeShipping,
  };
}

/**
 * Load + filter eligible automatic discounts for a store, in priority order.
 *
 * Mirrors validateDiscount's active-window predicate (is_active, starts/ends).
 * Per-customer caps + once_per_customer are evaluated here when a customer is
 * known so a stale automatic discount is not offered; the authoritative
 * once-per-customer burn still happens in completeCheckout.
 */
async function loadAutomaticRules(
  client: pg.PoolClient | pg.Pool,
  storeId: string,
  customerId: string | null
): Promise<DiscountRule[]> {
  const { rows } = await client.query<{
    id: string;
    title: string;
    type: DiscountType;
    value: string | null;
    min_order_total: string | null;
    min_qty: number | null;
    max_discount: string | null;
    max_uses: number | null;
    uses_count: number;
    once_per_customer: boolean;
    applies_to: string;
    applies_to_ids: string[];
    customer_eligibility: string;
    eligible_ids: string[];
    allow_stacking: boolean;
    priority: number;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id::text, title, type, value::text, min_order_total::text, min_qty,
            max_discount::text, max_uses, uses_count, once_per_customer,
            applies_to, applies_to_ids::text[], customer_eligibility,
            eligible_ids::text[], allow_stacking, priority, metadata
     FROM automatic_discounts
     WHERE store_id = $1::uuid
       AND is_active = true
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at   IS NULL OR ends_at   >  now())
     ORDER BY priority DESC, created_at DESC`,
    [storeId]
  );

  const rules: DiscountRule[] = [];
  for (const r of rows) {
    // Global usage cap.
    if (r.max_uses !== null && r.uses_count >= r.max_uses) continue;

    // Customer eligibility.
    if (r.customer_eligibility === "specific_customers") {
      if (!customerId || !r.eligible_ids.includes(customerId)) continue;
    }
    // customer_groups eligibility is not modelled in this schema slice — treat
    // as not-yet-supported and skip rather than over-apply.
    if (r.customer_eligibility === "customer_groups") continue;

    // once_per_customer pre-flight (non-authoritative; burn re-checks atomically).
    if (r.once_per_customer && customerId) {
      const { rows: usage } = await client.query<{ found: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM discount_usages
           WHERE discount_id = $1::uuid AND customer_id = $2::uuid
         ) AS found`,
        [r.id, customerId]
      );
      if (usage[0]?.found === true) continue;
    }

    rules.push({
      id: r.id,
      code: null,
      title: r.title,
      type: r.type,
      value: num(r.value),
      min_order_total: num(r.min_order_total),
      min_qty: r.min_qty,
      max_discount: num(r.max_discount),
      applies_to: r.applies_to,
      applies_to_ids: r.applies_to_ids,
      allow_stacking: r.allow_stacking,
      priority: r.priority,
      metadata: r.metadata ?? {},
      automatic: true,
    });
  }
  return rules;
}

/** Load a single explicit discount code as a rule (active-window + cap pre-flight). */
async function loadCodeRule(
  client: pg.PoolClient | pg.Pool,
  storeId: string,
  code: string,
  customerId: string | null
): Promise<{ rule: DiscountRule | null; error: string | null }> {
  const { rows } = await client.query<{
    id: string;
    code: string;
    type: DiscountType;
    value: string | null;
    min_order_total: string | null;
    min_qty: number | null;
    max_discount: string | null;
    max_uses: number | null;
    uses_count: number;
    once_per_customer: boolean;
    applies_to: string;
    applies_to_ids: string[];
    metadata: Record<string, unknown>;
  }>(
    `SELECT id::text, code, type, value::text, min_order_total::text, min_qty,
            max_discount::text, max_uses, uses_count, once_per_customer,
            applies_to, applies_to_ids::text[], metadata
     FROM discount_codes
     WHERE store_id = $1::uuid AND UPPER(code) = $2
       AND is_active = true
       AND (starts_at IS NULL OR starts_at <= now())
       AND (ends_at   IS NULL OR ends_at   >= now())`,
    [storeId, code.toUpperCase()]
  );

  const dc = rows[0];
  if (!dc) return { rule: null, error: "invalid or expired discount code" };

  if (dc.max_uses !== null && dc.uses_count >= dc.max_uses) {
    return { rule: null, error: "invalid or expired discount code" };
  }
  if (dc.once_per_customer) {
    if (!customerId) return { rule: null, error: "invalid or expired discount code" };
    const { rows: usage } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM discount_usages
       WHERE discount_id = $1::uuid AND customer_id = $2::uuid`,
      [dc.id, customerId]
    );
    if (parseInt(usage[0]?.count ?? "0", 10) > 0) {
      return { rule: null, error: "invalid or expired discount code" };
    }
  }

  return {
    rule: {
      id: dc.id,
      code: dc.code,
      title: dc.code,
      type: dc.type,
      value: num(dc.value),
      min_order_total: num(dc.min_order_total),
      min_qty: dc.min_qty,
      max_discount: num(dc.max_discount),
      applies_to: dc.applies_to,
      applies_to_ids: dc.applies_to_ids,
      allow_stacking: false, // explicit codes do not advertise stacking
      priority: 0,
      metadata: dc.metadata ?? {},
      automatic: false,
    },
    error: null,
  };
}

/**
 * Compute the full discount picture for a cart.
 *
 * Combines:
 *   1. an optional explicit discount CODE (validated; sets `error` if bad), and
 *   2. all eligible AUTOMATIC discounts for the store.
 *
 * Stacking semantics (matches admin model):
 *   - An explicit code always applies (subject to validation) and is evaluated
 *     first; it counts as the first applied discount.
 *   - Automatic discounts are considered in priority order (priority DESC).
 *     • If an applied discount has allow_stacking=false, no further discount
 *       stacks on top of it: when nothing-stackable is already applied we pick
 *       the single BEST automatic discount only.
 *     • If every applied discount allows stacking, additional stackable
 *       automatic discounts are applied in priority order.
 *
 * The aggregate subtotal discount is clamped to the cart subtotal.
 * Returns `error` (non-null) only for an invalid explicit code; automatic
 * discounts never error — they simply don't apply.
 */
export async function computeDiscounts(
  client: pg.PoolClient | pg.Pool,
  opts: {
    storeId: string;
    lines: DiscountCartLine[];
    subtotal: number;
    shippingTotal: number;
    customerId: string | null;
    code?: string | null;
  }
): Promise<ComputeDiscountsResult & { error: string | null }> {
  const subtotal = round2(opts.subtotal);
  const applied: AppliedDiscountLine[] = [];

  // 1) Explicit code (if provided).
  let codeError: string | null = null;
  if (opts.code) {
    const { rule, error } = await loadCodeRule(client, opts.storeId, opts.code, opts.customerId);
    if (error) {
      codeError = error;
    } else if (rule) {
      const line = await applyRule(client, rule, opts.lines, subtotal);
      if (line) applied.push(line);
    }
  }

  // 2) Automatic discounts, priority order, honouring the stacking flag.
  const autos = await loadAutomaticRules(client, opts.storeId, opts.customerId);

  if (applied.length === 0) {
    // No code applied — pick automatics.
    // First non-stacking rule that applies wins-as-best if nothing stacks.
    // Strategy: evaluate all candidates; if the highest-priority applicable
    // rule disallows stacking, apply only the single best (largest amount,
    // counting free_shipping as the shipping value). Otherwise stack all
    // stackable rules in priority order.
    const candidates: Array<{ rule: DiscountRule; line: AppliedDiscountLine }> = [];
    for (const rule of autos) {
      const line = await applyRule(client, rule, opts.lines, subtotal);
      if (line) candidates.push({ rule, line });
    }
    if (candidates.length > 0) {
      const top = candidates[0]!; // highest priority (autos already sorted)
      if (!top.rule.allow_stacking) {
        // Apply the single BEST discount by value (shipping counted at its rate).
        let best = candidates[0]!;
        const valueOf = (c: { line: AppliedDiscountLine }) =>
          c.line.free_shipping ? opts.shippingTotal : c.line.amount;
        for (const c of candidates) {
          if (valueOf(c) > valueOf(best)) best = c;
        }
        applied.push(best.line);
      } else {
        // Stack all stackable rules in priority order; stop at first
        // non-stackable encountered (it cannot combine with others).
        for (const c of candidates) {
          applied.push(c.line);
          if (!c.rule.allow_stacking) break;
        }
      }
    }
  }
  // else: a code is already applied. By policy explicit codes do not stack with
  // automatic discounts, so automatics are skipped when a code is present.

  // 3) Aggregate. Clamp subtotal discount to subtotal; apply free shipping.
  let discountTotal = 0;
  let freeShipping = false;
  for (const l of applied) {
    discountTotal = round2(discountTotal + l.amount);
    if (l.free_shipping) freeShipping = true;
  }
  if (discountTotal > subtotal) discountTotal = subtotal;
  discountTotal = round2(discountTotal);

  const shippingTotal = freeShipping ? 0 : round2(opts.shippingTotal);

  return {
    discountTotal,
    shippingTotal,
    freeShipping,
    lines: applied,
    error: codeError,
  };
}
