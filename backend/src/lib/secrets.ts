/**
 * lib/secrets.ts — AES-256-GCM encrypt/decrypt utility.
 *
 * Layout on the wire: base64( nonce(12 bytes) || ciphertext || tag(16 bytes) )
 *
 * Key encoding:
 *   - 64 hex chars → 32-byte key
 *   - 44 base64 chars → 32-byte key
 *   - anything else → throw
 *
 * Dev mode passthrough:
 *   encodeSecretValue / decodeSecretValue accept an empty secretsKey to return
 *   the value as-is (no encryption). This makes local dev work without setting
 *   AUTH_SECRETS_KEY.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// ── Key parsing ────────────────────────────────────────────────────────────────

/**
 * Parse the raw key string into a 32-byte Buffer.
 * Tries hex (64 chars) first, then base64 (44 chars standard base64 for 32 bytes).
 * Throws if the key is malformed or the decoded length is not 32 bytes.
 */
function parseKey(key: string): Buffer {
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    const buf = Buffer.from(key, "hex");
    if (buf.length !== 32) {
      throw new Error("secrets: hex key decoded to unexpected length");
    }
    return buf;
  }

  // Try base64 (standard 44-char base64 encoding of 32 bytes)
  try {
    const buf = Buffer.from(key, "base64");
    if (buf.length === 32) {
      return buf;
    }
  } catch {
    // fall through
  }

  throw new Error(
    "secrets: AUTH_SECRETS_KEY must be a 64-char hex string or 44-char base64 string (32 bytes)"
  );
}

// ── Core encrypt/decrypt ───────────────────────────────────────────────────────

/**
 * Encrypt `value` with AES-256-GCM.
 *
 * Returns base64( nonce(12) || ciphertext || tag(16) ).
 * Throws if `key` is malformed.
 */
export function encryptSecret(value: string, key: string): string {
  const keyBuf = parseKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBuf, nonce);

  const pt = Buffer.from(value, "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  // Layout: nonce(12) || ciphertext(variable) || tag(16)
  const combined = Buffer.concat([nonce, ct, tag]);
  return combined.toString("base64");
}

/**
 * Decrypt a value previously produced by `encryptSecret`.
 *
 * Throws if `key` is malformed or the ciphertext is invalid/tampered.
 */
export function decryptSecret(ciphertext: string, key: string): string {
  const keyBuf = parseKey(key);
  const buf = Buffer.from(ciphertext, "base64");

  if (buf.length < 12 + 16) {
    throw new Error("secrets: ciphertext too short");
  }

  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);

  const decipher = createDecipheriv("aes-256-gcm", keyBuf, nonce);
  decipher.setAuthTag(tag);

  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// ── High-level helpers ─────────────────────────────────────────────────────────

/**
 * Encode a secret value for storage.
 *
 * - If `value` is empty string → return null (store SQL NULL)
 * - If `secretsKey` is empty  → return value as-is (dev plaintext passthrough)
 * - Otherwise                 → return encryptSecret(value, secretsKey)
 */
export function encodeSecretValue(
  value: string,
  secretsKey: string
): string | null {
  if (value === "") return null;
  if (!secretsKey) return value;
  return encryptSecret(value, secretsKey);
}

/**
 * Decode a secret value from storage.
 *
 * - If `stored` is empty string → return ''
 * - If `secretsKey` is empty   → return stored (dev plaintext passthrough)
 * - Otherwise                  → return decryptSecret(stored, secretsKey)
 */
export function decodeSecretValue(stored: string, secretsKey: string): string {
  if (!stored) return "";
  if (!secretsKey) return stored;
  return decryptSecret(stored, secretsKey);
}
