/**
 * marketing/types.ts — Shared types for the marketing flows / automation module.
 *
 * A "flow" is an event-triggered drip sequence: when a trigger entity appears
 * (a new order, a new customer, or a newly-abandoned cart), the matching active
 * flows enroll the customer into a `marketing_flow_run`. The worker then walks
 * the ordered `steps`, sending the email/SMS for each step after its delay.
 */

/** The event that enrolls a customer into a flow. */
export type TriggerEvent = "order_created" | "customer_created" | "abandoned_cart";

export const TRIGGER_EVENTS: readonly TriggerEvent[] = [
  "order_created",
  "customer_created",
  "abandoned_cart",
] as const;

/** A single delayed action in a flow. */
export type FlowAction = "email" | "sms";

export const FLOW_ACTIONS: readonly FlowAction[] = ["email", "sms"] as const;

/** One ordered step in a flow's drip sequence. */
export interface FlowStep {
  /** Delay (seconds) BEFORE this step runs, relative to the prior step / enroll. */
  delay_seconds: number;
  /** Channel for this step. */
  action: FlowAction;
  /** Email subject. Required for email steps, null/absent for sms. */
  subject: string | null;
  /** Message body (plain text; rendered into HTML for email). */
  body: string;
}

/** Run lifecycle status. */
export type FlowRunStatus = "active" | "completed" | "cancelled" | "failed";

/** A marketing flow row (store-scoped). */
export interface MarketingFlow {
  id: string;
  store_id: string;
  name: string;
  trigger_event: TriggerEvent;
  is_active: boolean;
  steps: FlowStep[];
  created_at: string;
  updated_at: string;
}

/** A marketing flow run row (one enrollment). */
export interface MarketingFlowRun {
  id: string;
  store_id: string;
  flow_id: string;
  customer_id: string | null;
  trigger_ref: string;
  current_step: number;
  status: FlowRunStatus;
  next_run_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Input to create a flow. */
export interface CreateFlowInput {
  name: string;
  trigger_event: TriggerEvent;
  steps: FlowStep[];
  is_active?: boolean;
}

/** Partial input to update a flow. */
export interface UpdateFlowInput {
  name?: string;
  trigger_event?: TriggerEvent;
  steps?: FlowStep[];
  is_active?: boolean;
}
