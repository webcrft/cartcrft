/**
 * notifications/types.ts — TypeScript types for notification providers and dispatch.
 * Uses explicit `| undefined` on optional fields for exactOptionalPropertyTypes.
 */

export const VALID_NOTIFICATION_EVENTS = [
  "order.created",
  "order.updated",
  "order.cancelled",
  "payment.captured",
  "payment.refunded",
  "shipment.created",
  "shipment.updated",
  "shipment.delivered",
  "shipment.tracking_updated",
  "customer.created",
  "inventory.low",
  "quote.sent",
  "quote.converted",
  "subscription.disable",
] as const;

export type NotificationEventType = (typeof VALID_NOTIFICATION_EVENTS)[number];

export function isValidEvent(event: string): event is NotificationEventType {
  return (VALID_NOTIFICATION_EVENTS as readonly string[]).includes(event);
}

export interface NotificationProviderRow {
  id: string;
  name: string;
  type: string;
  webhook_url: string | null;
  config: Record<string, unknown>;
  events: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateNotificationProviderInput {
  name: string;
  webhook_url: string;
  events: string[];
  webhook_secret?: string | undefined;
  config?: Record<string, unknown> | undefined;
  type?: string | undefined;
}

export interface UpdateNotificationProviderInput {
  name?: string | undefined;
  webhook_url?: string | undefined;
  is_active?: boolean | undefined;
  events?: string[] | undefined;
  webhook_secret?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface DeliveryLogRow {
  id: string;
  provider_id: string;
  store_id: string;
  event: string;
  payload: Record<string, unknown>;
  attempt_number: number;
  status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  duration_ms: number | null;
  delivered_at: string;
}
