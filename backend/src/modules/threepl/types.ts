/**
 * threepl/types.ts — row + IO types for the 3PL / fulfillment-network adapter.
 */

/** Supported 3PL provider identifiers. More slot in via the service registry. */
export type ThreePlProviderName = "shipbob";

export const THREEPL_PROVIDER_NAMES: readonly ThreePlProviderName[] = ["shipbob"];

export function isThreePlProviderName(s: string): s is ThreePlProviderName {
  return (THREEPL_PROVIDER_NAMES as readonly string[]).includes(s);
}

/** Lifecycle of a 3PL fulfillment row (threepl_fulfillments.status). */
export type ThreePlFulfillmentStatus =
  | "pending"
  | "submitted"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "error";

/** Statuses past which no further status-pull is needed. */
export const TERMINAL_FULFILLMENT_STATUSES: readonly ThreePlFulfillmentStatus[] = [
  "delivered",
  "cancelled",
  "error",
];

/** Non-secret config persisted on threepl_providers.config. */
export interface ThreePlProviderConfig {
  /** Shipping method passed to the 3PL, e.g. "Standard". */
  shipping_method?: string;
  /**
   * Which store_integrations row holds the 3PL API token. `integration_slug`
   * selects the definition (e.g. "shipbob"); `integration_name` disambiguates
   * when a store has more than one. Token is read decrypted at submit/sync time,
   * never persisted on threepl_providers.
   */
  integration_slug?: string;
  integration_name?: string;
  /**
   * Inline token escape hatch — used only when no integration_slug is set (dev /
   * tests). decodeSecretValue handles dev plaintext passthrough.
   */
  access_token?: string;
  [key: string]: unknown;
}

export interface ThreePlProviderRow {
  id: string;
  store_id: string;
  provider: ThreePlProviderName;
  is_active: boolean;
  config: ThreePlProviderConfig;
  created_at: string;
  updated_at: string;
}

export interface ThreePlFulfillmentRow {
  id: string;
  store_id: string;
  order_id: string;
  provider: string;
  external_id: string | null;
  status: ThreePlFulfillmentStatus;
  tracking_number: string | null;
  tracking_url: string | null;
  last_error: string | null;
  submitted_at: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertThreePlProviderInput {
  provider: ThreePlProviderName;
  is_active?: boolean;
  config?: ThreePlProviderConfig;
}
