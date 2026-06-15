/**
 * lib/superadmin-auth.ts — Hardened SUPER-ADMIN authentication.
 *
 * This is the platform-operator (Webcrft Systems god-mode) auth layer. It is
 * deliberately DISTINCT from org auth (lib/auth/*) and customer auth so that:
 *
 *   - An org/customer JWT can NEVER pass requireSuperAdmin (different audience
 *     AND a different signing key when SUPERADMIN_JWT_SECRET is set).
 *   - A super-admin JWT can NEVER pass the org middleware (its `aud` is
 *     "cartcrft-superadmin", which verifyJwt() rejects, and it has no `org`
 *     claim).
 *
 * Hardening features
 * ------------------
 *   1. argon2id password verification (reuses @node-rs/argon2 like customer-auth).
 *   2. Failed-attempt lockout: N consecutive failures locks the account for a
 *      cooldown window.
 *   3. Short-lived access JWT (default 30 min) with strict iss/aud validation
 *      (iss "cartcrft", aud "cartcrft-superadmin").
 *   4. Server-side session row (super_admin_sessions) hashed with sha256 — the
 *      JWT carries the session id (`sid`); requireSuperAdmin checks the session
 *      is not revoked/expired, so logout/refresh actually invalidate access.
 *   5. Optional IP allowlist (SUPERADMIN_IP_ALLOWLIST — comma-separated IPs /
 *      CIDRs). If set, off-list IPs are rejected at login AND on every request.
 *   6. Strict per-IP rate limit on the super-admin surface (in-memory, distinct
 *      from the global limiter).
 *   7. TOTP/MFA (RFC6238, node:crypto): when an admin has a totp_secret set,
 *      login requires a valid 6-digit code (±1 step skew).
 *   8. EVERY super-admin action writes a super_admin_audit_log row.
 *
 * Cross-tenant reads: super-admin service queries run via getPool() WITHOUT
 * setRequestCtx(), so withTx/plain queries execute as the owner role
 * (BYPASSRLS) and see every org's data. Each access is audit-logged.
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import { createHash, randomBytes, randomUUID, timingSafeEqual, createHmac } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { hashSync as argon2HashSync, verifySync as argon2VerifySync } from "@node-rs/argon2";
import type pg from "pg";
import { getPool } from "../db/pool.js";
import { config } from "../config/config.js";
import { decodeSecretValue } from "./secrets.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Issuer claim — shared platform issuer. */
export const SUPERADMIN_JWT_ISSUER = "cartcrft" as const;
/**
 * Audience claim — DISTINCT from the org audience ("cartcrft"). This is the
 * single most important isolation control: verifyJwt() (org) demands
 * aud="cartcrft" and rejects this token; verifySuperAdminJwt() demands
 * aud="cartcrft-superadmin" and rejects org tokens.
 */
export const SUPERADMIN_JWT_AUDIENCE = "cartcrft-superadmin" as const;

/** Access token lifetime — SHORT. */
const ACCESS_TOKEN_TTL_SECONDS = 30 * 60; // 30 min
/** Server-side session lifetime — matches the access token. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** Lockout policy. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/** Per-IP rate limit on the super-admin surface. */
const SUPERADMIN_RATE_LIMIT = 30; // requests
const SUPERADMIN_RATE_WINDOW_MS = 60 * 1000; // per minute

// argon2id options — same posture as customer-auth.
// @node-rs/argon2 Algorithm enum: 2 = Argon2id
const ARGON2_OPTS = { algorithm: 2 } as const;

// ── Types ───────────────────────────────────────────────────────────────────

export interface SuperAdminRow {
  id: string;
  email: string;
  password_hash: string;
  totp_secret_enc: string | null;
  is_active: boolean;
  failed_attempts: number;
  locked_until: string | null;
}

export interface SuperAdminClaims extends JWTPayload {
  sub: string; // super_admin id
  sid: string; // session id
  email?: string;
  role: "superadmin";
}

/** Attached to request by requireSuperAdmin. */
export interface SuperAdminContext {
  superAdminId: string;
  sessionId: string;
  email: string;
  ip: string;
  userAgent: string;
}

declare module "fastify" {
  interface FastifyRequest {
    superAdmin?: SuperAdminContext | undefined;
  }
}

// ── Password hashing (exported for the create-super-admin script) ────────────

export function hashSuperAdminPassword(password: string): string {
  return argon2HashSync(password, ARGON2_OPTS);
}

function verifySuperAdminPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  try {
    return argon2VerifySync(stored, password);
  } catch {
    return false;
  }
}

// ── JWT signing key (separate secret if configured) ──────────────────────────

function superAdminSecretKey(): Uint8Array {
  const sep = process.env["SUPERADMIN_JWT_SECRET"];
  return new TextEncoder().encode(sep && sep.length > 0 ? sep : config.JWT_SECRET);
}

// ── TOTP (RFC6238, node:crypto) ──────────────────────────────────────────────

/** Decode a base32 (RFC4648) secret into bytes. */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/g, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** Compute the RFC6238 TOTP code for a given secret + time step. */
function totpCodeAt(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  // Write the 64-bit counter (big-endian). JS bitwise is 32-bit; split halves.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * Verify a TOTP code against a base32 secret, allowing ±1 step (30s) clock skew.
 * Constant-time compare on the rendered code strings.
 */
export function verifyTotp(secretBase32: string, code: string, atMs = Date.now()): boolean {
  if (!secretBase32 || !/^\d{6}$/.test(code.trim())) return false;
  const secret = base32Decode(secretBase32);
  if (secret.length === 0) return false;
  const step = Math.floor(atMs / 1000 / 30);
  const candidate = Buffer.from(code.trim(), "utf8");
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(totpCodeAt(secret, step + drift), "utf8");
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return true;
    }
  }
  return false;
}

// ── IP allowlist ─────────────────────────────────────────────────────────────

function ipToBigInt(ip: string): bigint | null {
  // IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split(".").map((p) => Number(p));
    if (parts.some((p) => p < 0 || p > 255)) return null;
    return (
      (BigInt(parts[0]!) << 24n) |
      (BigInt(parts[1]!) << 16n) |
      (BigInt(parts[2]!) << 8n) |
      BigInt(parts[3]!)
    );
  }
  return null; // IPv6 allowlisting not supported (use exact-match fallback)
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  if (!range) return false;
  if (bitsRaw === undefined) {
    return ip === range; // plain IP exact match
  }
  const bits = Number(bitsRaw);
  const ipNum = ipToBigInt(ip);
  const rangeNum = ipToBigInt(range);
  if (ipNum === null || rangeNum === null) return ip === range;
  if (bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (~0n << BigInt(32 - bits)) & 0xffffffffn;
  return (ipNum & mask) === (rangeNum & mask);
}

/**
 * Returns true if the IP is allowed. When SUPERADMIN_IP_ALLOWLIST is unset/empty
 * the allowlist is disabled (allow all). When set, only listed IPs/CIDRs pass.
 */
export function isIpAllowed(ip: string): boolean {
  const raw = process.env["SUPERADMIN_IP_ALLOWLIST"];
  if (!raw || raw.trim() === "") return true;
  const entries = raw.split(",").map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) return true;
  return entries.some((entry) => ipInCidr(ip, entry));
}

// ── Per-IP rate limiter (in-memory, super-admin surface only) ────────────────

const _ipBuckets = new Map<string, { count: number; resetAt: number }>();

function checkSuperAdminRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = _ipBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    _ipBuckets.set(ip, { count: 1, resetAt: now + SUPERADMIN_RATE_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= SUPERADMIN_RATE_LIMIT;
}

/** Test/ops helper: clear rate-limit + lockout state. */
export function _resetSuperAdminRateLimit(): void {
  _ipBuckets.clear();
}

// ── Request helpers ──────────────────────────────────────────────────────────

/**
 * P0-2: Return the client IP.
 *
 * Uses `request.ip` exclusively.  When `TRUST_PROXY` is configured, Fastify
 * resolves the real IP from X-Forwarded-For before we ever see the request.
 * Reading XFF directly here would let an unauthenticated caller forge their IP
 * to bypass the SUPERADMIN_IP_ALLOWLIST.
 */
export function getClientIp(request: FastifyRequest): string {
  return request.ip;
}

function getUserAgent(request: FastifyRequest): string {
  const ua = request.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 512) : "";
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── Audit logging ────────────────────────────────────────────────────────────

export interface AuditEntry {
  superAdminId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Write a super_admin_audit_log row. Best-effort but errors are surfaced in
 * dev; failures must never silently drop the audit trail in prod, so we log.
 */
export async function writeAudit(entry: AuditEntry, exec: pg.Pool | pg.PoolClient = getPool()): Promise<void> {
  await exec.query(
    `INSERT INTO super_admin_audit_log
       (super_admin_id, action, target_type, target_id, ip, user_agent, data)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      entry.superAdminId,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.ip ?? null,
      entry.userAgent ?? null,
      JSON.stringify(entry.data ?? {}),
    ]
  );
}

/** Convenience: audit an action performed by the authenticated super-admin on a request. */
export async function auditRequest(
  request: FastifyRequest,
  action: string,
  opts: { targetType?: string; targetId?: string; data?: Record<string, unknown> } = {}
): Promise<void> {
  const ctx = request.superAdmin;
  await writeAudit({
    superAdminId: ctx?.superAdminId ?? null,
    action,
    targetType: opts.targetType ?? null,
    targetId: opts.targetId ?? null,
    ip: ctx?.ip ?? getClientIp(request),
    userAgent: ctx?.userAgent ?? getUserAgent(request),
    data: opts.data ?? {},
  });
}

// ── Login ────────────────────────────────────────────────────────────────────

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; superAdmin: { id: string; email: string } }
  | { ok: false; code: "INVALID_CREDENTIALS" | "LOCKED" | "INACTIVE" | "MFA_REQUIRED" | "MFA_INVALID" | "IP_BLOCKED"; message: string };

/**
 * Authenticate a super-admin by email + password (+ TOTP if enabled).
 *
 * Security flow:
 *   1. IP allowlist check (if configured).
 *   2. Load admin by email (case-insensitive). Always run an argon2 verify on a
 *      dummy hash if the admin is missing to reduce user-enumeration timing.
 *   3. Lockout check (locked_until in the future → reject).
 *   4. Password verify. On failure: increment failed_attempts; lock at threshold.
 *   5. TOTP verify if a secret is set.
 *   6. On success: reset failed_attempts, set last_login_at, issue session + JWT.
 *   7. Audit every outcome.
 */
export async function loginSuperAdmin(opts: {
  email: string;
  password: string;
  totp?: string | undefined;
  ip: string;
  userAgent: string;
}): Promise<LoginResult> {
  const pool = getPool();

  if (!isIpAllowed(opts.ip)) {
    await writeAudit({
      superAdminId: null,
      action: "login.ip_blocked",
      ip: opts.ip,
      userAgent: opts.userAgent,
      data: { email: opts.email },
    });
    return { ok: false, code: "IP_BLOCKED", message: "access from this IP is not permitted" };
  }

  const { rows } = await pool.query<SuperAdminRow>(
    `SELECT id::text, email, password_hash, totp_secret_enc, is_active,
            failed_attempts, locked_until::text
       FROM super_admins
      WHERE lower(email) = lower($1)`,
    [opts.email]
  );
  const admin = rows[0];

  // Anti-enumeration: dummy verify when the account is absent.
  if (!admin) {
    verifySuperAdminPassword(opts.password, "$argon2id$v=19$m=19456,t=2,p=1$" + "A".repeat(22) + "$" + "B".repeat(43));
    await writeAudit({
      superAdminId: null,
      action: "login.failed",
      ip: opts.ip,
      userAgent: opts.userAgent,
      data: { email: opts.email, reason: "no_account" },
    });
    return { ok: false, code: "INVALID_CREDENTIALS", message: "invalid credentials" };
  }

  if (!admin.is_active) {
    await writeAudit({ superAdminId: admin.id, action: "login.inactive", ip: opts.ip, userAgent: opts.userAgent });
    return { ok: false, code: "INACTIVE", message: "account is disabled" };
  }

  if (admin.locked_until && new Date(admin.locked_until).getTime() > Date.now()) {
    await writeAudit({ superAdminId: admin.id, action: "login.locked", ip: opts.ip, userAgent: opts.userAgent });
    return { ok: false, code: "LOCKED", message: "account is temporarily locked due to failed attempts" };
  }

  const passwordOk = verifySuperAdminPassword(opts.password, admin.password_hash);
  if (!passwordOk) {
    const nextAttempts = admin.failed_attempts + 1;
    const shouldLock = nextAttempts >= MAX_FAILED_ATTEMPTS;
    await pool.query(
      `UPDATE super_admins
          SET failed_attempts = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END,
              updated_at = now()
        WHERE id = $1::uuid`,
      [admin.id, nextAttempts, shouldLock, String(LOCKOUT_MINUTES)]
    );
    await writeAudit({
      superAdminId: admin.id,
      action: "login.failed",
      ip: opts.ip,
      userAgent: opts.userAgent,
      data: { reason: "bad_password", failed_attempts: nextAttempts, locked: shouldLock },
    });
    if (shouldLock) {
      return { ok: false, code: "LOCKED", message: "account locked due to too many failed attempts" };
    }
    return { ok: false, code: "INVALID_CREDENTIALS", message: "invalid credentials" };
  }

  // MFA — if a TOTP secret is configured, require a valid code.
  if (admin.totp_secret_enc) {
    if (!opts.totp) {
      await writeAudit({ superAdminId: admin.id, action: "login.mfa_required", ip: opts.ip, userAgent: opts.userAgent });
      return { ok: false, code: "MFA_REQUIRED", message: "TOTP code required" };
    }
    const secret = decodeSecretValue(admin.totp_secret_enc, process.env["AUTH_SECRETS_KEY"] ?? "");
    if (!verifyTotp(secret, opts.totp)) {
      await writeAudit({ superAdminId: admin.id, action: "login.mfa_invalid", ip: opts.ip, userAgent: opts.userAgent });
      return { ok: false, code: "MFA_INVALID", message: "invalid TOTP code" };
    }
  }

  // Success: reset attempts, stamp login, create session, mint JWT.
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("hex");
  const tokenHash = sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await pool.query(
    `UPDATE super_admins
        SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
      WHERE id = $1::uuid`,
    [admin.id]
  );
  await pool.query(
    `INSERT INTO super_admin_sessions (id, super_admin_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
    [sessionId, admin.id, tokenHash, expiresAt, opts.ip, opts.userAgent]
  );

  const token = await mintSuperAdminJwt({ superAdminId: admin.id, sessionId, email: admin.email });

  await writeAudit({ superAdminId: admin.id, action: "login.success", ip: opts.ip, userAgent: opts.userAgent, data: { sessionId } });

  return { ok: true, token, expiresAt, superAdmin: { id: admin.id, email: admin.email } };
}

// ── JWT mint / verify ────────────────────────────────────────────────────────

export async function mintSuperAdminJwt(opts: {
  superAdminId: string;
  sessionId: string;
  email?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: opts.superAdminId,
    sid: opts.sessionId,
    email: opts.email,
    role: "superadmin",
    iat: now,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SUPERADMIN_JWT_ISSUER)
    .setAudience(SUPERADMIN_JWT_AUDIENCE)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .sign(superAdminSecretKey());
}

export async function verifySuperAdminJwt(token: string): Promise<SuperAdminClaims | null> {
  try {
    const { payload } = await jwtVerify(token, superAdminSecretKey(), {
      algorithms: ["HS256"],
      issuer: SUPERADMIN_JWT_ISSUER,
      audience: SUPERADMIN_JWT_AUDIENCE,
    });
    const claims = payload as SuperAdminClaims;
    if (!claims.sub || !claims.sid || claims.role !== "superadmin") return null;
    return claims;
  } catch {
    return null;
  }
}

// ── Session revoke / refresh ─────────────────────────────────────────────────

export async function revokeSession(sessionId: string): Promise<void> {
  await getPool().query(
    `UPDATE super_admin_sessions SET revoked_at = now() WHERE id = $1::uuid AND revoked_at IS NULL`,
    [sessionId]
  );
}

/**
 * Refresh: given a still-valid session, revoke it and issue a fresh session +
 * JWT (rotation). Returns null if the session is invalid/expired/revoked.
 */
export async function refreshSession(opts: {
  superAdminId: string;
  sessionId: string;
  email: string;
  ip: string;
  userAgent: string;
}): Promise<{ token: string; expiresAt: Date } | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM super_admin_sessions
      WHERE id = $1::uuid AND super_admin_id = $2::uuid
        AND revoked_at IS NULL AND expires_at > now()`,
    [opts.sessionId, opts.superAdminId]
  );
  if (!rows[0]) return null;

  await revokeSession(opts.sessionId);

  const newSessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO super_admin_sessions (id, super_admin_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
    [newSessionId, opts.superAdminId, sha256Hex(sessionToken), expiresAt, opts.ip, opts.userAgent]
  );
  const token = await mintSuperAdminJwt({ superAdminId: opts.superAdminId, sessionId: newSessionId, email: opts.email });
  return { token, expiresAt };
}

// ── requireSuperAdmin preHandler ─────────────────────────────────────────────

async function deny(reply: FastifyReply, status: number, code: string, message: string): Promise<void> {
  await reply.status(status).send({ error: { code, message } });
}

/**
 * requireSuperAdmin — the hardened gate on every /superadmin route (except the
 * login endpoint).
 *
 * Order of checks (fail-closed):
 *   1. Per-IP rate limit on the super-admin surface.
 *   2. IP allowlist (if SUPERADMIN_IP_ALLOWLIST set).
 *   3. Bearer token present.
 *   4. Verify super JWT (strict iss + aud="cartcrft-superadmin"). An org JWT
 *      fails here because its aud is "cartcrft".
 *   5. Load the session: must exist, not revoked, not expired.
 *   6. Load the super_admin: must exist and be active.
 *   7. Attach request.superAdmin. Does NOT call setRequestCtx → queries run as
 *      the owner role (BYPASSRLS) for cross-tenant reads.
 */
export const requireSuperAdmin: preHandlerHookHandler = async (request, reply) => {
  const ip = getClientIp(request);

  if (!checkSuperAdminRateLimit(ip)) {
    return deny(reply, 429, "RATE_LIMIT_EXCEEDED", "super-admin rate limit exceeded");
  }

  if (!isIpAllowed(ip)) {
    await writeAudit({ superAdminId: null, action: "access.ip_blocked", ip, userAgent: getUserAgent(request) }).catch(() => {});
    return deny(reply, 403, "FORBIDDEN", "access from this IP is not permitted");
  }

  const authorization = request.headers["authorization"] ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!bearer) {
    return deny(reply, 401, "UNAUTHORIZED", "missing super-admin Authorization header");
  }
  // Reject API keys outright — they can never be a super-admin.
  if (bearer.startsWith("cc_pub_") || bearer.startsWith("cc_prv_")) {
    return deny(reply, 401, "UNAUTHORIZED", "API keys cannot access the super-admin surface");
  }

  const claims = await verifySuperAdminJwt(bearer);
  if (!claims) {
    return deny(reply, 401, "UNAUTHORIZED", "invalid or expired super-admin token");
  }

  const pool = getPool();
  const { rows: sessionRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM super_admin_sessions
      WHERE id = $1::uuid AND super_admin_id = $2::uuid
        AND revoked_at IS NULL AND expires_at > now()`,
    [claims.sid, claims.sub]
  );
  if (!sessionRows[0]) {
    return deny(reply, 401, "UNAUTHORIZED", "session revoked or expired");
  }

  const { rows: adminRows } = await pool.query<{ id: string; email: string; is_active: boolean }>(
    `SELECT id::text, email, is_active FROM super_admins WHERE id = $1::uuid`,
    [claims.sub]
  );
  const admin = adminRows[0];
  if (!admin || !admin.is_active) {
    return deny(reply, 403, "FORBIDDEN", "super-admin account is inactive");
  }

  request.superAdmin = {
    superAdminId: admin.id,
    sessionId: claims.sid,
    email: admin.email,
    ip,
    userAgent: getUserAgent(request),
  };
  // NOTE: intentionally NOT calling setRequestCtx — super-admin reads must run
  // as the owner role (BYPASSRLS) to see across all tenants.
};
