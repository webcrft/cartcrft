/**
 * notifications/service.ts — Notification providers CRUD + DispatchStoreEvent.
 *
 * DispatchStoreEvent:
 *   - Loads active providers for the store subscribed to the event
 *   - For webhook type: POST with HMAC-SHA256 signature header (X-Cartcrft-Signature)
 *     + retries (up to MAX_RETRIES attempts with exponential backoff)
 *     + logs each attempt to notification_delivery_log
 *   - For email type: delegates to Mailer if set via setNotificationMailer(), else console fallback
 *   - For sms/whatsapp type: no-op with warning (not implemented)
 *   - Fire-and-forget: runs in background, never blocks HTTP response
 *
 * Mailer wiring (H2.1):
 *   main.ts cannot be touched in this wave so we use the same lazy-factory approach
 *   as customer-auth/service.ts: a module-level singleton that defaults to ConsoleMailer
 *   and can be overridden via setNotificationMailer(). The recovery worker already
 *   builds a SES/Console mailer from lib/mailer — callers that want real email dispatch
 *   call setNotificationMailer() with that instance before processing begins.
 *   In practice the notification module resolves its own mailer at module init using the
 *   same config env-vars the recovery worker uses, so no boot wiring is required.
 */

import { createHmac } from "node:crypto";
import { getPool } from "../../db/pool.js";
import { assertSafeOutboundUrl } from "../../lib/net/ssrf.js";
import { config } from "../../config/config.js";

/**
 * Whether to relax the SSRF guard to permit loopback/private webhook targets.
 * Computed once at module load. Only the multi-tenant cloud (APP_ENV=production)
 * enforces full SSRF blocking; dev/test/self-host may legitimately point a
 * webhook at localhost or an internal service. NOTE: inside deliverWebhook the
 * name `config` is shadowed by the destructured provider.config, so this
 * module-level constant must be used instead of `config.APP_ENV` there.
 */
const WEBHOOK_ALLOW_PRIVATE = config.APP_ENV !== "production";
import { ConsoleMailer } from "../../lib/mailer/console.js";
import { SesMailer } from "../../lib/mailer/ses.js";
import type { Mailer } from "../../lib/mailer/index.js";
import { renderEventEmail } from "../../lib/mailer/templates.js";
import { newTwilioClient, TwilioClient, TwilioAPIError } from "../../providers/notifications/twilio.js";
import type {
  NotificationProviderRow,
  CreateNotificationProviderInput,
  UpdateNotificationProviderInput,
  DeliveryLogRow,
} from "./types.js";
import { isValidEvent, WEBHOOK_SPEC_VERSION, isKnownWebhookSpecVersion } from "./types.js";

/**
 * Resolve the webhook spec version to stamp on a delivery for this provider.
 *
 * A provider may pin a version via config.api_version. When that pin is a known
 * spec version it wins; otherwise (absent / malformed / unrecognised) we fall
 * back to the current WEBHOOK_SPEC_VERSION (fail-safe forward — never deliver an
 * un-versioned or speculative-version body).
 */
function resolveWebhookVersion(config: Record<string, unknown>): string {
  const pinned = config["api_version"];
  if (typeof pinned === "string" && isKnownWebhookSpecVersion(pinned)) {
    return pinned;
  }
  return WEBHOOK_SPEC_VERSION;
}

// ── Mailer singleton (injectable; auto-resolved from env at module load) ────────

function buildMailerFromConfig(): Mailer {
  if (
    config.AWS_SES_REGION &&
    config.AWS_SES_ACCESS_KEY_ID &&
    config.AWS_SES_SECRET_ACCESS_KEY &&
    config.EMAIL_FROM
  ) {
    return new SesMailer({
      region: config.AWS_SES_REGION,
      accessKeyId: config.AWS_SES_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SES_SECRET_ACCESS_KEY,
      fromAddress: config.EMAIL_FROM,
    });
  }
  return new ConsoleMailer();
}

let _notifMailer: Mailer = buildMailerFromConfig();

/**
 * Override the mailer used for email-type notification providers.
 * Called by integration tests (ConsoleMailer) or by boot code (SesMailer).
 * Since main.ts cannot be touched in wave H2, the module self-resolves from env
 * at load time — this setter exists for tests and future explicit wiring.
 */
export function setNotificationMailer(m: Mailer): void {
  _notifMailer = m;
}

// ── SMS/WhatsApp provider singleton (Twilio; injectable; env-resolved) ──────────

/**
 * Build a Twilio client from env config, mirroring buildMailerFromConfig().
 * Returns null when Twilio is not configured (no account SID / auth token).
 */
function buildSmsProviderFromConfig(): TwilioClient | null {
  if (config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN) {
    return newTwilioClient({
      accountSid: config.TWILIO_ACCOUNT_SID,
      authToken: config.TWILIO_AUTH_TOKEN,
      fromNumber: config.TWILIO_FROM_NUMBER,
      messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
    });
  }
  return null;
}

let _smsProvider: TwilioClient | null = buildSmsProviderFromConfig();

/**
 * Override the Twilio client used for sms/whatsapp-type notification providers.
 * Called by tests or by boot/wiring code. Mirrors setNotificationMailer().
 */
export function setNotificationSmsProvider(p: TwilioClient | null): void {
  _smsProvider = p;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000]; // exponential-ish backoff

// ── CRUD ───────────────────────────────────────────────────────────────────────

export async function listNotificationProviders(
  storeId: string
): Promise<NotificationProviderRow[]> {
  const pool = getPool();
  const res = await pool.query<NotificationProviderRow>(
    `SELECT id::text, name, type, webhook_url,
            COALESCE(config, '{}') AS config,
            events, is_active, created_at, updated_at
     FROM notification_providers
     WHERE store_id = $1::uuid
     ORDER BY created_at`,
    [storeId]
  );
  return res.rows;
}

export async function createNotificationProvider(
  storeId: string,
  input: CreateNotificationProviderInput
): Promise<string> {
  const pool = getPool();

  const name = input.name.trim();
  if (!name) throw Object.assign(new Error("name is required"), { code: "VALIDATION_ERROR" });

  const providerType = input.type ?? "webhook";

  // webhook_url is required ONLY for webhook providers; email/sms/whatsapp omit it.
  if (providerType === "webhook" && !input.webhook_url?.trim()) {
    throw Object.assign(new Error("webhook_url is required"), { code: "VALIDATION_ERROR" });
  }

  // SSRF write-time guard (best-effort due to DNS TOCTOU; deliverWebhook re-checks
  // at fetch time and is authoritative). Only webhook-type providers actually
  // fetch webhook_url, so only they are SSRF-validated — email/sms/whatsapp may
  // carry an unused/mailto value that must not be scheme-rejected here.
  if (providerType === "webhook" && input.webhook_url?.trim()) {
    try {
      await assertSafeOutboundUrl(input.webhook_url.trim(), { allowPrivate: WEBHOOK_ALLOW_PRIVATE });
    } catch (err) {
      throw Object.assign(
        new Error(`webhook_url rejected: ${err instanceof Error ? err.message : String(err)}`),
        { code: "VALIDATION_ERROR" }
      );
    }
  }

  if (!input.events || input.events.length === 0) {
    throw Object.assign(new Error("events must contain at least one event type"), { code: "VALIDATION_ERROR" });
  }
  for (const ev of input.events) {
    if (!isValidEvent(ev)) {
      throw Object.assign(new Error(`unknown event type: "${ev}"`), { code: "VALIDATION_ERROR" });
    }
  }

  // Config can carry webhook_secret
  const cfg: Record<string, unknown> = { ...(input.config ?? {}) };
  if (input.webhook_secret) {
    cfg["webhook_secret"] = input.webhook_secret;
  }
  const webhookUrl = input.webhook_url?.trim() ? input.webhook_url.trim() : null;
  const res = await pool.query<{ id: string }>(
    `INSERT INTO notification_providers
       (store_id, name, type, webhook_url, config, events, is_active)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, true)
     RETURNING id::text`,
    [storeId, name, providerType, webhookUrl, JSON.stringify(cfg), input.events]
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error("createNotificationProvider: no id returned");
  return id;
}

export async function updateNotificationProvider(
  providerId: string,
  storeId: string,
  input: UpdateNotificationProviderInput
): Promise<boolean> {
  const pool = getPool();

  const sets: string[] = [];
  const args: unknown[] = [providerId, storeId];
  let n = 3;

  const add = (col: string, val: unknown) => {
    sets.push(`${col} = $${n}`);
    args.push(val);
    n++;
  };

  if (input.name !== undefined) add("name", input.name);
  if (input.webhook_url !== undefined) {
    // SSRF write-time guard (see createNotificationProvider). Best-effort only —
    // the fetch-time guard in deliverWebhook is authoritative and only webhook
    // providers ever fetch. The update input carries no `type`, so we validate
    // only http(s) targets (real webhook sinks); a non-http value (e.g. a mailto
    // on a non-webhook provider) is not a fetch sink and is left alone. Skip
    // empty strings (clearing the URL).
    if (input.webhook_url.trim() && /^https?:/i.test(input.webhook_url.trim())) {
      try {
        await assertSafeOutboundUrl(input.webhook_url.trim(), { allowPrivate: WEBHOOK_ALLOW_PRIVATE });
      } catch (err) {
        throw Object.assign(
          new Error(`webhook_url rejected: ${err instanceof Error ? err.message : String(err)}`),
          { code: "VALIDATION_ERROR" }
        );
      }
    }
    add("webhook_url", input.webhook_url);
  }
  if (input.is_active !== undefined) add("is_active", input.is_active);

  if (input.events !== undefined) {
    if (input.events.length === 0) {
      throw Object.assign(new Error("events cannot be empty"), { code: "VALIDATION_ERROR" });
    }
    for (const ev of input.events) {
      if (!isValidEvent(ev)) {
        throw Object.assign(new Error(`unknown event type: "${ev}"`), { code: "VALIDATION_ERROR" });
      }
    }
    add("events", input.events);
  }

  if (input.config !== undefined) {
    const cfg: Record<string, unknown> = { ...(input.config ?? {}) };
    if (input.webhook_secret) cfg["webhook_secret"] = input.webhook_secret;
    add("config", JSON.stringify(cfg));
  } else if (input.webhook_secret !== undefined) {
    // Only updating the secret — merge into existing config
    // We do this via a jsonb || expression
    sets.push(`config = config || $${n}::jsonb`);
    args.push(JSON.stringify({ webhook_secret: input.webhook_secret }));
    n++;
  }

  if (sets.length === 0) {
    throw Object.assign(new Error("nothing to update"), { code: "VALIDATION_ERROR" });
  }
  sets.push("updated_at = now()");

  const query = `UPDATE notification_providers SET ${sets.join(", ")} WHERE id = $1::uuid AND store_id = $2::uuid`;
  const res = await pool.query(query, args);
  return (res.rowCount ?? 0) > 0;
}

export async function deleteNotificationProvider(
  providerId: string,
  storeId: string
): Promise<boolean> {
  const pool = getPool();
  const res = await pool.query(
    `DELETE FROM notification_providers WHERE id = $1::uuid AND store_id = $2::uuid`,
    [providerId, storeId]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Delivery log ───────────────────────────────────────────────────────────────

export async function getWebhookLog(storeId: string): Promise<DeliveryLogRow[]> {
  const pool = getPool();
  const res = await pool.query<DeliveryLogRow>(
    `SELECT id::text, provider_id::text, store_id::text, event, payload,
            attempt_number, status_code, response_body, error_message, duration_ms, delivered_at
     FROM notification_delivery_log
     WHERE store_id = $1::uuid
     ORDER BY delivered_at DESC
     LIMIT 500`,
    [storeId]
  );
  return res.rows;
}

export async function getWebhookUrl(storeId: string): Promise<string> {
  // Returns the inbound payment webhook endpoint for the store.
  const pool = getPool();
  const res = await pool.query<{ id: string }>(
    `SELECT id::text FROM stores WHERE id = $1::uuid`,
    [storeId]
  );
  if (!res.rows[0]) throw Object.assign(new Error("store not found"), { code: "NOT_FOUND" });
  return `/webhooks/${storeId}`;
}

// ── Outbound dispatch ──────────────────────────────────────────────────────────

interface ProviderRecord {
  id: string;
  type: string;
  webhook_url: string | null;
  config: Record<string, unknown>;
}

/**
 * dispatchStoreEvent fires outbound webhooks to all active notification providers
 * subscribed to eventType for the given store.
 *
 * This is fire-and-forget — it runs in the background and never blocks callers.
 * Export this for use by checkout/orders in the integration pass.
 *
 * DISCOVERED: Not wired into checkout/orders here (scope constraint T2.10).
 * Integration pass note: call dispatchStoreEvent from orders service on
 * order.created, from payments service on payment.captured/refunded,
 * from shipments service on shipment.created/updated/delivered.
 */
export function dispatchStoreEvent(
  storeId: string,
  eventType: string,
  payload: Record<string, unknown>
): void {
  void _dispatchStoreEvent(storeId, eventType, payload);
}

async function _dispatchStoreEvent(
  storeId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const pool = getPool();

  // Enrich payload with standard fields (mirrors Go source).
  // NOTE: the `version` field is deliberately NOT added here — it is
  // provider-specific (a provider may pin config.api_version), so the webhook
  // path stamps it per-provider just before signing (see deliverWebhook). The
  // email/sms paths use this base `out` directly (delivery channels other than
  // webhook do not carry the spec-version contract).
  const out: Record<string, unknown> = {
    ...payload,
    event: eventType,
    store_id: storeId,
    timestamp: new Date().toISOString(),
  };

  // Load active providers for this event
  let providers: ProviderRecord[];
  try {
    const res = await pool.query<{ id: string; type: string; webhook_url: string | null; config: string }>(
      `SELECT id::text, type, webhook_url, COALESCE(config::text, '{}') AS config
       FROM notification_providers
       WHERE store_id = $1::uuid
         AND is_active = true
         AND $2 = ANY(events)`,
      [storeId, eventType]
    );
    providers = res.rows.map((r) => ({
      id: r.id,
      type: r.type,
      webhook_url: r.webhook_url,
      config: JSON.parse(r.config) as Record<string, unknown>,
    }));
  } catch (err) {
    console.error("notification: query providers", { storeId, eventType, err });
    return;
  }

  for (const provider of providers) {
    if (provider.type === "webhook") {
      await deliverWebhook(pool, storeId, provider, eventType, out);
    } else if (provider.type === "email") {
      await deliverEmail(provider, eventType, out);
    } else if (provider.type === "sms" || provider.type === "whatsapp") {
      await deliverSms(pool, storeId, provider, eventType, out);
    } else {
      console.info("notification: unhandled provider type", { type: provider.type, event: eventType });
    }
  }
}

/** POST to webhook URL with HMAC-SHA256 signature + retries. */
async function deliverWebhook(
  pool: ReturnType<typeof getPool>,
  storeId: string,
  provider: ProviderRecord,
  eventType: string,
  basePayload: Record<string, unknown>
): Promise<void> {
  const { id: providerId, webhook_url, config } = provider;
  if (!webhook_url) {
    console.warn("notification: webhook provider missing url", { providerId });
    return;
  }

  const secret = typeof config["webhook_secret"] === "string" ? config["webhook_secret"] : "";

  // Determine the spec version for THIS provider (honours config.api_version pin)
  // and stamp the outbound payload with it. The signing order is strict:
  //   enrich (add `version`) → stringify → sign → send
  // so the HMAC is computed over the exact bytes the receiver gets, including
  // the version field.
  //
  // Future v2 transform slot-in: once a second dated version exists, branch on
  // `version` here to shape the payload, e.g.
  //   const payload = version === "2026-12-01"
  //     ? transformV2(basePayload) : { ...basePayload, version };
  // Each known version maps to one transform; unknown pins already fell back to
  // the current version in resolveWebhookVersion().
  const version = resolveWebhookVersion(config);
  const payload: Record<string, unknown> = { ...basePayload, version };
  const body = JSON.stringify(payload);

  // SSRF fetch-time guard (authoritative). Validate the URL resolves only to
  // public addresses before any network call. On block, record a failed delivery
  // and return without ever fetching — never let dispatch reach internal targets.
  try {
    await assertSafeOutboundUrl(webhook_url, { allowPrivate: WEBHOOK_ALLOW_PRIVATE });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("notification: webhook blocked by SSRF guard", { providerId, eventType, message });
    await logDelivery(pool, {
      providerId,
      storeId,
      event: eventType,
      payload,
      attempt: 1,
      statusCode: null,
      responseBody: null,
      errorMessage: "blocked unsafe URL",
      durationMs: 0,
    });
    return;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Cartcrft-Event": eventType,
        "X-Cartcrft-Store-ID": storeId,
        "X-Cartcrft-Version": version,
      };

      // Sign the EXACT body that is sent (already includes the `version` field).
      if (secret) {
        const mac = createHmac("sha256", secret);
        mac.update(Buffer.from(body, "utf8"));
        headers["X-Cartcrft-Signature"] = mac.digest("hex");
      }

      const resp = await fetch(webhook_url, {
        method: "POST",
        headers,
        body,
        // Do not follow redirects: a 3xx could bounce to an internal target that
        // bypasses the pre-fetch SSRF check. Treat 3xx as a delivery outcome.
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      statusCode = resp.status;
      try {
        responseBody = await resp.text();
      } catch {
        responseBody = null;
      }

      const durationMs = Date.now() - start;

      await logDelivery(pool, {
        providerId,
        storeId,
        event: eventType,
        payload,
        attempt,
        statusCode,
        responseBody,
        errorMessage: null,
        durationMs,
      });

      if (resp.ok) {
        console.info("notification: delivered", { providerId, eventType, statusCode });
        return;
      }
      // Non-2xx — retry
      errorMessage = `HTTP ${statusCode}`;
      console.warn("notification: non-ok response", { providerId, eventType, statusCode, attempt });

    } catch (err) {
      const durationMs = Date.now() - start;
      errorMessage = err instanceof Error ? err.message : String(err);
      console.warn("notification: delivery error", { providerId, eventType, attempt, err });

      await logDelivery(pool, {
        providerId,
        storeId,
        event: eventType,
        payload,
        attempt,
        statusCode: null,
        responseBody: null,
        errorMessage,
        durationMs,
      });
    }

    // Wait before next retry (except on last attempt)
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 1_000;
      await sleep(delay);
    }
  }
}

/**
 * Email delivery via the module-level Mailer (_notifMailer).
 *
 * Mailer wiring (H2.1): _notifMailer is resolved at module load from env vars
 * (SES if configured, ConsoleMailer otherwise) and can be overridden via
 * setNotificationMailer(). This mirrors the customer-auth/service.ts pattern.
 * Since main.ts cannot be touched in wave H2, no explicit boot wiring is needed —
 * the factory runs automatically when this module is first imported.
 *
 * The provider's config may carry: to_email, from_name, from_email, store_name,
 * brand_color, logo_url.
 *
 * C-10c: HTML templates are rendered by lib/mailer/templates.ts for known event
 * types (order.created, payment.captured, shipment.created/delivered,
 * payment.refunded). Unknown event types fall back to an escaped JSON body so no
 * information is lost. All user-data values go through esc() inside the renderer.
 */
async function deliverEmail(
  provider: ProviderRecord,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const toEmail =
    typeof provider.config["to_email"] === "string" && provider.config["to_email"]
      ? provider.config["to_email"]
      : typeof payload["email"] === "string"
        ? payload["email"]
        : "";

  if (!toEmail) {
    console.warn("notification: email provider has no recipient address", {
      providerId: provider.id,
      eventType,
    });
    return;
  }

  const fromName =
    typeof provider.config["from_name"] === "string"
      ? provider.config["from_name"]
      : "CartCrft";
  const fromEmail =
    typeof provider.config["from_email"] === "string" && provider.config["from_email"]
      ? provider.config["from_email"]
      : (config.EMAIL_FROM ?? "noreply@cartcrft.com");

  // Brand vars from provider config (optional — store can customise)
  const brandVars = {
    storeName: typeof provider.config["store_name"] === "string"
      ? provider.config["store_name"]
      : fromName,
    brandColor: typeof provider.config["brand_color"] === "string"
      ? provider.config["brand_color"]
      : undefined,
    logoUrl: typeof provider.config["logo_url"] === "string"
      ? provider.config["logo_url"]
      : undefined,
  };

  // Try to render a branded HTML template for known event types
  const rendered = renderEventEmail(eventType, payload, brandVars);

  let subject: string;
  let bodyHtml: string;
  let bodyText: string;

  if (rendered) {
    subject = rendered.subject;
    bodyHtml = rendered.bodyHtml;
    bodyText = rendered.bodyText;
  } else {
    // Fallback: escaped JSON dump for unknown/internal event types
    subject = `[${eventType}] Store notification`;
    bodyText = JSON.stringify(payload, null, 2);
    bodyHtml = `<pre style="font-family:monospace;font-size:13px;">${bodyText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`;
  }

  try {
    await _notifMailer.send({
      to: toEmail,
      fromName,
      fromEmail,
      subject,
      bodyHtml,
      bodyText,
    });
    console.info("notification: email delivered", { providerId: provider.id, eventType, to: toEmail });
  } catch (err) {
    console.error("notification: email delivery failed", { providerId: provider.id, eventType, err });
  }
}

/**
 * SMS / WhatsApp delivery via Twilio.
 *
 * Recipient resolution: provider.config.to_phone, else payload.phone, else skip.
 * Client resolution: a per-provider Twilio client when provider.config carries
 * account_sid + auth_token (+ optional from_number / messaging_service_sid),
 * else the module-level _smsProvider (env-resolved). If neither is available we
 * warn and skip.
 *
 * The provider.type ("sms" | "whatsapp") selects sendSms vs sendWhatsapp.
 * Never throws out of dispatch — failures are logged to notification_delivery_log.
 */
async function deliverSms(
  pool: ReturnType<typeof getPool>,
  storeId: string,
  provider: ProviderRecord,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  const isWhatsapp = provider.type === "whatsapp";

  const toPhone =
    typeof provider.config["to_phone"] === "string" && provider.config["to_phone"]
      ? provider.config["to_phone"]
      : typeof payload["phone"] === "string"
        ? payload["phone"]
        : "";

  if (!toPhone) {
    console.warn("notification: sms/whatsapp provider has no recipient phone", {
      providerId: provider.id,
      eventType,
    });
    return;
  }

  // Resolve a Twilio client: per-provider config first, else module singleton.
  let client: TwilioClient | null = null;
  const cfgSid = provider.config["account_sid"];
  const cfgToken = provider.config["auth_token"];
  if (typeof cfgSid === "string" && cfgSid && typeof cfgToken === "string" && cfgToken) {
    client = newTwilioClient({
      accountSid: cfgSid,
      authToken: cfgToken,
      fromNumber:
        typeof provider.config["from_number"] === "string"
          ? provider.config["from_number"]
          : undefined,
      messagingServiceSid:
        typeof provider.config["messaging_service_sid"] === "string"
          ? provider.config["messaging_service_sid"]
          : undefined,
    });
  } else {
    client = _smsProvider;
  }

  if (!client) {
    console.warn("notification: no Twilio client configured for sms/whatsapp", {
      providerId: provider.id,
      eventType,
    });
    return;
  }

  const messageBody = composeSmsBody(eventType, payload);

  const start = Date.now();
  try {
    const result = isWhatsapp
      ? await client.sendWhatsapp({ to: toPhone, body: messageBody })
      : await client.sendSms({ to: toPhone, body: messageBody });

    console.info("notification: sms/whatsapp delivered", {
      providerId: provider.id,
      eventType,
      type: provider.type,
      sid: result.sid,
    });
    await logDelivery(pool, {
      providerId: provider.id,
      storeId,
      event: eventType,
      payload,
      attempt: 1,
      statusCode: 200,
      responseBody: result.sid,
      errorMessage: null,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    const errorMessage =
      err instanceof TwilioAPIError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    console.error("notification: sms/whatsapp delivery failed", {
      providerId: provider.id,
      eventType,
      type: provider.type,
      err,
    });
    await logDelivery(pool, {
      providerId: provider.id,
      storeId,
      event: eventType,
      payload,
      attempt: 1,
      statusCode: null,
      responseBody: null,
      errorMessage,
      durationMs: Date.now() - start,
    });
  }
}

/** Compose a concise SMS/WhatsApp message body for a known event type. */
function composeSmsBody(eventType: string, payload: Record<string, unknown>): string {
  const orderNumber =
    typeof payload["order_number"] === "string" || typeof payload["order_number"] === "number"
      ? String(payload["order_number"])
      : "";
  const tracking =
    typeof payload["tracking_number"] === "string" && payload["tracking_number"]
      ? payload["tracking_number"]
      : typeof payload["tracking_reference"] === "string" && payload["tracking_reference"]
        ? payload["tracking_reference"]
        : "";

  switch (eventType) {
    case "order.created":
      return orderNumber ? `Order #${orderNumber} confirmed` : "Order confirmed";
    case "payment.captured":
      return "Payment received";
    case "shipment.created":
      return tracking ? `Your order has shipped — tracking ${tracking}` : "Your order has shipped";
    case "shipment.delivered":
      return "Your order was delivered";
    default:
      return `${eventType} update`;
  }
}

/** Log a delivery attempt to notification_delivery_log. */
async function logDelivery(
  pool: ReturnType<typeof getPool>,
  opts: {
    providerId: string;
    storeId: string;
    event: string;
    payload: Record<string, unknown>;
    attempt: number;
    statusCode: number | null;
    responseBody: string | null;
    errorMessage: string | null;
    durationMs: number;
  }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notification_delivery_log
         (provider_id, store_id, event, payload, attempt_number, status_code,
          response_body, error_message, duration_ms)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
      [
        opts.providerId,
        opts.storeId,
        opts.event,
        JSON.stringify(opts.payload),
        opts.attempt,
        opts.statusCode,
        opts.responseBody,
        opts.errorMessage,
        opts.durationMs,
      ]
    );
  } catch (err) {
    // Swallow — delivery log must not crash dispatch
    console.warn("notification: failed to write delivery log", err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
