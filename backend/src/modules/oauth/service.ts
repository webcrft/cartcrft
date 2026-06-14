/**
 * modules/oauth/service.ts — OAuth2 authorization-server core.
 *
 * cartcrft is the authorization server. An org (merchant) registers apps; an
 * external app redirects a logged-in merchant/user through a consent flow and
 * receives scoped tokens that call the existing /commerce API.
 *
 * Security posture (mirrors the platform-account + api-keys modules):
 *   - client_secret: argon2id-hashed at rest, returned ONCE on create/rotate.
 *   - authorization codes: sha256-at-rest, single-use (consumed_at), short TTL.
 *   - PKCE: required for public clients (S256); verified at token exchange.
 *   - refresh tokens: sha256-at-rest, rotated on every use; presenting an
 *     already-rotated/consumed token revokes the whole rotation family
 *     (reuse-detection).
 *   - access token: a JWT minted with the EXACT iss/aud/sub/org claims
 *     lib/auth/jwt.ts expects (so the existing /commerce middleware accepts it)
 *     PLUS `scope` and `oauth_app` claims; ~1h expiry.
 *
 * RLS: app-management reads/writes run under the caller's org context (RLS-gated
 * to the owning org). The authorization-server flows (authorize/token/revoke/
 * introspect) run via getPool() as the owner role (BYPASSRLS) WITHOUT
 * setRequestCtx — exactly like the pre-auth flows in modules/account — because a
 * confidential client authenticating with its secret has no org JWT, and code/
 * token lookups are by hash across orgs. Org-binding is enforced explicitly in
 * SQL (organization_id columns) and in the minted token's `org` claim.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";
import { hashSync as argon2HashSync, verifySync as argon2VerifySync } from "@node-rs/argon2";
import { getPool, getReadDb } from "../../db/pool.js";
import { config } from "../../config/config.js";
import { JWT_ISSUER, JWT_AUDIENCE } from "../../lib/auth/jwt.js";
import { verifyPkce, type CodeChallengeMethod } from "../../lib/oauth/pkce.js";
import { scopesCovered } from "../../lib/oauth/scopes.js";

// ── Policy constants ─────────────────────────────────────────────────────────

/** OAuth access-token (JWT) lifetime — ~1h. */
export const OAUTH_ACCESS_TTL_SECONDS = 60 * 60;
/** Authorization-code lifetime — short (5 min). */
export const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
/** Refresh-token lifetime — 60 days. */
export const OAUTH_REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;

// argon2id — Algorithm enum: 2 = Argon2id (same posture as account/super-admin).
const ARGON2_OPTS = { algorithm: 2 } as const;

export type ClientType = "confidential" | "public";

// ── Hashing helpers ──────────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashSecret(secret: string): string {
  return argon2HashSync(secret, ARGON2_OPTS);
}

function verifySecret(secret: string, stored: string | null): boolean {
  if (!stored) return false;
  try {
    return argon2VerifySync(stored, secret);
  } catch {
    return false;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface OAuthAppRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  client_id: string;
  client_type: ClientType;
  redirect_uris: string[];
  allowed_scopes: string[];
  logo_url: string | null;
  homepage_url: string | null;
  status: "active" | "suspended";
  created_at: string;
  updated_at: string;
}

export interface CreatedApp extends OAuthAppRow {
  /** Raw client secret — returned ONCE on create (null for public clients). */
  client_secret: string | null;
}

const APP_PUBLIC_COLUMNS = `
  id::text, organization_id::text, name, description, client_id, client_type,
  redirect_uris, allowed_scopes, logo_url, homepage_url, status,
  created_at::text, updated_at::text`;

// ── App management (org-scoped CRUD) ─────────────────────────────────────────

function newClientId(): string {
  return `cc_app_${randomBytes(16).toString("hex")}`;
}

function newClientSecret(): string {
  return `cc_secret_${randomBytes(32).toString("hex")}`;
}

export async function createApp(opts: {
  orgId: string;
  name: string;
  description?: string | null;
  clientType: ClientType;
  redirectUris: string[];
  allowedScopes: string[];
  logoUrl?: string | null;
  homepageUrl?: string | null;
}): Promise<CreatedApp> {
  const clientId = newClientId();
  // Confidential clients get a secret; public/PKCE clients do not.
  const rawSecret = opts.clientType === "confidential" ? newClientSecret() : null;
  const secretHash = rawSecret ? hashSecret(rawSecret) : null;

  const { rows } = await getPool().query<OAuthAppRow>(
    `INSERT INTO oauth_apps
       (organization_id, name, description, client_id, client_secret_hash,
        client_type, redirect_uris, allowed_scopes, logo_url, homepage_url)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${APP_PUBLIC_COLUMNS}`,
    [
      opts.orgId,
      opts.name,
      opts.description ?? null,
      clientId,
      secretHash,
      opts.clientType,
      opts.redirectUris,
      opts.allowedScopes,
      opts.logoUrl ?? null,
      opts.homepageUrl ?? null,
    ]
  );
  return { ...rows[0]!, client_secret: rawSecret };
}

export async function listApps(orgId: string): Promise<OAuthAppRow[]> {
  const { rows } = await getReadDb().query<OAuthAppRow>(
    `SELECT ${APP_PUBLIC_COLUMNS} FROM oauth_apps
      WHERE organization_id = $1::uuid ORDER BY created_at DESC`,
    [orgId]
  );
  return rows;
}

export async function getApp(orgId: string, appId: string): Promise<OAuthAppRow | null> {
  const { rows } = await getReadDb().query<OAuthAppRow>(
    `SELECT ${APP_PUBLIC_COLUMNS} FROM oauth_apps
      WHERE id = $1::uuid AND organization_id = $2::uuid`,
    [appId, orgId]
  );
  return rows[0] ?? null;
}

export async function updateApp(
  orgId: string,
  appId: string,
  patch: {
    name?: string | undefined;
    description?: string | null | undefined;
    redirectUris?: string[] | undefined;
    allowedScopes?: string[] | undefined;
    logoUrl?: string | null | undefined;
    homepageUrl?: string | null | undefined;
    status?: "active" | "suspended" | undefined;
  }
): Promise<OAuthAppRow | null> {
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [appId, orgId];
  let n = 3;
  if (patch.name !== undefined) { sets.push(`name = $${n++}`); args.push(patch.name); }
  if (patch.description !== undefined) { sets.push(`description = $${n++}`); args.push(patch.description); }
  if (patch.redirectUris !== undefined) { sets.push(`redirect_uris = $${n++}`); args.push(patch.redirectUris); }
  if (patch.allowedScopes !== undefined) { sets.push(`allowed_scopes = $${n++}`); args.push(patch.allowedScopes); }
  if (patch.logoUrl !== undefined) { sets.push(`logo_url = $${n++}`); args.push(patch.logoUrl); }
  if (patch.homepageUrl !== undefined) { sets.push(`homepage_url = $${n++}`); args.push(patch.homepageUrl); }
  if (patch.status !== undefined) { sets.push(`status = $${n++}`); args.push(patch.status); }

  const { rows } = await getPool().query<OAuthAppRow>(
    `UPDATE oauth_apps SET ${sets.join(", ")}
      WHERE id = $1::uuid AND organization_id = $2::uuid
      RETURNING ${APP_PUBLIC_COLUMNS}`,
    args
  );
  return rows[0] ?? null;
}

/** Rotate the client secret. Confidential clients only. Returns the new raw secret once. */
export async function rotateSecret(
  orgId: string,
  appId: string
): Promise<{ ok: true; client_secret: string } | { ok: false; code: "NOT_FOUND" | "NOT_CONFIDENTIAL" }> {
  const app = await getApp(orgId, appId);
  if (!app) return { ok: false, code: "NOT_FOUND" };
  if (app.client_type !== "confidential") return { ok: false, code: "NOT_CONFIDENTIAL" };
  const raw = newClientSecret();
  await getPool().query(
    `UPDATE oauth_apps SET client_secret_hash = $3, updated_at = now()
      WHERE id = $1::uuid AND organization_id = $2::uuid`,
    [appId, orgId, hashSecret(raw)]
  );
  return { ok: true, client_secret: raw };
}

export async function deleteApp(orgId: string, appId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM oauth_apps WHERE id = $1::uuid AND organization_id = $2::uuid`,
    [appId, orgId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Authorization-server lookups (owner role; cross-org by client_id) ────────

/** Resolve an active app by its public client_id (no org context). */
export async function findAppByClientId(clientId: string): Promise<OAuthAppRow | null> {
  const { rows } = await getPool().query<OAuthAppRow>(
    `SELECT ${APP_PUBLIC_COLUMNS} FROM oauth_apps WHERE client_id = $1`,
    [clientId]
  );
  return rows[0] ?? null;
}

/** Verify a confidential client's secret. */
export async function verifyClientSecret(clientId: string, secret: string): Promise<boolean> {
  const { rows } = await getPool().query<{ client_secret_hash: string | null; status: string }>(
    `SELECT client_secret_hash, status FROM oauth_apps WHERE client_id = $1`,
    [clientId]
  );
  const row = rows[0];
  if (!row || row.status !== "active") return false;
  return verifySecret(secret, row.client_secret_hash);
}

/** Look up a remembered consent grant for (app, subject, resource org). */
export async function getGrant(opts: {
  appId: string;
  subject: string;
  organizationId: string;
}): Promise<{ scopes: string[] } | null> {
  const { rows } = await getPool().query<{ scopes: string[] }>(
    `SELECT scopes FROM oauth_grants
      WHERE app_id = $1::uuid AND subject = $2 AND organization_id = $3::uuid`,
    [opts.appId, opts.subject, opts.organizationId]
  );
  return rows[0] ?? null;
}

async function upsertGrant(opts: {
  appId: string;
  subject: string;
  organizationId: string;
  scopes: string[];
}): Promise<void> {
  await getPool().query(
    `INSERT INTO oauth_grants (app_id, subject, organization_id, scopes)
     VALUES ($1::uuid, $2, $3::uuid, $4)
     ON CONFLICT (app_id, subject, organization_id)
     DO UPDATE SET scopes = excluded.scopes, updated_at = now()`,
    [opts.appId, opts.subject, opts.organizationId, opts.scopes]
  );
}

// ── Authorization code issuance (on consent approve) ─────────────────────────

/**
 * Mint a one-time authorization code. The raw code is returned to the caller
 * (to put in the redirect); only its sha256 is stored. Remembers consent via
 * an oauth_grants upsert so a future authorize can skip the consent screen.
 */
export async function issueAuthorizationCode(opts: {
  appId: string;
  organizationId: string;
  subject: string;
  scopes: string[];
  redirectUri: string;
  codeChallenge?: string | null;
  codeChallengeMethod?: CodeChallengeMethod | null;
}): Promise<string> {
  const rawCode = `cc_ac_${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + OAUTH_CODE_TTL_MS);
  await getPool().query(
    `INSERT INTO oauth_authorization_codes
       (code_hash, app_id, organization_id, subject, scopes, redirect_uri,
        code_challenge, code_challenge_method, expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9)`,
    [
      sha256Hex(rawCode),
      opts.appId,
      opts.organizationId,
      opts.subject,
      opts.scopes,
      opts.redirectUri,
      opts.codeChallenge ?? null,
      opts.codeChallengeMethod ?? null,
      expiresAt,
    ]
  );
  await upsertGrant({
    appId: opts.appId,
    subject: opts.subject,
    organizationId: opts.organizationId,
    scopes: opts.scopes,
  });
  return rawCode;
}

// ── Token minting ────────────────────────────────────────────────────────────

/**
 * Mint the OAuth access token (a JWT). CRITICAL: iss/aud/sub/org match
 * lib/auth/jwt.ts verifyJwt() exactly so the existing /commerce middleware
 * accepts it. We add `scope` (space-delimited) and `oauth_app` (the app id) so
 * the scope-enforcement layer can recognise the token and assert scopes.
 */
async function mintAccessToken(opts: {
  subject: string;
  orgId: string;
  appId: string;
  scopes: string[];
}): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + OAUTH_ACCESS_TTL_SECONDS;
  const token = await new SignJWT({
    sub: opts.subject,
    org: opts.orgId,
    scope: opts.scopes.join(" "),
    oauth_app: opts.appId,
    iat: now,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(config.JWT_SECRET));
  return { token, expiresIn: OAUTH_ACCESS_TTL_SECONDS };
}

async function issueRefreshToken(opts: {
  appId: string;
  organizationId: string;
  subject: string;
  scopes: string[];
  rotatedFrom?: string | null;
}): Promise<string> {
  const raw = `cc_rt_${randomBytes(32).toString("hex")}`;
  const expiresAt = new Date(Date.now() + OAUTH_REFRESH_TTL_MS);
  await getPool().query(
    `INSERT INTO oauth_refresh_tokens
       (token_hash, app_id, organization_id, subject, scopes, expires_at, rotated_from)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
    [
      sha256Hex(raw),
      opts.appId,
      opts.organizationId,
      opts.subject,
      opts.scopes,
      expiresAt,
      opts.rotatedFrom ?? null,
    ]
  );
  return raw;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export type TokenError =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_client"
  | "unauthorized_client"
  | "invalid_scope";

// ── grant_type=authorization_code ────────────────────────────────────────────

export async function exchangeAuthorizationCode(opts: {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier?: string | null;
}): Promise<{ ok: true; body: TokenResponse } | { ok: false; error: TokenError; message: string }> {
  const app = await findAppByClientId(opts.clientId);
  if (!app || app.status !== "active") {
    return { ok: false, error: "invalid_client", message: "unknown or inactive client" };
  }

  const codeHash = sha256Hex(opts.code);
  // Atomically consume: only succeeds if not yet consumed and not expired.
  const { rows } = await getPool().query<{
    app_id: string;
    organization_id: string;
    subject: string;
    scopes: string[];
    redirect_uri: string;
    code_challenge: string | null;
    code_challenge_method: CodeChallengeMethod | null;
    consumed_at: string | null;
    expired: boolean;
  }>(
    `UPDATE oauth_authorization_codes
        SET consumed_at = now()
      WHERE code_hash = $1 AND consumed_at IS NULL
      RETURNING app_id::text, organization_id::text, subject, scopes, redirect_uri,
                code_challenge, code_challenge_method, consumed_at,
                (expires_at <= now()) AS expired`,
    [codeHash]
  );
  const code = rows[0];
  if (!code) {
    return { ok: false, error: "invalid_grant", message: "authorization code invalid, expired, or already used" };
  }
  if (code.expired) {
    return { ok: false, error: "invalid_grant", message: "authorization code expired" };
  }
  // The code must belong to the authenticating client.
  if (code.app_id !== app.id) {
    return { ok: false, error: "invalid_grant", message: "authorization code was issued to a different client" };
  }
  // redirect_uri must match the one the code was issued for (exact).
  if (!constantTimeEqual(code.redirect_uri, opts.redirectUri)) {
    return { ok: false, error: "invalid_grant", message: "redirect_uri mismatch" };
  }

  // PKCE verification.
  if (code.code_challenge) {
    if (!opts.codeVerifier) {
      return { ok: false, error: "invalid_grant", message: "code_verifier required (PKCE)" };
    }
    const ok = verifyPkce({
      verifier: opts.codeVerifier,
      challenge: code.code_challenge,
      method: code.code_challenge_method ?? "plain",
    });
    if (!ok) {
      return { ok: false, error: "invalid_grant", message: "PKCE verification failed" };
    }
  } else if (app.client_type === "public") {
    // Defence-in-depth: a public client must always have used PKCE.
    return { ok: false, error: "invalid_grant", message: "PKCE required for public clients" };
  }

  const access = await mintAccessToken({
    subject: code.subject,
    orgId: code.organization_id,
    appId: app.id,
    scopes: code.scopes,
  });
  const refresh = await issueRefreshToken({
    appId: app.id,
    organizationId: code.organization_id,
    subject: code.subject,
    scopes: code.scopes,
  });

  return {
    ok: true,
    body: {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      refresh_token: refresh,
      scope: code.scopes.join(" "),
    },
  };
}

// ── grant_type=refresh_token (rotation + reuse-detection) ────────────────────

/** Revoke an entire rotation family by walking rotated_from forward + backward. */
async function revokeRefreshFamily(seedHash: string): Promise<void> {
  // Collect the whole family: any token reachable via rotated_from links from
  // the seed, in either direction. A bounded BFS keeps it simple and safe.
  const pool = getPool();
  const family = new Set<string>([seedHash]);
  const frontier = [seedHash];
  // Walk a bounded number of hops (rotation chains are short in practice).
  for (let i = 0; i < 1000 && frontier.length > 0; i++) {
    const cur = frontier.shift()!;
    const { rows } = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM oauth_refresh_tokens
        WHERE rotated_from = $1 OR token_hash = (
          SELECT rotated_from FROM oauth_refresh_tokens WHERE token_hash = $1
        )`,
      [cur]
    );
    for (const r of rows) {
      if (!family.has(r.token_hash)) {
        family.add(r.token_hash);
        frontier.push(r.token_hash);
      }
    }
  }
  await pool.query(
    `UPDATE oauth_refresh_tokens SET revoked_at = now()
      WHERE token_hash = ANY($1) AND revoked_at IS NULL`,
    [[...family]]
  );
}

export async function exchangeRefreshToken(opts: {
  clientId: string;
  refreshToken: string;
}): Promise<{ ok: true; body: TokenResponse } | { ok: false; error: TokenError; message: string }> {
  const app = await findAppByClientId(opts.clientId);
  if (!app || app.status !== "active") {
    return { ok: false, error: "invalid_client", message: "unknown or inactive client" };
  }

  const tokenHash = sha256Hex(opts.refreshToken);
  const pool = getPool();
  const { rows } = await pool.query<{
    app_id: string;
    organization_id: string;
    subject: string;
    scopes: string[];
    expires_at: string;
    revoked_at: string | null;
    expired: boolean;
  }>(
    `SELECT app_id::text, organization_id::text, subject, scopes, expires_at::text,
            revoked_at, (expires_at <= now()) AS expired
       FROM oauth_refresh_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  const tok = rows[0];
  if (!tok) {
    return { ok: false, error: "invalid_grant", message: "unknown refresh token" };
  }
  if (tok.app_id !== app.id) {
    return { ok: false, error: "invalid_grant", message: "refresh token was issued to a different client" };
  }

  // ── Reuse-detection: a revoked (already-rotated) token presented again means
  // the token was leaked/replayed → revoke the whole family and refuse. ───────
  if (tok.revoked_at) {
    await revokeRefreshFamily(tokenHash);
    return { ok: false, error: "invalid_grant", message: "refresh token reuse detected; family revoked" };
  }
  if (tok.expired) {
    return { ok: false, error: "invalid_grant", message: "refresh token expired" };
  }

  // Rotate: revoke the presented token, issue a fresh one chained via rotated_from.
  await pool.query(
    `UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE token_hash = $1`,
    [tokenHash]
  );
  const access = await mintAccessToken({
    subject: tok.subject,
    orgId: tok.organization_id,
    appId: app.id,
    scopes: tok.scopes,
  });
  const refresh = await issueRefreshToken({
    appId: app.id,
    organizationId: tok.organization_id,
    subject: tok.subject,
    scopes: tok.scopes,
    rotatedFrom: tokenHash,
  });

  return {
    ok: true,
    body: {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      refresh_token: refresh,
      scope: tok.scopes.join(" "),
    },
  };
}

// ── grant_type=client_credentials (confidential only) ────────────────────────

export async function clientCredentialsGrant(opts: {
  clientId: string;
  scopes: string[];
}): Promise<{ ok: true; body: TokenResponse } | { ok: false; error: TokenError; message: string }> {
  const app = await findAppByClientId(opts.clientId);
  if (!app || app.status !== "active") {
    return { ok: false, error: "invalid_client", message: "unknown or inactive client" };
  }
  if (app.client_type !== "confidential") {
    return { ok: false, error: "unauthorized_client", message: "client_credentials requires a confidential client" };
  }
  // Default to the app's full allowed_scopes; an explicit subset is validated.
  const granted = opts.scopes.length > 0 ? opts.scopes : app.allowed_scopes;
  if (!scopesCovered(granted, app.allowed_scopes)) {
    return { ok: false, error: "invalid_scope", message: "requested scope exceeds the app's allowed scopes" };
  }
  // The app acts as itself on its OWN org. subject is the app id.
  const access = await mintAccessToken({
    subject: `app:${app.id}`,
    orgId: app.organization_id,
    appId: app.id,
    scopes: granted,
  });
  return {
    ok: true,
    body: {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: access.expiresIn,
      scope: granted.join(" "),
    },
  };
}

// ── Revocation ───────────────────────────────────────────────────────────────

/** Revoke a refresh token (RFC 7009). Best-effort, always 200 at the route. */
export async function revokeToken(refreshToken: string): Promise<void> {
  await getPool().query(
    `UPDATE oauth_refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256Hex(refreshToken)]
  );
}
