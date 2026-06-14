/**
 * lib/auth/jwt.ts — JWT mint + verify helpers.
 *
 * JWT claim shape (management / dashboard tokens):
 * {
 *   iss:   "cartcrft",               // issuer — always "cartcrft" for platform tokens
 *   aud:   "cartcrft",               // audience — always "cartcrft" for platform tokens
 *   sub:   "<userId UUID>",          // user identifier
 *   org:   "<orgId UUID>",           // org the user is acting in
 *   email: "<email>",                // informational
 *   iat:   <unix seconds>,
 *   exp:   <unix seconds>,
 * }
 *
 * jti (JWT ID) decision: DROPPED. No revocation list exists in this codebase.
 * Keeping jti without a blacklist provides false safety: callers see the claim
 * and assume revocation is possible, but it is not checked. If a revocation list
 * is added in a future task, restore jti at that point.
 *
 * Uses `jose` (JOSE spec, HS256) — same library installed in the skeleton.
 * Mirrors webcrft JWT shape (sub = userId, org claim added for cartcrft
 * since we have no organization_members table — org is embedded in the token).
 *
 * Test helper: mintTestJwt(userId, orgId) signs with JWT_SECRET from env.
 * Documented in parity-endpoints.md.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { config } from "../../config/config.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Issuer claim value for all platform (management/dashboard) JWTs. */
export const JWT_ISSUER = "cartcrft" as const;

/** Audience claim value for all platform JWTs. */
export const JWT_AUDIENCE = "cartcrft" as const;

// ── Claim types ───────────────────────────────────────────────────────────────

export interface CartcrftJwtClaims extends JWTPayload {
  sub: string;   // userId
  org: string;   // orgId
  email?: string;
  /**
   * OAuth2 access-token claims (present ONLY on tokens minted by the OAuth
   * authorization server — modules/oauth). When set, the request is acting as a
   * third-party app on behalf of a merchant; the scope-enforcement layer
   * (requireScope) asserts these scopes. Absent on dashboard/management JWTs.
   */
  scope?: string;       // space-delimited granted scopes
  oauth_app?: string;   // the oauth_apps.id the token was issued to
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function secretKey(): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

/**
 * Mint a signed JWT for a user + org pair.
 *
 * Sets `iss: "cartcrft"` and `aud: "cartcrft"` on every token so that
 * verifyJwt() can reject tokens issued by a different system or intended for
 * a different audience (defence-in-depth against key reuse across services).
 *
 * Used by:
 *  - Platform auth (T2.8) when a dashboard user logs in.
 *  - mintTestJwt() in test suites.
 */
export async function mintJwt(opts: {
  userId: string;
  orgId: string;
  email?: string;
  expiryHours?: number;
}): Promise<string> {
  const expHours = opts.expiryHours ?? config.JWT_EXPIRY_HOURS;
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    sub: opts.userId,
    org: opts.orgId,
    email: opts.email,
    iat: now,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(`${expHours}h`)
    .sign(secretKey());
}

/**
 * Verify + decode a JWT.
 * Returns the claims on success, null on failure (expired / invalid / wrong iss or aud).
 */
export async function verifyJwt(
  token: string
): Promise<CartcrftJwtClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    const claims = payload as CartcrftJwtClaims;
    if (!claims.sub || !claims.org) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * mintTestJwt — convenience helper for test suites.
 *
 * Signs a JWT with JWT_SECRET from the environment.  Suites import this
 * directly; no REST endpoint needed to obtain a test token.
 *
 * Includes iss/aud so tokens minted here pass verifyJwt() validation.
 * Claim shape documented in docs/parity-endpoints.md.
 */
export async function mintTestJwt(opts: {
  userId: string;
  orgId: string;
  email?: string;
}): Promise<string> {
  return mintJwt({ ...opts, expiryHours: 24 });
}
