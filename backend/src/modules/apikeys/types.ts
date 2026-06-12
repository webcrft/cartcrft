/**
 * apikeys/types.ts — API key module types.
 *
 * Key prefixes:
 *   cc_pub_  — publishable / client-side, commerce:read only
 *   cc_prv_  — server-side secret, any scope
 *
 * Storage: SHA-256 hex hash at rest; full key returned once on creation.
 *
 * Valid scopes (cartcrft port of webcrft):
 *   commerce:read | commerce:write | commerce:admin
 */

export const VALID_SCOPES = new Set([
  "commerce:read",
  "commerce:write",
  "commerce:admin",
  "auth:read",
  "auth:write",
  "auth:admin",
]);

/** Scopes allowed on cc_pub_ (read-only) keys. */
export const READ_ONLY_SCOPES = new Set([
  "commerce:read",
  "auth:read",
]);

/** Key material returned once on creation. */
export interface ApiKeyCreated {
  id: string;
  name: string;
  key_type: "public" | "private";
  /** Full raw key — shown ONCE, never stored. */
  key: string;
  key_masked: string;
  scopes: string[];
  store_id: string | null;
  expires_at: string | null;
  created_at: string;
}

/** Safe listing row (no secret material). */
export interface ApiKeyRow {
  id: string;
  organization_id: string;
  store_id: string | null;
  name: string;
  key_type: "public" | "private";
  key_masked: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Cached key lookup result (in-memory, 30 s TTL). */
export interface CachedKey {
  orgId: string;
  storeRestriction: string | null;
  keyType: "public" | "private";
  scopes: string[];
  cachedAt: number; // Date.now()
}

export interface CreateApiKeyInput {
  name: string;
  key_type?: "public" | "private";
  scopes?: string[];
  store_id?: string | null;
  expires_at?: string | null;
}

export interface UpdateApiKeyInput {
  name?: string;
  scopes?: string[];
  store_id?: string | null | undefined; // undefined = don't touch
  store_id_clear?: boolean;             // explicit null/clear sent by client
  expires_at?: string | null;
  expires_at_clear?: boolean;           // explicit "" or null sent by client
}
