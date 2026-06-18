/**
 * channels/types.ts — row + IO types for outbound channel sync.
 */

/** Supported channel identifiers. More slot in via the service registry. */
export type ChannelName = "google_shopping";

export const CHANNEL_NAMES: readonly ChannelName[] = ["google_shopping"];

export function isChannelName(s: string): s is ChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(s);
}

/** Non-secret config persisted on channel_syncs.config. */
export interface ChannelSyncConfig {
  /** Google Merchant Center account id. Required for google_shopping. */
  merchant_id?: string;
  /** ISO-3166 target country, e.g. "US". */
  country?: string;
  /** ISO-4217 currency override. Falls back to the store currency. */
  currency?: string;
  /** BCP-47 content language, e.g. "en". */
  content_language?: string;
  /**
   * Which store_integrations row holds the OAuth access token. `integration_slug`
   * selects the definition (e.g. "google_merchant"); `integration_name`
   * disambiguates when a store has more than one. Token is read decrypted at
   * sync time, never persisted on channel_syncs.
   */
  integration_slug?: string;
  integration_name?: string;
  [key: string]: unknown;
}

export interface ChannelSyncRow {
  id: string;
  store_id: string;
  channel: ChannelName;
  is_active: boolean;
  config: ChannelSyncConfig;
  last_synced_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelSyncItemRow {
  id: string;
  store_id: string;
  channel_sync_id: string;
  product_id: string;
  external_id: string | null;
  status: "pending" | "synced" | "error";
  error: string | null;
  synced_at: string | null;
  updated_at: string;
}

export interface UpsertChannelSyncInput {
  channel: ChannelName;
  is_active?: boolean;
  config?: ChannelSyncConfig;
}

/** Result of a sync run — drives last_status and the API response. */
export interface SyncResult {
  /** Products successfully pushed/updated. */
  synced: number;
  /** Products that errored. */
  errored: number;
  /** Overall status for channel_syncs.last_status. */
  status: "ok" | "error" | "partial";
  /** First/aggregate error message, if any. */
  error?: string;
}
