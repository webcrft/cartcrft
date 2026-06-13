/**
 * lib/auth/super-token.ts — Timing-safe SUPER_TOKEN validator.
 *
 * Problem: a naïve `=== superToken` comparison leaks the token length (and
 * potentially character-by-character timing information) through early-exit
 * behaviour.  Node's `crypto.timingSafeEqual` avoids this by comparing two
 * fixed-length Buffers in constant time.
 *
 * Usage (stores super-routes):
 *   import { timingSafeCheckSuperToken } from "../../lib/auth/super-token.js";
 *   if (!timingSafeCheckSuperToken(provided)) { return reply.status(401)... }
 *
 * Usage (payments super-routes, x-super-token header):
 *   if (!timingSafeCheckSuperToken(request.headers["x-super-token"])) { ... }
 *
 * Behaviour:
 *  - Returns false if SUPER_TOKEN env var is not set or is empty.
 *  - Returns false if provided is undefined / empty string / not a string.
 *  - Returns false if lengths differ (constant-time: pads provided to match).
 *  - Returns timingSafeEqual result otherwise.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Validate `provided` against the SUPER_TOKEN environment variable using a
 * constant-time comparison (immune to timing side-channels).
 *
 * @param provided - The raw token value extracted from the request (header
 *   value, post-"Bearer " strip, etc.).  `undefined` is treated as empty.
 * @returns `true` only when `provided` exactly matches the configured
 *   SUPER_TOKEN and the env var is non-empty.
 */
export function timingSafeCheckSuperToken(
  provided: string | string[] | undefined
): boolean {
  const expected = process.env["SUPER_TOKEN"];

  // Guard: env var not set or empty → always deny.
  if (!expected) return false;

  // Normalise: accept only a plain string; array values (multiple header
  // occurrences) and undefined are treated as empty → deny.
  const candidate: string =
    typeof provided === "string" ? provided : "";

  // Constant-time comparison.
  //
  // timingSafeEqual requires both Buffers to be the same length.  We pad the
  // shorter value to match the expected length so that the comparison always
  // runs over `expected.length` bytes.  This prevents length leakage.
  const expectedBuf = Buffer.from(expected, "utf8");
  const candidateBuf = Buffer.alloc(expectedBuf.length);

  // Copy candidate bytes into the fixed-size buffer (truncates if longer,
  // zero-pads if shorter — either way the comparison runs the full length).
  const src = Buffer.from(candidate, "utf8");
  src.copy(candidateBuf, 0, 0, Math.min(src.length, expectedBuf.length));

  // If the candidate was a different length it can never match, but we still
  // run timingSafeEqual to avoid leaking the expected length via timing.
  const lengthsMatch = src.length === expectedBuf.length;
  const bytesMatch = timingSafeEqual(candidateBuf, expectedBuf);

  return lengthsMatch && bytesMatch;
}
