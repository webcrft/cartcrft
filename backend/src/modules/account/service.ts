/**
 * modules/account/service.ts — Platform-account auth (P3 / audit item 1).
 *
 * This is the org-dashboard human-login layer. It replaces the previous trust
 * model where the browser held a cc_prv_ commerce:admin key (or a pasted JWT)
 * in localStorage. The new model:
 *
 *   access token  — a SHORT-LIVED JWT (15 min) held only in browser memory.
 *                   It is minted with the SAME secret/iss/aud/claims that the
 *                   existing org middleware (lib/auth/jwt.ts verifyJwt) expects
 *                   — iss="cartcrft", aud="cartcrft", sub=<platform_user id>,
 *                   org=<org_id> — so EVERY existing /commerce route accepts it
 *                   unchanged.
 *   refresh token — an opaque random token. Only its sha256 is stored
 *                   (platform_sessions.token_hash); the raw value is delivered
 *                   to the browser ONLY as an httpOnly, Secure, SameSite=Lax
 *                   cookie scoped to /account/refresh. Rotated on refresh,
 *                   revoked on logout.
 *
 * Pre-auth flows (register/login/refresh) run via getPool() WITHOUT
 * setRequestCtx → owner role (BYPASSRLS): there is no org context yet, and the
 * lookups are by email/token-hash. Team-management flows run under the access
 * JWT's org context, so RLS (0026) gates them to the caller's org as well.
 *
 * Hardening: argon2id hashes, failed-attempt lockout, anti-enumeration dummy
 * verify, hashed refresh tokens, refresh rotation.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { hashSync as argon2HashSync, verifySync as argon2VerifySync } from "@node-rs/argon2";
import { getPool, getReadDb } from "../../db/pool.js";
import { config } from "../../config/config.js";
import { JWT_ISSUER, JWT_AUDIENCE } from "../../lib/auth/jwt.js";
import { buildKv } from "../../lib/cache/kv.js";

// ── Policy constants ─────────────────────────────────────────────────────────

/** Access JWT lifetime — SHORT. Held in browser memory only. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 min
/** Refresh session lifetime — the httpOnly cookie's max-age. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Path the refresh cookie is scoped to (it is sent ONLY to /account/refresh & /account/logout). */
export const REFRESH_COOKIE_PATH = "/account";
/** Cookie name for the opaque refresh token. */
export const REFRESH_COOKIE_NAME = "cc_refresh";

/** Lockout policy. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/**
 * FIX 3: per-IP login throttle. Counts login attempts from one IP across ALL
 * accounts so an attacker cannot weaponise the per-account lockout to lock
 * arbitrary victims, and a single IP brute-forcing is rate-limited independently
 * of the per-account lockout. Threshold sits well above MAX_FAILED_ATTEMPTS so
 * normal single-account lockout semantics are unaffected.
 */
const LOGIN_IP_WINDOW_MS = 15 * 60_000; // 15-minute window
const LOGIN_IP_MAX_ATTEMPTS = 50;       // attempts per IP per window before throttle

/**
 * Record a login attempt from `ip`; return whether the IP is now throttled.
 * Fail-open (returns false) on KV failure or unknown IP.
 */
async function loginIpThrottled(ip: string): Promise<boolean> {
  if (!ip) return false;
  try {
    const kv = await buildKv();
    const count = await kv.incrWithWindow(`acctlogin:ip:${ip}`, LOGIN_IP_WINDOW_MS);
    return count > LOGIN_IP_MAX_ATTEMPTS;
  } catch {
    return false;
  }
}

// argon2id — Algorithm enum: 2 = Argon2id (same posture as customer/super-admin auth).
const ARGON2_OPTS = { algorithm: 2 } as const;

export type PlatformRole = "owner" | "admin" | "member";

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlatformUserRow {
  id: string;
  org_id: string;
  email: string;
  password_hash: string | null;
  role: PlatformRole;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
}

export interface PublicPlatformUser {
  id: string;
  org_id: string;
  email: string;
  role: PlatformRole;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface IssuedSession {
  accessToken: string;
  accessExpiresAt: Date;
  /** Raw opaque refresh token — goes into the httpOnly cookie ONLY. */
  refreshToken: string;
  refreshExpiresAt: Date;
}

// ── Password hashing ─────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  return argon2HashSync(password, ARGON2_OPTS);
}

function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  try {
    return argon2VerifySync(stored, password);
  } catch {
    return false;
  }
}

// ── Hashing helper ───────────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── Access JWT (org-middleware compatible) ───────────────────────────────────

/**
 * Mint the short-lived access JWT.
 *
 * CRITICAL: the claim shape, signing key, issuer, and audience match
 * lib/auth/jwt.ts verifyJwt() EXACTLY, so this token authenticates against the
 * existing org middleware (storeAuthRead/Write/Admin + requireJwt) with no
 * changes there. We mint here (rather than via mintJwt) only because mintJwt's
 * expiry is hours-granular; the access token must be minutes-short.
 */
async function mintAccessToken(opts: { userId: string; orgId: string; email: string }): Promise<{ token: string; expiresAt: Date }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ACCESS_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    sub: opts.userId,
    org: opts.orgId,
    email: opts.email,
    iat: now,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(config.JWT_SECRET));
  return { token, expiresAt: new Date(exp * 1000) };
}

// ── Session issuance (access + refresh) ──────────────────────────────────────

async function issueSession(opts: {
  userId: string;
  orgId: string;
  email: string;
  ip: string;
  userAgent: string;
}): Promise<IssuedSession> {
  const access = await mintAccessToken({ userId: opts.userId, orgId: opts.orgId, email: opts.email });

  const refreshToken = randomBytes(32).toString("hex");
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await getPool().query(
    `INSERT INTO platform_sessions (id, platform_user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
    [randomUUID(), opts.userId, sha256Hex(refreshToken), refreshExpiresAt, opts.ip, opts.userAgent.slice(0, 512)]
  );

  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken,
    refreshExpiresAt,
  };
}

function toPublicUser(r: {
  id: string;
  org_id: string;
  email: string;
  role: PlatformRole;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}): PublicPlatformUser {
  return {
    id: r.id,
    org_id: r.org_id,
    email: r.email,
    role: r.role,
    is_active: r.is_active,
    last_login_at: r.last_login_at,
    created_at: r.created_at,
  };
}

// ── Register (new org + owner) ───────────────────────────────────────────────

export type RegisterResult =
  | { ok: true; user: PublicPlatformUser; session: IssuedSession }
  | { ok: false; code: "EMAIL_TAKEN"; message: string };

/**
 * Register a brand-new org: mints a fresh org uuid and creates the first user
 * as the org `owner`. Returns an access JWT + refresh session.
 *
 * "Email taken" here means an account already owns/uses a *new* org under this
 * email AND we attempted to reuse it — but since each register creates a NEW
 * org_id, a collision is only possible on the (org_id, email) unique index,
 * which a fresh org_id makes impossible. We still guard defensively.
 */
export async function register(opts: {
  email: string;
  password: string;
  ip: string;
  userAgent: string;
}): Promise<RegisterResult> {
  const pool = getPool();
  const orgId = randomUUID();
  const userId = randomUUID();
  const passwordHash = hashPassword(opts.password);

  let row: { id: string; org_id: string; email: string; role: PlatformRole; is_active: boolean; last_login_at: string | null; created_at: string };
  try {
    const { rows } = await pool.query<typeof row>(
      `INSERT INTO platform_users (id, org_id, email, password_hash, role, last_login_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'owner', now())
       RETURNING id::text, org_id::text, email, role, is_active, last_login_at::text, created_at::text`,
      [userId, orgId, opts.email, passwordHash]
    );
    row = rows[0]!;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      return { ok: false, code: "EMAIL_TAKEN", message: "an account already exists for this email" };
    }
    throw err;
  }

  const session = await issueSession({ userId: row.id, orgId: row.org_id, email: row.email, ip: opts.ip, userAgent: opts.userAgent });
  return { ok: true, user: toPublicUser(row), session };
}

// ── Login ────────────────────────────────────────────────────────────────────

export type LoginResult =
  | { ok: true; user: PublicPlatformUser; session: IssuedSession }
  | { ok: false; code: "INVALID_CREDENTIALS" | "LOCKED" | "INACTIVE" | "THROTTLED"; message: string };

/**
 * Authenticate by email + password. Anti-enumeration dummy verify on missing
 * account; failed-attempt lockout. On success: reset attempts, stamp login,
 * issue access JWT + refresh session.
 *
 * Email is unique per-org; to support the common single-org dashboard login we
 * resolve the account by email alone and (when the same email exists in more
 * than one org) prefer the most-recently-active. An optional org_id narrows it.
 */
export async function login(opts: {
  email: string;
  password: string;
  orgId?: string | undefined;
  ip: string;
  userAgent: string;
}): Promise<LoginResult> {
  const pool = getPool();

  // FIX 3: per-IP throttle before touching the DB / per-account lockout.
  if (await loginIpThrottled(opts.ip)) {
    return { ok: false, code: "THROTTLED", message: "too many login attempts from this network — try again later" };
  }

  const { rows } = await pool.query<PlatformUserRow>(
    `SELECT id::text, org_id::text, email, password_hash, role, is_active,
            failed_attempts, locked_until::text
       FROM platform_users
      WHERE lower(email) = lower($1)
        AND ($2::uuid IS NULL OR org_id = $2::uuid)
      ORDER BY last_login_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [opts.email, opts.orgId ?? null]
  );
  const user = rows[0];

  // Anti-enumeration: dummy verify when the account is absent.
  if (!user) {
    verifyPassword(opts.password, "$argon2id$v=19$m=19456,t=2,p=1$" + "A".repeat(22) + "$" + "B".repeat(43));
    return { ok: false, code: "INVALID_CREDENTIALS", message: "invalid credentials" };
  }

  if (!user.is_active) {
    return { ok: false, code: "INACTIVE", message: "account is disabled" };
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return { ok: false, code: "LOCKED", message: "account is temporarily locked due to failed attempts" };
  }

  if (!verifyPassword(opts.password, user.password_hash)) {
    const nextAttempts = user.failed_attempts + 1;
    const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;
    await pool.query(
      `UPDATE platform_users
          SET failed_attempts = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END,
              updated_at = now()
        WHERE id = $1::uuid`,
      [user.id, nextAttempts, shouldLock, String(LOCKOUT_MINUTES)]
    );
    if (shouldLock) {
      return { ok: false, code: "LOCKED", message: "account locked due to too many failed attempts" };
    }
    return { ok: false, code: "INVALID_CREDENTIALS", message: "invalid credentials" };
  }

  // Success.
  await pool.query(
    `UPDATE platform_users
        SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
      WHERE id = $1::uuid`,
    [user.id]
  );

  const userRes = await pool.query<{ id: string; org_id: string; email: string; role: PlatformRole; is_active: boolean; last_login_at: string | null; created_at: string }>(
    `SELECT id::text, org_id::text, email, role, is_active, last_login_at::text, created_at::text
       FROM platform_users WHERE id = $1::uuid`,
    [user.id]
  );

  const session = await issueSession({ userId: user.id, orgId: user.org_id, email: user.email, ip: opts.ip, userAgent: opts.userAgent });
  return { ok: true, user: toPublicUser(userRes.rows[0]!), session };
}

// ── Refresh (rotate) ─────────────────────────────────────────────────────────

export type RefreshResult =
  | { ok: true; user: PublicPlatformUser; session: IssuedSession }
  | { ok: false; code: "INVALID_REFRESH"; message: string };

/**
 * Rotate a refresh session: validate the opaque token (by sha256), revoke the
 * old session row, mint a fresh access JWT + a new refresh session. Returns the
 * new refresh token so the caller can re-set the httpOnly cookie.
 */
export async function refresh(opts: {
  refreshToken: string;
  ip: string;
  userAgent: string;
}): Promise<RefreshResult> {
  const pool = getPool();
  const tokenHash = sha256Hex(opts.refreshToken);

  // P1-3: Atomic consume — UPDATE…WHERE revoked_at IS NULL RETURNING.
  // Zero rows ⟹ token is unknown, already revoked, or expired.
  const { rows } = await pool.query<{ id: string; platform_user_id: string }>(
    `UPDATE platform_sessions
        SET revoked_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id::text, platform_user_id::text`,
    [tokenHash]
  );
  const sess = rows[0];
  if (!sess) {
    return { ok: false, code: "INVALID_REFRESH", message: "invalid or expired refresh token" };
  }

  const userRes = await pool.query<{ id: string; org_id: string; email: string; role: PlatformRole; is_active: boolean; last_login_at: string | null; created_at: string }>(
    `SELECT id::text, org_id::text, email, role, is_active, last_login_at::text, created_at::text
       FROM platform_users WHERE id = $1::uuid`,
    [sess.platform_user_id]
  );
  const user = userRes.rows[0];
  if (!user || !user.is_active) {
    // Session was atomically consumed above; user inactive → just reject.
    return { ok: false, code: "INVALID_REFRESH", message: "account inactive" };
  }

  // Issue a fresh session (old one already atomically revoked).
  const session = await issueSession({ userId: user.id, orgId: user.org_id, email: user.email, ip: opts.ip, userAgent: opts.userAgent });
  return { ok: true, user: toPublicUser(user), session };
}

// ── Logout / revoke ──────────────────────────────────────────────────────────

export async function revokeSession(sessionId: string): Promise<void> {
  await getPool().query(
    `UPDATE platform_sessions SET revoked_at = now() WHERE id = $1::uuid AND revoked_at IS NULL`,
    [sessionId]
  );
}

/** Revoke a refresh session by its opaque token (used by /account/logout with the cookie). */
export async function revokeByToken(refreshToken: string): Promise<void> {
  await getPool().query(
    `UPDATE platform_sessions SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256Hex(refreshToken)]
  );
}

// ── /account/me ──────────────────────────────────────────────────────────────

export async function getUser(userId: string): Promise<PublicPlatformUser | null> {
  const { rows } = await getReadDb().query<{ id: string; org_id: string; email: string; role: PlatformRole; is_active: boolean; last_login_at: string | null; created_at: string }>(
    `SELECT id::text, org_id::text, email, role, is_active, last_login_at::text, created_at::text
       FROM platform_users WHERE id = $1::uuid`,
    [userId]
  );
  return rows[0] ? toPublicUser(rows[0]) : null;
}

// ── Team management ──────────────────────────────────────────────────────────

export async function listUsers(orgId: string): Promise<PublicPlatformUser[]> {
  const { rows } = await getReadDb().query<{ id: string; org_id: string; email: string; role: PlatformRole; is_active: boolean; last_login_at: string | null; created_at: string }>(
    `SELECT id::text, org_id::text, email, role, is_active, last_login_at::text, created_at::text
       FROM platform_users WHERE org_id = $1::uuid ORDER BY created_at ASC`,
    [orgId]
  );
  return rows.map(toPublicUser);
}

export type InviteResult =
  | { ok: true; user: PublicPlatformUser }
  | { ok: false; code: "EMAIL_TAKEN"; message: string };

/**
 * Invite (create) a team member in the caller's org. The invited user gets a
 * password set immediately (a temporary password the inviter shares out-of-band
 * — there is no email-delivery in OSS). Role defaults to member; owner cannot be
 * granted via invite (only the registrant is owner).
 */
export async function inviteUser(opts: {
  orgId: string;
  email: string;
  password: string;
  role: Exclude<PlatformRole, "owner">;
}): Promise<InviteResult> {
  const passwordHash = hashPassword(opts.password);
  try {
    const { rows } = await getPool().query<{ id: string; org_id: string; email: string; role: PlatformRole; is_active: boolean; last_login_at: string | null; created_at: string }>(
      `INSERT INTO platform_users (org_id, email, password_hash, role)
       VALUES ($1::uuid, $2, $3, $4)
       RETURNING id::text, org_id::text, email, role, is_active, last_login_at::text, created_at::text`,
      [opts.orgId, opts.email, passwordHash, opts.role]
    );
    return { ok: true, user: toPublicUser(rows[0]!) };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      return { ok: false, code: "EMAIL_TAKEN", message: "a member with this email already exists in this org" };
    }
    throw err;
  }
}

export type RemoveResult =
  | { ok: true }
  | { ok: false; code: "NOT_FOUND" | "CANNOT_REMOVE_OWNER" | "CANNOT_REMOVE_SELF"; message: string };

/** Remove a team member. Owners cannot be removed; you cannot remove yourself. */
export async function removeUser(opts: { orgId: string; targetUserId: string; actingUserId: string }): Promise<RemoveResult> {
  if (opts.targetUserId === opts.actingUserId) {
    return { ok: false, code: "CANNOT_REMOVE_SELF", message: "you cannot remove your own account" };
  }
  const pool = getPool();
  const { rows } = await pool.query<{ id: string; role: PlatformRole }>(
    `SELECT id::text, role FROM platform_users WHERE id = $1::uuid AND org_id = $2::uuid`,
    [opts.targetUserId, opts.orgId]
  );
  const target = rows[0];
  if (!target) return { ok: false, code: "NOT_FOUND", message: "member not found in this org" };
  if (target.role === "owner") return { ok: false, code: "CANNOT_REMOVE_OWNER", message: "the org owner cannot be removed" };

  // Cascade revokes their sessions (FK on delete cascade).
  await pool.query(`DELETE FROM platform_users WHERE id = $1::uuid AND org_id = $2::uuid`, [opts.targetUserId, opts.orgId]);
  return { ok: true };
}
