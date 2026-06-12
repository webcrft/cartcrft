/**
 * engagement/routes.ts — Fastify plugin for wishlists and abandoned carts.
 *
 * Routes:
 *  Wishlists (admin/customer):
 *    GET    /commerce/stores/:storeId/wishlists
 *    POST   /commerce/stores/:storeId/wishlists
 *    GET    /commerce/stores/:storeId/wishlists/:wishlistId
 *    DELETE /commerce/stores/:storeId/wishlists/:wishlistId
 *    POST   /commerce/stores/:storeId/wishlists/:wishlistId/items
 *    DELETE /commerce/stores/:storeId/wishlists/:wishlistId/items/:itemId
 *  Public share token:
 *    GET    /storefront/:storeId/wishlists/:shareToken
 *  Abandoned carts:
 *    GET    /commerce/stores/:storeId/abandoned-carts  (admin)
 *    POST   /commerce/stores/:storeId/abandoned-carts/:cartId/recover  (admin)
 *
 * Note: product reviews are in catalog module (T2.2).
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthRead, storeAuthAdmin, storeAuthWrite } from "../../lib/auth/middleware.js";
import {
  listWishlists,
  getWishlist,
  getWishlistByShareToken,
  createWishlist,
  deleteWishlist,
  addWishlistItem,
  removeWishlistItem,
  markCartRecovered,
} from "./service.js";

const UUID = z.string().uuid();

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}
function badRequest(msg: string, code = "VALIDATION_ERROR") {
  return { error: { code, message: msg } };
}

export const engagementPlugin: FastifyPluginAsync = async (app) => {
  const storeParams = z.object({ storeId: UUID });

  // ── Wishlists (admin-scoped) ───────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/wishlists",
    { preHandler: storeAuthRead },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const query = z
        .object({ customer_id: UUID.optional() })
        .safeParse(request.query);
      const customerId = query.success ? query.data.customer_id : undefined;
      const wishlists = await listWishlists(params.data.storeId, customerId);
      return reply.send({ wishlists });
    }
  );

  app.post(
    "/commerce/stores/:storeId/wishlists",
    { preHandler: storeAuthRead },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const body = z
        .object({
          customer_id: UUID.optional().nullable(),
          session_id: z.string().optional().nullable(),
          name: z.string().optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));

      if (!body.data.customer_id && !body.data.session_id) {
        return reply.status(400).send(badRequest("customer_id or session_id required"));
      }

      const wl = await createWishlist(params.data.storeId, body.data);
      if (!wl) return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "failed to create wishlist" } });
      return reply.status(201).send(wl);
    }
  );

  app.get(
    "/commerce/stores/:storeId/wishlists/:wishlistId",
    { preHandler: storeAuthRead },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, wishlistId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const wl = await getWishlist(params.data.storeId, params.data.wishlistId);
      if (!wl) return reply.status(404).send(notFound("wishlist not found"));
      return reply.send(wl);
    }
  );

  app.delete(
    "/commerce/stores/:storeId/wishlists/:wishlistId",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, wishlistId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const ok = await deleteWishlist(params.data.storeId, params.data.wishlistId);
      if (!ok) return reply.status(404).send(notFound("wishlist not found"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/wishlists/:wishlistId/items",
    { preHandler: storeAuthRead },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, wishlistId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          product_id: UUID,
          variant_id: UUID.optional().nullable(),
          note: z.string().optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("product_id required"));

      const item = await addWishlistItem(
        params.data.storeId,
        params.data.wishlistId,
        body.data
      );
      if (!item) return reply.status(404).send(notFound("wishlist not found"));
      return reply.status(201).send(item);
    }
  );

  app.delete(
    "/commerce/stores/:storeId/wishlists/:wishlistId/items/:itemId",
    { preHandler: storeAuthRead },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, wishlistId: UUID, itemId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const ok = await removeWishlistItem(
        params.data.storeId,
        params.data.wishlistId,
        params.data.itemId
      );
      if (!ok) return reply.status(404).send(notFound("item not found"));
      return reply.send({ ok: true });
    }
  );

  // ── Public share token route ───────────────────────────────────────────────

  app.get(
    "/storefront/:storeId/wishlists/:shareToken",
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, shareToken: z.string().min(1) })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));

      const wl = await getWishlistByShareToken(
        params.data.storeId,
        params.data.shareToken
      );
      if (!wl) return reply.status(404).send(notFound("wishlist not found"));
      return reply.send(wl);
    }
  );

  // ── Abandoned carts (admin) ────────────────────────────────────────────────
  // Note: GET /abandoned-carts list is in carts module (T2.3). This module
  // only provides the recover action which T2.3 doesn't implement.

  app.post(
    "/commerce/stores/:storeId/abandoned-carts/:cartId/recover",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, cartId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({ order_id: UUID.optional().nullable() })
        .safeParse(request.body ?? {});
      const orderId = body.success ? body.data.order_id : undefined;
      const result = await markCartRecovered(
        params.data.storeId,
        params.data.cartId,
        orderId ?? undefined
      );
      if (!result) return reply.status(404).send(notFound("abandoned cart not found or already recovered"));
      return reply.send({ ok: true, recovered_at: result.recovered_at, recovery_order_id: result.recovery_order_id });
    }
  );
};
