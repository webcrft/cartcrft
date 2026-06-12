/**
 * orders/routes.ts — Fastify plugin for orders CRUD.
 *
 * Routes:
 *   GET    /commerce/stores/:storeId/orders                         — storeAuthWrite
 *   POST   /commerce/stores/:storeId/orders                         — storeAuthWrite
 *   GET    /commerce/stores/:storeId/orders/:orderId                — storeAuthWrite
 *   PUT    /commerce/stores/:storeId/orders/:orderId                — storeAuthWrite
 *   POST   /commerce/stores/:storeId/orders/:orderId/cancel         — storeAuthWrite
 *   POST   /commerce/stores/:storeId/orders/:orderId/notes          — requireJwt
 *   GET    /commerce/stores/:storeId/orders/:orderId/events         — storeAuthWrite
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  requireJwt,
  storeAuthWrite,
} from "../../lib/auth/middleware.js";
import {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  cancelOrder,
  addOrderNote,
  listOrderEvents,
} from "./service.js";

// ── Schemas ────────────────────────────────────────────────────────────────────

const StoreOrderParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
});

const StoreOrderIdParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
  orderId: z.string().uuid("orderId must be a UUID"),
});

const ListOrdersQuery = z.object({
  status: z.string().optional(),
  financial_status: z.string().optional(),
  fulfillment_status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateOrderLineSchema = z.object({
  variant_id: z.string().uuid().optional(),
  title: z.string().max(500).optional(),
  sku: z.string().max(200).optional(),
  quantity: z.number().int().min(1).optional(),
});

const CreateOrderBody = z.object({
  currency: z.string().length(3).optional(),
  customer_id: z.string().uuid().optional(),
  shipping_address: z.record(z.string(), z.unknown()).optional(),
  billing_address: z.record(z.string(), z.unknown()).optional(),
  po_number: z.string().max(200).optional(),
  payment_terms_days: z.number().int().min(0).optional(),
  source_name: z.string().max(200).optional(),
  notes: z.string().max(16384).optional(),
  shipping_total: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  tax_total: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  discount_total: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  mode: z.enum(["live", "dev"]).optional(),
  lines: z.array(CreateOrderLineSchema).min(1, "lines must be a non-empty array"),
});

const UpdateOrderBody = z.object({
  notes: z.string().max(16384).optional(),
  tags: z.array(z.string()).optional(),
  // Blocked fields — presence triggers 400
  status: z.never().optional(),
  financial_status: z.never().optional(),
  fulfillment_status: z.never().optional(),
}).passthrough();

const CancelOrderBody = z.object({
  reason: z.string().max(500).optional(),
});

const AddNoteBody = z.object({
  note: z.string().min(1, "note is required").max(16384),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const ordersPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /commerce/stores/:storeId/orders ────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/orders",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreOrderParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      const query = ListOrdersQuery.safeParse(request.query);
      const opts = query.success ? query.data : {};

      const result = await listOrders(params.data.storeId, opts);
      return reply.send(result);
    }
  );

  // ── POST /commerce/stores/:storeId/orders ───────────────────────────────────
  app.post(
    "/commerce/stores/:storeId/orders",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreOrderParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      // Check for blocked status fields before full parse
      const rawBody = request.body as Record<string, unknown> | null;
      if (rawBody) {
        for (const f of ["status", "financial_status", "fulfillment_status"]) {
          if (f in (rawBody as Record<string, unknown>)) {
            return reply.status(400).send({
              error: {
                code: "VALIDATION_ERROR",
                message: `field '${f}' cannot be set via CreateOrder`,
              },
            });
          }
        }
      }

      const parsed = CreateOrderBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: parsed.error.issues,
          },
        });
      }

      const userId = request.auth?.userId;

      try {
        const result = await createOrder(
          params.data.storeId,
          parsed.data,
          userId
        );
        return reply.status(201).send(result);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "VALIDATION_ERROR"
        ) {
          return reply.status(400).send({
            error: { code: "VALIDATION_ERROR", message: err.message },
          });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/orders/:orderId ───────────────────────────
  app.get(
    "/commerce/stores/:storeId/orders/:orderId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreOrderIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const order = await getOrder(params.data.orderId, params.data.storeId);
      if (!order) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "order not found" } });
      }
      return reply.send(order);
    }
  );

  // ── PUT /commerce/stores/:storeId/orders/:orderId ───────────────────────────
  app.put(
    "/commerce/stores/:storeId/orders/:orderId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreOrderIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      // Block state-machine fields
      const rawBody = request.body as Record<string, unknown> | null;
      for (const forbidden of [
        "status",
        "financial_status",
        "fulfillment_status",
      ]) {
        if (rawBody && forbidden in rawBody) {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message: `field '${forbidden}' cannot be set via UpdateOrder; use the dedicated state-transition endpoint`,
            },
          });
        }
      }

      const parsed = z
        .object({
          notes: z.string().max(16384).optional(),
          tags: z.array(z.string()).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: parsed.error.issues,
          },
        });
      }

      const userId = request.auth?.userId;
      const updated = await updateOrder(
        params.data.orderId,
        params.data.storeId,
        parsed.data,
        userId
      );

      if (!updated) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "order not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── POST /commerce/stores/:storeId/orders/:orderId/cancel ───────────────────
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/cancel",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreOrderIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const parsed = CancelOrderBody.safeParse(request.body);
      const reason = parsed.success ? parsed.data.reason : undefined;
      const userId = request.auth?.userId;

      const cancelled = await cancelOrder(
        params.data.orderId,
        params.data.storeId,
        reason,
        userId
      );

      if (!cancelled) {
        return reply.status(409).send({
          error: {
            code: "CONFLICT",
            message: "order cannot be cancelled in its current status",
          },
        });
      }
      return reply.send({ ok: true });
    }
  );

  // ── POST /commerce/stores/:storeId/orders/:orderId/notes ────────────────────
  // Requires JWT auth (not API key)
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/notes",
    { preHandler: [requireJwt] },
    async (request, reply) => {
      const params = StoreOrderIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const parsed = AddNoteBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "note is required",
            details: parsed.error.issues,
          },
        });
      }

      const userId = request.auth?.userId;
      if (!userId) {
        return reply
          .status(401)
          .send({ error: { code: "UNAUTHORIZED", message: "authentication required" } });
      }

      try {
        const eventId = await addOrderNote(
          params.data.orderId,
          params.data.storeId,
          parsed.data.note,
          userId
        );
        return reply.status(201).send({ id: eventId });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "NOT_FOUND"
        ) {
          return reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: err.message } });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/orders/:orderId/events ────────────────────
  app.get(
    "/commerce/stores/:storeId/orders/:orderId/events",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreOrderIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const events = await listOrderEvents(
        params.data.orderId,
        params.data.storeId
      );
      return reply.send({ events });
    }
  );
};
