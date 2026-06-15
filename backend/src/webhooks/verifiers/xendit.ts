/**
 * webhooks/verifiers/xendit.ts
 *
 * Xendit webhook verification + event normalisation.
 *
 * Ported from: webcrft-mono/backend/internal/webhooks/providers/xendit/xendit.go
 *
 * Verification scheme (x-callback-token header):
 *   Constant-time compare against the configured webhook_token.
 *   Xendit does NOT use HMAC — the callback token is a shared secret.
 */

import { timingSafeEqual } from "node:crypto";

/** Normalised Xendit event. */
export interface XenditEvent {
  eventType: string;
  raw: unknown;
  data: Record<string, unknown>;
}

/**
 * Verify x-callback-token and parse the event.
 *
 * Throws if the token is invalid.
 * P2-16: configuredToken is always required; callers must ensure it is non-empty.
 */
export function verifyAndParseXendit(
  body: Buffer | string,
  callbackToken: string,
  configuredToken: string
): XenditEvent {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  verifyXenditToken(callbackToken, configuredToken);
  return parseXenditEvent(bodyBuf);
}

export function verifyXenditToken(provided: string, expected: string): void {
  if (!provided) {
    throw new Error("xendit: missing x-callback-token header");
  }
  // Constant-time compare — both must be same byte-length.
  // If lengths differ the tokens can't match, but we still do a constant-time
  // compare on equal-length copies to avoid timing leaks.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("xendit: callback token mismatch");
  }
}

function parseXenditEvent(body: Buffer): XenditEvent {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("xendit: unmarshal event: invalid JSON");
  }

  // Xendit event type is in the top-level "event" field for newer payloads,
  // or inferred from status for older invoice callbacks.
  let eventType: string = typeof raw["event"] === "string" ? raw["event"] : "";
  if (!eventType) {
    // Fallback: older invoice/payment callbacks have no "event" field.
    const status = typeof raw["status"] === "string" ? raw["status"] : "";
    eventType = status ? `payment.${status}` : "callback";
  }

  return {
    eventType,
    raw,
    data: raw,
  };
}
