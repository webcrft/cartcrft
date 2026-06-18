/**
 * threepl/connector.ts — the provider-agnostic fulfillment connector contract +
 * registry.
 *
 * A `FulfillmentProvider` knows how to submit ONE order to a single external 3PL,
 * pull its status, and cancel it. The service builds a `FulfillmentContext` (the
 * order view + credentials + config) and hands it to the connector; the connector
 * returns a `SubmitResult` / `StatusResult` the service persists onto
 * threepl_fulfillments.
 *
 * Adding a 3PL = implement FulfillmentProvider + register a factory in
 * PROVIDER_REGISTRY. The service and worker are provider-agnostic. The connector
 * is INJECTABLE via the service deps so tests never hit a real 3PL.
 */

import type { ThreePlFulfillmentStatus, ThreePlProviderConfig } from "./types.js";
import { newShipBobConnector } from "./shipbob-connector.js";

/** One order line flattened into 3PL submit shape. */
export interface FulfillmentLine {
  /** Merchant SKU / reference id. */
  sku: string;
  quantity: number;
}

/** A CartCrft order flattened into the view a 3PL submit needs. */
export interface FulfillmentOrderView {
  orderId: string;
  orderNumber: string;
  recipientName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  country: string;
  zip: string;
  email?: string;
  phone?: string;
  lines: FulfillmentLine[];
}

/**
 * Everything a connector needs to act on one order. Built by the service; the
 * connector treats it as read-only.
 */
export interface FulfillmentContext {
  storeId: string;
  /** Decrypted 3PL API token (read from store_integrations / config). "" if unset. */
  accessToken: string;
  /** Non-secret provider config (shipping_method, etc.). */
  config: ThreePlProviderConfig;
  /** The order to fulfil (present for submit; omitted for status/cancel). */
  order?: FulfillmentOrderView;
  /** Optional abort signal for the HTTP calls. */
  signal?: AbortSignal | undefined;
}

/** Result of submitting an order to a 3PL. */
export interface SubmitResult {
  /** The id the 3PL assigned (stored as external_id). */
  externalId: string;
  /** Normalized fulfillment status after submit. */
  status: ThreePlFulfillmentStatus;
  trackingNumber?: string;
  trackingUrl?: string;
}

/** Result of a status pull from a 3PL. */
export interface StatusResult {
  status: ThreePlFulfillmentStatus;
  trackingNumber?: string;
  trackingUrl?: string;
}

/** The contract every 3PL connector implements. */
export interface FulfillmentProvider {
  submit(ctx: FulfillmentContext): Promise<SubmitResult>;
  getStatus(externalId: string, ctx: FulfillmentContext): Promise<StatusResult>;
  cancel(externalId: string, ctx: FulfillmentContext): Promise<void>;
}

/** provider name → connector factory. Add new 3PLs here. */
export const PROVIDER_REGISTRY: Record<string, () => FulfillmentProvider> = {
  shipbob: newShipBobConnector,
};

/** Resolve a connector for a provider, or null if unregistered. */
export function getFulfillmentProvider(provider: string): FulfillmentProvider | null {
  const factory = PROVIDER_REGISTRY[provider];
  return factory ? factory() : null;
}
