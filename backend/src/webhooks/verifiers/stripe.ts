/**
 * webhooks/verifiers/stripe.ts
 *
 * Stripe webhook signature verification + event normalisation.
 *
 * Ported from: webcrft-mono/backend/internal/webhooks/providers/stripe/stripe.go
 *
 * Signature scheme (Stripe-Signature header):
 *   t=<unix_ts>,v1=<hmac_sha256_hex>[,v0=...]
 *   Signed payload: "<timestamp>.<raw_body>"
 *   Tolerance: 300 seconds (5 minutes)
 *
 * Dual-secret: the router tries the primary secret first; if it fails it tries
 * the secondary (webhook_secret_secondary). Rejection only when both fail.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Maximum webhook age accepted. */
export const STRIPE_TOLERANCE_SECONDS = 300;

/** Normalised Stripe event. */
export interface StripeEvent {
  id: string;
  type: string;
  created: Date;
  raw: unknown;
  /** data.object from the Stripe event payload. */
  object: Record<string, unknown>;
  /** metadata from object.metadata (if present). */
  metadata: Record<string, unknown>;
}

/**
 * Verify the Stripe-Signature header and parse the event.
 *
 * Throws if the signature is invalid or the timestamp is stale.
 * P2-16: secret is always required; callers must ensure it is non-empty before
 * calling (the router already enforces this with a 401 early-return).
 */
export function verifyAndParseStripe(
  body: Buffer | string,
  sigHeader: string,
  secret: string
): StripeEvent {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  verifyStripeSignature(bodyBuf, sigHeader, secret);
  return parseStripeEvent(bodyBuf);
}

/**
 * Verify only — throws on failure.
 * Public so the router can call it with the primary then secondary secret.
 */
export function verifyStripeSignature(
  body: Buffer,
  sigHeader: string,
  secret: string
): void {
  if (!sigHeader) {
    throw new Error("stripe: missing Stripe-Signature header");
  }

  const { ts, v1 } = extractStripeHeader(sigHeader);

  // Reject stale events (5-minute tolerance).
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = Math.abs(nowSec - ts);
  if (ageSec > STRIPE_TOLERANCE_SECONDS) {
    throw new Error(
      `stripe: webhook timestamp too old or in future (age=${ageSec}s)`
    );
  }

  // Compute expected: HMAC-SHA256("<ts>.<body>", secret).
  const signed = `${ts}.${body.toString("utf8")}`;
  const mac = createHmac("sha256", secret);
  mac.update(signed);
  const expected = mac.digest("hex");

  // Constant-time compare.
  if (
    expected.length !== v1.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(v1))
  ) {
    throw new Error("stripe: signature mismatch");
  }
}

/**
 * Parse "t=<ts>,v1=<sig>[,v0=...]" from the Stripe-Signature header.
 */
export function extractStripeHeader(h: string): { ts: number; v1: string } {
  let ts = 0;
  let v1 = "";

  for (const part of h.split(",")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (key === "t") {
      ts = parseInt(val, 10);
    } else if (key === "v1") {
      v1 = val;
    }
  }

  if (!ts) throw new Error("stripe: missing timestamp (t=) in Stripe-Signature");
  if (!v1) throw new Error("stripe: missing v1 signature in Stripe-Signature");

  return { ts, v1 };
}

function parseStripeEvent(body: Buffer): StripeEvent {
  let raw: {
    id?: string;
    type?: string;
    created?: number;
    data?: Record<string, unknown>;
  };
  try {
    raw = JSON.parse(body.toString("utf8")) as typeof raw;
  } catch {
    throw new Error("stripe: unmarshal event: invalid JSON");
  }

  if (!raw.type) throw new Error("stripe: event missing type field");

  const object =
    raw.data != null &&
    typeof raw.data["object"] === "object" &&
    raw.data["object"] !== null
      ? (raw.data["object"] as Record<string, unknown>)
      : {};

  const metadata =
    typeof object["metadata"] === "object" && object["metadata"] !== null
      ? (object["metadata"] as Record<string, unknown>)
      : {};

  return {
    id: raw.id ?? "",
    type: raw.type,
    created: raw.created ? new Date(raw.created * 1000) : new Date(),
    raw: JSON.parse(body.toString("utf8")) as unknown,
    object,
    metadata,
  };
}

/**
 * Sign a payload for testing.
 * Returns a Stripe-Signature header value.
 */
export function signStripe(body: Buffer | string, secret: string, tsOverride?: number): string {
  const bodyStr = typeof body === "string" ? body : body.toString("utf8");
  const ts = tsOverride ?? Math.floor(Date.now() / 1000);
  const signed = `${ts}.${bodyStr}`;
  const mac = createHmac("sha256", secret);
  mac.update(signed);
  const v1 = mac.digest("hex");
  return `t=${ts},v1=${v1}`;
}
