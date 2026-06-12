/**
 * subscriptions/types.ts — TypeScript types for subscription plans and subscriptions.
 */

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "paused"
  | "past_due"
  | "cancelled"
  | "expired";

export type SubscriptionInterval = "day" | "week" | "month" | "year";

export interface SubscriptionPlan {
  id: string;
  store_id: string;
  name: string;
  interval: SubscriptionInterval;
  interval_count: number;
  trial_days: number;
  is_active: boolean;
  created_at: Date;
}

export interface CreateSubscriptionPlanInput {
  name: string;
  interval: SubscriptionInterval;
  interval_count?: number | undefined;
  trial_days?: number | undefined;
  is_active?: boolean | undefined;
}

export interface UpdateSubscriptionPlanInput {
  name?: string | null | undefined;
  trial_days?: number | null | undefined;
  is_active?: boolean | null | undefined;
}

export interface SubscriptionItem {
  id: string;
  subscription_id: string;
  variant_id: string;
  quantity: number;
  price: string;
  sku?: string | null;
  product_title?: string | null;
}

export interface Subscription {
  id: string;
  store_id: string;
  customer_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  current_period_start: Date | null;
  current_period_end: Date | null;
  next_billing_at: Date | null;
  trial_ends_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
  plan_name?: string;
  interval?: string;
  interval_count?: number;
  items?: SubscriptionItem[];
  orders?: unknown[];
}

export interface CreateSubscriptionInput {
  customer_id: string;
  plan_id: string;
  items?: Array<{
    variant_id: string;
    quantity?: number | undefined;
    price: number;
  }> | undefined;
}

export interface BillSubscriptionResult {
  order_id: string;
  order_number: string;
  billing_period: number;
  next_billing_at: Date;
}
