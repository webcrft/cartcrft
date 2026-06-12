/**
 * discounts/types.ts — shared types for the discounts module.
 *
 * All DB-facing types use string IDs (uuid text).
 * Money fields are string (numeric) in API payloads; never float.
 */

export type DiscountType =
  | "percentage"
  | "fixed_amount"
  | "free_shipping"
  | "bogo"
  | "buy_x_get_y";

export type DiscountAppliesTo =
  | "order"
  | "specific_products"
  | "specific_collections"
  | "specific_customers"
  | "customer_group";

export type AutoDiscountAppliesTo =
  | "order"
  | "specific_products"
  | "specific_collections"
  | "customer_group";

export type CustomerEligibility = "all" | "specific_customers" | "customer_groups";

export interface DiscountCode {
  id: string;
  store_id: string;
  code: string;
  type: DiscountType;
  value: string | null;
  min_order_total: string | null;
  min_qty: number | null;
  max_discount: string | null;
  max_uses: number | null;
  uses_count: number;
  once_per_customer: boolean;
  applies_to: DiscountAppliesTo;
  applies_to_ids: string[];
  metadata: Record<string, unknown>;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutoDiscount {
  id: string;
  store_id: string;
  title: string;
  type: DiscountType;
  value: string | null;
  min_order_total: string | null;
  min_qty: number | null;
  max_discount: string | null;
  max_uses: number | null;
  uses_count: number;
  once_per_customer: boolean;
  applies_to: AutoDiscountAppliesTo;
  applies_to_ids: string[];
  customer_eligibility: CustomerEligibility;
  eligible_ids: string[];
  allow_stacking: boolean;
  priority: number;
  metadata: Record<string, unknown>;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDiscountInput {
  code: string;
  type: DiscountType;
  value?: string | undefined;
  min_order_total?: string | undefined;
  min_qty?: number | undefined;
  max_discount?: string | undefined;
  max_uses?: number | undefined;
  once_per_customer?: boolean | undefined;
  applies_to?: DiscountAppliesTo | undefined;
  applies_to_ids?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  starts_at?: string | null | undefined;
  ends_at?: string | null | undefined;
  is_active?: boolean | undefined;
  created_by?: string | null | undefined;
}

export interface UpdateDiscountInput {
  code?: string | undefined;
  type?: DiscountType | undefined;
  value?: string | null | undefined;
  min_order_total?: string | null | undefined;
  min_qty?: number | null | undefined;
  max_discount?: string | null | undefined;
  max_uses?: number | null | undefined;
  once_per_customer?: boolean | undefined;
  applies_to?: DiscountAppliesTo | undefined;
  applies_to_ids?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  starts_at?: string | null | undefined;
  ends_at?: string | null | undefined;
  is_active?: boolean | undefined;
}

export interface CreateAutoDiscountInput {
  title: string;
  type: DiscountType;
  value?: string | undefined;
  min_order_total?: string | undefined;
  min_qty?: number | undefined;
  max_discount?: string | undefined;
  max_uses?: number | undefined;
  once_per_customer?: boolean | undefined;
  applies_to?: AutoDiscountAppliesTo | undefined;
  applies_to_ids?: string[] | undefined;
  customer_eligibility?: CustomerEligibility | undefined;
  eligible_ids?: string[] | undefined;
  allow_stacking?: boolean | undefined;
  priority?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  starts_at?: string | null | undefined;
  ends_at?: string | null | undefined;
  is_active?: boolean | undefined;
  created_by?: string | null | undefined;
}

export interface UpdateAutoDiscountInput {
  title?: string | undefined;
  type?: DiscountType | undefined;
  value?: string | null | undefined;
  min_order_total?: string | null | undefined;
  min_qty?: number | null | undefined;
  max_discount?: string | null | undefined;
  max_uses?: number | null | undefined;
  once_per_customer?: boolean | undefined;
  applies_to?: AutoDiscountAppliesTo | undefined;
  applies_to_ids?: string[] | undefined;
  customer_eligibility?: CustomerEligibility | undefined;
  eligible_ids?: string[] | undefined;
  allow_stacking?: boolean | undefined;
  priority?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  starts_at?: string | null | undefined;
  ends_at?: string | null | undefined;
  is_active?: boolean | undefined;
}

export interface ValidateDiscountResult {
  discount_id: string;
  code: string;
  type: DiscountType;
  value: string | null;
  /** Computed discount amount, if order_total was provided. */
  computed_amount: string | null;
  max_discount: string | null;
  applies_to: DiscountAppliesTo;
  applies_to_ids: string[];
  min_order_total: string | null;
  min_qty: number | null;
  once_per_customer: boolean;
  metadata: Record<string, unknown>;
}
