/**
 * channels/connector.ts — the channel-agnostic connector contract + registry.
 *
 * A `ChannelConnector` knows how to push a store's catalog to ONE external sales
 * channel. The service builds a `SyncContext` (products + config + credentials +
 * a recordOutcomes callback) and hands it to the connector; the connector returns
 * a SyncResult and reports per-product outcomes via ctx.recordOutcomes so the
 * service can upsert channel_sync_items.
 *
 * Adding a channel = implement ChannelConnector + register a factory in
 * CONNECTOR_REGISTRY. The service and worker are channel-agnostic.
 */

import type { ChannelName, ChannelSyncConfig, SyncResult } from "./types.js";
import { newGoogleShoppingConnector } from "./google-connector.js";

/** A catalog product flattened into channel-push shape. */
export interface ChannelProduct {
  /** channel_sync_items.product_id (the CartCrft product id). */
  productId: string;
  /** Stable external offer id (we use the product id). */
  offerId: string;
  title: string;
  description?: string;
  link: string;
  imageLink?: string;
  /** Numeric string, e.g. "12.99". */
  price: string;
  inStock: boolean;
  brand?: string;
  gtin?: string;
  mpn?: string;
}

/** Per-product result the connector reports back for channel_sync_items upsert. */
export interface ProductSyncOutcome {
  productId: string;
  status: "synced" | "error";
  externalId?: string;
  error?: string;
}

/**
 * Everything a connector needs for one sync run. Built by the service; the
 * connector treats it as read-only except for calling recordOutcomes.
 */
export interface SyncContext {
  storeId: string;
  channelSyncId: string;
  config: ChannelSyncConfig;
  /** Decrypted OAuth access token (read from store_integrations). "" if unset. */
  accessToken: string;
  /** Store currency (or config override), upper-case ISO-4217. */
  currency: string;
  /** ISO-3166 target country, e.g. "US". */
  country: string;
  /** BCP-47 content language, e.g. "en". */
  contentLanguage: string;
  /** The catalog products to push. */
  products: ChannelProduct[];
  /** Persist per-product outcomes (service upserts channel_sync_items). */
  recordOutcomes: (outcomes: ProductSyncOutcome[]) => Promise<void>;
  /** Optional abort signal for the HTTP calls. */
  signal?: AbortSignal | undefined;
}

/** The contract every channel connector implements. */
export interface ChannelConnector {
  syncProducts(ctx: SyncContext): Promise<SyncResult>;
  syncInventory(ctx: SyncContext): Promise<SyncResult>;
}

/** channel name → connector factory. Add new channels here. */
export const CONNECTOR_REGISTRY: Record<ChannelName, () => ChannelConnector> = {
  google_shopping: newGoogleShoppingConnector,
};

/** Resolve a connector for a channel, or null if unregistered. */
export function getConnector(channel: ChannelName): ChannelConnector | null {
  const factory = CONNECTOR_REGISTRY[channel];
  return factory ? factory() : null;
}
