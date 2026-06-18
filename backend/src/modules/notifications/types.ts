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

/**
 * Outbound webhook payload spec version.
 *
 * Versioning scheme: a dated string "YYYY-MM-DD" identifying the day the
 * outbound webhook payload contract last changed in a way consumers may care
 * about. This is a CALENDAR-style spec version (à la Stripe API dates), NOT
 * semver — it is opaque to consumers except for ordering by date. Bump it only
 * when the payload shape changes; additive-only fields generally do not require
 * a bump, but a bump lets pinned subscribers opt into transforms.
 *
 * The current spec version is sent on every delivery as:
 *   - a `version` field inside the JSON body (signed by the HMAC), and
 *   - the `X-Cartcrft-Version` response header.
 *
 * Per-provider pinning: a provider may pin a version via config.api_version.
 * When present AND recognised (see KNOWN_WEBHOOK_SPEC_VERSIONS) the delivery is
 * stamped with that pinned version instead of the current one. This lets a
 * future v2 payload transform be applied selectively without breaking existing
 * subscribers — see resolveWebhookVersion() in service.ts.
 */
export const WEBHOOK_SPEC_VERSION = "2026-06-01";

/**
 * Recognised webhook spec versions. A provider's config.api_version is only
 * honoured when it appears here; an unknown/garbage pin falls back to the
 * current WEBHOOK_SPEC_VERSION (fail-safe forward). When introducing a new
 * dated version, add it here AND wire its transform into the version switch in
 * service.ts.
 */
export const KNOWN_WEBHOOK_SPEC_VERSIONS = [WEBHOOK_SPEC_VERSION] as const;

export type WebhookSpecVersion = (typeof KNOWN_WEBHOOK_SPEC_VERSIONS)[number];

export function isKnownWebhookSpecVersion(v: string): v is WebhookSpecVersion {
  return (KNOWN_WEBHOOK_SPEC_VERSIONS as readonly string[]).includes(v);
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
  // Optional: only webhook-type providers require it (enforced in the service).
  webhook_url?: string | undefined;
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
