/**
 * threepl/service.ts — 3PL / fulfillment-network adapter service.
 *
 * Responsibilities:
 *  - CRUD/config for threepl_providers (enable/disable/configure a 3PL per store).
 *  - submitOrderToThreePl(storeId, orderId, provider, deps) — load the active
 *    provider + credentials, build a fulfillment request from the order, call the
 *    connector (INJECTABLE), and upsert a threepl_fulfillments row keyed by
 *    (order_id, provider) so a re-submit never double-submits.
 *  - syncThreePlStatuses(storeId?, deps) — for non-terminal fulfillments, call the
 *    connector's getStatus, update status/tracking/last_synced_at, and emit
 *    shipment.* store events on status transitions.
 *
 * The connector is injected via deps so tests never hit a real 3PL. Background
 * worker reads use getPool() (BYPASSRLS) since jobs have no per-request tenant
 * context; every query is scoped by store_id.
 *
 * IMPORTANT: this module owns its OWN threepl_fulfillments table and only READS
 * from the orders/order_lines tables — it never touches shipping's
 * fulfillment_orders.
 */

import { getPool, getReadDb } from "../../db/pool.js";
import { config as appConfig } from "../../config/config.js";
import { decodeSecretValue } from "../../lib/secrets.js";
import { dispatchStoreEvent } from "../notifications/service.js";
import {
  getFulfillmentProvider,
  type FulfillmentProvider,
  type FulfillmentContext,
  type FulfillmentOrderView,
  type FulfillmentLine,
} from "./connector.js";
import {
  TERMINAL_FULFILLMENT_STATUSES,
  type ThreePlProviderName,
  type ThreePlProviderConfig,
  type ThreePlProviderRow,
  type ThreePlFulfillmentRow,
  type ThreePlFulfillmentStatus,
  type UpsertThreePlProviderInput,
} from "./types.js";

// Re-export the connector contract + registry so callers can `import from
// "./service.js"` (mirrors how the channels module surfaces its connector).
export {
  getFulfillmentProvider,
  type FulfillmentProvider,
  type FulfillmentContext,
  type FulfillmentOrderView,
  type SubmitResult,
  type StatusResult,
} from "./connector.js";

// ── threepl_providers CRUD ──────────────────────────────────────────────────────

export async function listThreePlProviders(storeId: string): Promise<ThreePlProviderRow[]> {
  const pool = getReadDb();
  const res = await pool.query<ThreePlProviderRow>(
    `SELECT id::text, store_id::text, provider, is_active, config,
            created_at, updated_at
     FROM threepl_providers
     WHERE store_id = $1::uuid
     ORDER BY provider`,
    [storeId]
  );
  return res.rows;
}

export async function getThreePlProvider(
  storeId: string,
  provider: ThreePlProviderName
): Promise<ThreePlProviderRow | null> {
  const pool = getReadDb();
  const res = await pool.query<ThreePlProviderRow>(
    `SELECT id::text, store_id::text, provider, is_active, config,
            created_at, updated_at
     FROM threepl_providers
     WHERE store_id = $1::uuid AND provider = $2`,
    [storeId, provider]
  );
  return res.rows[0] ?? null;
}

export async function upsertThreePlProvider(
  storeId: string,
  input: UpsertThreePlProviderInput
): Promise<ThreePlProviderRow> {
  const pool = getPool();
  const configJson = JSON.stringify(input.config ?? {});
  const res = await pool.query<ThreePlProviderRow>(
    `INSERT INTO threepl_providers (store_id, provider, is_active, config)
     VALUES ($1::uuid, $2, COALESCE($3, true), $4::jsonb)
     ON CONFLICT (store_id, provider) DO UPDATE SET
       is_active = COALESCE(EXCLUDED.is_active, threepl_providers.is_active),
       config    = EXCLUDED.config,
       updated_at = now()
     RETURNING id::text, store_id::text, provider, is_active, config,
               created_at, updated_at`,
    [storeId, input.provider, input.is_active ?? null, configJson]
  );
  const row = res.rows[0];
  if (!row) throw new Error("upsertThreePlProvider: no row returned");
  return row;
}

export async function setThreePlProviderActive(
  storeId: string,
  provider: ThreePlProviderName,
  isActive: boolean
): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE threepl_providers SET is_active = $3, updated_at = now()
     WHERE store_id = $1::uuid AND provider = $2`,
    [storeId, provider, isActive]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteThreePlProvider(
  storeId: string,
  provider: ThreePlProviderName
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM threepl_providers WHERE store_id = $1::uuid AND provider = $2`,
    [storeId, provider]
  );
}

// ── threepl_fulfillments reads ──────────────────────────────────────────────────

const FULFILLMENT_COLS = `
  id::text, store_id::text, order_id::text, provider, external_id, status,
  tracking_number, tracking_url, last_error, submitted_at, last_synced_at,
  created_at, updated_at
`;

export async function listThreePlFulfillments(
  storeId: string,
  opts: {
    status?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
): Promise<ThreePlFulfillmentRow[]> {
  const pool = getReadDb();
  const limit = Math.min(opts.limit ?? 100, 500);
  const offset = opts.offset ?? 0;
  const args: unknown[] = [storeId];
  let where = "store_id = $1::uuid";
  if (opts.status) {
    args.push(opts.status);
    where += ` AND status = $${args.length}`;
  }
  args.push(limit, offset);
  const res = await pool.query<ThreePlFulfillmentRow>(
    `SELECT ${FULFILLMENT_COLS}
     FROM threepl_fulfillments
     WHERE ${where}
     ORDER BY updated_at DESC
     LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args
  );
  return res.rows;
}

export async function getThreePlFulfillmentForOrder(
  storeId: string,
  orderId: string,
  provider?: string
): Promise<ThreePlFulfillmentRow | null> {
  const pool = getReadDb();
  const args: unknown[] = [storeId, orderId];
  let where = "store_id = $1::uuid AND order_id = $2::uuid";
  if (provider) {
    args.push(provider);
    where += ` AND provider = $${args.length}`;
  }
  const res = await pool.query<ThreePlFulfillmentRow>(
    `SELECT ${FULFILLMENT_COLS}
     FROM threepl_fulfillments
     WHERE ${where}
     ORDER BY updated_at DESC
     LIMIT 1`,
    args
  );
  return res.rows[0] ?? null;
}

// ── Credentials ─────────────────────────────────────────────────────────────────

/**
 * Read the decrypted 3PL API token for a store's provider integration.
 *
 * Mirrors channels.getChannelAccessToken / shipping / payments: resolve the
 * matching store_integrations row from config.integration_slug (+ optional
 * integration_name) and decode its access_token via the AUTH_SECRETS_KEY path
 * (decodeSecretValue handles dev plaintext passthrough). When no integration is
 * configured it falls back to an inline, already-plaintext config.access_token
 * (dev / tests — this value is NOT run through the secrets-decrypt path since it
 * was never encrypted). Returns "" when no token is available.
 */
export async function getThreePlAccessToken(
  storeId: string,
  cfg: ThreePlProviderConfig
): Promise<string> {
  const slug = cfg.integration_slug;
  if (!slug) return cfg.access_token ?? "";

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
  if (!stored) return cfg.access_token ?? "";
  return decodeSecretValue(stored, appConfig.AUTH_SECRETS_KEY ?? "");
}

// ── Order → FulfillmentOrderView ─────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Pick the first non-empty string value among the given address keys. */
function pick(addr: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = str(addr[k]);
    if (v) return v;
  }
  return "";
}

function recipientName(addr: Record<string, unknown>): string {
  const name = pick(addr, "name");
  if (name) return name;
  const first = pick(addr, "first_name");
  const last = pick(addr, "last_name");
  return [first, last].filter(Boolean).join(" ").trim();
}

/**
 * Load an order (RLS-scoped read) and flatten it into a FulfillmentOrderView:
 * recipient name/address from shipping_address jsonb, and one shippable line per
 * order_line (sku + quantity). Lines without a SKU or that are digital/non-
 * shippable are excluded. Returns null if the order does not exist.
 */
export async function buildFulfillmentOrderView(
  storeId: string,
  orderId: string
): Promise<FulfillmentOrderView | null> {
  const pool = getReadDb();
  const orderRes = await pool.query<{
    order_number: string;
    shipping_address: Record<string, unknown>;
  }>(
    `SELECT order_number, COALESCE(shipping_address, '{}'::jsonb) AS shipping_address
     FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [orderId, storeId]
  );
  const order = orderRes.rows[0];
  if (!order) return null;

  const linesRes = await pool.query<{ sku: string | null; quantity: number }>(
    `SELECT sku, quantity
     FROM order_lines
     WHERE order_id = $1::uuid
       AND requires_shipping = true
       AND is_digital = false
       AND is_gift_card = false
     ORDER BY created_at`,
    [orderId]
  );

  const lines: FulfillmentLine[] = linesRes.rows
    .filter((l) => str(l.sku) !== "" && l.quantity > 0)
    .map((l) => ({ sku: l.sku as string, quantity: l.quantity }));

  const addr = order.shipping_address ?? {};
  const view: FulfillmentOrderView = {
    orderId,
    orderNumber: order.order_number,
    recipientName: recipientName(addr),
    address1: pick(addr, "address1", "address_line1", "line1", "street_address"),
    city: pick(addr, "city"),
    state: pick(addr, "province_code", "province", "state", "zone"),
    country: pick(addr, "country_code", "country"),
    zip: pick(addr, "zip", "postal_code", "postcode"),
    lines,
  };
  const address2 = pick(addr, "address2", "address_line2", "line2");
  if (address2) view.address2 = address2;
  const email = pick(addr, "email");
  if (email) view.email = email;
  const phone = pick(addr, "phone", "phone_number");
  if (phone) view.phone = phone;
  return view;
}

// ── submitOrderToThreePl ──────────────────────────────────────────────────────────

export interface SubmitThreePlDeps {
  /** Inject a connector to avoid hitting the real 3PL API (tests). */
  connector?: FulfillmentProvider;
  signal?: AbortSignal;
}

export interface SubmitOutcome {
  fulfillment: ThreePlFulfillmentRow;
  /** True when an existing non-error fulfillment was returned as-is (idempotent). */
  alreadySubmitted: boolean;
}

/**
 * Submit an order to a store's active 3PL provider.
 *
 *   1. Load the active threepl_providers row.
 *   2. If a threepl_fulfillments row already exists for (order, provider) in a
 *      non-error state, return it unchanged (idempotent — never double-submit).
 *   3. Build the FulfillmentOrderView from the order; resolve credentials.
 *   4. Call the connector (injectable). On success, upsert external_id + status +
 *      submitted_at; on failure, record status='error' + last_error.
 *
 * Throws a coded Error for caller-facing problems (provider not configured /
 * inactive, order not found). A connector/API failure is NOT thrown — it is
 * recorded on the row and returned, so the worker/route never crashes.
 */
export async function submitOrderToThreePl(
  storeId: string,
  orderId: string,
  provider: ThreePlProviderName,
  deps: SubmitThreePlDeps = {}
): Promise<SubmitOutcome> {
  const providerRow = await getThreePlProvider(storeId, provider);
  if (!providerRow) {
    throw svcError("3PL provider not configured", "NOT_FOUND");
  }
  if (!providerRow.is_active) {
    throw svcError("3PL provider is not active", "VALIDATION_ERROR");
  }

  // Idempotency: an existing non-error fulfillment is returned as-is.
  const existing = await getThreePlFulfillmentForOrder(storeId, orderId, provider);
  if (existing && existing.status !== "error" && existing.status !== "pending") {
    return { fulfillment: existing, alreadySubmitted: true };
  }

  const view = await buildFulfillmentOrderView(storeId, orderId);
  if (!view) {
    throw svcError("order not found", "NOT_FOUND");
  }

  const connector = deps.connector ?? getFulfillmentProvider(provider);
  if (!connector) {
    throw svcError(`no connector for provider ${provider}`, "VALIDATION_ERROR");
  }

  const accessToken = await getThreePlAccessToken(storeId, providerRow.config ?? {});
  const ctx: FulfillmentContext = {
    storeId,
    accessToken,
    config: providerRow.config ?? {},
    order: view,
    signal: deps.signal,
  };

  try {
    const result = await connector.submit(ctx);
    const row = await upsertFulfillment(storeId, orderId, provider, {
      external_id: result.externalId,
      status: result.status,
      tracking_number: result.trackingNumber ?? null,
      tracking_url: result.trackingUrl ?? null,
      last_error: null,
      submitted: true,
    });
    return { fulfillment: row, alreadySubmitted: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const row = await upsertFulfillment(storeId, orderId, provider, {
      external_id: null,
      status: "error",
      tracking_number: null,
      tracking_url: null,
      last_error: msg,
      submitted: false,
    });
    return { fulfillment: row, alreadySubmitted: false };
  }
}

interface UpsertFulfillmentFields {
  external_id: string | null;
  status: ThreePlFulfillmentStatus;
  tracking_number: string | null;
  tracking_url: string | null;
  last_error: string | null;
  /** When true, stamp submitted_at (only on the first successful submit). */
  submitted: boolean;
}

/**
 * Idempotent upsert keyed by unique(order_id, provider). A re-submit UPDATEs the
 * existing row rather than inserting a duplicate. submitted_at is only stamped
 * once (COALESCE keeps an earlier value).
 */
async function upsertFulfillment(
  storeId: string,
  orderId: string,
  provider: ThreePlProviderName,
  f: UpsertFulfillmentFields
): Promise<ThreePlFulfillmentRow> {
  const pool = getPool();
  const res = await pool.query<ThreePlFulfillmentRow>(
    `INSERT INTO threepl_fulfillments
       (store_id, order_id, provider, external_id, status,
        tracking_number, tracking_url, last_error, submitted_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8,
             CASE WHEN $9 THEN now() ELSE NULL END)
     ON CONFLICT (order_id, provider) DO UPDATE SET
       external_id     = COALESCE(EXCLUDED.external_id, threepl_fulfillments.external_id),
       status          = EXCLUDED.status,
       tracking_number = COALESCE(EXCLUDED.tracking_number, threepl_fulfillments.tracking_number),
       tracking_url    = COALESCE(EXCLUDED.tracking_url, threepl_fulfillments.tracking_url),
       last_error      = EXCLUDED.last_error,
       submitted_at    = COALESCE(threepl_fulfillments.submitted_at, EXCLUDED.submitted_at),
       updated_at      = now()
     RETURNING ${FULFILLMENT_COLS}`,
    [
      storeId,
      orderId,
      provider,
      f.external_id,
      f.status,
      f.tracking_number,
      f.tracking_url,
      f.last_error,
      f.submitted,
    ]
  );
  const row = res.rows[0];
  if (!row) throw new Error("upsertFulfillment: no row returned");
  return row;
}

// ── syncThreePlStatuses ────────────────────────────────────────────────────────────

export interface SyncThreePlDeps {
  /** Inject a connector to avoid hitting the real 3PL API (tests). */
  connector?: FulfillmentProvider;
  signal?: AbortSignal;
}

/**
 * Pull fresh status for every non-terminal threepl_fulfillments row (optionally
 * scoped to a single store). For each, call the connector's getStatus, update
 * status/tracking/last_synced_at, and emit a shipment.* store event on a status
 * transition. Returns the number of rows advanced.
 *
 * Never throws on a connector/API failure — records last_error on the row instead
 * and keeps going, so one bad fulfillment never stops the worker tick.
 */
export async function syncThreePlStatuses(
  storeId: string | undefined,
  deps: SyncThreePlDeps = {}
): Promise<number> {
  const pool = getPool();
  const args: unknown[] = [];
  let where = `external_id IS NOT NULL AND status NOT IN ('pending', 'delivered', 'cancelled', 'error')`;
  if (storeId) {
    args.push(storeId);
    where = `store_id = $1::uuid AND ${where}`;
  }
  const open = await pool.query<ThreePlFulfillmentRow>(
    `SELECT ${FULFILLMENT_COLS} FROM threepl_fulfillments WHERE ${where} LIMIT 500`,
    args
  );

  // Cache provider rows + tokens per (store, provider) so we don't re-read creds.
  const providerCache = new Map<string, ThreePlProviderRow | null>();
  let advanced = 0;

  for (const row of open.rows) {
    if (!row.external_id) continue;
    const cacheKey = `${row.store_id}:${row.provider}`;
    let providerRow = providerCache.get(cacheKey);
    if (providerRow === undefined) {
      providerRow = await getThreePlProviderById(row.store_id, row.provider);
      providerCache.set(cacheKey, providerRow);
    }
    if (!providerRow) continue;

    const connector = deps.connector ?? getFulfillmentProvider(row.provider);
    if (!connector) continue;

    const accessToken = await getThreePlAccessToken(row.store_id, providerRow.config ?? {});
    const ctx: FulfillmentContext = {
      storeId: row.store_id,
      accessToken,
      config: providerRow.config ?? {},
      signal: deps.signal,
    };

    try {
      const result = await connector.getStatus(row.external_id, ctx);
      const changed =
        result.status !== row.status ||
        (result.trackingNumber ?? null) !== row.tracking_number ||
        (result.trackingUrl ?? null) !== row.tracking_url;

      await pool.query(
        `UPDATE threepl_fulfillments SET
           status          = $3,
           tracking_number = COALESCE($4, tracking_number),
           tracking_url    = COALESCE($5, tracking_url),
           last_error      = NULL,
           last_synced_at  = now(),
           updated_at      = now()
         WHERE id = $1::uuid AND store_id = $2::uuid`,
        [
          row.id,
          row.store_id,
          result.status,
          result.trackingNumber ?? null,
          result.trackingUrl ?? null,
        ]
      );

      if (changed) {
        advanced++;
        emitStatusEvent(row, result.status, result.trackingNumber, result.trackingUrl);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE threepl_fulfillments SET
           last_error = $3, last_synced_at = now(), updated_at = now()
         WHERE id = $1::uuid AND store_id = $2::uuid`,
        [row.id, row.store_id, msg]
      );
    }
  }

  return advanced;
}

/** Provider row lookup by store + provider string (BYPASSRLS — worker path). */
async function getThreePlProviderById(
  storeId: string,
  provider: string
): Promise<ThreePlProviderRow | null> {
  const pool = getPool();
  const res = await pool.query<ThreePlProviderRow>(
    `SELECT id::text, store_id::text, provider, is_active, config,
            created_at, updated_at
     FROM threepl_providers
     WHERE store_id = $1::uuid AND provider = $2`,
    [storeId, provider]
  );
  return res.rows[0] ?? null;
}

/** Map a 3PL status transition → a shipment.* store event (best-effort). */
function emitStatusEvent(
  row: ThreePlFulfillmentRow,
  status: ThreePlFulfillmentStatus,
  trackingNumber: string | undefined,
  trackingUrl: string | undefined
): void {
  const eventType =
    status === "shipped"
      ? "shipment.shipped"
      : status === "delivered"
        ? "shipment.delivered"
        : status === "cancelled"
          ? "shipment.cancelled"
          : "shipment.updated";

  const payload: Record<string, unknown> = {
    order_id: row.order_id,
    provider: row.provider,
    external_id: row.external_id,
    status,
  };
  if (trackingNumber) payload["tracking_number"] = trackingNumber;
  if (trackingUrl) payload["tracking_url"] = trackingUrl;

  dispatchStoreEvent(row.store_id, eventType, payload);
}

// ── Worker discovery ────────────────────────────────────────────────────────────

/**
 * All store_ids that have at least one active provider AND a non-terminal
 * fulfillment to pull. Cross-store (BYPASSRLS). The worker calls
 * syncThreePlStatuses(storeId) per store so a slow/failing store is isolated.
 */
export async function listStoresWithOpenThreePlFulfillments(): Promise<string[]> {
  const pool = getPool();
  const terminal = TERMINAL_FULFILLMENT_STATUSES as readonly string[];
  const res = await pool.query<{ store_id: string }>(
    `SELECT DISTINCT f.store_id::text
     FROM threepl_fulfillments f
     JOIN threepl_providers p
       ON p.store_id = f.store_id AND p.provider = f.provider AND p.is_active = true
     WHERE f.external_id IS NOT NULL
       AND f.status <> ALL($1::text[])
       AND f.status <> 'pending'`,
    [terminal]
  );
  return res.rows.map((r) => r.store_id);
}

// ── Domain errors ───────────────────────────────────────────────────────────────

function svcError(message: string, code: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}
