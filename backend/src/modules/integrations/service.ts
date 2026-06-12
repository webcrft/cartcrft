/**
 * integrations/service.ts — SQL-backed service for integration definitions,
 * store integrations (with encrypted creds), and tracking pixels.
 */

import { getPool } from "../../db/pool.js";
import { encodeSecretValue } from "../../lib/secrets.js";
import { config } from "../../config/config.js";
import type {
  IntegrationDefinitionRow,
  StoreIntegrationRow,
  UpsertStoreIntegrationInput,
  TrackingPixelRow,
  TrackingPixelPublicRow,
  UpsertTrackingPixelInput,
} from "./types.js";

// ── Integration definitions ────────────────────────────────────────────────────

export async function listIntegrationDefinitions(
  category?: string
): Promise<IntegrationDefinitionRow[]> {
  const pool = getPool();
  let res;
  if (category) {
    res = await pool.query<IntegrationDefinitionRow>(
      `SELECT slug, name, category, auth_type, capabilities, supported_events,
              docs_url, logo_url
       FROM integration_definitions
       WHERE is_active = true AND category = $1
       ORDER BY category, name`,
      [category]
    );
  } else {
    res = await pool.query<IntegrationDefinitionRow>(
      `SELECT slug, name, category, auth_type, capabilities, supported_events,
              docs_url, logo_url
       FROM integration_definitions
       WHERE is_active = true
       ORDER BY category, name`
    );
  }
  return res.rows;
}

// ── Store integrations ─────────────────────────────────────────────────────────

export async function listStoreIntegrations(
  storeId: string
): Promise<StoreIntegrationRow[]> {
  const pool = getPool();
  const res = await pool.query<StoreIntegrationRow>(
    `SELECT si.id::text, si.store_id::text, si.integration_slug,
            si.name, si.oauth_account_id, si.oauth_account_name,
            si.config, si.status, si.last_synced_at, si.last_error,
            si.scopes, si.created_at, si.updated_at,
            id.name AS integration_name, id.category, id.auth_type,
            id.capabilities, id.logo_url
     FROM store_integrations si
     JOIN integration_definitions id ON id.slug = si.integration_slug
     WHERE si.store_id = $1::uuid
     ORDER BY id.category, si.integration_slug`,
    [storeId]
  );
  return res.rows;
}

export async function upsertStoreIntegration(
  storeId: string,
  input: UpsertStoreIntegrationInput
): Promise<{ id: string; name: string }> {
  const pool = getPool();
  const secretsKey = config.AUTH_SECRETS_KEY ?? "";

  // Verify slug exists
  const defCheck = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM integration_definitions WHERE slug = $1 AND is_active = true) AS exists`,
    [input.integration_slug]
  );
  if (!defCheck.rows[0]?.exists) {
    throw Object.assign(new Error("unknown integration"), { code: "BAD_REQUEST" });
  }

  const name = input.name.trim();
  if (!name) {
    throw Object.assign(new Error("name is required"), { code: "VALIDATION_ERROR" });
  }

  const apiKey = encodeSecretValue(input.api_key ?? "", secretsKey);
  const apiSecret = encodeSecretValue(input.api_secret ?? "", secretsKey);
  const webhookSecret = encodeSecretValue(input.webhook_secret ?? "", secretsKey);
  const accessToken = encodeSecretValue(input.access_token ?? "", secretsKey);
  const refreshToken = encodeSecretValue(input.refresh_token ?? "", secretsKey);

  const configJson = JSON.stringify(input.config ?? {});
  const status = input.status ?? "active";
  const scopes = input.scopes ?? [];

  const res = await pool.query<{ id: string }>(
    `INSERT INTO store_integrations
       (store_id, integration_slug, name,
        api_key, api_secret,
        access_token, refresh_token,
        webhook_secret,
        oauth_account_id, oauth_account_name,
        config, status, scopes)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
     ON CONFLICT (store_id, integration_slug, lower(name))
       DO UPDATE SET
         api_key            = COALESCE(EXCLUDED.api_key, store_integrations.api_key),
         api_secret         = COALESCE(EXCLUDED.api_secret, store_integrations.api_secret),
         access_token       = COALESCE(EXCLUDED.access_token, store_integrations.access_token),
         refresh_token      = COALESCE(EXCLUDED.refresh_token, store_integrations.refresh_token),
         webhook_secret     = COALESCE(EXCLUDED.webhook_secret, store_integrations.webhook_secret),
         oauth_account_id   = COALESCE(EXCLUDED.oauth_account_id, store_integrations.oauth_account_id),
         oauth_account_name = COALESCE(EXCLUDED.oauth_account_name, store_integrations.oauth_account_name),
         config             = EXCLUDED.config,
         status             = EXCLUDED.status,
         scopes             = EXCLUDED.scopes,
         updated_at         = now()
     RETURNING id::text`,
    [
      storeId,
      input.integration_slug,
      name,
      apiKey,
      apiSecret,
      accessToken,
      refreshToken,
      webhookSecret,
      input.oauth_account_id ?? null,
      input.oauth_account_name ?? null,
      configJson,
      status,
      scopes,
    ]
  );

  const id = res.rows[0]?.id;
  if (!id) throw new Error("upsertStoreIntegration: no id returned");
  return { id, name };
}

export async function deleteStoreIntegration(
  integrationId: string,
  storeId: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM store_integrations WHERE id = $1::uuid AND store_id = $2::uuid`,
    [integrationId, storeId]
  );
}

// ── Tracking pixels ────────────────────────────────────────────────────────────

export async function listTrackingPixels(storeId: string): Promise<TrackingPixelRow[]> {
  const pool = getPool();
  const res = await pool.query<TrackingPixelRow>(
    `SELECT id::text, store_id::text, pixel_type, name, tracking_id,
            fire_on, url_pattern, event_mapping, inject_location,
            is_active, created_at, updated_at
     FROM store_tracking_pixels
     WHERE store_id = $1::uuid
     ORDER BY pixel_type, name`,
    [storeId]
  );
  return res.rows;
}

export async function upsertTrackingPixel(
  storeId: string,
  input: UpsertTrackingPixelInput
): Promise<string> {
  const pool = getPool();
  const secretsKey = config.AUTH_SECRETS_KEY ?? "";

  const pixelType = input.pixel_type.trim();
  const trackingId = input.tracking_id.trim();
  if (!pixelType || !trackingId) {
    throw Object.assign(new Error("pixel_type and tracking_id are required"), { code: "VALIDATION_ERROR" });
  }

  const name = (input.name?.trim() || pixelType);
  const fireOn = input.fire_on ?? "all";
  const injectLocation = input.inject_location ?? "head";

  // Encrypt optional sensitive fields
  const apiSecret = encodeSecretValue(input.api_secret ?? "", secretsKey);
  const accessToken = encodeSecretValue(input.access_token ?? "", secretsKey);

  const eventMappingJson = JSON.stringify(input.event_mapping ?? {});

  const res = await pool.query<{ id: string }>(
    `INSERT INTO store_tracking_pixels
       (store_id, pixel_type, name, tracking_id,
        api_secret, access_token,
        fire_on, url_pattern, event_mapping, script_content,
        inject_location, is_active)
     VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'{}')::jsonb,$10,$11,COALESCE($12,true))
     ON CONFLICT (store_id, pixel_type)
       DO UPDATE SET
         name             = EXCLUDED.name,
         tracking_id      = EXCLUDED.tracking_id,
         api_secret       = EXCLUDED.api_secret,
         access_token     = EXCLUDED.access_token,
         fire_on          = EXCLUDED.fire_on,
         url_pattern      = EXCLUDED.url_pattern,
         event_mapping    = EXCLUDED.event_mapping,
         script_content   = EXCLUDED.script_content,
         inject_location  = EXCLUDED.inject_location,
         is_active        = EXCLUDED.is_active,
         updated_at       = now()
     RETURNING id::text`,
    [
      storeId,
      pixelType,
      name,
      trackingId,
      apiSecret,
      accessToken,
      fireOn,
      input.url_pattern ?? null,
      eventMappingJson,
      input.script_content ?? null,
      injectLocation,
      input.is_active ?? true,
    ]
  );

  const id = res.rows[0]?.id;
  if (!id) throw new Error("upsertTrackingPixel: no id returned");
  return id;
}

export async function deleteTrackingPixel(pixelId: string, storeId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM store_tracking_pixels WHERE id = $1::uuid AND store_id = $2::uuid`,
    [pixelId, storeId]
  );
}

/**
 * Public pixel endpoint — only safe fields (no api_secret, no access_token).
 */
export async function getPublicPixels(storeId: string): Promise<TrackingPixelPublicRow[]> {
  const pool = getPool();
  const res = await pool.query<TrackingPixelPublicRow>(
    `SELECT pixel_type, tracking_id, fire_on, url_pattern,
            event_mapping, inject_location, script_content
     FROM store_tracking_pixels
     WHERE store_id = $1::uuid AND is_active = true
     ORDER BY pixel_type`,
    [storeId]
  );
  return res.rows;
}
