/**
 * returns/routes.ts — Fastify plugin for Returns/RMA routes.
 *
 * Routes:
 *  List/Get/Create/Update returns: /commerce/stores/:storeId/returns
 *  Create return from order: /commerce/stores/:storeId/orders/:orderId/returns
 *  Return events: /commerce/stores/:storeId/returns/:returnId/events
 *
 * Auth: admin tier for all return operations.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin } from "../../lib/auth/middleware.js";
import {
  listReturns,
  getReturn,
  createReturn,
  updateReturn,
  listReturnEvents,
  addReturnEvent,
} from "./service.js";

const UUID = z.string().uuid();

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}
function badRequest(msg: string, code = "VALIDATION_ERROR") {
  return { error: { code, message: msg } };
}

export const returnsPlugin: FastifyPluginAsync = async (app) => {
  const storeParams = z.object({ storeId: UUID });

  // ── List / Get returns ─────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/returns",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const query = z
        .object({
          status: z.string().optional(),
          order_id: UUID.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .safeParse(request.query);
      if (!query.success) return reply.status(400).send(badRequest("invalid query"));
      const { returns, total } = await listReturns(params.data.storeId, query.data);
      return reply.send({ returns, total });
    }
  );

  app.get(
    "/commerce/stores/:storeId/returns/:returnId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, returnId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const ret = await getReturn(params.data.storeId, params.data.returnId);
      if (!ret) return reply.status(404).send(notFound("return not found"));
      return reply.send(ret);
    }
  );

  // ── Create return from order ───────────────────────────────────────────────

  app.post(
    "/commerce/stores/:storeId/orders/:orderId/returns",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, orderId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          return_type: z.enum(["refund", "exchange", "store_credit", "repair"]).optional(),
          notes: z.string().optional().nullable(),
          lines: z
            .array(
              z.object({
                order_line_id: UUID,
                quantity: z.number().int().min(1).optional(),
                reason: z.string().optional().nullable(),
                condition: z.string().optional().nullable(),
                action: z
                  .enum(["refund", "exchange", "store_credit", "repair"])
                  .optional(),
                exchange_variant_id: UUID.optional().nullable(),
                restock: z.boolean().optional(),
              })
            )
            .optional(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));

      const userId =
        (request as { auth?: { userId?: string } }).auth?.userId ??
        "00000000-0000-0000-0000-000000000000";

      try {
        const id = await createReturn(
          params.data.storeId,
          params.data.orderId,
          body.data,
          userId
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "NOT_FOUND") {
          return reply.status(404).send(notFound(err.message));
        }
        throw err;
      }
    }
  );

  // ── Update return (status transitions) ────────────────────────────────────

  app.put(
    "/commerce/stores/:storeId/returns/:returnId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, returnId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          status: z
            .enum([
              "requested",
              "approved",
              "rejected",
              "in_transit",
              "received",
              "inspected",
              "resolved",
              "closed",
            ])
            .optional()
            .nullable(),
          notes: z.string().optional().nullable(),
          return_type: z
            .enum(["refund", "exchange", "store_credit", "repair"])
            .optional()
            .nullable(),
          credit_amount: z.number().min(0).optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));

      const userId =
        (request as { auth?: { userId?: string } }).auth?.userId ??
        "00000000-0000-0000-0000-000000000000";

      const ok = await updateReturn(
        params.data.storeId,
        params.data.returnId,
        body.data,
        userId
      );
      if (!ok) return reply.status(404).send(notFound("return not found"));
      return reply.send({ ok: true });
    }
  );

  // ── Return events ──────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/returns/:returnId/events",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, returnId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const events = await listReturnEvents(params.data.storeId, params.data.returnId);
      return reply.send({ events });
    }
  );

  app.post(
    "/commerce/stores/:storeId/returns/:returnId/events",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, returnId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          type: z.string().optional(),
          data: z.record(z.string(), z.unknown()).optional(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));

      const userId =
        (request as { auth?: { userId?: string } }).auth?.userId ??
        "00000000-0000-0000-0000-000000000000";

      try {
        const id = await addReturnEvent(
          params.data.storeId,
          params.data.returnId,
          { type: body.data.type, data: body.data.data },
          userId
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "NOT_FOUND") {
          return reply.status(404).send(notFound(err.message));
        }
        throw err;
      }
    }
  );
};
