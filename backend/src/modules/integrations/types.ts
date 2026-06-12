/**
 * integrations/types.ts — TypeScript types for integrations + tracking pixels.
 * Uses explicit `| undefined` on optional fields for exactOptionalPropertyTypes.
 */

export interface IntegrationDefinitionRow {
  slug: string;
  name: string;
  category: string;
  auth_type: string;
  capabilities: string[];
  supported_events: string[];
  docs_url: string | null;
  logo_url: string | null;
}

export interface StoreIntegrationRow {
  id: string;
  store_id: string;
  integration_slug: string;
  name: string;
  oauth_account_id: string | null;
  oauth_account_name: string | null;
  config: Record<string, unknown>;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  scopes: string[];
  created_at: string;
  updated_at: string;
  integration_name: string;
  category: string;
  auth_type: string;
  capabilities: string[];
  logo_url: string | null;
}

export interface UpsertStoreIntegrationInput {
  integration_slug: string;
  name: string;
  api_key?: string | undefined;
  api_secret?: string | undefined;
  access_token?: string | undefined;
  refresh_token?: string | undefined;
  webhook_secret?: string | undefined;
  oauth_account_id?: string | undefined;
  oauth_account_name?: string | undefined;
  config?: Record<string, unknown> | undefined;
  status?: string | undefined;
  scopes?: string[] | undefined;
}

export interface TrackingPixelRow {
  id: string;
  store_id: string;
  pixel_type: string;
  name: string;
  tracking_id: string;
  fire_on: string;
  url_pattern: string | null;
  event_mapping: Record<string, unknown>;
  inject_location: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface TrackingPixelPublicRow {
  pixel_type: string;
  tracking_id: string;
  fire_on: string;
  url_pattern: string | null;
  event_mapping: Record<string, unknown>;
  inject_location: string;
  script_content: string | null;
}

export interface UpsertTrackingPixelInput {
  pixel_type: string;
  name?: string | undefined;
  tracking_id: string;
  api_secret?: string | undefined;
  access_token?: string | undefined;
  fire_on?: string | undefined;
  url_pattern?: string | undefined;
  event_mapping?: Record<string, unknown> | undefined;
  script_content?: string | undefined;
  inject_location?: string | undefined;
  is_active?: boolean | undefined;
}
