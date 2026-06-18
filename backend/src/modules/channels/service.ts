/**
 * channels/service.ts — outbound channel sync service.
 *
 * Responsibilities:
 *  - CRUD/config for channel_syncs (enable/disable/configure a channel per store).
 *  - List sync items (per-product state).
 *  - listChannelProducts(storeId) — flatten the catalog into ChannelProduct rows
 *    (one per active product, using its first/default variant), reusing the
 *    product→item mapping logic the feeds module uses (title/description,
 *    slug→link, image, price, in/out-of-stock from inventory, brand, gtin/mpn).
 *  - runChannelSync(storeId, channel, deps) — load active config + credentials,
 *    list products, push via the connector (INJECTABLE), upsert channel_sync_items
 *    with external_id/status, and update last_synced_at/last_status/last_error.
 *
 * The connector is injected via deps so tests never hit Google. Background-worker
 * reads use getPool() (BYPASSRLS) since jobs have no per-request tenant context;
 * every query is scoped by store_id.
 */

import { getPool, getReadDb } from "../../db/pool.js";
import { config as appConfig } from "../../config/config.js";
import { decodeSecretValue } from "../../lib/secrets.js";
import {
  getConnector,
  type ChannelConnector,
  type ChannelProduct,
  type ProductSyncOutcome,
  type SyncContext,
} from "./connector.js";
import {
  type ChannelName,
  type ChannelSyncConfig,
  type ChannelSyncRow,
  type ChannelSyncItemRow,
  type SyncResult,
  type UpsertChannelSyncInput,
} from "./types.js";

// ── Store info (currency for the channel resource) ──────────────────────────────

async function getStoreCurrency(storeId: string): Promise<string> {
  const pool = getReadDb();
  const res = await pool.query<{ currency: string; domain: string }>(
    `SELECT COALESCE(currency, 'USD') AS currency, COALESCE(domain, '') AS domain
     FROM stores WHERE id = $1::uuid`,
    [storeId]
  );
  return res.rows[0]?.currency ?? "USD";
}

async function getStoreUrl(storeId: string): Promise<string> {
  const pool = getReadDb();
  const res = await pool.query<{ domain: string }>(
    `SELECT COALESCE(domain, '') AS domain FROM stores WHERE id = $1::uuid`,
    [storeId]
  );
  let url = res.rows[0]?.domain ?? "";
  if (url && !url.startsWith("http")) url = "https://" + url;
  return url;
}

// ── channel_syncs CRUD ──────────────────────────────────────────────────────────

export async function listChannelSyncs(storeId: string): Promise<ChannelSyncRow[]> {
  const pool = getReadDb();
  const res = await pool.query<ChannelSyncRow>(
    `SELECT id::text, store_id::text, channel, is_active, config,
            last_synced_at, last_status, last_error, created_at, updated_at
     FROM channel_syncs
     WHERE store_id = $1::uuid
     ORDER BY channel`,
    [storeId]
  );
  return res.rows;
}

export async function getChannelSync(
  storeId: string,
  channel: ChannelName
): Promise<ChannelSyncRow | null> {
  const pool = getReadDb();
  const res = await pool.query<ChannelSyncRow>(
    `SELECT id::text, store_id::text, channel, is_active, config,
            last_synced_at, last_status, last_error, created_at, updated_at
     FROM channel_syncs
     WHERE store_id = $1::uuid AND channel = $2`,
    [storeId, channel]
  );
  return res.rows[0] ?? null;
}

export async function upsertChannelSync(
  storeId: string,
  input: UpsertChannelSyncInput
): Promise<ChannelSyncRow> {
  const pool = getPool();
  const configJson = JSON.stringify(input.config ?? {});
  const res = await pool.query<ChannelSyncRow>(
    `INSERT INTO channel_syncs (store_id, channel, is_active, config)
     VALUES ($1::uuid, $2, COALESCE($3, true), $4::jsonb)
     ON CONFLICT (store_id, channel) DO UPDATE SET
       is_active = COALESCE(EXCLUDED.is_active, channel_syncs.is_active),
       config    = EXCLUDED.config,
       updated_at = now()
     RETURNING id::text, store_id::text, channel, is_active, config,
               last_synced_at, last_status, last_error, created_at, updated_at`,
    [storeId, input.channel, input.is_active ?? null, configJson]
  );
  const row = res.rows[0];
  if (!row) throw new Error("upsertChannelSync: no row returned");
  return row;
}

export async function setChannelSyncActive(
  storeId: string,
  channel: ChannelName,
  isActive: boolean
): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE channel_syncs SET is_active = $3, updated_at = now()
     WHERE store_id = $1::uuid AND channel = $2`,
    [storeId, channel, isActive]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteChannelSync(
  storeId: string,
  channel: ChannelName
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM channel_syncs WHERE store_id = $1::uuid AND channel = $2`,
    [storeId, channel]
  );
}

export async function listChannelSyncItems(
  storeId: string,
  channelSyncId: string
): Promise<ChannelSyncItemRow[]> {
  const pool = getReadDb();
  const res = await pool.query<ChannelSyncItemRow>(
    `SELECT id::text, store_id::text, channel_sync_id::text, product_id::text,
            external_id, status, error, synced_at, updated_at
     FROM channel_sync_items
     WHERE store_id = $1::uuid AND channel_sync_id = $2::uuid
     ORDER BY updated_at DESC`,
    [storeId, channelSyncId]
  );
  return res.rows;
}

// ── Credentials ─────────────────────────────────────────────────────────────────

/**
 * Read the decrypted OAuth access token for a store's channel integration.
 *
 * Mirrors how shipping/payments read encrypted per-store config: select the
 * matching store_integrations row and decode its access_token via the
 * AUTH_SECRETS_KEY path (decodeSecretValue handles dev plaintext passthrough).
 *
 * Resolution: config.integration_slug (+ optional integration_name) → the
 * store_integrations row; returns "" when no token is configured.
 */
export async function getChannelAccessToken(
  storeId: string,
  cfg: ChannelSyncConfig
): Promise<string> {
  const slug = cfg.integration_slug;
  if (!slug) return "";
  const pool = getReadDb();
  const params: unknown[] = [storeId, slug];
  let nameClause = "";
  if (cfg.integration_name) {
    nameClause = " AND lower(name) = lower($3)";
    params.push(cfg.integration_name);
  }
  const res = await pool.query<{ access_token: string | null }>(
    `SELECT access_token
     FROM store_integrations
     WHERE store_id = $1::uuid AND integration_slug = $2${nameClause}
     ORDER BY updated_at DESC
     LIMIT 1`,
    params
  );
  const stored = res.rows[0]?.access_token ?? "";
  if (!stored) return "";
  return decodeSecretValue(stored, appConfig.AUTH_SECRETS_KEY ?? "");
}

// ── Catalog → ChannelProduct ────────────────────────────────────────────────────

/**
 * Flatten the active catalog into one ChannelProduct per product (using its
 * first/default active variant). Reuses the same column mapping the feeds module
 * uses for Google Shopping items (modules/feeds/service.ts getFeedItems):
 * title/description, slug→link, image, price, availability from inventory,
 * brand, gtin/mpn.
 */
export async function listChannelProducts(storeId: string): Promise<ChannelProduct[]> {
  const pool = getReadDb();
  const storeUrl = await getStoreUrl(storeId);

  const res = await pool.query<{
    product_id: string;
    title: string;
    description: string;
    slug: string;
    image_url: string;
    price: string;
    in_stock: boolean;
    brand: string;
    gtin: string;
    mpn: string;
  }>(
    `SELECT DISTINCT ON (p.id)
       p.id::text                                                 AS product_id,
       COALESCE(pv.title, p.title)                                AS title,
       COALESCE(p.description, '')                                AS description,
       p.slug                                                     AS slug,
       COALESCE(pfd.image_url,
         (SELECT COALESCE(pm.cdn_url, pm.url) FROM product_media pm
          WHERE pm.product_id = p.id ORDER BY pm.position ASC LIMIT 1),
         ''
       )                                                          AS image_url,
       pv.price::text                                             AS price,
       (COALESCE(il.quantity_on_hand, 0) > 0
         OR pv.track_inventory = false)                           AS in_stock,
       COALESCE(pfd.brand, p.vendor, '')                          AS brand,
       COALESCE(pfd.gtin, pv.barcode, '')                         AS gtin,
       COALESCE(pfd.mpn, pv.sku, '')                              AS mpn
     FROM products p
     JOIN product_variants pv ON pv.product_id = p.id AND pv.is_active = true
     LEFT JOIN product_feed_data pfd ON pfd.variant_id = pv.id
     LEFT JOIN inventory_levels il ON il.variant_id = pv.id
     WHERE p.store_id = $1::uuid
       AND p.status = 'active'
     ORDER BY p.id, pv.position ASC
     LIMIT 50000`,
    [storeId]
  );

  return res.rows.map((r) => {
    const product: ChannelProduct = {
      productId: r.product_id,
      offerId: r.product_id,
      title: r.title,
      link: storeUrl ? `${storeUrl}/products/${r.slug}` : `/products/${r.slug}`,
      price: r.price,
      inStock: r.in_stock,
    };
    if (r.description) product.description = r.description;
    if (r.image_url) product.imageLink = r.image_url;
    if (r.brand) product.brand = r.brand;
    if (r.gtin) product.gtin = r.gtin;
    if (r.mpn) product.mpn = r.mpn;
    return product;
  });
}

// ── channel_sync_items upsert ───────────────────────────────────────────────────

async function recordOutcomes(
  storeId: string,
  channelSyncId: string,
  outcomes: ProductSyncOutcome[]
): Promise<void> {
  if (outcomes.length === 0) return;
  const pool = getPool();
  // Idempotent upsert keyed by unique(channel_sync_id, product_id): re-running a
  // sync UPDATEs the existing row rather than inserting a duplicate.
  for (const o of outcomes) {
    await pool.query(
      `INSERT INTO channel_sync_items
         (store_id, channel_sync_id, product_id, external_id, status, error, synced_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
               CASE WHEN $5 = 'synced' THEN now() ELSE NULL END)
       ON CONFLICT (channel_sync_id, product_id) DO UPDATE SET
         external_id = COALESCE(EXCLUDED.external_id, channel_sync_items.external_id),
         status      = EXCLUDED.status,
         error       = EXCLUDED.error,
         synced_at   = CASE WHEN EXCLUDED.status = 'synced' THEN now()
                            ELSE channel_sync_items.synced_at END,
         updated_at  = now()`,
      [
        storeId,
        channelSyncId,
        o.productId,
        o.externalId ?? null,
        o.status,
        o.error ?? null,
      ]
    );
  }
}

// ── runChannelSync ──────────────────────────────────────────────────────────────

export interface RunChannelSyncDeps {
  /** Inject a connector to avoid hitting the real channel API (tests). */
  connector?: ChannelConnector;
  /** "products" (default) or "inventory" (availability/price refresh). */
  mode?: "products" | "inventory";
  signal?: AbortSignal;
}

/**
 * Run a sync for one (store, channel):
 *   1. Load the active channel_syncs row.
 *   2. Resolve credentials (decrypted access token) + currency/country.
 *   3. List catalog products.
 *   4. Push via the connector (injectable); connector reports per-product
 *      outcomes → channel_sync_items upsert.
 *   5. Update last_synced_at / last_status / last_error.
 *
 * Never throws on a connector/API failure — records last_status='error' instead.
 */
export async function runChannelSync(
  storeId: string,
  channel: ChannelName,
  deps: RunChannelSyncDeps = {}
): Promise<SyncResult> {
  const sync = await getChannelSync(storeId, channel);
  if (!sync) {
    return { synced: 0, errored: 0, status: "error", error: "channel not configured" };
  }
  if (!sync.is_active) {
    return { synced: 0, errored: 0, status: "error", error: "channel is not active" };
  }

  const connector = deps.connector ?? getConnector(channel);
  if (!connector) {
    return { synced: 0, errored: 0, status: "error", error: `no connector for channel ${channel}` };
  }

  const cfg = sync.config ?? {};
  const accessToken = await getChannelAccessToken(storeId, cfg);
  const currency = (cfg.currency || (await getStoreCurrency(storeId))).toUpperCase();
  const country = (cfg.country ?? "US").toUpperCase();
  const contentLanguage = cfg.content_language ?? "en";
  const products = await listChannelProducts(storeId);

  const ctx: SyncContext = {
    storeId,
    channelSyncId: sync.id,
    config: cfg,
    accessToken,
    currency,
    country,
    contentLanguage,
    products,
    recordOutcomes: (outcomes) => recordOutcomes(storeId, sync.id, outcomes),
    signal: deps.signal,
  };

  let result: SyncResult;
  try {
    result =
      deps.mode === "inventory"
        ? await connector.syncInventory(ctx)
        : await connector.syncProducts(ctx);
  } catch (err) {
    // Connectors are expected to be graceful, but never let a throw escape.
    result = {
      synced: 0,
      errored: products.length,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await updateSyncStatus(storeId, channel, result);
  return result;
}

async function updateSyncStatus(
  storeId: string,
  channel: ChannelName,
  result: SyncResult
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE channel_syncs SET
       last_synced_at = now(),
       last_status    = $3,
       last_error     = $4,
       updated_at     = now()
     WHERE store_id = $1::uuid AND channel = $2`,
    [storeId, channel, result.status, result.error ?? null]
  );
}

// ── Worker discovery ────────────────────────────────────────────────────────────

/** All (store_id, channel) pairs with an active sync. Cross-store (BYPASSRLS). */
export async function listActiveChannelSyncs(): Promise<
  Array<{ storeId: string; channel: ChannelName }>
> {
  const pool = getPool();
  const res = await pool.query<{ store_id: string; channel: ChannelName }>(
    `SELECT store_id::text, channel FROM channel_syncs WHERE is_active = true`
  );
  return res.rows.map((r) => ({ storeId: r.store_id, channel: r.channel }));
}
