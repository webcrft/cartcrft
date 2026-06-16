/**
 * Fastify application factory.
 *
 * Features:
 *  - Zod type provider (fastify-type-provider-zod)
 *  - Unified error envelope { error: { code, message, details? } }
 *  - request-id on every response
 *  - GET /healthz → { status: "ok"|"degraded", version, db: "ok"|"error" }
 *    Server keeps serving /healthz even when the DB is unreachable.
 *
 * OpenAPI generation:
 *  - Pass `{ openapi: true }` or set CARTCRFT_OPENAPI=1 to register
 *    @fastify/swagger with the jsonSchemaTransform from fastify-type-provider-zod.
 *    This is off by default in production to avoid the overhead.
 *    The generate-openapi.ts script uses this to produce docs/openapi.json.
 */
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
} from "fastify-type-provider-zod";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import http from "node:http";
import { getPool } from "../db/pool.js";
import { runInRequestScope } from "../lib/request-ctx.js";
import { authPlugin, rateLimitHook } from "../lib/auth/middleware.js";
import { storesPlugin } from "../modules/stores/routes.js";
import { apiKeysPlugin } from "../modules/apikeys/routes.js";
import { ordersPlugin } from "../modules/orders/routes.js";
import { paymentsPlugin } from "../modules/payments/routes.js";
import { cartsPlugin } from "../modules/carts/routes.js";
import { checkoutPlugin } from "../modules/checkout/routes.js";
import { checkoutLinksPlugin } from "../modules/checkout-links/routes.js";
import { discountsPlugin } from "../modules/discounts/routes.js";
import { walletPlugin } from "../modules/wallet/routes.js";
import { catalogPlugin } from "../modules/catalog/routes.js";
import { customersPlugin } from "../modules/customers/routes.js";
import { customerAuthPlugin } from "../modules/customer-auth/routes.js";
import { inventoryPlugin } from "../modules/inventory/routes.js";
import { shippingPlugin } from "../modules/shipping/routes.js";
import { taxPlugin } from "../modules/tax/routes.js";
import { feedsPlugin } from "../modules/feeds/routes.js";
import { integrationsPlugin } from "../modules/integrations/routes.js";
import { notificationsPlugin } from "../modules/notifications/routes.js";
import { analyticsPlugin } from "../modules/analytics/routes.js";
import { superadminPlugin } from "../modules/superadmin/routes.js";
import { accountPlugin } from "../modules/account/routes.js";
import { oauthPlugin } from "../modules/oauth/routes.js";
import { mcpHttpPlugin } from "../agent/mcp/http.js";
import { searchPlugin } from "../agent/search/routes.js";
import { agentsPlugin } from "../modules/agents/routes.js";
import { agentAttributionHook } from "../lib/agent-auth.js";
import { webhooksPlugin } from "../webhooks/router.js";
import { acpPlugin } from "../agent/acp/index.js";
import { ucpPlugin } from "../agent/ucp/index.js";
import { onboardingPlugin } from "../agent/onboarding/routes.js";
import { b2bPlugin } from "../modules/b2b/routes.js";
import { subscriptionsPlugin } from "../modules/subscriptions/routes.js";
import { returnsPlugin } from "../modules/returns/routes.js";
import { digitalPlugin } from "../modules/digital/routes.js";
import { engagementPlugin } from "../modules/engagement/routes.js";
import { staticPlugin } from "./static.js";
import { recoveryPlugin } from "../modules/recovery/routes.js";
import { catalogCsvPlugin } from "../modules/catalog/csv-routes.js";
import { bookingsPlugin } from "../modules/bookings/index.js";
import { setAnalyticsSink, PgAnalyticsSink } from "../lib/analytics.js";
import { x402Plugin } from "../lib/x402/index.js";

const VERSION = process.env["npm_package_version"] ?? "0.0.0";
const OPENAPI_VERSION = "2026-06-12";

export interface BuildAppOptions {
  /** Enable @fastify/swagger OpenAPI 3.1 registration. Defaults to CARTCRFT_OPENAPI=1 env. */
  openapi?: boolean;
}

/** Build and configure the Fastify app. Returns the instance (not started). */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const enableOpenApi =
    opts.openapi ?? process.env["CARTCRFT_OPENAPI"] === "1";

  // P0-2: configure trustProxy from env.
  // TRUST_PROXY=1 → trust one hop (leftmost XFF entry).
  // TRUST_PROXY=N → trust N hops.
  // Unset (default) → trust no proxy; request.ip = raw socket peer.
  const trustProxyEnv = process.env["TRUST_PROXY"];
  let trustProxy: boolean | number = false;
  if (trustProxyEnv) {
    const n = Number(trustProxyEnv);
    trustProxy = Number.isInteger(n) && n > 0 ? n : false;
  }

  const app = Fastify({
    trustProxy,
    // ── Per-request AsyncLocalStorage isolation (RLS tenant safety) ─────────
    // Wrap every incoming request in its own ALS frame so that the auth
    // middleware's setRequestCtx()/enterWith() can never leak the tenant
    // context to an ancestor frame (which would let a later non-request DB
    // call inherit a stale app.org_id and trip RLS for the wrong tenant).
    serverFactory: (handler) =>
      http.createServer((req, res) =>
        runInRequestScope(() => handler(req, res))
      ),
    logger: {
      level: process.env["APP_ENV"] === "production" ? "info" : "debug",
      // ── Log redaction (H1.3) ───────────────────────────────────────────
      // Prevent API keys, bearer tokens, and other credentials from
      // appearing in structured log output. pino replaces each matched
      // path with "[Redacted]" before serialisation.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers[\"x-api-key\"]",
          "req.query.key",
          "req.query.token",
          "req.query.api_key",
          "req.query.apikey",
        ],
        censor: "[Redacted]",
      },
    },
    // Generate a request ID for every request.
    genReqId: () =>
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    requestIdHeader: "x-request-id",
  });

  // ── Zod type provider ───────────────────────────────────────────────────
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ── Security: CORS ──────────────────────────────────────────────────────
  //
  // Allowed origins: FRONTEND_URL (always) + comma-separated CORS_ORIGINS env
  // (optional, e.g. a CDN or partner storefront) + localhost variants in dev.
  // credentials: true so the storefront SDK can send session cookies / auth
  // headers from a browser context.
  {
    const frontendUrl = process.env["FRONTEND_URL"] ?? "http://localhost:5173";
    const isDev = (process.env["APP_ENV"] ?? "development") !== "production";

    const allowedOrigins = new Set<string>([frontendUrl]);

    const extraOrigins = process.env["CORS_ORIGINS"];
    if (extraOrigins) {
      for (const o of extraOrigins.split(",")) {
        const trimmed = o.trim();
        if (trimmed) allowedOrigins.add(trimmed);
      }
    }

    // In dev mode allow common localhost ports so the admin + storefront dev
    // servers work without any extra env setup.
    // 4321 = unified web dev server (Astro/dashboard).
    if (isDev) {
      for (const port of ["3000", "3001", "4000", "4321", "5173", "5174", "8080"]) {
        allowedOrigins.add(`http://localhost:${port}`);
        allowedOrigins.add(`http://127.0.0.1:${port}`);
      }
    }

    await app.register(fastifyCors, {
      origin: (origin, cb) => {
        // No Origin header → same-origin / curl / server-to-server → allow.
        if (!origin) return cb(null, true);
        cb(null, allowedOrigins.has(origin));
      },
      credentials: true,
      methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Authorization",
        "Content-Type",
        "X-Request-Id",
        "X-Api-Key",
        "Idempotency-Key",
        "Mcp-Session-Id",
      ],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 86_400, // 24 h preflight cache
    });
  }

  // ── Security: Helmet (security response headers) ────────────────────────
  //
  // CSP is intentionally disabled (contentSecurityPolicy: false).
  //
  // Rationale:
  //  - This is a headless API server, not a browser document server. The only
  //    HTML-adjacent assets served are /storefront.js (an IIFE bundle) and the
  //    MCP/SSE stream. Neither needs a document-level CSP — that's the
  //    storefront's responsibility.
  //  - A strict CSP on a JSON API would block nothing meaningful (browsers
  //    don't apply CSP to XHR/fetch response bodies) but could break tooling.
  //  - Strict-Transport-Security, X-Content-Type-Options, X-Frame-Options,
  //    Referrer-Policy, and Permissions-Policy are all still active — these
  //    headers are valuable even on API responses.
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
  });

  // ── OpenAPI 3.1 (opt-in via CARTCRFT_OPENAPI=1 or buildApp({ openapi: true })) ─
  if (enableOpenApi) {
    // Dynamic import so @fastify/swagger is only required when generating specs.
    const { default: fastifySwagger } = await import("@fastify/swagger") as {
      default: (typeof import("@fastify/swagger"))["default"];
    };
    await app.register(fastifySwagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "Cartcrft API",
          description:
            "Open-source headless commerce API — agent-native, REST, date-versioned.",
          version: OPENAPI_VERSION,
          contact: { name: "Cartcrft", url: "https://cartcrft.dev" },
          license: { name: "MIT", url: "https://github.com/cartcrft/cartcrft/blob/main/LICENSE" },
        },
        servers: [
          { url: "https://api.cartcrft.dev", description: "Cartcrft Cloud" },
          { url: "http://localhost:8080", description: "Local dev" },
        ],
        components: {
          securitySchemes: {
            BearerJWT: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
              description: "Staff/admin JWT obtained from the platform login flow.",
            },
            ApiKey: {
              type: "http",
              scheme: "bearer",
              description:
                "Cartcrft API key — `cc_pub_*` (storefront, read-only) or `cc_prv_*` (server-side, read-write).",
            },
          },
        },
        security: [{ BearerJWT: [] }, { ApiKey: [] }],
        tags: [
          { name: "stores", description: "Store management" },
          { name: "api-keys", description: "API key issuance" },
          { name: "catalog", description: "Products, variants, collections, price lists" },
          { name: "carts", description: "Shopping carts" },
          { name: "checkout", description: "Checkout sessions" },
          { name: "orders", description: "Orders and fulfillment" },
          { name: "payments", description: "Payment intents, capture, refunds" },
          { name: "customers", description: "Customer accounts" },
          { name: "customer-auth", description: "Storefront authentication" },
          { name: "inventory", description: "Warehouses, levels, lots, serials" },
          { name: "shipping", description: "Shipping zones, rates, shipments" },
          { name: "tax", description: "Tax categories, zones, rates" },
          { name: "discounts", description: "Discount codes, auto-discounts" },
          { name: "wallet", description: "Store credits" },
          { name: "gift-cards", description: "Gift cards" },
          { name: "b2b", description: "B2B companies, quotes, purchase orders" },
          { name: "subscriptions", description: "Subscription plans and billing" },
          { name: "returns", description: "Returns / RMA" },
          { name: "digital", description: "Digital product downloads" },
          { name: "engagement", description: "Wishlists, abandoned carts" },
          { name: "feeds", description: "Shopping feeds (Google, Facebook)" },
          { name: "integrations", description: "Store integrations, pixels, providers" },
          { name: "notifications", description: "Outbound notification providers" },
          { name: "analytics", description: "Ecommerce analytics" },
          { name: "search", description: "Semantic + full-text catalog search" },
          { name: "agents", description: "Agent registry + mandates" },
          { name: "mcp", description: "Model Context Protocol endpoints" },
          { name: "acp", description: "Agentic Commerce Protocol adapter" },
          { name: "webhooks", description: "Inbound payment webhooks" },
          { name: "healthz", description: "Health check" },
        ],
      },
      transform: jsonSchemaTransform,
    });
  }

  // ── Request-id on every response ────────────────────────────────────────
  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });

  // ── Error envelope ─────────────────────────────────────────────────────
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    app.log.error({ err: error }, "request error");

    // Fastify validation errors (ZodError wrapped by the type provider)
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.validation,
        },
      });
    }

    const statusCode = error.statusCode ?? 500;
    const code =
      statusCode === 404
        ? "NOT_FOUND"
        : statusCode === 401
          ? "UNAUTHORIZED"
          : statusCode === 403
            ? "FORBIDDEN"
            : statusCode >= 500
              ? "INTERNAL_ERROR"
              : "BAD_REQUEST";

    return reply.status(statusCode).send({
      error: {
        code,
        message: error.message ?? "An unexpected error occurred",
      },
    });
  });

  // ── Static SPA (same-origin) + not-found handler ───────────────────────
  // When WEB_DIST points at a built frontend, serve it as static files and
  // fall back to index.html for client-side routes. Anything that isn't an
  // HTML navigation (API clients, JSON) still gets the JSON 404 envelope, so
  // existing API behaviour and tests are unchanged.
  const webDist = process.env["WEB_DIST"];
  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false, // serve real files only; unmatched paths hit notFound
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (
      webDist &&
      request.method === "GET" &&
      (request.headers.accept ?? "").includes("text/html")
    ) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.status(404).send({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  // ── Auth plugin (request.auth decorator) ──────────────────────────────────
  await app.register(authPlugin);
  // Agent context decorator (agentCtx populated by agentAttributionHook below)
  app.decorateRequest("agentCtx", undefined);

  // ── IP rate-limit on all routes ────────────────────────────────────────────
  app.addHook("preHandler", rateLimitHook);

  // ── Agent attribution hook — runs before all route handlers ─────────────────
  // Must be added directly (not via plugin) so it applies to all routes.
  app.addHook("preHandler", agentAttributionHook);

  // ── Analytics sink (H2.2) — install PgAnalyticsSink before routes boot ────────
  setAnalyticsSink(new PgAnalyticsSink());

  // ── Commerce modules ───────────────────────────────────────────────────────
  await app.register(storesPlugin);
  await app.register(apiKeysPlugin);
  await app.register(ordersPlugin);
  await app.register(paymentsPlugin);
  await app.register(cartsPlugin);
  await app.register(checkoutPlugin);
  await app.register(checkoutLinksPlugin);
  await app.register(discountsPlugin);
  await app.register(walletPlugin);
  await app.register(catalogPlugin);
  await app.register(customersPlugin);
  await app.register(customerAuthPlugin);
  await app.register(inventoryPlugin);
  await app.register(shippingPlugin);
  await app.register(taxPlugin);
  await app.register(feedsPlugin);
  await app.register(integrationsPlugin);
  await app.register(notificationsPlugin);
  await app.register(analyticsPlugin);

  // ── Super-admin portal (WebCrft operator god-mode) ────────────────
  // Hardened, distinct-audience JWT auth; cross-tenant reads; full audit trail.
  await app.register(superadminPlugin);

  // ── Platform-account auth (P3/item-1) — dashboard email+password login ────
  // Short-lived access JWT (org-middleware compatible) + httpOnly refresh cookie.
  await app.register(accountPlugin);

  // ── OAuth2 authorization server + app platform (T-OAuth) ──────────────────
  // App management under /account/oauth-apps (requireJwt) + the public /oauth
  // authorize/token/revoke/userinfo endpoints. Access tokens are JWTs the
  // existing /commerce middleware already accepts (iss/aud/org match), with
  // added scope/oauth_app claims that requireScope() enforces.
  await app.register(oauthPlugin);

  // ── MCP server (agent-native layer) ───────────────────────────────────────
  await app.register(mcpHttpPlugin);

  // ── Semantic catalog search (T3.2) ────────────────────────────────────────
  await app.register(searchPlugin);

  // ── Agent registry + mandates (T3.3) ────────────────────────────────────
  await app.register(agentsPlugin);

  // ── ACP adapter (T3.4) ────────────────────────────────────────────────────
  await app.register(acpPlugin);

  // ── UCP adapter (T6.2) ────────────────────────────────────────────────────
  await app.register(ucpPlugin);

  // ── Agent-surface onboarding (B7) ─────────────────────────────────────────
  await app.register(onboardingPlugin);

  // ── Inbound payment webhook router ────────────────────────────────────────
  await app.register(webhooksPlugin);

  // ── T2.9 — B2B, subscriptions, returns, digital, engagement ──────────────
  await app.register(b2bPlugin);
  await app.register(subscriptionsPlugin);
  await app.register(returnsPlugin);
  await app.register(digitalPlugin);
  await app.register(engagementPlugin);

  // ── Cloud billing webhook + read-API (CARTCRFT_CLOUD=1 only) ─────────────────
  // Dynamic import so the OSS build never eagerly imports @cartcrft/cloud-billing.
  // The backend typechecks and builds cleanly without the cloud package present.
  if (process.env["CARTCRFT_CLOUD"]) {
    // The `any` casts below are intentional: @cartcrft/cloud-billing is an optional
    // workspace dep (cloud-license boundary). TypeScript cannot statically verify
    // the import target when the package may be absent. The plugin function is
    // duck-typed by Fastify's register() call — safe at runtime. /* any: optional cloud dep */
    // Pass the backend's existing pg.Pool so plugins reuse the connection pool
    // instead of opening a second one from DATABASE_URL.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cloudBilling = await import("@cartcrft/cloud-billing" as any) as {
      billingWebhookPlugin: (instance: unknown, opts: Record<string, unknown>) => Promise<void>;
      billingApiPlugin: (instance: unknown, opts: Record<string, unknown>) => Promise<void>;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (app as any).register(cloudBilling.billingWebhookPlugin, { prefix: "/webhooks/billing", pool: getPool() });
    // Cloud account + billing read endpoints consumed by the dashboard cloud pages.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (app as any).register(cloudBilling.billingApiPlugin, { prefix: "/cloud", pool: getPool() });
  }

  // ── T6.5 — Abandoned-cart recovery emails (routes) ───────────────────────────
  await app.register(recoveryPlugin);

  // ── T6.6 — CSV product import/export ─────────────────────────────────────────
  await app.register(catalogCsvPlugin);

  // ── T6.1 — Bookings, resources, availability, price rules, iCal, OTA ─────────
  await app.register(bookingsPlugin);

  // ── C-10b — x402 machine-payment demo (off by default; X402_ENABLED=true to gate) ──
  await app.register(x402Plugin);

  // ── Static: drop-in storefront.js bundle ───────────────────────────────────
  await app.register(staticPlugin);

  // ── GET /healthz ────────────────────────────────────────────────────────
  app.get("/healthz", async (_request, reply) => {
    let dbStatus: "ok" | "error" = "ok";

    try {
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        client.release();
      }
    } catch (err) {
      dbStatus = "error";
      app.log.warn(
        { err },
        "healthz: DB unreachable — serving degraded"
      );
    }

    const status = dbStatus === "ok" ? "ok" : "degraded";

    return reply.status(200).send({
      status,
      version: VERSION,
      db: dbStatus,
    });
  });

  return app;
}
