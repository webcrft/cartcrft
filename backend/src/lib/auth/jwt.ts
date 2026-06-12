/**
 * lib/auth/jwt.ts — JWT mint + verify helpers.
 *
 * JWT claim shape (management / dashboard tokens):
 * {
 *   sub:   "<userId UUID>",          // user identifier
 *   org:   "<orgId UUID>",           // org the user is acting in
 *   email: "<email>",                // informational
 *   iat:   <unix seconds>,
 *   exp:   <unix seconds>,
 *   jti:   "<uuid>",                 // for future blacklisting
 * }
 *
 * Uses `jose` (JOSE spec, HS256) — same library installed in the skeleton.
 * Mirrors webcrft JWT shape (sub = userId, org claim added for cartcrft
 * since we have no organization_members table — org is embedded in the token).
 *
 * Test helper: mintTestJwt(userId, orgId) signs with JWT_SECRET from env.
 * Documented in parity-endpoints.md.
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { randomUUID } from "node:crypto";
import { config } from "../../config/config.js";

// ── Claim types ───────────────────────────────────────────────────────────────

export interface CartcrftJwtClaims extends JWTPayload {
  sub: string;   // userId
  org: string;   // orgId
  email?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function secretKey(): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

/**
 * Mint a signed JWT for a user + org pair.
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
    jti: randomUUID(),
    iat: now,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${expHours}h`)
    .sign(secretKey());
}

/**
 * Verify + decode a JWT.
 * Returns the claims on success, null on failure (expired / invalid).
 */
export async function verifyJwt(
  token: string
): Promise<CartcrftJwtClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: ["HS256"],
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
 * Claim shape documented in docs/parity-endpoints.md.
 */
export async function mintTestJwt(opts: {
  userId: string;
  orgId: string;
  email?: string;
}): Promise<string> {
  return mintJwt({ ...opts, expiryHours: 24 });
}
