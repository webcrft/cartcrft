/**
 * orders/routes.ts — Fastify plugin for orders CRUD.
 *
 * Routes (OAuth scope tier shown after the guard; "orders" is the resource tag):
 *   GET    /commerce/stores/:storeId/orders                         — storeAuthRead("orders")
 *   POST   /commerce/stores/:storeId/orders                         — storeAuthWrite("orders")
 *   GET    /commerce/stores/:storeId/orders/:orderId                — storeAuthRead("orders")
 *   PUT    /commerce/stores/:storeId/orders/:orderId                — storeAuthWrite("orders")
 *   POST   /commerce/stores/:storeId/orders/:orderId/cancel         — storeAuthWrite("orders")
 *   POST   /commerce/stores/:storeId/orders/:orderId/notes          — storeAuthWrite("orders")
 *   GET    /commerce/stores/:storeId/orders/:orderId/events         — storeAuthRead("orders")
 *   POST   /commerce/stores/:storeId/orders/:orderId/collect-balance — storeAuthAdmin("orders")
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  storeAuthRead,
  storeAuthWrite,
  storeAuthAdmin,
} from "../../lib/auth/middleware.js";
import {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  cancelOrder,
  addOrderNote,
  listOrderEvents,
  fulfillOrderLines,
  editOrderLines,
} from "./service.js";
import { collectOutstandingBalance } from "../payments/service.js";

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

// Blocked fields are typed z.never() so Fastify rejects them at schema validation
// with a 400, matching the original handler-level check behaviour.
const UpdateOrderBody = z.object({
  notes: z.string().max(16384).optional(),
  tags: z.array(z.string()).optional(),
  status: z.never().optional(),
  financial_status: z.never().optional(),
  fulfillment_status: z.never().optional(),
});

const CancelOrderBody = z.object({
  reason: z.string().max(500).optional(),
});

const AddNoteBody = z.object({
  note: z.string().min(1, "note is required").max(16384),
});

// Line-level (incremental, partial-capable) fulfillment.
// Replaces the prior absence of any fulfill schema — the order's
// fulfillment_status was previously only settable via the z.never()-blocked
// PUT path, so there was no safe way to fulfill at all.
const FulfillOrderBody = z.object({
  lines: z
    .array(
      z.object({
        order_line_id: z.string().uuid("order_line_id must be a UUID"),
        quantity: z.number().int().min(1, "quantity must be >= 1"),
      })
    )
    .min(1, "lines must be a non-empty array"),
});

// Safe order line edits on unfulfilled orders. Each op is discriminated by `op`.
const EditLineOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("update_quantity"),
    order_line_id: z.string().uuid("order_line_id must be a UUID"),
    quantity: z.number().int().min(1, "quantity must be >= 1"),
  }),
  z.object({
    op: z.literal("add"),
    variant_id: z.string().uuid("variant_id must be a UUID"),
    quantity: z.number().int().min(1, "quantity must be >= 1"),
  }),
  z.object({
    op: z.literal("remove"),
    order_line_id: z.string().uuid("order_line_id must be a UUID"),
  }),
]);

const EditOrderLinesBody = z.object({
  ops: z.array(EditLineOpSchema).min(1, "ops must be a non-empty array"),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const ordersPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /commerce/stores/:storeId/orders ────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/orders",
    {
      // Read tier: an OAuth orders:read token may list orders; write/admin imply
      // read. (JWT/API-key semantics unchanged from the storeAuthRead default.)
      preHandler: [storeAuthRead("orders")],
      schema: { params: StoreOrderParams, querystring: ListOrdersQuery },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreOrderParams>;
      const opts = request.query as z.infer<typeof ListOrdersQuery>;
      const result = await listOrders(storeId, opts);
      return reply.send(result);
    }
  );

  // ── POST /commerce/stores/:storeId/orders ───────────────────────────────────
  app.post(
    "/commerce/stores/:storeId/orders",
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreOrderParams, body: CreateOrderBody },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreOrderParams>;

      // Check for blocked status fields before using the parsed body
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

      const data = request.body as z.infer<typeof CreateOrderBody>;
      const userId = request.auth?.userId;

      try {
        const result = await createOrder(storeId, data, userId);
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
    {
      preHandler: [storeAuthRead("orders")],
      schema: { params: StoreOrderIdParams },
    },
    async (request, reply) => {
      const { storeId, orderId } = request.params as z.infer<typeof StoreOrderIdParams>;
      const order = await getOrder(orderId, storeId);
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
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreOrderIdParams, body: UpdateOrderBody },
    },
    async (request, reply) => {
      const { storeId, orderId } = request.params as z.infer<typeof StoreOrderIdParams>;
      // Blocked status fields (status, financial_status, fulfillment_status) are
      // rejected at the schema level via z.never() — no handler check needed.
      const data = request.body as z.infer<typeof UpdateOrderBody>;
      const userId = request.auth?.userId;
      const updated = await updateOrder(orderId, storeId, data, userId);

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
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreOrderIdParams, body: CancelOrderBody },
    },
    async (request, reply) => {
      const { storeId, orderId } = request.params as z.infer<typeof StoreOrderIdParams>;
      const data = request.body as z.infer<typeof CancelOrderBody>;
      const userId = request.auth?.userId;

      const cancelled = await cancelOrder(orderId, storeId, data.reason, userId);

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
  // SEC: was bare requireJwt, which set orgId but did NOT validate that
  // :storeId belongs to the caller's org (cross-tenant write IDOR). Use the
  // same storeAuthWrite guard the other order write routes use so the store is
  // org-scoped before the note is written.
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/notes",
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreOrderIdParams, body: AddNoteBody },
    },
    async (request, reply) => {
      const { storeId, orderId } = request.params as z.infer<typeof StoreOrderIdParams>;
      const { note } = request.body as z.infer<typeof AddNoteBody>;

      const userId = request.auth?.userId;
      if (!userId) {
        return reply
          .status(401)
          .send({ error: { code: "UNAUTHORIZED", message: "authentication required" } });
      }

      try {
        const eventId = await addOrderNote(orderId, storeId, note, userId);
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
    {
      preHandler: [storeAuthRead("orders")],
      schema: { params: StoreOrderIdParams },
    },
    async (request, reply) => {
      const { storeId, orderId } = request.params as z.infer<typeof StoreOrderIdParams>;
      const events = await listOrderEvents(orderId, storeId);
      return reply.send({ events });
    }
  );

  // ── POST /commerce/stores/:storeId/orders/:orderId/fulfillments ──────────────
  // Incremental, partial-capable line-level fulfillment.
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/fulfillments",
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreOrderIdParams, body: FulfillOrderBody },
    },
    async (request, reply) => {
      const { storeId, orderId } = request.params as z.infer<typeof StoreOrderIdParams>;
      const { lines } = request.body as z.infer<typeof FulfillOrderBody>;
      const userId = request.auth?.userId;

      try {
        const result = await fulfillOrderLines(storeId, orderId, lines, userId);
        if (!result) {
          return reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: "order not found" } });
        }
        return reply.status(201).send(result);
      } catch (err: unknown) {
        return mapServiceError(reply, err);
      }
    }
  );

  // ── POST /commerce/stores/:storeId/orders/:orderId/edit-lines ────────────────
  // Safe line edits (update qty / add / remove) on UNFULFILLED orders with
  // server-side re-pricing and inventory adjustment.
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/edit-lines",
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreOrderIdParams, body: EditOrderLinesBody },
    },
    async (request, reply) => {
      const { storeId, orderId } = request.params as z.infer<typeof StoreOrderIdParams>;
      const { ops } = request.body as z.infer<typeof EditOrderLinesBody>;
      const userId = request.auth?.userId;

      try {
        const result = await editOrderLines(storeId, orderId, ops, userId);
        if (!result) {
          return reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: "order not found" } });
        }
        return reply.send(result);
      } catch (err: unknown) {
        return mapServiceError(reply, err);
      }
    }
  );

  // ── POST /commerce/stores/:storeId/orders/:orderId/collect-balance ───────────
  // EXPLICIT collection of an outstanding balance left by an edit that increased
  // the order total. We NEVER auto-charge on edit; this endpoint is the only way
  // the saved payment method is charged for the delta. Admin-gated (money
  // movement), mirroring the payment capture route.
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/collect-balance",
    {
      preHandler: [storeAuthAdmin("orders")],
      schema: { params: StoreOrderIdParams },
    },
    async (request, reply) => {
      const { storeId, orderId } = request.params as z.infer<typeof StoreOrderIdParams>;
      const userId = request.auth?.userId;

      try {
        const result = await collectOutstandingBalance(orderId, storeId, userId);
        return reply.send(result);
      } catch (err: unknown) {
        return mapServiceError(reply, err);
      }
    }
  );
};

// ── Service-error → HTTP mapping ────────────────────────────────────────────────
// Mirrors the inline mapping the other handlers use, centralised for the two
// new endpoints (VALIDATION_ERROR → 400, CONFLICT → 409, NOT_FOUND → 404,
// INSUFFICIENT_INVENTORY → 409).
function mapServiceError(
  reply: import("fastify").FastifyReply,
  err: unknown
): unknown {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "VALIDATION_ERROR") {
      return reply.status(400).send({ error: { code, message: err.message } });
    }
    if (code === "NOT_FOUND") {
      return reply.status(404).send({ error: { code, message: err.message } });
    }
    if (code === "CONFLICT" || code === "INSUFFICIENT_INVENTORY") {
      return reply.status(409).send({ error: { code, message: err.message } });
    }
  }
  throw err;
}
