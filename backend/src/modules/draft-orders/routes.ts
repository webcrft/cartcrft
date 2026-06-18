/**
 * draft-orders/routes.ts — Fastify plugin for draft orders / invoicing.
 *
 * Routes (OAuth scope tier shown after the guard; "orders" is the resource tag):
 *   GET    /commerce/stores/:storeId/draft-orders                       — storeAuthRead("orders")
 *   POST   /commerce/stores/:storeId/draft-orders                       — storeAuthWrite("orders")
 *   GET    /commerce/stores/:storeId/draft-orders/:id                   — storeAuthRead("orders")
 *   PUT    /commerce/stores/:storeId/draft-orders/:id                   — storeAuthWrite("orders")
 *   DELETE /commerce/stores/:storeId/draft-orders/:id                   — storeAuthWrite("orders")
 *   POST   /commerce/stores/:storeId/draft-orders/:id/send-invoice      — storeAuthAdmin("orders")
 *   POST   /commerce/stores/:storeId/draft-orders/:id/convert           — storeAuthAdmin("orders")
 *
 * send-invoice / convert are admin-gated because they email customers / create a
 * real order (money + customer-facing side effects), mirroring orders'
 * collect-balance gating.
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  storeAuthRead,
  storeAuthWrite,
  storeAuthAdmin,
} from "../../lib/auth/middleware.js";
import {
  createDraft,
  listDrafts,
  getDraft,
  updateDraft,
  deleteDraft,
  sendInvoice,
  convertToOrder,
} from "./service.js";

// ── Schemas ────────────────────────────────────────────────────────────────────

const StoreParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
});

const StoreIdParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
  id: z.string().uuid("id must be a UUID"),
});

const ListQuery = z.object({
  status: z.enum(["draft", "invoice_sent", "converted", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const Money = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal money string");

const LineSchema = z.object({
  variant_id: z.string().uuid().optional(),
  title: z.string().max(500).optional(),
  quantity: z.number().int().min(1).optional(),
  price: Money.optional(),
});

const CreateBody = z.object({
  customer_id: z.string().uuid().optional(),
  email: z.string().email().optional(),
  currency: z.string().length(3).optional(),
  line_items: z.array(LineSchema).min(1, "line_items must be a non-empty array"),
  discount_total: Money.optional(),
  tax_total: Money.optional(),
  shipping_total: Money.optional(),
  note: z.string().max(16384).optional(),
});

const UpdateBody = z.object({
  customer_id: z.string().uuid().optional(),
  email: z.string().email().optional(),
  currency: z.string().length(3).optional(),
  line_items: z.array(LineSchema).min(1).optional(),
  discount_total: Money.optional(),
  tax_total: Money.optional(),
  shipping_total: Money.optional(),
  note: z.string().max(16384).optional(),
});

// ── Service-error → HTTP mapping ────────────────────────────────────────────────

function mapServiceError(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "VALIDATION_ERROR") {
      return reply.status(400).send({ error: { code, message: err.message } });
    }
    if (code === "NOT_FOUND") {
      return reply.status(404).send({ error: { code, message: err.message } });
    }
    if (code === "CONFLICT") {
      return reply.status(409).send({ error: { code, message: err.message } });
    }
  }
  throw err;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const draftOrdersPlugin: FastifyPluginAsync = async (app) => {
  const base = "/commerce/stores/:storeId/draft-orders";

  // ── GET /draft-orders ───────────────────────────────────────────────────────
  app.get(
    base,
    {
      preHandler: [storeAuthRead("orders")],
      schema: { params: StoreParams, querystring: ListQuery },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const opts = request.query as z.infer<typeof ListQuery>;
      const result = await listDrafts(storeId, opts);
      return reply.send(result);
    }
  );

  // ── POST /draft-orders ──────────────────────────────────────────────────────
  app.post(
    base,
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreParams, body: CreateBody },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const data = request.body as z.infer<typeof CreateBody>;
      try {
        const draft = await createDraft(storeId, data);
        return reply.status(201).send(draft);
      } catch (err: unknown) {
        return mapServiceError(reply, err);
      }
    }
  );

  // ── GET /draft-orders/:id ───────────────────────────────────────────────────
  app.get(
    `${base}/:id`,
    {
      preHandler: [storeAuthRead("orders")],
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      const { storeId, id } = request.params as z.infer<typeof StoreIdParams>;
      const draft = await getDraft(storeId, id);
      if (!draft) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "draft order not found" } });
      }
      return reply.send(draft);
    }
  );

  // ── PUT /draft-orders/:id ───────────────────────────────────────────────────
  app.put(
    `${base}/:id`,
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreIdParams, body: UpdateBody },
    },
    async (request, reply) => {
      const { storeId, id } = request.params as z.infer<typeof StoreIdParams>;
      const data = request.body as z.infer<typeof UpdateBody>;
      try {
        const draft = await updateDraft(storeId, id, data);
        if (!draft) {
          return reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: "draft order not found" } });
        }
        return reply.send(draft);
      } catch (err: unknown) {
        return mapServiceError(reply, err);
      }
    }
  );

  // ── DELETE /draft-orders/:id ────────────────────────────────────────────────
  app.delete(
    `${base}/:id`,
    {
      preHandler: [storeAuthWrite("orders")],
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      const { storeId, id } = request.params as z.infer<typeof StoreIdParams>;
      const ok = await deleteDraft(storeId, id);
      if (!ok) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "draft order not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── POST /draft-orders/:id/send-invoice ─────────────────────────────────────
  app.post(
    `${base}/:id/send-invoice`,
    {
      preHandler: [storeAuthAdmin("orders")],
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      const { storeId, id } = request.params as z.infer<typeof StoreIdParams>;
      try {
        const draft = await sendInvoice(storeId, id);
        return reply.send(draft);
      } catch (err: unknown) {
        return mapServiceError(reply, err);
      }
    }
  );

  // ── POST /draft-orders/:id/convert ──────────────────────────────────────────
  app.post(
    `${base}/:id/convert`,
    {
      preHandler: [storeAuthAdmin("orders")],
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      const { storeId, id } = request.params as z.infer<typeof StoreIdParams>;
      const userId = request.auth?.userId;
      try {
        const result = await convertToOrder(storeId, id, userId);
        return reply.status(201).send(result);
      } catch (err: unknown) {
        return mapServiceError(reply, err);
      }
    }
  );
};
