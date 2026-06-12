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

import type { FastifyPluginAsync } from "fastify";
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
  webhook_url: z.string().url(),
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

export const notificationsPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /commerce/stores/:storeId/notification-providers ──────────────────
  app.get(
    "/commerce/stores/:storeId/notification-providers",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const providers = await listNotificationProviders(params.data.storeId);
      return reply.send({ providers });
    }
  );

  // ── POST /commerce/stores/:storeId/notification-providers ─────────────────
  app.post(
    "/commerce/stores/:storeId/notification-providers",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const parsed = CreateProviderBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      try {
        const id = await createNotificationProvider(params.data.storeId, parsed.data);
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
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = ProviderIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const parsed = UpdateProviderBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      try {
        const updated = await updateNotificationProvider(
          params.data.providerId,
          params.data.storeId,
          parsed.data
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
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = ProviderIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const deleted = await deleteNotificationProvider(params.data.providerId, params.data.storeId);
      if (!deleted) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "notification provider not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/stores/:storeId/webhook-log ─────────────────────────────
  app.get(
    "/commerce/stores/:storeId/webhook-log",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const log = await getWebhookLog(params.data.storeId);
      return reply.send({ log });
    }
  );
};
