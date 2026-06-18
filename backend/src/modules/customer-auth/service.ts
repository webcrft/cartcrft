/**
 * customer-auth/service.ts — per-store storefront customer authentication.
 *
 * Covers:
 *  - Store config load/save (auth_jwt_secret decrypt, OAuth creds decrypt)
 *  - Session issuance, rotation, revocation (refresh token family pattern)
 *  - JWT issuance + verification (per-store HS256 secret)
 *  - Password hashing/verification (argon2id primary; PBKDF2-SHA512 legacy verify + rehash-on-login)
 *  - Email flows: register, verify, reset, magic-link, invite
 *  - OAuth: Google, Microsoft, Discord upsert-and-login
 *  - Audit log + email log helpers
 *  - Mailer injection (setMailer for tests)
 */

import { randomBytes, createHash, pbkdf2Sync } from "node:crypto";
import { hashSync as argon2HashSync, verifySync as argon2VerifySync } from "@node-rs/argon2";
// @node-rs/argon2 Algorithm enum: 0=Argon2d, 1=Argon2i, 2=Argon2id
const ARGON2ID_ALGORITHM = 2 as const;
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type pg from "pg";
import type { ReadDb } from "../../db/pool.js";
import { decodeSecretValue, encodeSecretValue } from "../../lib/secrets.js";
import { ConsoleMailer } from "../../lib/mailer/console.js";
import type { Mailer } from "../../lib/mailer/index.js";
import { renderAuthEmail } from "../../lib/mailer/templates.js";
import { buildKv } from "../../lib/cache/kv.js";

// ── Module-level mailer (injectable for tests) ────────────────────────────────

let _mailer: Mailer = new ConsoleMailer();

export function setMailer(m: Mailer): void {
  _mailer = m;
}

// Alias used in tests
export const setMailerForTesting = setMailer;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoreAuthConfig {
  storeId: string;
  storeName: string;
  jwtSecret: string;
  jwtExpiryMins: number;
  sessionDurationDays: number;
  emailPasswordEnabled: boolean;
  magicLinkEnabled: boolean;
  googleEnabled: boolean;
  googleClientId: string;
  googleClientSecret: string;
  microsoftEnabled: boolean;
  msClientId: string;
  msClientSecret: string;
  discordEnabled: boolean;
  discordClientId: string;
  discordClientSecret: string;
  allowSelfRegistration: boolean;
  requireEmailVerification: boolean;
  logoUrl: string;
  brandColor: string;
  redirectUrl: string;
  emailTemplates: Record<string, unknown> | null;
  maxSessions: number;
}

export interface CustomerClaims extends JWTPayload {
  sub: string;       // customerId
  email: string;
  store: string;     // storeId
  is_admin: boolean;
  tags?: string[];
}

export interface SessionResult {
  sessionToken: string;
  accessToken: string;
}

export interface RotateResult {
  newSessionToken: string;
  accessToken: string;
  customerId: string;
  email: string;
  isAdmin: boolean;
}

// ── OAuth state (in-memory, no Redis) ────────────────────────────────────────

interface OAuthStateEntry {
  storeId: string;
  provider: string;
  /** P1-6: persist redirect_uri so callbacks can include it in provider token exchanges. */
  redirectUri: string;
  expiresAt: Date;
}

const _oauthState = new Map<string, OAuthStateEntry>();

function pruneOAuthState(): void {
  const now = new Date();
  for (const [k, v] of _oauthState) {
    if (v.expiresAt < now) _oauthState.delete(k);
  }
}

export function saveOAuthState(storeId: string, provider: string, nonce: string, redirectUri: string): void {
  pruneOAuthState();
  _oauthState.set(nonce, {
    storeId,
    provider,
    redirectUri,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
}

/**
 * Consume and validate an OAuth state nonce.
 * Returns the persisted redirectUri on success, null on failure.
 */
export function loadOAuthState(nonce: string, storeId: string, provider: string): string | null {
  pruneOAuthState();
  const entry = _oauthState.get(nonce);
  if (!entry) return null;
  if (entry.storeId !== storeId || entry.provider !== provider) return null;
  _oauthState.delete(nonce);
  return entry.redirectUri;
}

// ── Token helpers ─────────────────────────────────────────────────────────────

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}

// ── Abuse throttles (FIX 1 / FIX 3) ───────────────────────────────────────────
//
// Unauthenticated email endpoints (register, password-reset, magic-link,
// verify-email/resend) send a real email — each send costs money and can be
// weaponised as an email-bomb. We gate every send behind a KV-backed cooldown:
//
//   - per (store,email): one send per EMAIL_COOLDOWN_MS, plus an hourly cap
//   - per IP:            an hourly cap across all email sends from that IP
//
// All throttling is "fail-open generic-success": when a limit is hit we SKIP
// the send and return normally, so the caller still emits its generic
// { ok: true } response and enumeration resistance is preserved.

const EMAIL_COOLDOWN_MS = 60_000;          // min 60s between sends to same (store,email)
const EMAIL_HOURLY_WINDOW_MS = 60 * 60_000; // 1 hour window for the caps
const EMAIL_MAX_PER_EMAIL_PER_HOUR = 5;     // per (store,email)
const EMAIL_MAX_PER_IP_PER_HOUR = 30;       // per IP across all email sends

function normalizeEmailKey(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Return true when an email send to (storeId,email) from `ip` is allowed, and
 * record the send. Returns false (and records nothing extra) when any cooldown
 * or hourly cap is exceeded. Never throws — KV failures fail-open (allow).
 */
export async function checkEmailSendAllowed(
  storeId: string,
  email: string,
  ip: string
): Promise<boolean> {
  try {
    const kv = await buildKv();
    const key = normalizeEmailKey(email);
    const cooldownKey = `caemail:cd:${storeId}:${key}`;

    // 60s cooldown: a recent marker means we must skip.
    const recent = await kv.get(cooldownKey);
    if (recent) return false;

    // Hourly cap per (store,email).
    const perEmail = await kv.incrWithWindow(
      `caemail:eh:${storeId}:${key}`,
      EMAIL_HOURLY_WINDOW_MS
    );
    if (perEmail > EMAIL_MAX_PER_EMAIL_PER_HOUR) return false;

    // Hourly cap per IP (skip when IP unknown).
    if (ip) {
      const perIp = await kv.incrWithWindow(
        `caemail:ih:${ip}`,
        EMAIL_HOURLY_WINDOW_MS
      );
      if (perIp > EMAIL_MAX_PER_IP_PER_HOUR) return false;
    }

    // Mark the cooldown only once we've decided to allow the send.
    await kv.set(cooldownKey, "1", EMAIL_COOLDOWN_MS);
    return true;
  } catch {
    // KV unavailable — never block a legitimate auth email.
    return true;
  }
}

// Per-IP login throttle (FIX 3): progressive backoff so an attacker cannot lock
// a victim's account by guessing from one IP, and brute-force from a single IP
// is rate-limited independently of the per-account lockout. The threshold is
// well above the per-account lockout (MAX_LOGIN_ATTEMPTS) so legitimate account
// lockout semantics are unaffected.
const LOGIN_IP_WINDOW_MS = 15 * 60_000; // 15-minute window
const LOGIN_IP_MAX_ATTEMPTS = 50;       // attempts per IP per window before 429

/**
 * Record a login attempt from `ip` and return whether the IP is now throttled.
 * Returns false (not throttled) on KV failure (fail-open).
 */
export async function registerLoginAttemptThrottled(ip: string): Promise<boolean> {
  if (!ip) return false;
  try {
    const kv = await buildKv();
    const count = await kv.incrWithWindow(`calogin:ip:${ip}`, LOGIN_IP_WINDOW_MS);
    return count > LOGIN_IP_MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

// ── Password hashing (argon2id primary; PBKDF2-SHA512 legacy) ────────────────
//
// New hashes use argon2id (prefix: "$argon2id$").
// Legacy hashes use PBKDF2-SHA512 (prefix: "pbkdf2:").
// On login: detect by prefix, verify with the correct algorithm.
// If a legacy PBKDF2 hash verifies successfully, rehash to argon2id
// transparently and update the stored hash (rehash-on-login migration).

const PBKDF2_ITERS = 100_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = "sha512";

const ARGON2_OPTS = {
  algorithm: ARGON2ID_ALGORITHM,
  // defaults: memoryCost=19456 KiB (~19 MiB), timeCost=2, parallelism=1
} as const;

/** Returns true when the stored hash was produced by argon2id. */
export function isArgon2Hash(stored: string): boolean {
  return stored.startsWith("$argon2id$");
}

/** Hash a new password with argon2id (sync). */
export function hashPasswordSync(password: string): string {
  return argon2HashSync(password, ARGON2_OPTS);
}

/**
 * Verify a password against a stored hash (either argon2id or legacy PBKDF2).
 * Does NOT perform rehashing — call `verifyAndMaybeRehash` at login for that.
 */
export function verifyPasswordSync(password: string, stored: string): boolean {
  if (!stored) return false;
  if (isArgon2Hash(stored)) {
    return argon2VerifySync(stored, password);
  }
  // Legacy PBKDF2-SHA512 path
  const parts = stored.split(":");
  if (parts[0] !== "pbkdf2" || parts.length !== 3) return false;
  const salt = parts[1]!;
  const expected = parts[2]!;
  const dk = pbkdf2Sync(password, salt, PBKDF2_ITERS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return dk.toString("hex") === expected;
}

/**
 * Verify a password and, if the hash is a legacy PBKDF2 hash and the
 * password matches, update the stored hash to argon2id in the DB
 * (rehash-on-login migration). Returns the verification result.
 */
export async function verifyAndMaybeRehash(
  pool: pg.Pool,
  customerId: string,
  password: string,
  stored: string
): Promise<boolean> {
  if (!stored) return false;
  if (isArgon2Hash(stored)) {
    return argon2VerifySync(stored, password);
  }
  // Legacy PBKDF2 path
  const valid = verifyPasswordSync(password, stored);
  if (valid) {
    // Transparently upgrade to argon2id
    try {
      const newHash = hashPasswordSync(password);
      await pool.query(
        `UPDATE customers SET password_hash = $2, updated_at = now() WHERE id = $1::uuid`,
        [customerId, newHash]
      );
    } catch {
      // Rehash failure must not block login — the user is authenticated
    }
  }
  return valid;
}

// ── Store config ──────────────────────────────────────────────────────────────

export async function loadStoreConfig(
  pool: pg.Pool,
  storeId: string,
  secretsKey: string
): Promise<StoreAuthConfig> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    auth_jwt_secret: string | null;
    auth_jwt_expiry_mins: number | null;
    auth_session_duration_days: number | null;
    auth_email_password_enabled: boolean | null;
    auth_magic_link_enabled: boolean | null;
    auth_google_enabled: boolean | null;
    auth_google_client_id: string | null;
    auth_google_client_secret_enc: string | null;
    auth_microsoft_enabled: boolean | null;
    auth_ms_client_id: string | null;
    auth_ms_client_secret_enc: string | null;
    auth_discord_enabled: boolean | null;
    auth_discord_client_id: string | null;
    auth_discord_client_secret_enc: string | null;
    auth_allow_self_registration: boolean | null;
    auth_require_email_verification: boolean | null;
    auth_logo_url: string | null;
    auth_brand_color: string | null;
    auth_redirect_url: string | null;
    auth_email_templates: unknown;
    auth_max_sessions: number | null;
  }>(
    `SELECT id, name, auth_jwt_secret,
            auth_jwt_expiry_mins, auth_session_duration_days,
            auth_email_password_enabled, auth_magic_link_enabled,
            auth_google_enabled, auth_google_client_id, auth_google_client_secret_enc,
            auth_microsoft_enabled, auth_ms_client_id, auth_ms_client_secret_enc,
            auth_discord_enabled, auth_discord_client_id, auth_discord_client_secret_enc,
            auth_allow_self_registration, auth_require_email_verification,
            auth_logo_url, auth_brand_color, auth_redirect_url,
            auth_email_templates, auth_max_sessions
     FROM stores
     WHERE id = $1::uuid AND is_active = true`,
    [storeId]
  );
  const row = rows[0];
  if (!row) throw Object.assign(new Error("store not found"), { statusCode: 404 });

  const jwtSecret = row.auth_jwt_secret
    ? decodeSecretValue(row.auth_jwt_secret, secretsKey)
    : "";
  const googleSecret = row.auth_google_client_secret_enc
    ? decodeSecretValue(row.auth_google_client_secret_enc, secretsKey)
    : "";
  const msSecret = row.auth_ms_client_secret_enc
    ? decodeSecretValue(row.auth_ms_client_secret_enc, secretsKey)
    : "";
  const discordSecret = row.auth_discord_client_secret_enc
    ? decodeSecretValue(row.auth_discord_client_secret_enc, secretsKey)
    : "";

  return {
    storeId: row.id,
    storeName: row.name,
    jwtSecret,
    jwtExpiryMins: row.auth_jwt_expiry_mins ?? 60,
    sessionDurationDays: row.auth_session_duration_days ?? 30,
    emailPasswordEnabled: row.auth_email_password_enabled ?? true,
    magicLinkEnabled: row.auth_magic_link_enabled ?? false,
    googleEnabled: row.auth_google_enabled ?? false,
    googleClientId: row.auth_google_client_id ?? "",
    googleClientSecret: googleSecret,
    microsoftEnabled: row.auth_microsoft_enabled ?? false,
    msClientId: row.auth_ms_client_id ?? "",
    msClientSecret: msSecret,
    discordEnabled: row.auth_discord_enabled ?? false,
    discordClientId: row.auth_discord_client_id ?? "",
    discordClientSecret: discordSecret,
    allowSelfRegistration: row.auth_allow_self_registration ?? true,
    requireEmailVerification: row.auth_require_email_verification ?? false,
    logoUrl: row.auth_logo_url ?? "",
    brandColor: row.auth_brand_color ?? "",
    redirectUrl: row.auth_redirect_url ?? "",
    emailTemplates: (row.auth_email_templates as Record<string, unknown>) ?? null,
    maxSessions: row.auth_max_sessions ?? 5,
  };
}

// ── Auth config CRUD ──────────────────────────────────────────────────────────

export async function getAuthConfig(
  pool: pg.Pool,
  storeId: string
): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `SELECT auth_enabled, auth_email_password_enabled, auth_magic_link_enabled,
            auth_otp_enabled, auth_google_enabled, auth_google_client_id,
            auth_microsoft_enabled, auth_ms_client_id,
            auth_discord_enabled, auth_discord_client_id,
            auth_allow_self_registration, auth_require_email_verification,
            auth_jwt_expiry_mins, auth_session_duration_days, auth_max_sessions,
            auth_logo_url, auth_brand_color, auth_redirect_url,
            auth_allowed_origins, auth_email_templates
     FROM stores WHERE id = $1::uuid`,
    [storeId]
  );
  return rows[0] ?? {};
}

export async function updateAuthConfig(
  pool: pg.Pool,
  storeId: string,
  secretsKey: string,
  body: Record<string, unknown>
): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [storeId];

  function add(col: string, val: unknown) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }

  const boolCols = [
    "auth_enabled", "auth_email_password_enabled", "auth_magic_link_enabled",
    "auth_otp_enabled", "auth_google_enabled", "auth_microsoft_enabled",
    "auth_discord_enabled", "auth_allow_self_registration",
    "auth_require_email_verification",
  ];
  const numCols = ["auth_jwt_expiry_mins", "auth_session_duration_days", "auth_max_sessions"];
  const strCols = [
    "auth_google_client_id", "auth_ms_client_id", "auth_discord_client_id",
    "auth_logo_url", "auth_brand_color", "auth_redirect_url",
  ];

  for (const key of boolCols) {
    if (key in body) add(key, body[key]);
  }
  for (const key of numCols) {
    if (key in body) add(key, body[key]);
  }
  for (const key of strCols) {
    if (key in body) add(key, body[key]);
  }

  if ("auth_jwt_secret" in body && typeof body["auth_jwt_secret"] === "string") {
    add("auth_jwt_secret", encodeSecretValue(body["auth_jwt_secret"] as string, secretsKey));
  }
  if ("auth_google_client_secret" in body && typeof body["auth_google_client_secret"] === "string") {
    add("auth_google_client_secret_enc", encodeSecretValue(body["auth_google_client_secret"] as string, secretsKey));
  }
  if ("auth_ms_client_secret" in body && typeof body["auth_ms_client_secret"] === "string") {
    add("auth_ms_client_secret_enc", encodeSecretValue(body["auth_ms_client_secret"] as string, secretsKey));
  }
  if ("auth_discord_client_secret" in body && typeof body["auth_discord_client_secret"] === "string") {
    add("auth_discord_client_secret_enc", encodeSecretValue(body["auth_discord_client_secret"] as string, secretsKey));
  }
  if ("auth_allowed_origins" in body) add("auth_allowed_origins", body["auth_allowed_origins"]);
  if ("auth_email_templates" in body) add("auth_email_templates", JSON.stringify(body["auth_email_templates"]));

  if (sets.length === 0) return true;
  sets.push("updated_at = now()");

  const res = await pool.query(
    `UPDATE stores SET ${sets.join(", ")} WHERE id = $1::uuid`,
    params
  );
  return (res.rowCount ?? 0) > 0;
}

// ── JWT ───────────────────────────────────────────────────────────────────────

/**
 * Audience claim for a per-store customer JWT.
 * Scoped to the store so a customer token from store A is rejected by store B's
 * verifyCustomerJwt() call even if they share the same JWT secret (defence in depth).
 */
export function customerJwtAudience(storeId: string): string {
  return `cartcrft:store:${storeId}`;
}

/** Issuer claim for all customer (storefront) JWTs. */
export const CUSTOMER_JWT_ISSUER = "cartcrft" as const;

export async function issueCustomerJwt(
  secret: string,
  customerId: string,
  email: string,
  isAdmin: boolean,
  storeId: string,
  tags: string[],
  expiryMins: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const key = new TextEncoder().encode(secret);
  // jti omitted: no revocation list exists for customer tokens.
  // Revocation is handled via customers.tokens_invalidated_at timestamp
  // (checked in verifyCustomerJwt), which is a lighter-weight and actually
  // enforced mechanism.
  return new SignJWT({
    sub: customerId,
    email,
    store: storeId,
    is_admin: isAdmin,
    tags,
    iat: now,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(CUSTOMER_JWT_ISSUER)
    .setAudience(customerJwtAudience(storeId))
    .setExpirationTime(`${expiryMins}m`)
    .sign(key);
}

export async function verifyCustomerJwt(
  token: string,
  secret: string,
  pool?: pg.Pool,
  storeId?: string
): Promise<CustomerClaims | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const verifyOpts: Parameters<typeof jwtVerify>[2] = {
      algorithms: ["HS256"],
      issuer: CUSTOMER_JWT_ISSUER,
    };
    // Validate store-scoped audience when storeId is provided.
    // When storeId is absent (legacy call sites during migration) skip audience
    // check — the store claim is still validated below.
    if (storeId) {
      verifyOpts.audience = customerJwtAudience(storeId);
    }
    const { payload } = await jwtVerify(token, key, verifyOpts);
    const claims = payload as CustomerClaims;
    if (!claims.sub || !claims.store) return null;

    if (pool) {
      const { rows } = await pool.query<{ tokens_invalidated_at: Date | null }>(
        `SELECT tokens_invalidated_at FROM customers WHERE id = $1::uuid`,
        [claims.sub]
      );
      const row = rows[0];
      if (row?.tokens_invalidated_at) {
        const iat = claims.iat ?? 0;
        if (iat < row.tokens_invalidated_at.getTime() / 1000) {
          return null;
        }
      }
    }
    return claims;
  } catch {
    return null;
  }
}

// ── Bearer auth ───────────────────────────────────────────────────────────────

export async function bearerAuth(
  pool: pg.Pool,
  authorization: string,
  storeId: string,
  secretsKey: string
): Promise<CustomerClaims | null> {
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : authorization;
  if (!bearer) return null;

  let cfg: StoreAuthConfig;
  try {
    cfg = await loadStoreConfig(pool, storeId, secretsKey);
  } catch {
    return null;
  }
  if (!cfg.jwtSecret) return null;

  return verifyCustomerJwt(bearer, cfg.jwtSecret, pool, storeId);
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function issueSession(
  pool: pg.Pool,
  customerId: string,
  storeId: string,
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<SessionResult> {
  const { raw: sessionRaw, hash: sessionHash } = generateToken();
  const familyId = randomBytes(16).toString("hex");
  const expiresAt = new Date(
    Date.now() + cfg.sessionDurationDays * 24 * 60 * 60 * 1000
  );

  // Enforce max sessions — prune oldest beyond limit
  const { rows: activeSessions } = await pool.query<{ id: string }>(
    `SELECT id::text FROM customer_sessions
     WHERE customer_id = $1::uuid AND store_id = $2::uuid AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [customerId, storeId]
  );
  if (activeSessions.length >= cfg.maxSessions) {
    const toRevoke = activeSessions.slice(cfg.maxSessions - 1).map(r => r.id);
    if (toRevoke.length > 0) {
      await pool.query(
        `UPDATE customer_sessions SET revoked_at = now(), is_revoked = true
         WHERE id = ANY($1::uuid[])`,
        [toRevoke]
      );
    }
  }

  await pool.query(
    `INSERT INTO customer_sessions
       (store_id, customer_id, refresh_token_hash, expires_at, ip_address, user_agent, family_id)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::inet, $6, $7::uuid)`,
    [storeId, customerId, sessionHash, expiresAt, ip || null, userAgent || null, familyId]
  );

  const { rows } = await pool.query<{
    email: string;
    is_admin: boolean;
    tags: string[];
  }>(
    `SELECT email, coalesce(is_admin, false) as is_admin,
            coalesce(tags, '{}') as tags
     FROM customers WHERE id = $1::uuid`,
    [customerId]
  );
  const customer = rows[0];
  if (!customer) throw new Error("customer not found");

  if (!cfg.jwtSecret) throw Object.assign(new Error("store JWT secret not configured"), { statusCode: 500 });

  const accessToken = await issueCustomerJwt(
    cfg.jwtSecret,
    customerId,
    customer.email,
    customer.is_admin,
    storeId,
    customer.tags,
    cfg.jwtExpiryMins
  );

  await pool.query(
    `UPDATE customers
     SET sign_in_count = coalesce(sign_in_count, 0) + 1,
         last_sign_in_at = now(),
         failed_login_attempts = 0,
         updated_at = now()
     WHERE id = $1::uuid`,
    [customerId]
  );

  return { sessionToken: sessionRaw, accessToken };
}

export async function rotateSession(
  pool: pg.Pool,
  rawToken: string,
  storeId: string,
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<RotateResult> {
  const hash = hashToken(rawToken);

  // P1-3: Atomic consume — a single UPDATE...WHERE revoked_at IS NULL AND
  // is_revoked = false AND expires_at > now() RETURNING.
  // Zero rows means the session was already consumed (reuse) or expired/unknown.
  const { rows } = await pool.query<{
    id: string;
    customer_id: string;
    family_id: string | null;
    expires_at: Date;
  }>(
    `UPDATE customer_sessions
        SET revoked_at = now(), is_revoked = true
      WHERE refresh_token_hash = $1
        AND store_id = $2::uuid
        AND revoked_at IS NULL
        AND is_revoked = false
        AND expires_at > now()
      RETURNING id::text, customer_id::text, family_id::text, expires_at`,
    [hash, storeId]
  );
  const session = rows[0];

  if (!session) {
    // Determine whether reuse or expired/unknown for best error message.
    const { rows: existing } = await pool.query<{
      revoked_at: Date | null;
      is_revoked: boolean;
      family_id: string | null;
      expires_at: Date;
    }>(
      `SELECT revoked_at, is_revoked, family_id::text, expires_at
         FROM customer_sessions
        WHERE refresh_token_hash = $1 AND store_id = $2::uuid`,
      [hash, storeId]
    );
    const prev = existing[0];
    if (prev && (prev.revoked_at !== null || prev.is_revoked)) {
      // Reuse-detection: revoke the entire token family.
      if (prev.family_id) {
        await revokeSessionFamily(pool, prev.family_id);
      }
      throw Object.assign(new Error("session token already used — possible replay attack"), { statusCode: 401 });
    }
    throw Object.assign(new Error("invalid session token"), { statusCode: 401 });
  }

  const { raw: newRaw, hash: newHash } = generateToken();
  const expiresAt = new Date(
    Date.now() + cfg.sessionDurationDays * 24 * 60 * 60 * 1000
  );
  const familyId = session.family_id ?? randomBytes(16).toString("hex");

  const { rows: newSessionRows } = await pool.query<{ id: string }>(
    `INSERT INTO customer_sessions
       (store_id, customer_id, refresh_token_hash, expires_at, ip_address, user_agent, family_id)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::inet, $6, $7::uuid)
     RETURNING id::text`,
    [storeId, session.customer_id, newHash, expiresAt, ip || null, userAgent || null, familyId]
  );

  if (newSessionRows[0]) {
    await pool.query(
      `UPDATE customer_sessions SET replaced_by = $1::uuid WHERE id = $2::uuid`,
      [newSessionRows[0].id, session.id]
    );
  }

  const { rows: custRows } = await pool.query<{
    email: string;
    is_admin: boolean;
    tags: string[];
  }>(
    `SELECT email, coalesce(is_admin, false) as is_admin, coalesce(tags, '{}') as tags
     FROM customers WHERE id = $1::uuid`,
    [session.customer_id]
  );
  const customer = custRows[0];
  if (!customer) throw new Error("customer not found");

  const accessToken = await issueCustomerJwt(
    cfg.jwtSecret,
    session.customer_id,
    customer.email,
    customer.is_admin,
    storeId,
    customer.tags,
    cfg.jwtExpiryMins
  );

  return {
    newSessionToken: newRaw,
    accessToken,
    customerId: session.customer_id,
    email: customer.email,
    isAdmin: customer.is_admin,
  };
}

export async function revokeSessionFamily(pool: pg.Pool, familyId: string): Promise<void> {
  await pool.query(
    `UPDATE customer_sessions SET revoked_at = now(), is_revoked = true
     WHERE family_id = $1::uuid AND revoked_at IS NULL`,
    [familyId]
  );
}

export async function revokeAllSessions(pool: pg.Pool, customerId: string): Promise<void> {
  await pool.query(
    `UPDATE customer_sessions SET revoked_at = now(), is_revoked = true
     WHERE customer_id = $1::uuid AND revoked_at IS NULL`,
    [customerId]
  );
}

export async function invalidateCustomerTokens(pool: pg.Pool, customerId: string): Promise<void> {
  await pool.query(
    `UPDATE customers SET tokens_invalidated_at = now(), updated_at = now()
     WHERE id = $1::uuid`,
    [customerId]
  );
  await revokeAllSessions(pool, customerId);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function caAudit(
  pool: pg.Pool,
  storeId: string,
  customerId: string | null,
  event: string,
  ip: string,
  userAgent: string,
  data?: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO customer_audit_log
         (store_id, customer_id, event, ip_address, user_agent, data)
       VALUES ($1::uuid, $2, $3, $4::inet, $5, $6)`,
      [
        storeId,
        customerId ?? null,
        event,
        ip || null,
        userAgent || null,
        JSON.stringify(data ?? {}),
      ]
    );
  } catch {
    // audit log must not break main flow
  }
}

// ── Email log ─────────────────────────────────────────────────────────────────

export async function getEmailLog(
  pool: ReadDb,
  storeId: string,
  limit = 50
): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, to_email, subject, template_name,
            status, error, sent_at, created_at
     FROM customer_email_log
     WHERE store_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2`,
    [storeId, limit]
  );
  return rows;
}

// ── Email templates ───────────────────────────────────────────────────────────

interface EmailVars {
  storeName?: string;
  logoUrl?: string;
  brandColor?: string;
  redirectUrl?: string;
  token?: string;
  link?: string;
  email?: string;
  name?: string;
}

/**
 * Render a customer-auth email template.
 *
 * C-10c: delegates to lib/mailer/templates.ts renderAuthEmail() for branded,
 * responsive HTML with inline CSS. All user-supplied values are XSS-escaped
 * inside the renderer. Plain-text fallback is always included.
 *
 * External callers (e.g. createInvitation) use this function directly.
 */
export function renderAuthEmailTemplate(
  name: string,
  vars: EmailVars
): { subject: string; bodyText: string; bodyHtml: string } {
  const result = renderAuthEmail(name, vars);
  return { subject: result.subject, bodyText: result.bodyText, bodyHtml: result.bodyHtml };
}

// ── Send customer email ───────────────────────────────────────────────────────

export async function sendCustomerEmail(
  pool: pg.Pool,
  storeId: string,
  cfg: Pick<StoreAuthConfig, "storeName" | "logoUrl" | "brandColor" | "redirectUrl">,
  toEmail: string,
  templateName: string,
  vars: EmailVars
): Promise<void> {
  const { subject, bodyText, bodyHtml } = renderAuthEmailTemplate(templateName, {
    storeName: cfg.storeName,
    logoUrl: cfg.logoUrl,
    brandColor: cfg.brandColor,
    redirectUrl: cfg.redirectUrl,
    ...vars,
  });

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customer_email_log (store_id, to_email, subject, template_name, status)
     VALUES ($1::uuid, $2, $3, $4, 'pending')
     RETURNING id::text`,
    [storeId, toEmail, subject, templateName]
  );
  const logId = rows[0]?.id;

  try {
    await _mailer.send({
      to: toEmail,
      fromName: cfg.storeName,
      fromEmail: "noreply@cartcrft.app",
      subject,
      bodyHtml,
      bodyText,
    });
    if (logId) {
      await pool.query(
        `UPDATE customer_email_log SET status = 'sent', sent_at = now() WHERE id = $1::uuid`,
        [logId]
      );
    }
  } catch (err) {
    if (logId) {
      await pool.query(
        `UPDATE customer_email_log SET status = 'failed', error = $2 WHERE id = $1::uuid`,
        [logId, err instanceof Error ? err.message : String(err)]
      );
    }
    throw err;
  }
}

export async function sendTestEmail(
  pool: pg.Pool,
  storeId: string,
  cfg: StoreAuthConfig,
  toEmail: string
): Promise<void> {
  await sendCustomerEmail(pool, storeId, cfg, toEmail, "customer.magic_link", {
    link: "https://example.com/test",
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

export async function registerCustomer(
  pool: pg.Pool,
  storeId: string,
  email: string,
  password: string,
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<{ customerId: string; requiresVerification: boolean }> {
  if (!cfg.allowSelfRegistration) {
    throw Object.assign(new Error("self-registration is disabled for this store"), { statusCode: 403 });
  }
  if (!cfg.emailPasswordEnabled) {
    throw Object.assign(new Error("email/password auth is disabled"), { statusCode: 400 });
  }

  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id::text FROM customers WHERE store_id = $1::uuid AND email = $2`,
    [storeId, email.toLowerCase().trim()]
  );
  if (existing[0]) {
    throw Object.assign(new Error("email already registered"), { statusCode: 409 });
  }

  const passwordHash = hashPasswordSync(password);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active)
     VALUES ($1::uuid, $2, $3, 'email', true)
     RETURNING id::text`,
    [storeId, email.toLowerCase().trim(), passwordHash]
  );
  const customerId = rows[0]?.id;
  if (!customerId) throw new Error("failed to create customer");

  await caAudit(pool, storeId, customerId, "customer.register", ip, userAgent);

  if (cfg.requireEmailVerification) {
    await sendEmailVerification(pool, storeId, customerId, email, cfg, ip);
  }

  return { customerId, requiresVerification: cfg.requireEmailVerification };
}

// ── Email verification ────────────────────────────────────────────────────────

export async function sendEmailVerification(
  pool: pg.Pool,
  storeId: string,
  customerId: string,
  email: string,
  cfg: Pick<StoreAuthConfig, "storeName" | "logoUrl" | "brandColor" | "redirectUrl">,
  ip = ""
): Promise<void> {
  // FIX 1: cooldown the verification email (email-bomb / cost-DoS). On throttle
  // skip silently — both register and verify-email/resend return generic success.
  if (!(await checkEmailSendAllowed(storeId, email, ip))) return;

  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO customer_email_verifications (store_id, customer_id, token_hash, expires_at)
     VALUES ($1::uuid, $2::uuid, $3, $4)`,
    [storeId, customerId, hash, expiresAt]
  );

  const redirectUrl = (cfg as StoreAuthConfig).redirectUrl ?? "http://localhost:3000";
  const link = `${redirectUrl || "http://localhost:3000"}/auth/verify-email?token=${raw}&store=${storeId}`;
  await sendCustomerEmail(pool, storeId, cfg, email, "customer.email_verify", { link });
}

export async function verifyEmail(
  pool: pg.Pool,
  storeId: string,
  rawToken: string
): Promise<string | null> {
  const hash = hashToken(rawToken);
  const { rows } = await pool.query<{
    id: string;
    customer_id: string;
    expires_at: Date;
    used_at: Date | null;
  }>(
    `SELECT id::text, customer_id::text, expires_at, used_at
     FROM customer_email_verifications
     WHERE token_hash = $1 AND store_id = $2::uuid`,
    [hash, storeId]
  );
  const row = rows[0];
  if (!row || row.used_at || new Date() > row.expires_at) return null;

  await pool.query(
    `UPDATE customer_email_verifications SET used_at = now() WHERE id = $1::uuid`,
    [row.id]
  );
  await pool.query(
    `UPDATE customers
     SET email_verified = true,
         email_verified_at = coalesce(email_verified_at, now()),
         updated_at = now()
     WHERE id = $1::uuid`,
    [row.customer_id]
  );
  return row.customer_id;
}

// ── Login ─────────────────────────────────────────────────────────────────────

const MAX_LOGIN_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

export async function loginWithPassword(
  pool: pg.Pool,
  storeId: string,
  email: string,
  password: string,
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<SessionResult> {
  if (!cfg.emailPasswordEnabled) {
    throw Object.assign(new Error("email/password auth is disabled"), { statusCode: 400 });
  }

  // FIX 3: per-IP login throttle (progressive backoff). Counts every attempt
  // from this IP across all accounts so a single IP cannot brute-force or lock
  // arbitrary victims; threshold sits well above the per-account lockout.
  if (await registerLoginAttemptThrottled(ip)) {
    throw Object.assign(
      new Error("too many login attempts from this network — try again later"),
      { statusCode: 429 }
    );
  }

  const { rows } = await pool.query<{
    id: string;
    password_hash: string | null;
    email_verified: boolean;
    is_blocked: boolean;
    is_active: boolean;
    failed_login_attempts: number;
    locked_until: Date | null;
  }>(
    `SELECT id::text, password_hash, coalesce(email_verified, false) as email_verified,
            coalesce(is_blocked, false) as is_blocked,
            coalesce(is_active, true) as is_active,
            coalesce(failed_login_attempts, 0) as failed_login_attempts,
            locked_until
     FROM customers
     WHERE store_id = $1::uuid AND email = $2`,
    [storeId, email.toLowerCase().trim()]
  );
  const customer = rows[0];

  if (!customer) {
    throw Object.assign(new Error("invalid email or password"), { statusCode: 401 });
  }
  if (!customer.is_active) {
    throw Object.assign(new Error("account is inactive"), { statusCode: 401 });
  }
  if (customer.is_blocked) {
    throw Object.assign(new Error("account is blocked"), { statusCode: 403 });
  }
  if (customer.locked_until && new Date() < customer.locked_until) {
    throw Object.assign(new Error("account temporarily locked due to too many failed attempts"), { statusCode: 423 });
  }
  if (!customer.password_hash) {
    throw Object.assign(new Error("no password set — use social or magic-link login"), { statusCode: 400 });
  }

  const valid = await verifyAndMaybeRehash(pool, customer.id, password, customer.password_hash);

  if (!valid) {
    const attempts = customer.failed_login_attempts + 1;
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      await pool.query(
        `UPDATE customers
         SET failed_login_attempts = $2, locked_until = $3, updated_at = now()
         WHERE id = $1::uuid`,
        [customer.id, attempts, lockedUntil]
      );
      await caAudit(pool, storeId, customer.id, "customer.lockout", ip, userAgent);
      throw Object.assign(new Error("account temporarily locked due to too many failed attempts"), { statusCode: 423 });
    }
    await pool.query(
      `UPDATE customers SET failed_login_attempts = $2, updated_at = now() WHERE id = $1::uuid`,
      [customer.id, attempts]
    );
    throw Object.assign(new Error("invalid email or password"), { statusCode: 401 });
  }

  if (cfg.requireEmailVerification && !customer.email_verified) {
    throw Object.assign(new Error("email not verified — check your inbox"), { statusCode: 403 });
  }

  // FIX 3 (Low): reset the per-account failed-attempt counter AND clear any
  // residual lockout on a successful login (the dashboard path does this; the
  // storefront path previously cleared only failed_login_attempts via
  // issueSession and left locked_until stale).
  await pool.query(
    `UPDATE customers
        SET failed_login_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE id = $1::uuid`,
    [customer.id]
  );

  await caAudit(pool, storeId, customer.id, "customer.login", ip, userAgent);
  return issueSession(pool, customer.id, storeId, cfg, ip, userAgent);
}

// ── Password reset ────────────────────────────────────────────────────────────

export async function requestPasswordReset(
  pool: pg.Pool,
  storeId: string,
  email: string,
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM customers WHERE store_id = $1::uuid AND email = $2 AND is_active = true`,
    [storeId, email.toLowerCase().trim()]
  );
  if (!rows[0]) return; // silent

  // FIX 1: per-(store,email) + per-IP cooldown before sending (email-bomb / cost-DoS).
  // On throttle we silently skip — caller still returns generic success.
  if (!(await checkEmailSendAllowed(storeId, email, ip))) return;

  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO customer_password_resets (store_id, customer_id, token_hash, expires_at, ip_address)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::inet)`,
    [storeId, rows[0].id, hash, expiresAt, ip || null]
  );

  const link = `${cfg.redirectUrl || "http://localhost:3000"}/auth/reset-password?token=${raw}&store=${storeId}`;
  await sendCustomerEmail(pool, storeId, cfg, email, "customer.password_reset", { link });
  await caAudit(pool, storeId, rows[0].id, "customer.password_reset_request", ip, userAgent);
}

export async function completePasswordReset(
  pool: pg.Pool,
  storeId: string,
  rawToken: string,
  newPassword: string
): Promise<boolean> {
  const hash = hashToken(rawToken);
  const { rows } = await pool.query<{
    id: string;
    customer_id: string;
    expires_at: Date;
    used_at: Date | null;
  }>(
    `SELECT id::text, customer_id::text, expires_at, used_at
     FROM customer_password_resets
     WHERE token_hash = $1 AND store_id = $2::uuid`,
    [hash, storeId]
  );
  const row = rows[0];
  if (!row || row.used_at || new Date() > row.expires_at) return false;

  const newHash = hashPasswordSync(newPassword);
  await pool.query(
    `UPDATE customers
     SET password_hash = $2, tokens_invalidated_at = now(), updated_at = now()
     WHERE id = $1::uuid`,
    [row.customer_id, newHash]
  );
  await pool.query(
    `UPDATE customer_password_resets SET used_at = now() WHERE id = $1::uuid`,
    [row.id]
  );
  await revokeAllSessions(pool, row.customer_id);
  return true;
}

// ── Magic link ────────────────────────────────────────────────────────────────

export async function sendMagicLink(
  pool: pg.Pool,
  storeId: string,
  email: string,
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<void> {
  if (!cfg.magicLinkEnabled) {
    throw Object.assign(new Error("magic link auth is disabled"), { statusCode: 400 });
  }

  // FIX 1: enforce the cooldown BEFORE any DB write so a throttled request never
  // auto-creates a customer row (avoids row-creation abuse) and never sends an
  // email. Silently skip — caller returns generic success (enumeration-safe).
  if (!(await checkEmailSendAllowed(storeId, email, ip))) return;

  let customerId: string;
  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id::text FROM customers WHERE store_id = $1::uuid AND email = $2`,
    [storeId, email.toLowerCase().trim()]
  );
  if (existing[0]) {
    customerId = existing[0].id;
  } else {
    if (!cfg.allowSelfRegistration) {
      throw Object.assign(new Error("self-registration is disabled"), { statusCode: 403 });
    }
    const { rows: newRows } = await pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, 'magic_link', true, true)
       RETURNING id::text`,
      [storeId, email.toLowerCase().trim()]
    );
    customerId = newRows[0]?.id ?? "";
    if (!customerId) throw new Error("failed to create customer");
  }

  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await pool.query(
    `INSERT INTO customer_magic_links (store_id, customer_id, token_hash, expires_at, ip_address)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::inet)`,
    [storeId, customerId, hash, expiresAt, ip || null]
  );

  const link = `${cfg.redirectUrl || "http://localhost:3000"}/auth/magic?token=${raw}&store=${storeId}`;
  await sendCustomerEmail(pool, storeId, cfg, email, "customer.magic_link", { link });
  await caAudit(pool, storeId, customerId, "customer.magic_link_request", ip, userAgent);
}

export async function verifyMagicLink(
  pool: pg.Pool,
  storeId: string,
  rawToken: string,
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<SessionResult> {
  const hash = hashToken(rawToken);
  const { rows } = await pool.query<{
    id: string;
    customer_id: string;
    expires_at: Date;
    used_at: Date | null;
  }>(
    `SELECT id::text, customer_id::text, expires_at, used_at
     FROM customer_magic_links
     WHERE token_hash = $1 AND store_id = $2::uuid`,
    [hash, storeId]
  );
  const row = rows[0];
  if (!row || row.used_at || new Date() > row.expires_at) {
    throw Object.assign(new Error("invalid or expired magic link"), { statusCode: 401 });
  }

  await pool.query(
    `UPDATE customer_magic_links SET used_at = now() WHERE id = $1::uuid`,
    [row.id]
  );
  await pool.query(
    `UPDATE customers
     SET email_verified = true,
         email_verified_at = coalesce(email_verified_at, now()),
         updated_at = now()
     WHERE id = $1::uuid`,
    [row.customer_id]
  );

  await caAudit(pool, storeId, row.customer_id, "customer.magic_link_used", ip, userAgent);
  return issueSession(pool, row.customer_id, storeId, cfg, ip, userAgent);
}

// ── Invitations ───────────────────────────────────────────────────────────────

export async function createInvitation(
  pool: pg.Pool,
  storeId: string,
  email: string
): Promise<void> {
  const { raw, hash } = generateToken();

  await pool.query(
    `INSERT INTO customer_invitations (store_id, email, token_hash)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (store_id, email)
     DO UPDATE SET token_hash = $3,
                   expires_at = now() + interval '7 days',
                   accepted_at = null`,
    [storeId, email.toLowerCase().trim(), hash]
  );

  const { rows } = await pool.query<{
    name: string;
    auth_redirect_url: string | null;
    auth_brand_color: string | null;
    auth_logo_url: string | null;
  }>(
    `SELECT name, auth_redirect_url, auth_brand_color, auth_logo_url
     FROM stores WHERE id = $1::uuid`,
    [storeId]
  );
  const store = rows[0];
  const redirectUrl = store?.auth_redirect_url ?? "http://localhost:3000";
  const link = `${redirectUrl}/auth/invite?token=${raw}&store=${storeId}`;

  const partialCfg = {
    storeName: store?.name ?? "Store",
    redirectUrl,
    brandColor: store?.auth_brand_color ?? "#4F46E5",
    logoUrl: store?.auth_logo_url ?? "",
  };

  const { subject, bodyHtml, bodyText } = renderAuthEmailTemplate("customer.invite", {
    ...partialCfg,
    link,
  });

  const { rows: logRows } = await pool.query<{ id: string }>(
    `INSERT INTO customer_email_log (store_id, to_email, subject, template_name, status)
     VALUES ($1::uuid, $2, $3, $4, 'pending') RETURNING id::text`,
    [storeId, email, subject, "customer.invite"]
  );
  const logId = logRows[0]?.id;

  try {
    await _mailer.send({
      to: email,
      fromName: partialCfg.storeName,
      fromEmail: "noreply@cartcrft.app",
      subject,
      bodyHtml,
      bodyText,
    });
    if (logId) {
      await pool.query(
        `UPDATE customer_email_log SET status = 'sent', sent_at = now() WHERE id = $1::uuid`,
        [logId]
      );
    }
  } catch (err) {
    if (logId) {
      await pool.query(
        `UPDATE customer_email_log SET status = 'failed', error = $2 WHERE id = $1::uuid`,
        [logId, err instanceof Error ? err.message : String(err)]
      );
    }
    // Don't throw — invitation was created, email may retry
  }
}

export async function acceptInvitation(
  pool: pg.Pool,
  storeId: string,
  rawToken: string,
  password: string,
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<SessionResult> {
  const hash = hashToken(rawToken);
  const { rows } = await pool.query<{
    id: string;
    email: string;
    expires_at: Date;
    accepted_at: Date | null;
  }>(
    `SELECT id::text, email, expires_at, accepted_at
     FROM customer_invitations
     WHERE token_hash = $1 AND store_id = $2::uuid`,
    [hash, storeId]
  );
  const inv = rows[0];
  if (!inv || inv.accepted_at || new Date() > inv.expires_at) {
    throw Object.assign(new Error("invalid or expired invitation"), { statusCode: 400 });
  }

  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id::text FROM customers WHERE store_id = $1::uuid AND email = $2`,
    [storeId, inv.email]
  );

  let customerId: string;
  const passwordHash = hashPasswordSync(password);

  if (existing[0]) {
    customerId = existing[0].id;
    await pool.query(
      `UPDATE customers
       SET password_hash = $2, email_verified = true, is_active = true, updated_at = now()
       WHERE id = $1::uuid`,
      [customerId, passwordHash]
    );
  } else {
    const { rows: newRows } = await pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)
       RETURNING id::text`,
      [storeId, inv.email, passwordHash]
    );
    customerId = newRows[0]?.id ?? "";
    if (!customerId) throw new Error("failed to create customer");
  }

  await pool.query(
    `UPDATE customer_invitations SET accepted_at = now() WHERE id = $1::uuid`,
    [inv.id]
  );

  await caAudit(pool, storeId, customerId, "customer.invite_accepted", ip, userAgent);
  return issueSession(pool, customerId, storeId, cfg, ip, userAgent);
}

// ── OAuth upsert ──────────────────────────────────────────────────────────────

type ProviderCol = "google_id" | "microsoft_id" | "discord_id";

export async function oauthUpsertAndLogin(
  pool: pg.Pool,
  storeId: string,
  providerCol: ProviderCol,
  info: { providerId: string; email: string; name?: string | undefined; avatarUrl?: string | undefined },
  cfg: StoreAuthConfig,
  ip: string,
  userAgent: string
): Promise<SessionResult & { customerId: string; email: string; isAdmin: boolean }> {
  const authProvider = providerCol === "google_id" ? "google"
    : providerCol === "microsoft_id" ? "microsoft"
    : "discord";

  let customerId: string | null = null;

  const { rows: byProvider } = await pool.query<{ id: string }>(
    `SELECT id::text FROM customers WHERE store_id = $1::uuid AND ${providerCol} = $2`,
    [storeId, info.providerId]
  );
  if (byProvider[0]) {
    customerId = byProvider[0].id;
  } else {
    const { rows: byEmail } = await pool.query<{ id: string }>(
      `SELECT id::text FROM customers WHERE store_id = $1::uuid AND email = $2`,
      [storeId, info.email.toLowerCase().trim()]
    );
    if (byEmail[0]) customerId = byEmail[0].id;
  }

  if (customerId) {
    await pool.query(
      `UPDATE customers
       SET ${providerCol} = $2,
           display_name = coalesce(display_name, $3),
           avatar_url = coalesce(avatar_url, $4),
           email_verified = true,
           updated_at = now()
       WHERE id = $1::uuid`,
      [customerId, info.providerId, info.name ?? null, info.avatarUrl ?? null]
    );
  } else {
    if (!cfg.allowSelfRegistration) {
      throw Object.assign(new Error("self-registration is disabled"), { statusCode: 403 });
    }
    const { rows: newRows } = await pool.query<{ id: string }>(
      `INSERT INTO customers
         (store_id, email, ${providerCol}, auth_provider, display_name, avatar_url, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, true, true)
       RETURNING id::text`,
      [
        storeId,
        info.email.toLowerCase().trim(),
        info.providerId,
        authProvider,
        info.name ?? null,
        info.avatarUrl ?? null,
      ]
    );
    customerId = newRows[0]?.id ?? "";
    if (!customerId) throw new Error("failed to create customer");
  }

  const { rows: custRows } = await pool.query<{ email: string; is_admin: boolean }>(
    `SELECT email, coalesce(is_admin, false) as is_admin FROM customers WHERE id = $1::uuid`,
    [customerId]
  );
  const cust = custRows[0];
  if (!cust) throw new Error("customer not found after upsert");

  await caAudit(pool, storeId, customerId, `customer.oauth_login.${authProvider}`, ip, userAgent);
  const session = await issueSession(pool, customerId, storeId, cfg, ip, userAgent);

  return { ...session, customerId, email: cust.email, isAdmin: cust.is_admin };
}
