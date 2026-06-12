/**
 * carts/routes.ts — Fastify plugin for cart CRUD.
 *
 * Routes (all scoped to /commerce/stores/:storeId):
 *   POST   /carts                         — CreateCart (storeAuthRead)
 *   GET    /carts/:cartId                 — GetCart (storeAuthRead)
 *   POST   /carts/:cartId/lines           — AddCartLine (storeAuthRead)
 *   PATCH  /carts/:cartId/lines/:lineId   — UpdateCartLine (storeAuthRead)
 *   DELETE /carts/:cartId/lines/:lineId   — RemoveCartLine (storeAuthRead)
 *   GET    /abandoned-carts               — ListAbandonedCarts (storeAuthAdmin)
 *   POST   /abandoned-carts               — MarkCartAbandoned (storeAuthWrite)
 *
 * IDOR protection: storeId from request.auth (set by auth middleware) is always
 * used for DB lookups — never from the URL alone.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthRead, storeAuthWrite, storeAuthAdmin } from "../../lib/auth/middleware.js";
import {
  createCart,
  getCart,
  addCartLine,
  updateCartLine,
  removeCartLine,
  listAbandonedCarts,
  markCartAbandoned,
} from "./service.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreIdParams = z.object({
  storeId: z.string().uuid(),
});

const CartIdParams = z.object({
  storeId: z.string().uuid(),
  cartId: z.string().uuid(),
});

const CartLineParams = z.object({
  storeId: z.string().uuid(),
  cartId: z.string().uuid(),
  lineId: z.string().uuid(),
});

const CreateCartBody = z.object({
  currency: z.string().length(3).optional(),
  customer_id: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const AddCartLineBody = z.object({
  variant_id: z.string().uuid("variant_id must be a UUID"),
  quantity: z.number().int().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateCartLineBody = z.object({
  quantity: z.number().int(),
});

const ListQuerystring = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const MarkAbandonedBody = z.object({
  cart_id: z.string().uuid("cart_id must be a UUID"),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const cartsPlugin: FastifyPluginAsync = async (app) => {

  // ── POST /commerce/stores/:storeId/carts ────────────────────────────────
  app.post(
    "/commerce/stores/:storeId/carts",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;

      const parsed = CreateCartBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }

      const cartId = await createCart(storeId, {
        ...(parsed.data.currency !== undefined && { currency: parsed.data.currency }),
        ...(parsed.data.customer_id !== undefined && { customerId: parsed.data.customer_id }),
      });
      return reply.status(201).send({ id: cartId });
    }
  );

  // ── GET /commerce/stores/:storeId/carts/:cartId ─────────────────────────
  app.get(
    "/commerce/stores/:storeId/carts/:cartId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = CartIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const cart = await getCart(storeId, params.data.cartId);
      if (!cart) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "cart not found" } });
      }
      return reply.send(cart);
    }
  );

  // ── POST /commerce/stores/:storeId/carts/:cartId/lines ──────────────────
  app.post(
    "/commerce/stores/:storeId/carts/:cartId/lines",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = CartIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const parsed = AddCartLineBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }

      try {
        const lineId = await addCartLine(
          storeId,
          params.data.cartId,
          parsed.data.variant_id,
          parsed.data.quantity
        );
        return reply.status(201).send({ id: lineId });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        if (code === "VALIDATION_ERROR") {
          return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: (err as Error).message } });
        }
        throw err;
      }
    }
  );

  // ── PATCH /commerce/stores/:storeId/carts/:cartId/lines/:lineId ─────────
  app.patch(
    "/commerce/stores/:storeId/carts/:cartId/lines/:lineId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = CartLineParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const parsed = UpdateCartLineBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }

      try {
        await updateCartLine(
          storeId,
          params.data.cartId,
          params.data.lineId,
          parsed.data.quantity
        );
        return reply.send({ ok: true });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        if (code === "VALIDATION_ERROR") {
          return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: (err as Error).message } });
        }
        throw err;
      }
    }
  );

  // ── DELETE /commerce/stores/:storeId/carts/:cartId/lines/:lineId ────────
  app.delete(
    "/commerce/stores/:storeId/carts/:cartId/lines/:lineId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = CartLineParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      try {
        await removeCartLine(storeId, params.data.cartId, params.data.lineId);
        return reply.send({ ok: true });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/abandoned-carts ───────────────────────
  app.get(
    "/commerce/stores/:storeId/abandoned-carts",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const query = ListQuerystring.safeParse(request.query);
      const carts = await listAbandonedCarts(storeId, {
        ...(query.success && query.data.limit !== undefined && { limit: query.data.limit }),
        ...(query.success && query.data.offset !== undefined && { offset: query.data.offset }),
      });
      return reply.send({ carts });
    }
  );

  // ── POST /commerce/stores/:storeId/abandoned-carts ─────────────────────
  app.post(
    "/commerce/stores/:storeId/abandoned-carts",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      const parsed = MarkAbandonedBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "cart_id is required", details: parsed.error.issues },
        });
      }

      try {
        const recoveryToken = await markCartAbandoned(storeId, parsed.data.cart_id);
        return reply.send({ ok: true, recovery_token: recoveryToken });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        throw err;
      }
    }
  );
};
