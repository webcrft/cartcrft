/**
 * notifications/routes.ts — Fastify plugin for notification providers + delivery log.
 *
 * Routes:
 *   GET    /commerce/stores/:storeId/notification-providers      admin
 *   POST   /commerce/stores/:storeId/notification-providers      admin
 *   PUT    /commerce/stores/:storeId/notification-providers/:providerId  admin
 *   DELETE /commerce/stores/:storeId/notification-providers/:providerId  admin
 *   GET    /commerce/stores/:storeId/webhook-log                 admin
 *
 * Note: GET /commerce/stores/:storeId/webhook-url is handled by webhooksPlugin
 * (webhooks/router.ts) which aggregates all provider types. The duplicate here
 * was removed to prevent FastifyError on startup.
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthAdmin } from "../../lib/auth/middleware.js";
import {
  listNotificationProviders,
  createNotificationProvider,
  updateNotificationProvider,
  deleteNotificationProvider,
  getWebhookLog,
} from "./service.js";

// ── Zod schemas ────────────────────────────────────────────────────────────────

const StoreIdParams = z.object({ storeId: z.string().uuid() });
const ProviderIdParams = z.object({
  storeId: z.string().uuid(),
  providerId: z.string().uuid(),
});

const CreateProviderBody = z.object({
  name: z.string().min(1),
  // Optional at the schema level: only webhook-type providers need it (enforced
  // in the service). email/sms/whatsapp providers omit it.
  webhook_url: z.string().optional(),
  events: z.array(z.string()).min(1),
  webhook_secret: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  type: z.string().optional(),
});

const UpdateProviderBody = z.object({
  name: z.string().optional(),
  webhook_url: z.string().url().optional(),
  is_active: z.boolean().optional(),
  events: z.array(z.string()).optional(),
  webhook_secret: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const notificationsPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── GET /commerce/stores/:storeId/notification-providers ──────────────────
  app.get(
    "/commerce/stores/:storeId/notification-providers",
    { preHandler: [storeAuthAdmin], schema: { params: StoreIdParams } },
    async (request, reply) => {
      const providers = await listNotificationProviders(request.params.storeId);
      return reply.send({ providers });
    }
  );

  // ── POST /commerce/stores/:storeId/notification-providers ─────────────────
  app.post(
    "/commerce/stores/:storeId/notification-providers",
    { preHandler: [storeAuthAdmin], schema: { params: StoreIdParams, body: CreateProviderBody } },
    async (request, reply) => {
      try {
        const id = await createNotificationProvider(request.params.storeId, request.body);
        return reply.status(201).send({ id });
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "VALIDATION_ERROR") {
          return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
        }
        throw err;
      }
    }
  );

  // ── PUT /commerce/stores/:storeId/notification-providers/:providerId ──────
  app.put(
    "/commerce/stores/:storeId/notification-providers/:providerId",
    { preHandler: [storeAuthAdmin], schema: { params: ProviderIdParams, body: UpdateProviderBody } },
    async (request, reply) => {
      try {
        const updated = await updateNotificationProvider(
          request.params.providerId,
          request.params.storeId,
          request.body
        );
        if (!updated) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "notification provider not found" } });
        }
        return reply.send({ ok: true });
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "VALIDATION_ERROR") {
          return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
        }
        throw err;
      }
    }
  );

  // ── DELETE /commerce/stores/:storeId/notification-providers/:providerId ───
  app.delete(
    "/commerce/stores/:storeId/notification-providers/:providerId",
    { preHandler: [storeAuthAdmin], schema: { params: ProviderIdParams } },
    async (request, reply) => {
      const deleted = await deleteNotificationProvider(request.params.providerId, request.params.storeId);
      if (!deleted) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "notification provider not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/stores/:storeId/webhook-log ─────────────────────────────
  app.get(
    "/commerce/stores/:storeId/webhook-log",
    { preHandler: [storeAuthAdmin], schema: { params: StoreIdParams } },
    async (request, reply) => {
      const log = await getWebhookLog(request.params.storeId);
      return reply.send({ log });
    }
  );
};
