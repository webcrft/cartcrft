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
    {
      preHandler: [storeAuthRead],
      schema: { params: StoreIdParams, body: CreateCartBody },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const data = request.body as z.infer<typeof CreateCartBody>;

      const cartId = await createCart(storeId, {
        ...(data.currency !== undefined && { currency: data.currency }),
        ...(data.customer_id !== undefined && { customerId: data.customer_id }),
      });
      return reply.status(201).send({ id: cartId });
    }
  );

  // ── GET /commerce/stores/:storeId/carts/:cartId ─────────────────────────
  app.get(
    "/commerce/stores/:storeId/carts/:cartId",
    {
      preHandler: [storeAuthRead],
      schema: { params: CartIdParams },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { cartId } = request.params as z.infer<typeof CartIdParams>;

      const cart = await getCart(storeId, cartId);
      if (!cart) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "cart not found" } });
      }
      return reply.send(cart);
    }
  );

  // ── POST /commerce/stores/:storeId/carts/:cartId/lines ──────────────────
  app.post(
    "/commerce/stores/:storeId/carts/:cartId/lines",
    {
      preHandler: [storeAuthRead],
      schema: { params: CartIdParams, body: AddCartLineBody },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { cartId } = request.params as z.infer<typeof CartIdParams>;
      const { variant_id, quantity } = request.body as z.infer<typeof AddCartLineBody>;

      try {
        const lineId = await addCartLine(storeId, cartId, variant_id, quantity);
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
    {
      preHandler: [storeAuthRead],
      schema: { params: CartLineParams, body: UpdateCartLineBody },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { cartId, lineId } = request.params as z.infer<typeof CartLineParams>;
      const { quantity } = request.body as z.infer<typeof UpdateCartLineBody>;

      try {
        await updateCartLine(storeId, cartId, lineId, quantity);
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
    {
      preHandler: [storeAuthRead],
      schema: { params: CartLineParams },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { cartId, lineId } = request.params as z.infer<typeof CartLineParams>;

      try {
        await removeCartLine(storeId, cartId, lineId);
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
    {
      preHandler: [storeAuthAdmin],
      schema: { params: StoreIdParams, querystring: ListQuerystring },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const q = request.query as z.infer<typeof ListQuerystring>;
      const carts = await listAbandonedCarts(storeId, {
        ...(q.limit !== undefined && { limit: q.limit }),
        ...(q.offset !== undefined && { offset: q.offset }),
      });
      return reply.send({ carts });
    }
  );

  // ── POST /commerce/stores/:storeId/abandoned-carts ─────────────────────
  app.post(
    "/commerce/stores/:storeId/abandoned-carts",
    {
      preHandler: [storeAuthWrite],
      schema: { params: StoreIdParams, body: MarkAbandonedBody },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { cart_id } = request.body as z.infer<typeof MarkAbandonedBody>;

      try {
        const recoveryToken = await markCartAbandoned(storeId, cart_id);
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
