/**
 * stores/service.ts — SQL-backed store CRUD service.
 *
 * No business logic in routes — this module owns the SQL.
 * All IDs are uuid text.  Currency block if orders exist mirrors webcrft.
 */

import type pg from "pg";
import { getPool, withTx } from "../../db/pool.js";
import { encodeSecretValue } from "../../lib/secrets.js";
import type {
  StorePublic,
  CreateStoreInput,
  UpdateStoreInput,
} from "./types.js";

// ── Slug helper (mirrors webcrft slugify) ─────────────────────────────────────

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// ── Column list for API responses (never returns auth_jwt_secret) ─────────────

const STORE_COLS = `
  id::text,
  organization_id::text,
  name,
  slug,
  currency,
  weight_unit,
  timezone,
  country_code,
  email,
  phone,
  address,
  enable_currency_conversion,
  domain,
  supported_locales,
  default_locale,
  metadata,
  is_active,
  taken_down_at,
  taken_down_reason,
  auth_enabled,
  auth_allowed_origins,
  auth_token_expiry_seconds,
  auth_refresh_expiry_seconds,
  auth_magic_link_enabled,
  auth_otp_enabled,
  auth_social_providers,
  auth_require_email_verify,
  auth_max_sessions,
  agents_require_mandate,
  created_at,
  updated_at
`;

// ── Service functions ─────────────────────────────────────────────────────────

/** List all stores belonging to orgId. */
export async function listStores(
  orgId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<StorePublic[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const { rows } = await pool.query<StorePublic>(
    `SELECT ${STORE_COLS}
     FROM stores
     WHERE organization_id = $1::uuid
     ORDER BY name
     LIMIT $2 OFFSET $3`,
    [orgId, limit, offset]
  );
  return rows;
}

/** Get a single store by id. Returns null if not found. */
export async function getStore(storeId: string): Promise<StorePublic | null> {
  const pool = getPool();
  const { rows } = await pool.query<StorePublic>(
    `SELECT ${STORE_COLS}
     FROM stores
     WHERE id = $1::uuid`,
    [storeId]
  );
  return rows[0] ?? null;
}

/**
 * Verify that storeId belongs to orgId.
 * Returns true if valid.
 */
export async function storeExistsInOrg(
  storeId: string,
  orgId: string
): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM stores
       WHERE id = $1::uuid AND organization_id = $2::uuid
     ) AS exists`,
    [storeId, orgId]
  );
  return rows[0]?.exists === true;
}

/**
 * Create a new store.
 * Returns the created store id.
 * Throws { code: "DUPLICATE_SLUG" } on slug conflict.
 */
export async function createStore(
  orgId: string,
  input: CreateStoreInput
): Promise<string> {
  const pool = getPool();

  const name = input.name.trim();
  const slug = (input.slug?.trim() || slugify(name)).slice(0, 80);
  const currency = input.currency || "ZAR";
  const timezone = input.timezone || "Africa/Johannesburg";
  const weightUnit = input.weight_unit || "g";
  const enableConversion = input.enable_currency_conversion ?? false;
  const metadata = input.metadata ?? {};

  // Generate a per-store JWT secret (random 32-byte hex).
  // Encrypt with AUTH_SECRETS_KEY (AES-256-GCM) so the decode path in
  // customer-auth/service.ts (decodeSecretValue) round-trips correctly in
  // production.  When AUTH_SECRETS_KEY is unset (local dev), encodeSecretValue
  // passes the value through as plaintext — matching the decode passthrough.
  const { randomBytes } = await import("node:crypto");
  const jwtSecret = randomBytes(32).toString("hex");
  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const encodedJwtSecret = encodeSecretValue(jwtSecret, secretsKey) ?? jwtSecret;

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO stores
         (organization_id, name, slug, currency, timezone, country_code,
          email, phone, weight_unit, enable_currency_conversion,
          metadata, auth_enabled, auth_jwt_secret)
       VALUES
         ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12)
       RETURNING id::text`,
      [
        orgId,
        name,
        slug,
        currency,
        timezone,
        input.country_code ?? null,
        input.email ?? null,
        input.phone ?? null,
        weightUnit,
        enableConversion,
        JSON.stringify(metadata),
        encodedJwtSecret,
      ]
    );
    const row = rows[0];
    if (!row) throw new Error("createStore: no row returned");
    return row.id;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      const e = new Error("a store with that slug already exists");
      (e as NodeJS.ErrnoException).code = "DUPLICATE_SLUG";
      throw e;
    }
    throw err;
  }
}

/**
 * Update an existing store.
 * Blocks currency change if orders exist (mirrors webcrft).
 * Throws { code: "CURRENCY_LOCKED" } if blocked.
 * Returns false if store not found.
 */
export async function updateStore(
  storeId: string,
  input: UpdateStoreInput
): Promise<boolean> {
  const pool = getPool();

  // Block currency change if orders exist.
  if (input.currency !== undefined) {
    const { rows: curRows } = await pool.query<{ currency: string }>(
      `SELECT currency FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    const currentCurrency = curRows[0]?.currency;
    if (currentCurrency && input.currency !== currentCurrency) {
      const { rows: orderRows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM orders WHERE store_id = $1::uuid`,
        [storeId]
      );
      const orderCount = parseInt(orderRows[0]?.count ?? "0", 10);
      if (orderCount > 0) {
        const e = new Error(
          "Store has existing orders; currency cannot be changed. " +
            "Use price lists for multi-currency selling."
        );
        (e as NodeJS.ErrnoException).code = "CURRENCY_LOCKED";
        throw e;
      }
    }
  }

  const { rowCount } = await pool.query(
    `UPDATE stores SET
       name                       = COALESCE($2, name),
       slug                       = COALESCE($3, slug),
       currency                   = COALESCE($4, currency),
       timezone                   = COALESCE($5, timezone),
       country_code               = COALESCE($6, country_code),
       email                      = COALESCE($7, email),
       phone                      = COALESCE($8, phone),
       weight_unit                = COALESCE($9, weight_unit),
       is_active                  = COALESCE($10, is_active),
       enable_currency_conversion = COALESCE($11, enable_currency_conversion),
       domain                     = COALESCE($12, domain),
       metadata                   = COALESCE($13, metadata),
       agents_require_mandate     = COALESCE($14, agents_require_mandate),
       updated_at                 = now()
     WHERE id = $1::uuid`,
    [
      storeId,
      input.name ?? null,
      input.slug ?? null,
      input.currency ?? null,
      input.timezone ?? null,
      input.country_code ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.weight_unit ?? null,
      input.is_active ?? null,
      input.enable_currency_conversion ?? null,
      input.domain ?? null,
      input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
      input.agents_require_mandate ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

/** Delete a store. Returns false if not found. */
export async function deleteStore(storeId: string): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM stores WHERE id = $1::uuid`,
    [storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Super-admin takedown / restore ─────────────────────────────────────────────

/** Take down a store (super-admin only). Sets taken_down_at + reason. */
export async function takedownStore(
  storeId: string,
  reason: string,
  client?: pg.PoolClient
): Promise<void> {
  const exec = client ?? getPool();
  await exec.query(
    `UPDATE stores
     SET taken_down_at = now(),
         taken_down_reason = $2,
         is_active = false,
         updated_at = now()
     WHERE id = $1::uuid`,
    [storeId, reason]
  );
}

/** Restore a taken-down store. Clears taken_down_at. */
export async function restoreStore(
  storeId: string,
  client?: pg.PoolClient
): Promise<void> {
  const exec = client ?? getPool();
  await exec.query(
    `UPDATE stores
     SET taken_down_at = NULL,
         taken_down_reason = NULL,
         is_active = true,
         updated_at = now()
     WHERE id = $1::uuid`,
    [storeId]
  );
}
