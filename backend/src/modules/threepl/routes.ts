/**
 * threepl/routes.ts — 3PL / fulfillment-network admin endpoints.
 *
 *   GET    /commerce/stores/:storeId/threepl/providers                 (read)  — list 3PL providers
 *   PUT    /commerce/stores/:storeId/threepl/providers/:provider       (write) — enable/configure a provider
 *   DELETE /commerce/stores/:storeId/threepl/providers/:provider       (admin) — remove a provider
 *   POST   /commerce/stores/:storeId/orders/:orderId/threepl/:provider/submit (admin) — submit an order for fulfillment
 *   GET    /commerce/stores/:storeId/threepl/fulfillments              (read)  — list 3PL fulfillments
 *   GET    /commerce/stores/:storeId/orders/:orderId/threepl           (read)  — an order's 3PL fulfillment status
 *
 * Auth mirrors other commerce modules: storeAuthRead/Write/Admin pull the
 * tenant-scoped storeId off request.auth (never the URL param) for the DB calls.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  storeAuthRead,
  storeAuthWrite,
  storeAuthAdmin,
} from "../../lib/auth/middleware.js";
import { isThreePlProviderName } from "./types.js";
import {
  listThreePlProviders,
  upsertThreePlProvider,
  deleteThreePlProvider,
  listThreePlFulfillments,
  getThreePlFulfillmentForOrder,
  submitOrderToThreePl,
} from "./service.js";

const ProviderParam = z.object({ provider: z.string().min(1) });

const UpsertBody = z.object({
  is_active: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const threeplPlugin: FastifyPluginAsync = async (app) => {
  // ── GET /threepl/providers ────────────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/threepl/providers",
    { preHandler: [storeAuthRead("threepl")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const providers = await listThreePlProviders(storeId);
      return reply.send({ providers });
    }
  );

  // ── PUT /threepl/providers/:provider — enable/configure ───────────────────
  app.put(
    "/commerce/stores/:storeId/threepl/providers/:provider",
    { preHandler: [storeAuthWrite("threepl")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = ProviderParam.safeParse(request.params);
      if (!params.success || !isThreePlProviderName(params.data.provider)) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "unknown 3PL provider" },
        });
      }
      const body = UpsertBody.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "invalid body" },
        });
      }

      const row = await upsertThreePlProvider(storeId, {
        provider: params.data.provider,
        ...(body.data.is_active !== undefined ? { is_active: body.data.is_active } : {}),
        ...(body.data.config !== undefined ? { config: body.data.config } : {}),
      });
      return reply.send({ provider: row });
    }
  );

  // ── DELETE /threepl/providers/:provider ───────────────────────────────────
  app.delete(
    "/commerce/stores/:storeId/threepl/providers/:provider",
    { preHandler: [storeAuthAdmin("threepl")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = ProviderParam.safeParse(request.params);
      if (!params.success || !isThreePlProviderName(params.data.provider)) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "unknown 3PL provider" },
        });
      }
      await deleteThreePlProvider(storeId, params.data.provider);
      return reply.send({ ok: true });
    }
  );

  // ── POST /orders/:orderId/threepl/:provider/submit (admin) ────────────────
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/threepl/:provider/submit",
    { preHandler: [storeAuthAdmin("threepl")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = z
        .object({ orderId: z.string().uuid(), provider: z.string().min(1) })
        .safeParse(request.params);
      if (!params.success || !isThreePlProviderName(params.data.provider)) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "invalid order id or provider" },
        });
      }

      try {
        const outcome = await submitOrderToThreePl(
          storeId,
          params.data.orderId,
          params.data.provider
        );
        return reply.send({
          fulfillment: outcome.fulfillment,
          already_submitted: outcome.alreadySubmitted,
        });
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        const status = e.code === "NOT_FOUND" ? 404 : 400;
        return reply.status(status).send({
          error: { code: e.code ?? "VALIDATION_ERROR", message: e.message },
        });
      }
    }
  );

  // ── GET /threepl/fulfillments — list (read) ───────────────────────────────
  app.get(
    "/commerce/stores/:storeId/threepl/fulfillments",
    { preHandler: [storeAuthRead("threepl")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const q = z
        .object({
          status: z.string().optional(),
          limit: z.coerce.number().int().positive().max(500).optional(),
          offset: z.coerce.number().int().nonnegative().optional(),
        })
        .safeParse(request.query ?? {});
      const opts = q.success ? q.data : {};
      const fulfillments = await listThreePlFulfillments(storeId, opts);
      return reply.send({ fulfillments });
    }
  );

  // ── GET /orders/:orderId/threepl — an order's 3PL fulfillment status (read) ─
  app.get(
    "/commerce/stores/:storeId/orders/:orderId/threepl",
    { preHandler: [storeAuthRead("threepl")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = z.object({ orderId: z.string().uuid() }).safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "invalid order id" },
        });
      }
      const fulfillment = await getThreePlFulfillmentForOrder(storeId, params.data.orderId);
      if (!fulfillment) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "no 3PL fulfillment for this order" },
        });
      }
      return reply.send({ fulfillment });
    }
  );
};
