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

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthAdmin, storeAuthWrite } from "../../lib/auth/middleware.js";
import {
  listReturns,
  getReturn,
  createReturn,
  updateReturn,
  listReturnEvents,
  addReturnEvent,
  generateReturnLabel,
  ReturnLabelError,
} from "./service.js";

const UUID = z.string().uuid();
// H3.2: money fields are decimal strings, never floats
const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}

// ── Shared param schemas ──────────────────────────────────────────────────────

const StoreParams = z.object({ storeId: UUID });
const ReturnParams = z.object({ storeId: UUID, returnId: UUID });
const OrderParams = z.object({ storeId: UUID, orderId: UUID });

// ── Shared body / querystring schemas ─────────────────────────────────────────

const ListReturnsQuerystring = z.object({
  status: z.string().optional(),
  order_id: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateReturnBody = z.object({
  return_type: z.enum(["refund", "exchange", "store_credit", "repair"]).optional(),
  notes: z.string().optional().nullable(),
  lines: z
    .array(
      z.object({
        order_line_id: UUID,
        quantity: z.number().int().min(1).optional(),
        reason: z.string().optional().nullable(),
        condition: z.string().optional().nullable(),
        action: z.enum(["refund", "exchange", "store_credit", "repair"]).optional(),
        exchange_variant_id: UUID.optional().nullable(),
        restock: z.boolean().optional(),
      })
    )
    .optional(),
});

const UpdateReturnBody = z.object({
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
  return_type: z.enum(["refund", "exchange", "store_credit", "repair"]).optional().nullable(),
  // H3.2: credit_amount as decimal string; parsed to number before service call
  credit_amount: MoneyStr.optional().nullable(),
});

const AddReturnEventBody = z.object({
  type: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const returnsPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── List / Get returns ─────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/returns",
    { preHandler: storeAuthAdmin("returns"), schema: { params: StoreParams, querystring: ListReturnsQuerystring } },
    async (request, reply) => {
      const { returns, total } = await listReturns(request.params.storeId, request.query);
      return reply.send({ returns, total });
    }
  );

  app.get(
    "/commerce/stores/:storeId/returns/:returnId",
    { preHandler: storeAuthAdmin("returns"), schema: { params: ReturnParams } },
    async (request, reply) => {
      const ret = await getReturn(request.params.storeId, request.params.returnId);
      if (!ret) return reply.status(404).send(notFound("return not found"));
      return reply.send(ret);
    }
  );

  // ── Create return from order ───────────────────────────────────────────────

  app.post(
    "/commerce/stores/:storeId/orders/:orderId/returns",
    { preHandler: storeAuthAdmin("returns"), schema: { params: OrderParams, body: CreateReturnBody } },
    async (request, reply) => {
      const userId =
        (request as { auth?: { userId?: string } }).auth?.userId ??
        "00000000-0000-0000-0000-000000000000";

      try {
        const id = await createReturn(
          request.params.storeId,
          request.params.orderId,
          request.body,
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
    { preHandler: storeAuthAdmin("returns"), schema: { params: ReturnParams, body: UpdateReturnBody } },
    async (request, reply) => {
      const userId =
        (request as { auth?: { userId?: string } }).auth?.userId ??
        "00000000-0000-0000-0000-000000000000";

      // H3.2: parse decimal-string credit_amount to number for service layer
      const { credit_amount: creditAmountStr, ...rest } = request.body;
      const creditAmount = creditAmountStr != null ? parseFloat(creditAmountStr) : undefined;

      const ok = await updateReturn(
        request.params.storeId,
        request.params.returnId,
        { ...rest, credit_amount: creditAmount },
        userId
      );
      if (!ok) return reply.status(404).send(notFound("return not found"));
      return reply.send({ ok: true });
    }
  );

  // ── Prepaid return shipping label (Shippo) ─────────────────────────────────

  app.post(
    "/commerce/stores/:storeId/returns/:returnId/label",
    { preHandler: storeAuthWrite("returns"), schema: { params: ReturnParams } },
    async (request, reply) => {
      try {
        const label = await generateReturnLabel(
          request.params.storeId,
          request.params.returnId
        );
        return reply.status(201).send(label);
      } catch (err) {
        if (err instanceof ReturnLabelError) {
          if (err.code === "NOT_FOUND") {
            return reply.status(404).send(notFound(err.message));
          }
          if (err.code === "INVALID_STATE") {
            return reply
              .status(409)
              .send({ error: { code: err.code, message: err.message } });
          }
          if (err.code === "NO_PROVIDER" || err.code === "NO_WAREHOUSE") {
            return reply
              .status(422)
              .send({ error: { code: err.code, message: err.message } });
          }
          // NO_RATES / PROVIDER_ERROR — upstream failure
          return reply
            .status(502)
            .send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    }
  );

  // ── Return events ──────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/returns/:returnId/events",
    { preHandler: storeAuthAdmin("returns"), schema: { params: ReturnParams } },
    async (request, reply) => {
      const events = await listReturnEvents(request.params.storeId, request.params.returnId);
      return reply.send({ events });
    }
  );

  app.post(
    "/commerce/stores/:storeId/returns/:returnId/events",
    { preHandler: storeAuthAdmin("returns"), schema: { params: ReturnParams, body: AddReturnEventBody } },
    async (request, reply) => {
      const userId =
        (request as { auth?: { userId?: string } }).auth?.userId ??
        "00000000-0000-0000-0000-000000000000";

      try {
        const id = await addReturnEvent(
          request.params.storeId,
          request.params.returnId,
          { type: request.body.type, data: request.body.data },
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
