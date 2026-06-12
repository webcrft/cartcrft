/**
 * integrations/routes.ts — Fastify plugin for integration definitions,
 * store integrations, and tracking pixels.
 *
 * Routes:
 *   GET  /commerce/integration-definitions       JWT
 *   GET  /commerce/stores/:storeId/integrations  admin
 *   POST /commerce/stores/:storeId/integrations  admin
 *   DELETE /commerce/stores/:storeId/integrations/:integrationId  admin
 *   GET  /commerce/stores/:storeId/tracking-pixels  admin
 *   POST /commerce/stores/:storeId/tracking-pixels  admin
 *   DELETE /commerce/stores/:storeId/tracking-pixels/:pixelId  admin
 *   GET  /storefront/:storeId/pixels             none (public)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  requireJwt,
  storeAuthAdmin,
} from "../../lib/auth/middleware.js";
import {
  listIntegrationDefinitions,
  listStoreIntegrations,
  upsertStoreIntegration,
  deleteStoreIntegration,
  listTrackingPixels,
  upsertTrackingPixel,
  deleteTrackingPixel,
  getPublicPixels,
} from "./service.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreIdParams = z.object({ storeId: z.string().uuid() });
const IntegrationIdParams = z.object({
  storeId: z.string().uuid(),
  integrationId: z.string().uuid(),
});
const PixelIdParams = z.object({
  storeId: z.string().uuid(),
  pixelId: z.string().uuid(),
});

const IntegrationDefsQuery = z.object({
  category: z.string().optional(),
});

const UpsertIntegrationBody = z.object({
  integration_slug: z.string().min(1),
  name: z.string().min(1),
  api_key: z.string().optional(),
  api_secret: z.string().optional(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  webhook_secret: z.string().optional(),
  oauth_account_id: z.string().optional(),
  oauth_account_name: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

const UpsertPixelBody = z.object({
  pixel_type: z.string().min(1),
  name: z.string().optional(),
  tracking_id: z.string().min(1),
  api_secret: z.string().optional(),
  access_token: z.string().optional(),
  fire_on: z.string().optional(),
  url_pattern: z.string().optional(),
  event_mapping: z.record(z.string(), z.unknown()).optional(),
  script_content: z.string().optional(),
  inject_location: z.string().optional(),
  is_active: z.boolean().optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const integrationsPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /commerce/integration-definitions ────────────────────────────────
  app.get(
    "/commerce/integration-definitions",
    { preHandler: [requireJwt] },
    async (request, reply) => {
      const q = IntegrationDefsQuery.safeParse(request.query);
      const category = q.success ? q.data.category : undefined;
      const integrations = await listIntegrationDefinitions(category);
      return reply.send({ integrations });
    }
  );

  // ── GET /commerce/stores/:storeId/integrations ───────────────────────────
  app.get(
    "/commerce/stores/:storeId/integrations",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const integrations = await listStoreIntegrations(params.data.storeId);
      return reply.send({ integrations });
    }
  );

  // ── POST /commerce/stores/:storeId/integrations ──────────────────────────
  app.post(
    "/commerce/stores/:storeId/integrations",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const parsed = UpsertIntegrationBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      try {
        const result = await upsertStoreIntegration(params.data.storeId, parsed.data);
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof Error) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "BAD_REQUEST") {
            return reply.status(400).send({ error: { code: "BAD_REQUEST", message: err.message } });
          }
          if (code === "VALIDATION_ERROR") {
            return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
          }
          // Unique constraint violation (duplicate name)
          if (err.message.includes("unique") || err.message.includes("duplicate")) {
            return reply.status(409).send({ error: { code: "CONFLICT", message: "an integration with that name already exists" } });
          }
        }
        throw err;
      }
    }
  );

  // ── DELETE /commerce/stores/:storeId/integrations/:integrationId ─────────
  app.delete(
    "/commerce/stores/:storeId/integrations/:integrationId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = IntegrationIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      await deleteStoreIntegration(params.data.integrationId, params.data.storeId);
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/stores/:storeId/tracking-pixels ────────────────────────
  app.get(
    "/commerce/stores/:storeId/tracking-pixels",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const pixels = await listTrackingPixels(params.data.storeId);
      return reply.send({ pixels });
    }
  );

  // ── POST /commerce/stores/:storeId/tracking-pixels ───────────────────────
  app.post(
    "/commerce/stores/:storeId/tracking-pixels",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const parsed = UpsertPixelBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      try {
        const id = await upsertTrackingPixel(params.data.storeId, parsed.data);
        return reply.status(201).send({ id });
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "VALIDATION_ERROR") {
          return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
        }
        throw err;
      }
    }
  );

  // ── DELETE /commerce/stores/:storeId/tracking-pixels/:pixelId ────────────
  app.delete(
    "/commerce/stores/:storeId/tracking-pixels/:pixelId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = PixelIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      await deleteTrackingPixel(params.data.pixelId, params.data.storeId);
      return reply.send({ ok: true });
    }
  );

  // ── GET /storefront/:storeId/pixels (public) ─────────────────────────────
  app.get("/storefront/:storeId/pixels", async (request, reply) => {
    const params = StoreIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
    }
    const pixels = await getPublicPixels(params.data.storeId);
    return reply.send({ pixels });
  });
};
