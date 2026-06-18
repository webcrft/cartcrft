/**
 * segments/types.ts — Customer segmentation (RFM-style) rule model + row types.
 *
 * A segment is a named, store-scoped rule definition whose membership is
 * computed ON DEMAND from the live customers/orders data (no materialized
 * membership table in v1).
 *
 * ── Rule model ──────────────────────────────────────────────────────────────
 * A rule is an object with a top-level boolean combinator (`match`) and a list
 * of conditions:
 *
 *   {
 *     match: "all" | "any",            // AND vs OR across the conditions
 *     conditions: [
 *       { field: "total_spent",         op: ">=", value: 100 },
 *       { field: "order_count",         op: ">=", value: 2 },
 *       { field: "last_order_days_ago", op: "<=", value: 30 },
 *       { field: "created_days_ago",    op: ">=", value: 7 },
 *       { field: "has_tag",             op: "=",  value: "vip" },
 *       { field: "email_domain",        op: "=",  value: "acme.com" },
 *     ]
 *   }
 *
 * SAFETY: `field` is a closed allow-list. Each field maps to a HARDCODED
 * parameterized SQL fragment in service.ts; the `value` is ALWAYS a bound
 * parameter. Raw rule text is never concatenated into SQL — a malicious value
 * can only ever be data, never executed.
 */

/** Numeric comparison fields (value is a number). */
export type NumericField =
  | "total_spent"          // SUM of paid order totals
  | "order_count"          // COUNT of (non-cancelled) orders
  | "last_order_days_ago"  // days since the most recent order
  | "created_days_ago";    // days since the customer was created

/** Numeric comparison operators. */
export type NumericOp = ">=" | "<=" | ">" | "<" | "=";

/** String / membership fields (value is a string). */
export type StringField =
  | "has_tag"        // customer.tags array contains value
  | "email_domain";  // customer.email ends with @value

/** String fields only support equality / containment. */
export type StringOp = "=";

export interface NumericCondition {
  field: NumericField;
  op: NumericOp;
  value: number;
}

export interface StringCondition {
  field: StringField;
  op: StringOp;
  value: string;
}

export type SegmentCondition = NumericCondition | StringCondition;

export type SegmentMatch = "all" | "any";

export interface SegmentRules {
  match: SegmentMatch;
  conditions: SegmentCondition[];
}

/** Persisted segment row (customer_segments table). */
export interface CustomerSegment {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  rules: SegmentRules;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateSegmentInput {
  name: string;
  description?: string | null | undefined;
  rules: SegmentRules;
  is_active?: boolean | undefined;
}

export interface UpdateSegmentInput {
  name?: string | undefined;
  description?: string | null | undefined;
  rules?: SegmentRules | undefined;
  is_active?: boolean | undefined;
}

/** A customer matched by a segment evaluation. */
export interface SegmentMember {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  tags: string[];
  total_spent: string;   // numeric — returned as a string to preserve precision
  order_count: number;
  last_order_at: Date | null;
  created_at: Date;
}

export interface EvaluateResult {
  members: SegmentMember[];
  total: number;
  limit: number;
  offset: number;
}
