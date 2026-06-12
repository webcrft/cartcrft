/**
 * webhooks/verifiers/razorpay.ts
 *
 * Razorpay webhook signature verification + event normalisation.
 *
 * Ported from: webcrft-mono/backend/internal/webhooks/providers/razorpay/razorpay.go
 *
 * Signature scheme (X-Razorpay-Signature header):
 *   HMAC-SHA256(raw_body, webhook_secret) encoded as lowercase hex.
 *
 * No timestamp in the signature. Replay protection via event-id dedup.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Normalised Razorpay event. */
export interface RazorpayEvent {
  entity: string;
  eventType: string;
  contains: string[];
  raw: unknown;
  payment: Record<string, unknown> | null;
  order: Record<string, unknown> | null;
  refund: Record<string, unknown> | null;
}

/**
 * Verify X-Razorpay-Signature and parse the event.
 *
 * Throws if the signature is invalid.
 * Pass an empty secret to skip validation.
 */
export function verifyAndParseRazorpay(
  body: Buffer | string,
  sigHeader: string,
  secret: string
): RazorpayEvent {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (secret) {
    verifyRazorpaySignature(bodyBuf, sigHeader, secret);
  }
  return parseRazorpayEvent(bodyBuf);
}

export function verifyRazorpaySignature(
  body: Buffer,
  sigHeader: string,
  secret: string
): void {
  if (!sigHeader) {
    throw new Error("razorpay: missing X-Razorpay-Signature header");
  }
  const mac = createHmac("sha256", secret);
  mac.update(body);
  const expected = mac.digest("hex");
  const provided = sigHeader.trim();

  if (
    expected.length !== provided.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
  ) {
    throw new Error("razorpay: signature mismatch");
  }
}

function parseRazorpayEvent(body: Buffer): RazorpayEvent {
  let raw: {
    entity?: string;
    event?: string;
    contains?: string[];
    payload?: {
      payment?: { entity?: Record<string, unknown> };
      order?: { entity?: Record<string, unknown> };
      refund?: { entity?: Record<string, unknown> };
    };
  };
  try {
    raw = JSON.parse(body.toString("utf8")) as typeof raw;
  } catch {
    throw new Error("razorpay: unmarshal event: invalid JSON");
  }

  if (!raw.event) throw new Error("razorpay: event missing event field");

  return {
    entity: raw.entity ?? "",
    eventType: raw.event,
    contains: raw.contains ?? [],
    raw: raw,
    payment: raw.payload?.payment?.entity ?? null,
    order: raw.payload?.order?.entity ?? null,
    refund: raw.payload?.refund?.entity ?? null,
  };
}

/**
 * Sign a payload for testing.
 * Returns the X-Razorpay-Signature header value.
 */
export function signRazorpay(body: Buffer | string, secret: string): string {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const mac = createHmac("sha256", secret);
  mac.update(bodyBuf);
  return mac.digest("hex");
}
