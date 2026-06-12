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
import { getPool } from "../db/pool.js";
import { authPlugin, rateLimitHook } from "../lib/auth/middleware.js";
import { storesPlugin } from "../modules/stores/routes.js";
import { apiKeysPlugin } from "../modules/apikeys/routes.js";
import { ordersPlugin } from "../modules/orders/routes.js";
import { paymentsPlugin } from "../modules/payments/routes.js";
import { cartsPlugin } from "../modules/carts/routes.js";
import { checkoutPlugin } from "../modules/checkout/routes.js";
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
import { mcpHttpPlugin } from "../agent/mcp/http.js";
import { searchPlugin } from "../agent/search/routes.js";
import { agentsPlugin } from "../modules/agents/routes.js";
import { agentAttributionHook } from "../lib/agent-auth.js";
import { webhooksPlugin } from "../webhooks/router.js";
import { acpPlugin } from "../agent/acp/index.js";
import { b2bPlugin } from "../modules/b2b/routes.js";
import { subscriptionsPlugin } from "../modules/subscriptions/routes.js";
import { returnsPlugin } from "../modules/returns/routes.js";
import { digitalPlugin } from "../modules/digital/routes.js";
import { engagementPlugin } from "../modules/engagement/routes.js";
import { staticPlugin } from "./static.js";
import { recoveryPlugin } from "../modules/recovery/routes.js";
import { catalogCsvPlugin } from "../modules/catalog/csv-routes.js";
import { bookingsPlugin } from "../modules/bookings/index.js";

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

  const app = Fastify({
    logger: {
      level: process.env["APP_ENV"] === "production" ? "info" : "debug",
    },
    // Generate a request ID for every request.
    genReqId: () =>
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    requestIdHeader: "x-request-id",
  });

  // ── Zod type provider ───────────────────────────────────────────────────
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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
          { url: "http://localhost:3000", description: "Local dev" },
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

  // ── Not-found handler ──────────────────────────────────────────────────
  app.setNotFoundHandler((_request, reply) => {
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

  // ── Commerce modules ───────────────────────────────────────────────────────
  await app.register(storesPlugin);
  await app.register(apiKeysPlugin);
  await app.register(ordersPlugin);
  await app.register(paymentsPlugin);
  await app.register(cartsPlugin);
  await app.register(checkoutPlugin);
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

  // ── MCP server (agent-native layer) ───────────────────────────────────────
  await app.register(mcpHttpPlugin);

  // ── Semantic catalog search (T3.2) ────────────────────────────────────────
  await app.register(searchPlugin);

  // ── Agent registry + mandates (T3.3) ────────────────────────────────────
  await app.register(agentsPlugin);

  // ── ACP adapter (T3.4) ────────────────────────────────────────────────────
  await app.register(acpPlugin);

  // ── Inbound payment webhook router (T2.5) ─────────────────────────────────
  await app.register(webhooksPlugin);

  // ── T2.9 — B2B, subscriptions, returns, digital, engagement ──────────────
  await app.register(b2bPlugin);
  await app.register(subscriptionsPlugin);
  await app.register(returnsPlugin);
  await app.register(digitalPlugin);
  await app.register(engagementPlugin);

  // ── Cloud billing webhook (CARTCRFT_CLOUD=1 only) ────────────────────────────
  // Dynamic import so the OSS build never eagerly imports @cartcrft/cloud-billing.
  // The backend typechecks and builds cleanly without the cloud package present.
  if (process.env["CARTCRFT_CLOUD"]) {
    // The `any` casts below are intentional: @cartcrft/cloud-billing is an optional
    // workspace dep (cloud-license boundary). TypeScript cannot statically verify
    // the import target when the package may be absent. The plugin function is
    // duck-typed by Fastify's register() call — safe at runtime. /* any: optional cloud dep */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cloudBilling = await import("@cartcrft/cloud-billing" as any) as { billingWebhookPlugin: (instance: unknown, opts: Record<string, unknown>) => Promise<void> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (app as any).register(cloudBilling.billingWebhookPlugin, { prefix: "/webhooks/billing" });
  }

  // ── T6.5 — Abandoned-cart recovery emails (routes) ───────────────────────────
  await app.register(recoveryPlugin);

  // ── T6.6 — CSV product import/export ─────────────────────────────────────────
  await app.register(catalogCsvPlugin);

  // ── T6.1 — Bookings, resources, availability, price rules, iCal, OTA ─────────
  await app.register(bookingsPlugin);

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
