/**
 * apikeys/service.ts — API key issue / list / revoke service.
 *
 * Key generation:
 *   - cc_pub_ prefix for public keys (commerce:read only)
 *   - cc_prv_ prefix for private keys (any commerce scope)
 *   - 16 random bytes → hex → prefix + hex = 40-char raw key
 *   - key_hash = SHA-256(raw_key) — stored, used for lookup
 *   - key_masked = first 12 chars + "..." + last 4 chars — safe for UI
 *   - Full raw key returned once on creation, never stored again
 *
 * Cache: in-memory Map<hash, CachedKey> with 30 s TTL.
 *        Evicted on revoke. last_used_at debounced (60 s).
 */

import { createHash, randomBytes } from "node:crypto";
import { getPool, getReadDb } from "../../db/pool.js";
import {
  VALID_SCOPES,
  READ_ONLY_SCOPES,
  type ApiKeyCreated,
  type ApiKeyRow,
  type CachedKey,
  type CreateApiKeyInput,
  type UpdateApiKeyInput,
} from "./types.js";

// ── In-memory cache ──────────────────────────────────────────────────────────

const KEY_CACHE_TTL_MS = 30_000;
const LAST_USED_DEBOUNCE_MS = 60_000;

const keyCache = new Map<string, CachedKey>();
const lastUsedBumped = new Map<string, number>(); // hash → Date.now()

function evictKey(hash: string): void {
  keyCache.delete(hash);
  lastUsedBumped.delete(hash);
}

function maybeBumpLastUsed(hash: string): void {
  const last = lastUsedBumped.get(hash);
  if (last && Date.now() - last < LAST_USED_DEBOUNCE_MS) return;
  lastUsedBumped.set(hash, Date.now());
  // Fire-and-forget
  void bumpLastUsed(hash);
}

async function bumpLastUsed(hash: string): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1`,
      [hash]
    );
  } catch {
    // Best-effort; don't crash
  }
}

// ── Scope validation ─────────────────────────────────────────────────────────

/**
 * Validate a scope list against the key type.
 * Returns an error message or null.
 */
export function validateScopes(
  keyType: "public" | "private",
  scopes: string[]
): string | null {
  for (const s of scopes) {
    if (!VALID_SCOPES.has(s)) return `unknown scope: ${s}`;
    if (keyType === "public" && !READ_ONLY_SCOPES.has(s)) {
      return "public keys may only hold read-only scopes (*:read)";
    }
  }
  return null;
}

/**
 * HasScope: does the scope list satisfy the required scope?
 * :write implies :read on the same resource (e.g. commerce:write satisfies commerce:read).
 * :admin implies :write and :read.
 */
export function hasScope(scopes: string[], required: string): boolean {
  for (const s of scopes) {
    if (s === required) return true;
    // :write implies :read
    if (required.endsWith(":read")) {
      const resource = required.slice(0, required.length - ":read".length);
      if (s === `${resource}:write` || s === `${resource}:admin`) return true;
    }
    // :admin implies :write
    if (required.endsWith(":write")) {
      const resource = required.slice(0, required.length - ":write".length);
      if (s === `${resource}:admin`) return true;
    }
  }
  return false;
}

// ── Key generation ─────────────────────────────────────────────────────────────

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function maskKey(rawKey: string): string {
  // cc_pub_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx → cc_pub_xxxx...xxxx
  const prefix = rawKey.startsWith("cc_pub_")
    ? "cc_pub_"
    : rawKey.startsWith("cc_prv_")
      ? "cc_prv_"
      : "";
  const body = rawKey.slice(prefix.length);
  if (body.length <= 8) return rawKey;
  return `${prefix}${body.slice(0, 4)}...${body.slice(-4)}`;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Issue a new API key.
 * Returns ApiKeyCreated (full raw key included — shown once only).
 */
export async function createApiKey(
  orgId: string,
  createdBy: string | null,
  input: CreateApiKeyInput
): Promise<ApiKeyCreated> {
  const keyType = input.key_type ?? "private";
  const scopes = input.scopes ?? [];

  const validationErr = validateScopes(keyType, scopes);
  if (validationErr) {
    throw Object.assign(new Error(validationErr), { code: "INVALID_SCOPES" });
  }

  const prefix = keyType === "public" ? "cc_pub_" : "cc_prv_";
  const raw = `${prefix}${randomBytes(16).toString("hex")}`;
  const keyHash = hashKey(raw);
  const keyMasked = maskKey(raw);

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; created_at: string }>(
    `INSERT INTO api_keys
       (organization_id, store_id, name, key_hash, key_masked, scopes,
        expires_at, created_by, is_active, metadata)
     VALUES
       ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, true, '{}')
     RETURNING id::text, created_at`,
    [
      orgId,
      input.store_id ?? null,
      input.name,
      keyHash,
      keyMasked,
      scopes,
      input.expires_at ?? null,
      createdBy ?? null,
    ]
  );

  const row = rows[0];
  if (!row) throw new Error("createApiKey: no row returned");

  return {
    id: row.id,
    name: input.name,
    key_type: keyType,
    key: raw,
    key_masked: keyMasked,
    scopes,
    store_id: input.store_id ?? null,
    expires_at: input.expires_at ?? null,
    created_at: row.created_at,
  };
}

/** List active (non-revoked) API keys for an org. */
export async function listApiKeys(orgId: string): Promise<ApiKeyRow[]> {
  const pool = getReadDb();
  const { rows } = await pool.query<ApiKeyRow>(
    `SELECT id::text,
            organization_id::text,
            store_id::text,
            name,
            CASE WHEN key_masked LIKE 'cc_pub_%' THEN 'public'::text ELSE 'private'::text END AS key_type,
            key_masked,
            scopes,
            last_used_at,
            expires_at,
            is_active,
            created_at,
            updated_at
     FROM api_keys
     WHERE organization_id = $1::uuid
       AND is_active = true
     ORDER BY created_at DESC`,
    [orgId]
  );
  return rows;
}

/**
 * Update key metadata (name, scopes, store_id, expires_at).
 * Evicts cache entry on success.
 * Returns false if key not found or revoked.
 */
export async function updateApiKey(
  keyId: string,
  orgId: string,
  input: UpdateApiKeyInput
): Promise<boolean> {
  const pool = getPool();

  // Fetch current key type for scope re-validation.
  const { rows: cur } = await pool.query<{
    key_masked: string;
    key_hash: string;
    scopes: string[];
  }>(
    `SELECT key_masked, key_hash, scopes
     FROM api_keys
     WHERE id = $1::uuid AND organization_id = $2::uuid AND is_active = true`,
    [keyId, orgId]
  );
  const current = cur[0];
  if (!current) return false;

  const keyType: "public" | "private" = current.key_masked.startsWith(
    "cc_pub_"
  )
    ? "public"
    : "private";

  if (input.scopes !== undefined) {
    const err = validateScopes(keyType, input.scopes);
    if (err) {
      throw Object.assign(new Error(err), { code: "INVALID_SCOPES" });
    }
  }

  // Build SET clauses dynamically.
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [keyId, orgId];
  let n = 3;

  if (input.name !== undefined) {
    sets.push(`name = $${n++}`);
    args.push(input.name);
  }
  if (input.scopes !== undefined) {
    sets.push(`scopes = $${n++}`);
    args.push(input.scopes);
  }
  if (input.store_id_clear) {
    sets.push("store_id = NULL");
  } else if (input.store_id !== undefined) {
    sets.push(`store_id = $${n++}::uuid`);
    args.push(input.store_id);
  }
  if (input.expires_at_clear) {
    sets.push("expires_at = NULL");
  } else if (input.expires_at !== undefined) {
    sets.push(`expires_at = $${n++}`);
    args.push(input.expires_at);
  }

  const { rowCount } = await pool.query(
    `UPDATE api_keys SET ${sets.join(", ")}
     WHERE id = $1::uuid AND organization_id = $2::uuid AND is_active = true`,
    args
  );

  if ((rowCount ?? 0) > 0) {
    evictKey(current.key_hash);
    return true;
  }
  return false;
}

/**
 * Revoke an API key (sets is_active = false).
 * Evicts cache entry on success.
 * Returns false if key not found or already revoked.
 */
export async function revokeApiKey(
  keyId: string,
  orgId: string
): Promise<boolean> {
  const pool = getPool();

  // Get hash to evict cache.
  const { rows: cur } = await pool.query<{ key_hash: string }>(
    `SELECT key_hash FROM api_keys
     WHERE id = $1::uuid AND organization_id = $2::uuid AND is_active = true`,
    [keyId, orgId]
  );
  if (!cur[0]) return false;

  const { rowCount } = await pool.query(
    `UPDATE api_keys
     SET is_active = false, updated_at = now()
     WHERE id = $1::uuid AND organization_id = $2::uuid AND is_active = true`,
    [keyId, orgId]
  );

  if ((rowCount ?? 0) > 0) {
    evictKey(cur[0].key_hash);
    return true;
  }
  return false;
}

// ── Key lookup (used by auth middleware) ─────────────────────────────────────

/**
 * Look up a raw API key.  Returns the cache entry if fresh, otherwise
 * queries the DB and populates the cache.
 *
 * Returns null if the key is not found, expired, or revoked.
 */
export async function lookupApiKey(rawKey: string): Promise<CachedKey | null> {
  if (!rawKey) return null;

  const hash = hashKey(rawKey);

  // Fast path: cache hit within TTL.
  const cached = keyCache.get(hash);
  if (cached && Date.now() - cached.cachedAt < KEY_CACHE_TTL_MS) {
    maybeBumpLastUsed(hash);
    return cached;
  }
  keyCache.delete(hash);

  // DB lookup.
  const pool = getPool();
  const { rows } = await pool.query<{
    organization_id: string;
    store_id: string | null;
    key_masked: string;
    scopes: string[];
  }>(
    `SELECT organization_id::text,
            store_id::text,
            key_masked,
            scopes
     FROM api_keys
     WHERE key_hash = $1
       AND is_active = true
       AND (expires_at IS NULL OR expires_at > now())`,
    [hash]
  );

  const row = rows[0];
  if (!row) return null;

  const keyType: "public" | "private" = row.key_masked.startsWith("cc_pub_")
    ? "public"
    : "private";

  const entry: CachedKey = {
    orgId: row.organization_id,
    storeRestriction: row.store_id ?? null,
    keyType,
    scopes: row.scopes ?? [],
    cachedAt: Date.now(),
  };

  keyCache.set(hash, entry);
  maybeBumpLastUsed(hash);

  return entry;
}
