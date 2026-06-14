/**
 * lib/oauth/pkce.ts — PKCE (RFC 7636) verification helpers.
 *
 * Public clients (and any client that supplies one) bind an authorization code
 * to a `code_verifier` via a `code_challenge`. At /oauth/authorize the app sends
 * the challenge; at /oauth/token it proves possession by sending the verifier.
 *
 *   S256 (required for public clients): challenge = BASE64URL(SHA256(verifier))
 *   plain (discouraged, confidential-only): challenge === verifier
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type CodeChallengeMethod = "S256" | "plain";

/** base64url(sha256(input)) — the S256 transform. */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Constant-time string comparison (avoids leaking match position via timing). */
function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify a code_verifier against the stored code_challenge.
 * Returns true when the verifier transforms (per method) to the challenge.
 */
export function verifyPkce(opts: {
  verifier: string;
  challenge: string;
  method: CodeChallengeMethod;
}): boolean {
  if (!opts.verifier || !opts.challenge) return false;
  const transformed =
    opts.method === "S256" ? s256Challenge(opts.verifier) : opts.verifier;
  return constantTimeEqual(transformed, opts.challenge);
}

/**
 * RFC 7636 code_verifier syntax: 43–128 chars from the unreserved set
 * [A-Za-z0-9-._~]. Enforced so we reject malformed verifiers early.
 */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidCodeVerifier(verifier: string): boolean {
  return VERIFIER_RE.test(verifier);
}
