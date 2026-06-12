/**
 * Fastify application factory.
 *
 * Features:
 *  - Zod type provider (fastify-type-provider-zod)
 *  - Unified error envelope { error: { code, message, details? } }
 *  - request-id on every response
 *  - GET /healthz → { status: "ok"|"degraded", version, db: "ok"|"error" }
 *    Server keeps serving /healthz even when the DB is unreachable.
 */
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
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

const VERSION = process.env["npm_package_version"] ?? "0.0.0";

/** Build and configure the Fastify app. Returns the instance (not started). */
export async function buildApp(): Promise<FastifyInstance> {
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

  // ── Inbound payment webhook router (T2.5) ─────────────────────────────────
  await app.register(webhooksPlugin);

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
