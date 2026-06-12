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

  // ── IP rate-limit on all routes ────────────────────────────────────────────
  app.addHook("preHandler", rateLimitHook);

  // ── Commerce modules ───────────────────────────────────────────────────────
  await app.register(storesPlugin);
  await app.register(apiKeysPlugin);

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
