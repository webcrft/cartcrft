/**
 * segments/service.ts — Customer segmentation (RFM-style) service.
 *
 * CRUD over `customer_segments` plus on-demand membership evaluation.
 *
 * ── SQL-injection safety ────────────────────────────────────────────────────
 * Segment rules are NEVER turned into SQL by string concatenation. Each rule
 * `field` is looked up in a closed allow-list (FIELD_SQL) that maps it to a
 * HARDCODED SQL expression and a fixed operator allow-list. The condition's
 * `value` is always pushed onto a parameter array and referenced by `$n`, so a
 * malicious value (e.g. "1; DROP TABLE customers") can only ever be bound data,
 * never executed.
 *
 * Membership is computed against a per-customer aggregate CTE:
 *   total_spent  = SUM(orders.total) over paid, non-cancelled orders
 *   order_count  = COUNT of non-cancelled orders
 *   last_order_at = MAX(orders.created_at)
 */

import { getPool, getReadDb } from "../../db/pool.js";
import type {
  CustomerSegment,
  CreateSegmentInput,
  UpdateSegmentInput,
  SegmentRules,
  SegmentCondition,
  SegmentMember,
  EvaluateResult,
} from "./types.js";

// ── Rule → SQL allow-list ─────────────────────────────────────────────────────
//
// Every supported field maps to a fixed SQL expression evaluated against the
// `agg` CTE (see buildAggregateCte). Numeric fields allow a set of comparison
// operators; string fields use a bespoke fragment that binds the value as data.

const NUMERIC_OPS = new Set([">=", "<=", ">", "<", "="]);

/** Numeric field → SQL expression on the `agg` CTE. */
const NUMERIC_FIELD_SQL: Record<string, string> = {
  total_spent: "agg.total_spent",
  order_count: "agg.order_count",
  // days since the most recent order; NULL (no orders) sorts as "infinitely ago".
  last_order_days_ago:
    "COALESCE(EXTRACT(EPOCH FROM (now() - agg.last_order_at)) / 86400.0, 1e9)",
  created_days_ago: "EXTRACT(EPOCH FROM (now() - c.created_at)) / 86400.0",
};

const STRING_FIELDS = new Set(["has_tag", "email_domain"]);

/**
 * Translate a single condition into a parameterized SQL boolean expression.
 * `nextParam()` returns the placeholder index ($n) for each bound value and the
 * caller collects the values into a shared params array in order.
 */
function conditionToSql(
  cond: SegmentCondition,
  params: unknown[]
): string {
  if (NUMERIC_FIELD_SQL[cond.field as string] !== undefined) {
    const op = cond.op;
    if (!NUMERIC_OPS.has(op)) {
      throw new SegmentRuleError(`Unsupported operator "${op}" for field "${cond.field}"`);
    }
    if (typeof cond.value !== "number" || !Number.isFinite(cond.value)) {
      throw new SegmentRuleError(`Field "${cond.field}" requires a finite numeric value`);
    }
    const expr = NUMERIC_FIELD_SQL[cond.field as string]!;
    params.push(cond.value);
    return `(${expr} ${op} $${params.length})`;
  }

  if (STRING_FIELDS.has(cond.field as string)) {
    if (cond.op !== "=") {
      throw new SegmentRuleError(`Field "${cond.field}" only supports the "=" operator`);
    }
    if (typeof cond.value !== "string" || cond.value.length === 0) {
      throw new SegmentRuleError(`Field "${cond.field}" requires a non-empty string value`);
    }
    if (cond.field === "has_tag") {
      params.push(cond.value);
      // tags is text[]; membership test binds the value as data.
      return `($${params.length} = ANY(c.tags))`;
    }
    // email_domain — case-insensitive suffix match on "@domain". The domain is
    // bound as data; only the literal "@" and "%" wildcard are SQL.
    params.push(`@${cond.value.toLowerCase()}`);
    return `(lower(c.email) LIKE '%' || $${params.length})`;
  }

  throw new SegmentRuleError(`Unknown segment field "${String(cond.field)}"`);
}

/** Thrown when a rule references an unknown field/operator or a bad value. */
export class SegmentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentRuleError";
  }
}

/**
 * Build the WHERE clause from a rule set, appending bound values onto the
 * caller's `params` array so placeholder indices ($n) account for any leading
 * params (e.g. $1 = storeId) the caller already pushed. Returns the SQL boolean
 * expression. An empty condition list matches everyone (TRUE) — the documented
 * "no filter" behaviour.
 */
function rulesToWhere(rules: SegmentRules, params: unknown[]): string {
  const conditions = rules.conditions ?? [];
  if (conditions.length === 0) {
    return "TRUE";
  }
  const parts = conditions.map((cond) => conditionToSql(cond, params));
  const joiner = rules.match === "any" ? " OR " : " AND ";
  return `(${parts.join(joiner)})`;
}

/**
 * The per-customer aggregate CTE. `total_spent`/`order_count` are derived from
 * paid, non-cancelled orders; `last_order_at` is the most recent order date.
 * `$1` is always the storeId.
 */
function buildAggregateCte(): string {
  return `
    WITH agg AS (
      SELECT
        c.id AS customer_id,
        COALESCE(SUM(o.total) FILTER (
          WHERE o.status <> 'cancelled'
            AND o.financial_status IN ('paid','partially_refunded','partially_paid')
        ), 0)::numeric AS total_spent,
        COUNT(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS order_count,
        MAX(o.created_at) FILTER (WHERE o.status <> 'cancelled') AS last_order_at
      FROM customers c
      LEFT JOIN orders o
        ON o.customer_id = c.id AND o.store_id = c.store_id
      WHERE c.store_id = $1::uuid
      GROUP BY c.id
    )`;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function listSegments(storeId: string): Promise<CustomerSegment[]> {
  const pool = getReadDb();
  const { rows } = await pool.query<CustomerSegment>(
    `SELECT id::text, store_id::text, name, description, rules, is_active, created_at, updated_at
     FROM customer_segments
     WHERE store_id = $1::uuid
     ORDER BY created_at DESC`,
    [storeId]
  );
  return rows;
}

export async function getSegment(
  storeId: string,
  segmentId: string
): Promise<CustomerSegment | null> {
  const pool = getReadDb();
  const { rows } = await pool.query<CustomerSegment>(
    `SELECT id::text, store_id::text, name, description, rules, is_active, created_at, updated_at
     FROM customer_segments
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [segmentId, storeId]
  );
  return rows[0] ?? null;
}

export async function createSegment(
  storeId: string,
  input: CreateSegmentInput
): Promise<CustomerSegment> {
  validateRules(input.rules);
  const pool = getPool();
  const { rows } = await pool.query<CustomerSegment>(
    `INSERT INTO customer_segments (store_id, name, description, rules, is_active)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
     RETURNING id::text, store_id::text, name, description, rules, is_active, created_at, updated_at`,
    [
      storeId,
      input.name,
      input.description ?? null,
      JSON.stringify(input.rules),
      input.is_active ?? true,
    ]
  );
  return rows[0]!;
}

export async function updateSegment(
  storeId: string,
  segmentId: string,
  input: UpdateSegmentInput
): Promise<CustomerSegment | null> {
  if (input.rules !== undefined) validateRules(input.rules);
  const pool = getPool();
  // COALESCE-style partial update: only provided fields change.
  const { rows } = await pool.query<CustomerSegment>(
    `UPDATE customer_segments
     SET name        = COALESCE($3, name),
         description  = CASE WHEN $4::boolean THEN $5 ELSE description END,
         rules        = COALESCE($6::jsonb, rules),
         is_active    = COALESCE($7, is_active),
         updated_at   = now()
     WHERE id = $1::uuid AND store_id = $2::uuid
     RETURNING id::text, store_id::text, name, description, rules, is_active, created_at, updated_at`,
    [
      segmentId,
      storeId,
      input.name ?? null,
      input.description !== undefined,        // $4 — whether description was supplied
      input.description ?? null,              // $5 — the new (possibly null) value
      input.rules !== undefined ? JSON.stringify(input.rules) : null,
      input.is_active ?? null,
    ]
  );
  return rows[0] ?? null;
}

export async function deleteSegment(
  storeId: string,
  segmentId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM customer_segments WHERE id = $1::uuid AND store_id = $2::uuid`,
    [segmentId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Evaluation ────────────────────────────────────────────────────────────────

/**
 * Evaluate a segment's rules and return the matching customers, paginated, plus
 * a total count. Returns null if the segment does not exist for this store.
 */
export async function evaluateSegment(
  storeId: string,
  segmentId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<EvaluateResult | null> {
  const segment = await getSegment(storeId, segmentId);
  if (!segment) return null;
  return evaluateRules(storeId, segment.rules, opts);
}

/**
 * Evaluate an arbitrary rule set against a store's customers. Shared by
 * evaluateSegment and (in callers) any ad-hoc preview before saving.
 */
export async function evaluateRules(
  storeId: string,
  rules: SegmentRules,
  opts: { limit?: number; offset?: number } = {}
): Promise<EvaluateResult> {
  validateRules(rules);
  const limit = clampInt(opts.limit ?? 50, 1, 500);
  const offset = clampInt(opts.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);

  // $1 = storeId, then the rule params, then limit/offset (appended last).
  const params: unknown[] = [storeId];
  const whereSql = rulesToWhere(rules, params);
  const limitIdx = params.push(limit);
  const offsetIdx = params.push(offset);

  const cte = buildAggregateCte();
  const pool = getReadDb();

  const { rows } = await pool.query<SegmentMember & { match_count: string }>(
    `${cte}
     SELECT
       c.id::text          AS id,
       c.email             AS email,
       c.first_name        AS first_name,
       c.last_name         AS last_name,
       c.tags              AS tags,
       agg.total_spent::text AS total_spent,
       agg.order_count     AS order_count,
       agg.last_order_at   AS last_order_at,
       c.created_at        AS created_at,
       count(*) OVER ()    AS match_count
     FROM customers c
     JOIN agg ON agg.customer_id = c.id
     WHERE c.store_id = $1::uuid AND ${whereSql}
     ORDER BY agg.total_spent DESC, c.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const total = rows[0] ? parseInt(rows[0].match_count, 10) : 0;
  const members: SegmentMember[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    first_name: r.first_name,
    last_name: r.last_name,
    tags: r.tags,
    total_spent: r.total_spent,
    order_count: r.order_count,
    last_order_at: r.last_order_at,
    created_at: r.created_at,
  }));

  return { members, total, limit, offset };
}

/**
 * Return the active segments a given customer matches — useful for targeting /
 * flows. Evaluates each active segment's rules scoped to this one customer.
 */
export async function customerSegments(
  storeId: string,
  customerId: string
): Promise<CustomerSegment[]> {
  // Verify the customer belongs to the store first (store-scoped).
  const pool = getReadDb();
  const { rows: custRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM customers WHERE id = $1::uuid AND store_id = $2::uuid`,
    [customerId, storeId]
  );
  if (!custRows[0]) return [];

  const segments = await listSegments(storeId);
  const matched: CustomerSegment[] = [];

  for (const seg of segments) {
    if (!seg.is_active) continue;
    // $1 = storeId, $2 = customerId, then rule params.
    const params: unknown[] = [storeId, customerId];
    const whereSql = rulesToWhere(seg.rules, params);
    const cte = buildAggregateCte();
    const { rows } = await pool.query<{ matched: boolean }>(
      `${cte}
       SELECT TRUE AS matched
       FROM customers c
       JOIN agg ON agg.customer_id = c.id
       WHERE c.store_id = $1::uuid AND c.id = $2::uuid AND ${whereSql}
       LIMIT 1`,
      params
    );
    if (rows[0]) matched.push(seg);
  }

  return matched;
}

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Validate a rule set against the allow-list WITHOUT touching the DB, so bad
 * rules are rejected at create/update time (and surfaced as a 400 by the route).
 * Reuses conditionToSql purely for its allow-list checks; the generated SQL is
 * discarded.
 */
function validateRules(rules: SegmentRules): void {
  if (!rules || (rules.match !== "all" && rules.match !== "any")) {
    throw new SegmentRuleError('rules.match must be "all" or "any"');
  }
  if (!Array.isArray(rules.conditions)) {
    throw new SegmentRuleError("rules.conditions must be an array");
  }
  const scratch: unknown[] = [];
  for (const cond of rules.conditions) {
    conditionToSql(cond, scratch);
  }
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.floor(n), min), max);
}
