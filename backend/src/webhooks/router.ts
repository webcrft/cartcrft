/**
 * webhooks/router.ts — Inbound payment webhook router.
 *
 * Ported faithfully from:
 *   webcrft-mono/backend/internal/webhooks/router/router.go
 *
 * Routes:
 *   POST /webhooks/:storeId/payment/:providerRef  (path-based — T2.5)
 *   POST /{providerType}/{ref}  via Host: {storeId}.webhooks.{BASE_DOMAIN}  (T6.3)
 *   GET  /commerce/stores/:storeId/webhook-url  (T6.3)
 *
 * The `:providerRef` param is the payment provider id or slug. The handler:
 *  1. Reads the raw body (needed for HMAC verification — must run before JSON parsing).
 *  2. Loads the payment_providers row for this store + ref.
 *  3. Verifies the provider-specific signature.
 *  4. Deduplicates via webhook_replay_guard (per-event-id for native providers,
 *     body-hash for custom-webhook providers).
 *  5. Records payment success / refund in the appropriate tables.
 *  6. Logs the request to payment_provider_webhook_log.
 *
 * Note: the tracking webhook /webhooks/:storeId/tracking/:shipmentId is owned by
 * T2.6 (logistics). This router is mounted at /webhooks/:storeId/payment/:providerRef
 * so both coexist under the same /webhooks prefix without conflict.
 *
 * Subdomain routing (T6.3):
 *   An onRequest hook inspects the Host header. If it matches
 *   {storeId}.webhooks.{BASE_DOMAIN}, the storeId is extracted and the
 *   path is interpreted as /{providerType}/{providerRef}. Both path-based and
 *   subdomain-based routing call the same handleWebhook() core, so signature
 *   verification, replay dedup, and payment recording are identical.
 *
 *   When BASE_DOMAIN is absent or "localhost", subdomain routing is disabled and
 *   the onRequest hook is a no-op (path-based routing still works).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { getPool } from "../db/pool.js";
import { config } from "../config/config.js";
import { decodeSecretValue } from "../lib/secrets.js";
import { completeCheckout } from "../modules/checkout/complete.js";
import { trackEcommerce } from "../lib/analytics.js";

import {
  verifyAndParseStripe,
  verifyStripeSignature,
  type StripeEvent,
} from "./verifiers/stripe.js";
import {
  verifyAndParsePaystack,
  type PaystackEvent,
} from "./verifiers/paystack.js";
import {
  verifyAndParseRazorpay,
  type RazorpayEvent,
} from "./verifiers/razorpay.js";
import {
  verifyAndParseXendit,
  type XenditEvent,
} from "./verifiers/xendit.js";
import { storeAuthRead } from "../lib/auth/middleware.js";

const secretsKey = config.AUTH_SECRETS_KEY ?? "";

// ── Subdomain routing helpers (T6.3) ──────────────────────────────────────────

/**
 * Returns the effective BASE_DOMAIN at call time, stripped of protocol and port.
 *
 * Reads from process.env directly so that tests can override BASE_DOMAIN after
 * the module is loaded (the config singleton is frozen at import time).
 * Falls back to config.BASE_DOMAIN when the env var is not set at call time.
 */
function getBaseDomain(): string {
  const raw = process.env["BASE_DOMAIN"] ?? config.BASE_DOMAIN ?? "";
  return raw
    .replace(/^https?:\/\//, "")
    .replace(/:.*$/, ""); // strip port if any
}

/**
 * Whether subdomain webhook routing is enabled.
 * Evaluated lazily so tests can set BASE_DOMAIN after module load.
 * Disabled when BASE_DOMAIN is absent, "localhost", or "127.0.0.1".
 */
export function isSubdomainRoutingEnabled(): boolean {
  const bd = getBaseDomain();
  return Boolean(bd) &&
    bd !== "localhost" &&
    bd !== "127.0.0.1";
}

/**
 * Given a Host header value, extract the storeId UUID if the host matches
 * the pattern `{storeId}.webhooks.{BASE_DOMAIN}`.
 * Returns null when subdomain routing is disabled or the host does not match.
 */
export function storeIdFromHost(host: string): string | null {
  const bd = getBaseDomain();
  if (!bd || bd === "localhost" || bd === "127.0.0.1") return null;

  // Strip port suffix (e.g. host:3000 → host).
  const bareHost = host.split(":")[0] ?? host;
  const suffix = `.webhooks.${bd}`;
  if (!bareHost.endsWith(suffix)) return null;

  const storeId = bareHost.slice(0, bareHost.length - suffix.length);
  // Must be a UUID (36 chars with dashes).
  if (storeId.length !== 36) return null;
  return storeId;
}

/** 1-cent tolerance to allow for provider rounding. */
const AMOUNT_TOLERANCE = 0.01;

// ── Provider row shape ─────────────────────────────────────────────────────────

interface ProviderRow {
  id: string;
  storeId: string;
  name: string;
  type: string;
  webhookUrl: string;
  webhookSecret: string;
  providerSlug: string;
  config: Record<string, unknown>;
}

// ── Fastify plugin ─────────────────────────────────────────────────────────────

/**
 * Register inbound webhook routes.
 *
 * Mounts:
 *   POST /webhooks/:storeId/payment/:providerRef
 *   PUT  /webhooks/:storeId/payment/:providerRef
 *   POST /webhooks/:storeId/payment              (no providerRef — load by type)
 *   PUT  /webhooks/:storeId/payment              (no providerRef — load by type)
 *   GET  /commerce/stores/:storeId/webhook-url   (T6.3)
 *
 * Subdomain routing (T6.3):
 *   An onRequest hook detects Host: {storeId}.webhooks.{BASE_DOMAIN} and
 *   dispatches to handleWebhook() with the storeId from the subdomain and
 *   the providerType/ref from the URL path. The request is replied inside the
 *   hook, so none of the path-based routes run for subdomain requests.
 *
 * Does NOT register /webhooks/:storeId/tracking/:shipmentId (owned by T2.6).
 */
export async function webhooksPlugin(app: FastifyInstance): Promise<void> {
  // Add content-type parser for application/json that preserves the raw body.
  // This must be done before route registration so signature verification can
  // access the un-parsed bytes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // Also handle text/plain (Stripe sends application/json but some providers vary).
  app.addContentTypeParser(
    "text/plain",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // ── T6.3: Subdomain webhook routing ─────────────────────────────────────────
  // Mechanism: wildcard routes registered for paths /:providerType and
  // /:providerType/:providerRef with a preHandler that verifies the Host header
  // matches the {storeId}.webhooks.{BASE_DOMAIN} pattern.
  //
  // Why wildcard routes rather than an onRequest hook:
  //   In Fastify 5, hooks registered inside a plugin scope only run for routes
  //   in that scope. Requests to unregistered paths skip plugin-scoped hooks
  //   and go directly to the not-found handler. Wildcard routes ARE proper
  //   routes and participate in normal route matching + body parsing.
  //
  // Both POST and PUT are registered (payment providers may use either).
  // Raw body is available as a Buffer because of the content-type parsers above.

  const subdomainHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> => {
    const host = (request.headers["host"] as string | undefined) ?? "";
    const storeId = storeIdFromHost(host);
    if (!storeId) {
      // Not a subdomain request — this wildcard route should not match for
      // non-subdomain hosts, but guard here just in case.
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } });
    }

    // Parse /:providerType and optional /:providerRef from route params.
    const params = request.params as Record<string, string>;
    const providerType = params["providerType"] ?? "";
    const providerRef = params["providerRef"] ?? "";

    if (!providerType) {
      return reply.status(400).send({ error: { code: "INVALID_PAYLOAD", message: "path must be /{provider_type}/{provider_ref}" } });
    }

    const rawBody: Buffer =
      request.body instanceof Buffer
        ? request.body
        : Buffer.from(
            typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body ?? ""),
            "utf8"
          );

    await handleWebhook(request, reply, storeId, providerType, providerRef, rawBody);
  };

  // Wildcard routes for subdomain-based dispatch: /{providerType}/{providerRef}
  // These routes have broad paths so they ONLY handle requests when the Host
  // header matches the subdomain pattern (checked inside subdomainHandler).
  // They are registered AFTER the specific path-based routes above to ensure
  // Fastify's router prefers the more specific /webhooks/:storeId/... routes.
  app.post<{ Params: { providerType: string; providerRef: string } }>(
    "/:providerType/:providerRef",
    subdomainHandler
  );
  app.put<{ Params: { providerType: string; providerRef: string } }>(
    "/:providerType/:providerRef",
    subdomainHandler
  );
  app.post<{ Params: { providerType: string; providerRef?: string } }>(
    "/:providerType",
    subdomainHandler
  );
  app.put<{ Params: { providerType: string; providerRef?: string } }>(
    "/:providerType",
    subdomainHandler
  );

  const handler = async (
    request: FastifyRequest<{
      Params: { storeId: string; providerRef?: string };
    }>,
    reply: FastifyReply
  ) => {
    const { storeId, providerRef = "" } = request.params;
    const rawBody: Buffer =
      request.body instanceof Buffer
        ? request.body
        : Buffer.from(
            typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body ?? ""),
            "utf8"
          );

    await handleWebhook(request, reply, storeId, "payment", providerRef, rawBody);
  };

  // With providerRef
  app.post<{ Params: { storeId: string; providerRef: string } }>(
    "/webhooks/:storeId/payment/:providerRef",
    handler
  );
  app.put<{ Params: { storeId: string; providerRef: string } }>(
    "/webhooks/:storeId/payment/:providerRef",
    handler
  );

  // Without providerRef (load first active provider of 'payment' type)
  app.post<{ Params: { storeId: string; providerRef?: string } }>(
    "/webhooks/:storeId/payment",
    handler
  );
  app.put<{ Params: { storeId: string; providerRef?: string } }>(
    "/webhooks/:storeId/payment",
    handler
  );

  // ── T6.3: GET /commerce/stores/:storeId/webhook-url ─────────────────────────
  // Returns subdomain + path-based webhook URLs for all active providers.
  // Ported from: webcrft-mono/backend/internal/handlers/commerce.go GetWebhookURL().
  app.get<{ Params: { storeId: string } }>(
    "/commerce/stores/:storeId/webhook-url",
    { preHandler: storeAuthRead },
    async (request, reply) => {
      const { storeId } = request.params;
      const pool = getPool();

      // Evaluate lazily at request time so tests can override BASE_DOMAIN.
      const baseDomain = getBaseDomain();
      const subdomainEnabled = isSubdomainRoutingEnabled();

      // Provider tables and their routing types.
      // Columns differ by table: payment_providers has slug+position;
      // shipping has position but no slug; notification/tax have neither.
      // We handle this by per-table SQL with available columns only.
      interface TableDef {
        table: string;
        ptype: string;
        hasSlug: boolean;
        hasPosition: boolean;
      }
      const providerTables: TableDef[] = [
        { table: "payment_providers",      ptype: "payment",      hasSlug: true,  hasPosition: true  },
        { table: "shipping_providers",     ptype: "shipping",     hasSlug: false, hasPosition: true  },
        { table: "notification_providers", ptype: "notification", hasSlug: false, hasPosition: false },
        { table: "tax_providers",          ptype: "tax",          hasSlug: false, hasPosition: false },
      ];

      interface WebhookEntry {
        provider_id: string;
        provider_type: string;
        name: string;
        slug: string;
        subdomain_url: string | null;
        path_url: string;
      }

      const entries: WebhookEntry[] = [];

      for (const { table, ptype, hasSlug, hasPosition } of providerTables) {
        const slugCol = hasSlug ? ", coalesce(slug, '') AS slug" : ", '' AS slug";
        const orderClause = hasPosition
          ? "ORDER BY position ASC, created_at ASC"
          : "ORDER BY created_at ASC";

        const { rows } = await pool.query<{
          id: string;
          name: string;
          slug: string;
        }>(
          `SELECT id::text, name${slugCol}
           FROM ${table}
           WHERE store_id = $1::uuid AND is_active = true
           ${orderClause}`,
          [storeId]
        );

        for (const row of rows) {
          const ref = row.slug || row.id;

          // Path-based URL (always available).
          const pathUrl = `/webhooks/${storeId}/${ptype}/${ref}`;

          // Subdomain URL (null when BASE_DOMAIN not configured or is localhost).
          const subdomainUrl = subdomainEnabled
            ? `https://${storeId}.webhooks.${baseDomain}/${ptype}/${ref}`
            : null;

          entries.push({
            provider_id: row.id,
            provider_type: ptype,
            name: row.name,
            slug: row.slug,
            subdomain_url: subdomainUrl,
            path_url: pathUrl,
          });
        }
      }

      return reply.status(200).send({
        webhooks: entries,
        base_domain: baseDomain || null,
        subdomain_routing_enabled: subdomainEnabled,
      });
    }
  );
}

// ── Core dispatch ──────────────────────────────────────────────────────────────

async function handleWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  storeId: string,
  providerType: string,
  providerRef: string,
  body: Buffer
): Promise<void> {
  const pool = getPool();
  const startMs = Date.now();

  // Load provider.
  const prov = await loadProvider(storeId, providerType, providerRef);
  if (!prov) {
    await logEvent(
      storeId, "", providerType, providerRef,
      request.method, request.url,
      captureHeaders(request), body,
      404, "provider not found", 0
    );
    return reply.status(404).send({ error: { code: "WEBHOOK_PROVIDER_NOT_FOUND", message: "provider not found" } });
  }

  let statusCode = 200;
  let message = "ok";

  try {
    const result = await dispatch(request, prov, storeId, body);
    statusCode = result.status;
    message = result.message;
    if (statusCode >= 400) {
      const code = result.code ?? (statusCode === 401 ? "INVALID_SIGNATURE" : "WEBHOOK_ERROR");
      reply.status(statusCode).send({ error: { code, message } });
    } else {
      reply.status(statusCode).send({ message });
    }
  } catch (err) {
    statusCode = 500;
    message = err instanceof Error ? err.message : "internal error";
    request.log.error({ err }, "webhook dispatch error");
    reply.status(500).send({ error: { code: "INTERNAL_ERROR", message } });
  } finally {
    const durationMs = Date.now() - startMs;
    void logEvent(
      storeId, prov.id, providerType, providerRef,
      request.method, request.url,
      captureHeaders(request), body,
      statusCode, message, durationMs
    );
  }
}

// DispatchResult carries an optional machine-readable error code for non-2xx
// results; when absent the caller falls back to a generic code.
interface DispatchResult {
  status: number;
  message: string;
  /** Machine-readable error code included in the { error: { code, message } }
   *  envelope for non-2xx responses. Only set on error paths. */
  code?: string;
}

async function dispatch(
  request: FastifyRequest,
  prov: ProviderRow,
  storeId: string,
  body: Buffer
): Promise<DispatchResult> {
  switch (prov.type) {
    case "stripe":
      return dispatchStripe(request, prov, storeId, body);
    case "paystack":
      return dispatchPaystack(request, prov, storeId, body);
    case "xendit":
      return dispatchXendit(request, prov, storeId, body);
    case "razorpay":
      return dispatchRazorpay(request, prov, storeId, body);
    default:
      // custom-webhook or unknown type
      return dispatchCustom(request, prov, storeId, body);
  }
}

// ── Stripe ─────────────────────────────────────────────────────────────────────

async function dispatchStripe(
  request: FastifyRequest,
  prov: ProviderRow,
  storeId: string,
  body: Buffer
): Promise<DispatchResult> {
  // Extract secrets from provider config.
  const primarySecret = configSecret(prov.config, "webhook_secret");
  const secondarySecret = configSecret(prov.config, "webhook_secret_secondary");

  if (!primarySecret && !secondarySecret) {
    return { status: 401, code: "INVALID_SIGNATURE", message: "webhook secret not configured" };
  }

  const sigHeader = (request.headers["stripe-signature"] as string) ?? "";

  let ev: StripeEvent;
  let verifyErr: Error | null = null;

  // Try primary first, then secondary.
  if (primarySecret) {
    try {
      ev = verifyAndParseStripe(body, sigHeader, primarySecret);
      verifyErr = null;
    } catch (e) {
      verifyErr = e instanceof Error ? e : new Error(String(e));
      if (secondarySecret) {
        try {
          ev = verifyAndParseStripe(body, sigHeader, secondarySecret);
          verifyErr = null;
        } catch (e2) {
          verifyErr = e2 instanceof Error ? e2 : new Error(String(e2));
        }
      }
    }
  } else {
    // Primary not set — only secondary.
    try {
      ev = verifyAndParseStripe(body, sigHeader, secondarySecret!);
      verifyErr = null;
    } catch (e) {
      verifyErr = e instanceof Error ? e : new Error(String(e));
    }
  }

  if (verifyErr || !ev!) {
    return {
      status: 401,
      code: "INVALID_SIGNATURE",
      message: `stripe signature invalid: ${verifyErr?.message ?? "unknown"}`,
    };
  }

  // Replay dedup keyed on Stripe event id.
  const replayed = await recordAndCheckReplayEvent(prov.id, ev!.id);
  if (replayed) {
    return { status: 200, message: `duplicate stripe event: ${ev!.id}` };
  }

  if (ev!.type === "payment_intent.succeeded") {
    const checkoutId = typeof ev!.metadata["checkout_id"] === "string"
      ? ev!.metadata["checkout_id"]
      : "";
    const amount = typeof ev!.object["amount"] === "number"
      ? (ev!.object["amount"] as number) / 100
      : 0;
    const currency = typeof ev!.object["currency"] === "string"
      ? (ev!.object["currency"] as string)
      : "";
    await recordPaymentSuccess(storeId, checkoutId, "stripe", ev!.id, amount, currency);
  }

  if (ev!.type === "charge.refunded") {
    const chargeId = typeof ev!.object["id"] === "string" ? ev!.object["id"] : "";
    let refundAmount = 0;
    let refundRef = "";

    // Prefer the first refund in data.object.refunds.data[].
    const refunds = ev!.object["refunds"];
    if (refunds && typeof refunds === "object" && !Array.isArray(refunds)) {
      const data = (refunds as Record<string, unknown>)["data"];
      if (Array.isArray(data) && data.length > 0) {
        const r0 = data[0] as Record<string, unknown>;
        refundAmount = typeof r0["amount"] === "number" ? r0["amount"] / 100 : 0;
        refundRef = typeof r0["id"] === "string" ? r0["id"] : "";
      }
    }

    if (refundAmount === 0) {
      refundAmount = typeof ev!.object["amount_refunded"] === "number"
        ? (ev!.object["amount_refunded"] as number) / 100
        : 0;
    }
    if (!refundRef) refundRef = ev!.id; // fallback to event id for dedup
    const currency = typeof ev!.object["currency"] === "string"
      ? (ev!.object["currency"] as string)
      : "";
    await recordPaymentRefund(storeId, "stripe", chargeId, refundRef, refundAmount, currency);
  }

  return { status: 200, message: `stripe event received: ${ev!.type}` };
}

// ── Paystack ───────────────────────────────────────────────────────────────────

async function dispatchPaystack(
  request: FastifyRequest,
  prov: ProviderRow,
  storeId: string,
  body: Buffer
): Promise<DispatchResult> {
  const secretKey = configSecret(prov.config, "secret_key");
  if (!secretKey) {
    return { status: 401, code: "INVALID_SIGNATURE", message: "paystack secret not configured" };
  }

  const sigHeader = (request.headers["x-paystack-signature"] as string) ?? "";
  let ev: PaystackEvent;
  try {
    ev = verifyAndParsePaystack(body, sigHeader, secretKey);
  } catch (e) {
    return {
      status: 401,
      code: "INVALID_SIGNATURE",
      message: `paystack signature invalid: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Replay dedup keyed on Paystack data.id.
  const eventId = paystackEventId(ev);
  if (eventId) {
    const replayed = await recordAndCheckReplayEvent(prov.id, eventId);
    if (replayed) {
      return { status: 200, message: `duplicate paystack event: ${eventId}` };
    }
  }

  if (ev.eventType === "charge.success") {
    const checkoutId = typeof ev.data["reference"] === "string"
      ? ev.data["reference"]
      : "";
    const amount = typeof ev.data["amount"] === "number"
      ? (ev.data["amount"] as number) / 100
      : 0;
    const currency = typeof ev.data["currency"] === "string"
      ? (ev.data["currency"] as string)
      : "";
    // For Paystack the reference IS the checkoutId and also our provider_reference.
    await recordPaymentSuccess(storeId, checkoutId, "paystack", checkoutId, amount, currency);
  }

  if (ev.eventType === "refund.processed") {
    const paymentRef = typeof ev.data["transaction_reference"] === "string"
      ? ev.data["transaction_reference"]
      : "";
    const amount = typeof ev.data["amount"] === "number"
      ? (ev.data["amount"] as number) / 100
      : 0;
    const currency = typeof ev.data["currency"] === "string"
      ? (ev.data["currency"] as string)
      : "";
    let refundRef = "";
    const rawId = ev.data["id"];
    if (typeof rawId === "string") refundRef = rawId;
    else if (typeof rawId === "number") refundRef = String(Math.floor(rawId));
    await recordPaymentRefund(storeId, "paystack", paymentRef, refundRef, amount, currency);
  }

  return { status: 200, message: `paystack event received: ${ev.eventType}` };
}

// ── Xendit ─────────────────────────────────────────────────────────────────────

async function dispatchXendit(
  request: FastifyRequest,
  prov: ProviderRow,
  storeId: string,
  body: Buffer
): Promise<DispatchResult> {
  const webhookToken = configSecret(prov.config, "webhook_token");
  if (!webhookToken) {
    return { status: 401, code: "INVALID_SIGNATURE", message: "xendit webhook token not configured" };
  }

  const callbackToken = (request.headers["x-callback-token"] as string) ?? "";
  let ev: XenditEvent;
  try {
    ev = verifyAndParseXendit(body, callbackToken, webhookToken);
  } catch (e) {
    return {
      status: 401,
      code: "INVALID_SIGNATURE",
      message: `xendit callback token invalid: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Replay dedup keyed on data.id.
  const eventId = typeof ev.data["id"] === "string" ? ev.data["id"] : "";
  if (eventId) {
    const replayed = await recordAndCheckReplayEvent(prov.id, eventId);
    if (replayed) {
      return { status: 200, message: `duplicate xendit event: ${eventId}` };
    }
  }

  if (ev.eventType === "INVOICE.PAID" || ev.eventType === "invoice.paid") {
    const checkoutId = typeof ev.data["external_id"] === "string"
      ? ev.data["external_id"]
      : "";
    const amount = typeof ev.data["paid_amount"] === "number"
      ? (ev.data["paid_amount"] as number)
      : 0;
    const currency = typeof ev.data["currency"] === "string"
      ? (ev.data["currency"] as string)
      : "";
    const invoiceId = typeof ev.data["id"] === "string" ? ev.data["id"] : "";
    await recordPaymentSuccess(storeId, checkoutId, "xendit", invoiceId, amount, currency);
  }

  if (ev.eventType === "refund.succeeded" || ev.eventType === "REFUND_SUCCEEDED") {
    const refundId = typeof ev.data["id"] === "string" ? ev.data["id"] : "";
    const paymentRef = typeof ev.data["payment_id"] === "string" ? ev.data["payment_id"] : "";
    const amount = typeof ev.data["amount"] === "number" ? ev.data["amount"] : 0;
    const currency = typeof ev.data["currency"] === "string" ? ev.data["currency"] : "";
    await recordPaymentRefund(storeId, "xendit", paymentRef, refundId, amount, currency);
  }

  return { status: 200, message: `xendit event received: ${ev.eventType}` };
}

// ── Razorpay ───────────────────────────────────────────────────────────────────

async function dispatchRazorpay(
  request: FastifyRequest,
  prov: ProviderRow,
  storeId: string,
  body: Buffer
): Promise<DispatchResult> {
  const webhookSecret = configSecret(prov.config, "webhook_secret");
  if (!webhookSecret) {
    return { status: 401, code: "INVALID_SIGNATURE", message: "razorpay webhook secret not configured" };
  }

  const sigHeader = (request.headers["x-razorpay-signature"] as string) ?? "";
  let ev: RazorpayEvent;
  try {
    ev = verifyAndParseRazorpay(body, sigHeader, webhookSecret);
  } catch (e) {
    return {
      status: 401,
      code: "INVALID_SIGNATURE",
      message: `razorpay signature invalid: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Replay dedup keyed on payment entity id (or order id).
  const eventId = razorpayEventId(ev);
  if (eventId) {
    const replayed = await recordAndCheckReplayEvent(prov.id, eventId);
    if (replayed) {
      return { status: 200, message: `duplicate razorpay event: ${eventId}` };
    }
  }

  if (ev.eventType === "payment.captured") {
    let checkoutId = "";
    if (ev.order) {
      checkoutId = typeof ev.order["receipt"] === "string" ? ev.order["receipt"] : "";
    }
    if (!checkoutId && ev.payment) {
      const notes = ev.payment["notes"];
      if (notes && typeof notes === "object" && !Array.isArray(notes)) {
        checkoutId = typeof (notes as Record<string, unknown>)["checkout_id"] === "string"
          ? (notes as Record<string, unknown>)["checkout_id"] as string
          : "";
      }
    }
    const paymentId = ev.payment && typeof ev.payment["id"] === "string" ? ev.payment["id"] : "";
    const amount = ev.payment && typeof ev.payment["amount"] === "number"
      ? (ev.payment["amount"] as number) / 100
      : 0;
    const currency = ev.payment && typeof ev.payment["currency"] === "string"
      ? ev.payment["currency"] as string
      : "";
    await recordPaymentSuccess(storeId, checkoutId, "razorpay", paymentId, amount, currency);
  }

  if (ev.eventType === "refund.created" || ev.eventType === "refund.processed") {
    if (ev.refund) {
      const refundId = typeof ev.refund["id"] === "string" ? ev.refund["id"] : "";
      const paymentRef = typeof ev.refund["payment_id"] === "string" ? ev.refund["payment_id"] : "";
      const amount = typeof ev.refund["amount"] === "number"
        ? (ev.refund["amount"] as number) / 100
        : 0;
      const currency = typeof ev.refund["currency"] === "string" ? ev.refund["currency"] : "";
      await recordPaymentRefund(storeId, "razorpay", paymentRef, refundId, amount, currency);
    }
  }

  return { status: 200, message: `razorpay event received: ${ev.eventType}` };
}

// ── Custom webhook ─────────────────────────────────────────────────────────────

async function dispatchCustom(
  request: FastifyRequest,
  prov: ProviderRow,
  storeId: string,
  body: Buffer
): Promise<DispatchResult> {
  if (!prov.webhookSecret) {
    return { status: 401, code: "INVALID_SIGNATURE", message: "webhook secret not configured" };
  }

  // HMAC-SHA256 validation.
  if (!validateHMAC(body, prov.webhookSecret, request)) {
    return { status: 401, code: "INVALID_SIGNATURE", message: "invalid signature" };
  }

  // 5-minute timestamp window (X-Webhook-Timestamp header).
  const tsHeader = request.headers["x-webhook-timestamp"] as string | undefined;
  if (tsHeader) {
    const parsed = parseInt(tsHeader.trim(), 10);
    if (!isNaN(parsed)) {
      const skew = Math.abs(Math.floor(Date.now() / 1000) - parsed);
      if (skew > 300) {
        return { status: 401, code: "INVALID_SIGNATURE", message: "stale timestamp" };
      }
    }
  }

  // Body-hash dedup.
  const replayed = await recordAndCheckReplayBody(prov.id, body);
  if (replayed) {
    return { status: 200, message: "duplicate (replay)" };
  }

  return { status: 200, message: "custom webhook received" };
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function loadProvider(
  storeId: string,
  _providerType: string,
  ref: string
): Promise<ProviderRow | null> {
  const pool = getPool();
  // Only payment_providers are supported here (path-based routing owns /payment/).
  let query = `
    SELECT id::text, store_id::text, name, type,
           coalesce(webhook_url, '') as webhook_url,
           coalesce(webhook_secret, '') as webhook_secret,
           coalesce(slug, '') as slug,
           coalesce(config::text, '{}') as config
    FROM payment_providers
    WHERE store_id = $1::uuid AND is_active = true`;

  const args: unknown[] = [storeId];
  if (ref) {
    query += ` AND (id::text = $2 OR slug = $2)`;
    args.push(ref);
  }
  query += ` ORDER BY position ASC, created_at ASC LIMIT 1`;

  const { rows } = await pool.query<{
    id: string;
    store_id: string;
    name: string;
    type: string;
    webhook_url: string;
    webhook_secret: string;
    slug: string;
    config: string | Record<string, unknown>;
  }>(query, args);

  if (!rows[0]) return null;

  const row = rows[0];

  // Decrypt webhook_secret if it's encrypted.
  let webhookSecret = row.webhook_secret;
  if (webhookSecret && secretsKey) {
    try {
      webhookSecret = decodeSecretValue(webhookSecret, secretsKey);
    } catch {
      webhookSecret = row.webhook_secret; // fallback — plaintext in dev
    }
  }

  // Config is stored as plain JSON in the JSONB column.
  let cfg: Record<string, unknown> = {};
  if (typeof row.config === "object" && row.config !== null) {
    cfg = row.config as Record<string, unknown>;
  } else if (typeof row.config === "string") {
    try {
      cfg = JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
  }

  // Decrypt any encrypted values inside config (secret/key/token fields).
  if (secretsKey) {
    const decrypted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === "string" && /secret|key|token|password/i.test(k)) {
        try {
          decrypted[k] = decodeSecretValue(v, secretsKey);
        } catch {
          decrypted[k] = v; // plaintext passthrough in dev
        }
      } else {
        decrypted[k] = v;
      }
    }
    cfg = decrypted;
  }

  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    type: row.type,
    webhookUrl: row.webhook_url,
    webhookSecret: webhookSecret,
    providerSlug: row.slug,
    config: cfg,
  };
}

/**
 * Dedup keyed on (provider_id, "evt:" + eventId).
 * Returns true if this is a replay.
 */
async function recordAndCheckReplayEvent(
  providerId: string,
  eventId: string
): Promise<boolean> {
  if (!eventId) return false;
  const pool = getPool();
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO webhook_replay_guard (provider_id, body_hash, received_at)
       VALUES ($1::uuid, $2, now())
       ON CONFLICT (provider_id, body_hash) DO NOTHING`,
      [providerId, `evt:${eventId}`]
    );
    return (rowCount ?? 0) === 0;
  } catch {
    return false; // fail open — let the downstream UNIQUE index guard
  }
}

/**
 * Dedup keyed on (provider_id, sha256(body)).
 * Returns true if this is a replay.
 */
async function recordAndCheckReplayBody(
  providerId: string,
  body: Buffer
): Promise<boolean> {
  const hash = createHash("sha256").update(body).digest("hex");
  const pool = getPool();
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO webhook_replay_guard (provider_id, body_hash, received_at)
       VALUES ($1::uuid, $2, now())
       ON CONFLICT (provider_id, body_hash) DO NOTHING`,
      [providerId, hash]
    );
    return (rowCount ?? 0) === 0;
  } catch {
    return false;
  }
}

async function logEvent(
  storeId: string,
  providerId: string,
  providerType: string,
  providerRef: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
  statusCode: number,
  message: string,
  durationMs: number
): Promise<void> {
  const pool = getPool();
  const bodyStr = body.toString("utf8").slice(0, 65536);
  const headersJson = JSON.stringify(headers);
  try {
    await pool.query(
      `INSERT INTO payment_provider_webhook_log
         (store_id, provider_id, provider_type, provider_ref,
          method, path, headers, body,
          status_code, message, duration_ms)
       VALUES
         ($1::uuid, nullif($2, '')::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
      [
        storeId,
        providerId || null,
        providerType,
        providerRef,
        method,
        path,
        headersJson,
        bodyStr,
        statusCode,
        message,
        durationMs,
      ]
    );
  } catch {
    // Best-effort — never crash the webhook handler on a log failure.
  }
}

// ── recordPaymentSuccess ───────────────────────────────────────────────────────

/**
 * Record a captured payment and flip the order to 'paid'.
 *
 * If no order exists for the checkout yet (Paystack/Xendit/Razorpay redirect-flow
 * where the storefront never called /complete), we auto-complete the checkout
 * first (using its own transaction), then record the payment in a second
 * transaction. Both are individually atomic; the payment INSERT is idempotent.
 *
 * Idempotency: UNIQUE(order_id, provider_reference) on payments — duplicate
 * delivery is a no-op.
 *
 * Ported from: webcrft-mono/backend/internal/webhooks/router/router.go
 *              recordPaymentSuccess()
 */
async function recordPaymentSuccess(
  storeId: string,
  checkoutId: string,
  providerType: string,
  providerRef: string,
  amount: number,
  currency: string
): Promise<void> {
  if (!checkoutId) {
    console.warn(`recordPaymentSuccess: empty checkoutId`, { providerType, providerRef });
    return;
  }
  if (!providerRef) {
    console.warn(`recordPaymentSuccess: empty providerRef`, { checkoutId, providerType });
    return;
  }

  const pool = getPool();

  // ── Phase 1: Resolve orderId ─────────────────────────────────────────────────

  let orderId: string | null = null;

  // 1a. Check for an existing order linked to this checkout.
  {
    const { rows: orderRows } = await pool.query<{ id: string }>(
      `SELECT o.id::text FROM orders o
       JOIN checkouts c ON c.id = o.checkout_id
       WHERE c.id = $1::uuid AND o.store_id = $2::uuid
       LIMIT 1`,
      [checkoutId, storeId]
    );
    orderId = orderRows[0]?.id ?? null;
  }

  // 1b. Auto-complete the checkout if no order exists yet (C4 in source).
  if (!orderId) {
    try {
      const result = await completeCheckout(storeId, checkoutId);
      orderId = result.orderId;
      console.info(`recordPaymentSuccess: auto-completed checkout from webhook`, {
        orderId, checkoutId, providerType,
      });
    } catch (cerr) {
      console.warn(`recordPaymentSuccess: order not found and auto-complete failed`, {
        checkoutId, storeId, providerType,
        err: cerr instanceof Error ? cerr.message : String(cerr),
      });
      return;
    }
  }

  // ── Phase 2: Record payment in a transaction ──────────────────────────────────

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 2. Validate amount + currency against the order.
    const { rows: totalRows } = await client.query<{
      total: string;
      currency: string;
    }>(
      `SELECT total::text, currency FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    if (!totalRows[0]) {
      console.warn(`recordPaymentSuccess: order not found after auto-complete`, { orderId });
      await client.query("ROLLBACK");
      return;
    }

    const orderTotal = parseFloat(totalRows[0].total);
    const orderCurrency = totalRows[0].currency;

    if (currency && orderCurrency &&
        currency.trim().toUpperCase() !== orderCurrency.trim().toUpperCase()) {
      console.warn(`recordPaymentSuccess: currency mismatch`, {
        orderId, providerType, webhookCurrency: currency, orderCurrency, providerRef,
      });
      await client.query("ROLLBACK");
      return;
    }

    const { rows: capturedRows } = await client.query<{ sum: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
       FROM payments WHERE order_id = $1::uuid AND status = 'captured'`,
      [orderId]
    );
    const alreadyCaptured = parseFloat(capturedRows[0]?.sum ?? "0");

    if (amount + alreadyCaptured > orderTotal + AMOUNT_TOLERANCE) {
      console.warn(`recordPaymentSuccess: amount exceeds order total`, {
        orderId, providerType, amount, alreadyCaptured, orderTotal, providerRef,
      });
      await client.query("ROLLBACK");
      return;
    }

    // 3. Insert payment row (idempotent via ON CONFLICT DO NOTHING).
    const { rows: insertedRows } = await client.query<{ id: string }>(
      `INSERT INTO payments (order_id, amount, currency, status, provider_reference, mode)
       VALUES ($1::uuid, $2, $3, 'captured', $4, 'live')
       ON CONFLICT (order_id, provider_reference) WHERE provider_reference IS NOT NULL
       DO NOTHING
       RETURNING id::text`,
      [orderId, amount, currency.toUpperCase(), providerRef]
    );

    if (!insertedRows[0]) {
      // Already recorded — no-op.
      await client.query("ROLLBACK");
      return;
    }

    // 4. Flip order financial_status to 'paid'.
    await client.query(
      `UPDATE orders SET financial_status = 'paid', updated_at = now()
       WHERE id = $1::uuid AND financial_status != 'paid'`,
      [orderId]
    );

    await client.query("COMMIT");

    console.info(`recordPaymentSuccess: order marked paid`, {
      orderId, providerType,
    });

    // Fire analytics purchase event (fire-and-forget).
    trackEcommerce(storeId, "order_completed", {
      order_id: orderId,
      provider: providerType,
      amount,
      currency,
    });

    // Fire GA4 server-side purchase event (H2.2 — fire-and-forget).
    void fireGA4Purchase(storeId, orderId, amount, currency);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`recordPaymentSuccess: failed`, {
      err: err instanceof Error ? err.message : String(err),
      checkoutId, providerType,
    });
  } finally {
    client.release();
  }
}

// ── recordPaymentRefund ────────────────────────────────────────────────────────

/**
 * Record a provider refund event.
 *
 * Ported from: webcrft-mono/backend/internal/webhooks/router/router.go
 *              recordPaymentRefund()
 *
 * All writes are in a single transaction. Idempotency via UNIQUE(payment_id,
 * provider_reference) on refunds.
 */
async function recordPaymentRefund(
  storeId: string,
  providerType: string,
  paymentRef: string,
  refundRef: string,
  amount: number,
  currency: string
): Promise<void> {
  if (!paymentRef) {
    console.warn(`recordPaymentRefund: empty paymentRef`, { providerType });
    return;
  }
  if (amount <= 0) {
    console.warn(`recordPaymentRefund: non-positive amount`, { providerType, amount });
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Find the captured payment by provider_reference, scoped to this store.
    const { rows: payRows } = await client.query<{
      id: string;
      order_id: string;
      amount: string;
      currency: string;
    }>(
      `SELECT p.id::text, p.order_id::text, p.amount::text, p.currency
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       WHERE o.store_id = $1::uuid
         AND p.provider_reference = $2
         AND p.status IN ('captured', 'partially_refunded')
       ORDER BY p.created_at DESC LIMIT 1`,
      [storeId, paymentRef]
    );

    if (!payRows[0]) {
      console.warn(`recordPaymentRefund: payment not found`, {
        storeId, providerType, paymentRef,
      });
      await client.query("ROLLBACK");
      return;
    }

    const { id: paymentId, order_id: orderId, amount: payAmtStr, currency: payCurrency } = payRows[0];
    const paymentAmount = parseFloat(payAmtStr);

    // 2. Currency sanity.
    if (currency && payCurrency &&
        currency.trim().toUpperCase() !== payCurrency.trim().toUpperCase()) {
      console.warn(`recordPaymentRefund: currency mismatch`, {
        orderId, providerType, webhookCurrency: currency, paymentCurrency: payCurrency,
      });
      await client.query("ROLLBACK");
      return;
    }

    // 3. Lock the order row.
    const { rows: orderRows } = await client.query<{
      total: string;
      total_refunded: string;
    }>(
      `SELECT total::text, total_refunded::text FROM orders WHERE id = $1::uuid FOR UPDATE`,
      [orderId]
    );
    if (!orderRows[0]) {
      await client.query("ROLLBACK");
      return;
    }
    const orderTotal = parseFloat(orderRows[0].total);
    const totalRefunded = parseFloat(orderRows[0].total_refunded);

    // 4. Insert refund row (idempotent via ON CONFLICT DO NOTHING).
    const idempotencyKey = refundRef || `${paymentRef}:${amount.toFixed(2)}`;
    const { rows: refundRows } = await client.query<{ id: string }>(
      `INSERT INTO refunds (payment_id, order_id, amount, status, provider_reference)
       VALUES ($1::uuid, $2::uuid, $3, 'succeeded', $4)
       ON CONFLICT (payment_id, provider_reference) WHERE provider_reference IS NOT NULL
       DO NOTHING
       RETURNING id::text`,
      [paymentId, orderId, amount, idempotencyKey]
    );

    if (!refundRows[0]) {
      // Already processed — no-op.
      console.info(`recordPaymentRefund: duplicate refund ignored`, {
        orderId, providerType, ref: idempotencyKey,
      });
      await client.query("ROLLBACK");
      return;
    }
    const refundId = refundRows[0].id;

    // 5. Bump total_refunded and set financial_status.
    const newTotalRefunded = totalRefunded + amount;
    const orderStatus = newTotalRefunded + AMOUNT_TOLERANCE >= orderTotal
      ? "refunded"
      : "partially_refunded";

    await client.query(
      `UPDATE orders SET total_refunded = $2, financial_status = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [orderId, newTotalRefunded, orderStatus]
    );

    // 6. Update payment status.
    const paymentStatus = amount + AMOUNT_TOLERANCE >= paymentAmount
      ? "refunded"
      : "partially_refunded";
    await client.query(
      `UPDATE payments SET status = $2, updated_at = now() WHERE id = $1::uuid`,
      [paymentId, paymentStatus]
    );

    // 7. Insert order_events entry.
    const eventData = {
      refund_id: refundId,
      payment_id: paymentId,
      amount,
      provider: providerType,
      provider_ref: idempotencyKey,
    };
    await client.query(
      `INSERT INTO order_events (order_id, type, data)
       VALUES ($1::uuid, 'refund_received', $2::jsonb)`,
      [orderId, JSON.stringify(eventData)]
    ).catch(() => undefined); // best-effort

    await client.query("COMMIT");

    console.info(`recordPaymentRefund: refund recorded`, {
      orderId, refundId, providerType, amount, orderStatus,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`recordPaymentRefund: failed`, { err, providerType });
  } finally {
    client.release();
  }
}

// ── Utility helpers ────────────────────────────────────────────────────────────

/**
 * Extract a secret value from provider config JSONB.
 * Config values are stored as plaintext JSON (not encrypted) — only
 * webhook_secret (text column) is encrypted. However, if the config key
 * contains a ciphertext AND secretsKey is set, we attempt decrypt.
 */
function configSecret(cfg: Record<string, unknown>, key: string): string {
  const raw = cfg[key];
  if (typeof raw !== "string" || !raw) return "";
  // Already decrypted in loadProvider.
  return raw;
}

function validateHMAC(body: Buffer, secret: string, request: FastifyRequest): boolean {
  const mac = createHmac("sha256", secret);
  mac.update(body);
  const expected = mac.digest("hex");

  for (const headerName of [
    "x-webhook-signature",
    "x-hub-signature-256",
    "x-signature",
  ]) {
    const val = request.headers[headerName] as string | undefined;
    if (!val) continue;
    const trimmed = val
      .replace(/^sha256=/i, "")
      .replace(/^sha512=/i, "");
    try {
      if (
        expected.length === trimmed.length &&
        timingSafeEqual(Buffer.from(expected), Buffer.from(trimmed))
      ) {
        return true;
      }
    } catch {
      // length mismatch guard above handles this, but be safe
    }
  }
  return false;
}

function captureHeaders(request: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
    else if (Array.isArray(v) && v.length > 0) out[k.toLowerCase()] = v[0] ?? "";
  }
  return out;
}

// ── Event ID extractors ────────────────────────────────────────────────────────

function paystackEventId(ev: PaystackEvent): string {
  const rawId = ev.data["id"];
  if (typeof rawId === "string") return rawId;
  if (typeof rawId === "number") return String(Math.floor(rawId));
  return "";
}

function razorpayEventId(ev: RazorpayEvent): string {
  if (ev.payment) {
    const id = ev.payment["id"];
    if (typeof id === "string") return id;
  }
  if (ev.order) {
    const id = ev.order["id"];
    if (typeof id === "string") return id;
  }
  return "";
}

// ── GA4 server-side purchase (H2.2) ──────────────────────────────────────────

/**
 * fireGA4Purchase — send a GA4 Measurement Protocol `purchase` event when the
 * store has a google_analytics_4 pixel with a tracking_id (measurementID) and
 * api_secret configured.
 *
 * Ported from: webcrft-mono/backend/internal/webhooks/router/router.go
 *              fireGA4Purchase() + ga4.Client.Send()
 *
 * Measurement Protocol endpoint:
 *   POST https://www.google-analytics.com/mp/collect
 *        ?measurement_id=G-XXXXXXXXXX&api_secret=<secret>
 *
 * Payload: { client_id, events: [{ name: "purchase", params: { ... } }] }
 *
 * Skips gracefully (no error logged) when:
 *  - No GA4 pixel configured for the store
 *  - api_secret is empty (pixel exists but no server-side secret set)
 *
 * api_secret is stored encrypted (AES-GCM via encodeSecretValue) when
 * AUTH_SECRETS_KEY is set — decodes transparently via decodeSecretValue.
 */
async function fireGA4Purchase(
  storeId: string,
  orderId: string,
  amount: number,
  currency: string
): Promise<void> {
  try {
    const pool = getPool();

    // Load GA4 pixel + order details in a single query (mirrors Go implementation).
    const { rows } = await pool.query<{
      tracking_id: string;
      api_secret: string | null;
      order_number: string;
      customer_id: string | null;
    }>(
      `SELECT tp.tracking_id,
              tp.api_secret,
              o.order_number,
              o.customer_id::text
       FROM store_tracking_pixels tp
       JOIN orders o ON o.id = $2::uuid
       WHERE tp.store_id = $1::uuid
         AND tp.pixel_type = 'google_analytics_4'
         AND tp.is_active = true
       LIMIT 1`,
      [storeId, orderId]
    );

    const pixel = rows[0];
    if (!pixel) return; // no GA4 pixel configured — skip

    const measurementId = pixel.tracking_id;

    // Decrypt api_secret if encrypted (AUTH_SECRETS_KEY present).
    let apiSecret = "";
    if (pixel.api_secret) {
      try {
        apiSecret = await decodeSecretValue(pixel.api_secret, secretsKey);
      } catch {
        apiSecret = pixel.api_secret; // plaintext dev mode fallback
      }
    }
    if (!apiSecret) return; // no api_secret — server-side send impossible

    // client_id: customer_id if known, else orderId (stable per order).
    const clientId = pixel.customer_id ?? orderId;

    const payload = {
      client_id: clientId,
      events: [
        {
          name: "purchase",
          params: {
            transaction_id: pixel.order_number,
            value: amount,
            currency: currency.toUpperCase(),
            items: [], // items array required by GA4 schema; populated empty here
          },
        },
      ],
    };

    const mpUrl = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

    const response = await fetch(mpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn("ga4: measurement protocol returned non-2xx", {
        storeId, orderId, status: response.status,
      });
    }
  } catch (err) {
    // GA4 send must never crash the webhook flow.
    console.warn("ga4: fireGA4Purchase failed", {
      storeId, orderId, err: err instanceof Error ? err.message : String(err),
    });
  }
}
