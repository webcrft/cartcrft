/**
 * webhooks/verifiers/paystack.ts
 *
 * Paystack webhook signature verification + event normalisation.
 *
 * Ported from: webcrft-mono/backend/internal/webhooks/providers/paystack/paystack.go
 *
 * Signature scheme (X-Paystack-Signature header):
 *   HMAC-SHA512(raw_body, secret_key) encoded as lowercase hex.
 *
 * The secret_key is your Paystack Secret Key (sk_live_... or sk_test_...).
 * No timestamp is embedded — replay protection is event-id based.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Normalised Paystack event. */
export interface PaystackEvent {
  eventType: string;
  raw: unknown;
  data: Record<string, unknown>;
}

/**
 * Verify X-Paystack-Signature and parse the event.
 *
 * Throws if the signature is invalid.
 * Pass an empty secret to skip validation (test fixture injection).
 */
export function verifyAndParsePaystack(
  body: Buffer | string,
  sigHeader: string,
  secret: string
): PaystackEvent {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (secret) {
    verifyPaystackSignature(bodyBuf, sigHeader, secret);
  }
  return parsePaystackEvent(bodyBuf);
}

export function verifyPaystackSignature(
  body: Buffer,
  sigHeader: string,
  secret: string
): void {
  if (!sigHeader) {
    throw new Error("paystack: missing X-Paystack-Signature header");
  }
  const mac = createHmac("sha512", secret);
  mac.update(body);
  const expected = mac.digest("hex");
  const provided = sigHeader.trim();

  if (
    expected.length !== provided.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
  ) {
    throw new Error("paystack: signature mismatch");
  }
}

function parsePaystackEvent(body: Buffer): PaystackEvent {
  let raw: { event?: string; data?: Record<string, unknown> };
  try {
    raw = JSON.parse(body.toString("utf8")) as typeof raw;
  } catch {
    throw new Error("paystack: unmarshal event: invalid JSON");
  }

  if (!raw.event) throw new Error("paystack: event missing event field");

  return {
    eventType: raw.event,
    raw: raw,
    data: raw.data ?? {},
  };
}

/**
 * Sign a payload for testing.
 * Returns the X-Paystack-Signature header value.
 */
export function signPaystack(body: Buffer | string, secret: string): string {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const mac = createHmac("sha512", secret);
  mac.update(bodyBuf);
  return mac.digest("hex");
}
