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

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
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

export const integrationsPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── GET /commerce/integration-definitions ────────────────────────────────
  app.get(
    "/commerce/integration-definitions",
    { preHandler: [requireJwt], schema: { querystring: IntegrationDefsQuery } },
    async (request, reply) => {
      const category = request.query.category;
      const integrations = await listIntegrationDefinitions(category);
      return reply.send({ integrations });
    }
  );

  // ── GET /commerce/stores/:storeId/integrations ───────────────────────────
  app.get(
    "/commerce/stores/:storeId/integrations",
    { preHandler: [storeAuthAdmin("integrations")], schema: { params: StoreIdParams } },
    async (request, reply) => {
      const integrations = await listStoreIntegrations(request.params.storeId);
      return reply.send({ integrations });
    }
  );

  // ── POST /commerce/stores/:storeId/integrations ──────────────────────────
  app.post(
    "/commerce/stores/:storeId/integrations",
    { preHandler: [storeAuthAdmin("integrations")], schema: { params: StoreIdParams, body: UpsertIntegrationBody } },
    async (request, reply) => {
      try {
        const result = await upsertStoreIntegration(request.params.storeId, request.body);
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
    { preHandler: [storeAuthAdmin("integrations")], schema: { params: IntegrationIdParams } },
    async (request, reply) => {
      await deleteStoreIntegration(request.params.integrationId, request.params.storeId);
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/stores/:storeId/tracking-pixels ────────────────────────
  app.get(
    "/commerce/stores/:storeId/tracking-pixels",
    { preHandler: [storeAuthAdmin("integrations")], schema: { params: StoreIdParams } },
    async (request, reply) => {
      const pixels = await listTrackingPixels(request.params.storeId);
      return reply.send({ pixels });
    }
  );

  // ── POST /commerce/stores/:storeId/tracking-pixels ───────────────────────
  app.post(
    "/commerce/stores/:storeId/tracking-pixels",
    { preHandler: [storeAuthAdmin("integrations")], schema: { params: StoreIdParams, body: UpsertPixelBody } },
    async (request, reply) => {
      try {
        const id = await upsertTrackingPixel(request.params.storeId, request.body);
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
    { preHandler: [storeAuthAdmin("integrations")], schema: { params: PixelIdParams } },
    async (request, reply) => {
      await deleteTrackingPixel(request.params.pixelId, request.params.storeId);
      return reply.send({ ok: true });
    }
  );

  // ── GET /storefront/:storeId/pixels (public) ─────────────────────────────
  app.get(
    "/storefront/:storeId/pixels",
    { schema: { params: StoreIdParams } },
    async (request, reply) => {
      const pixels = await getPublicPixels(request.params.storeId);
      return reply.send({ pixels });
    }
  );
};
