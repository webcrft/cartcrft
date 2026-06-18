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

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
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

// ── Shared param schemas ──────────────────────────────────────────────────────

const StoreParams = z.object({ storeId: UUID });
const WishlistParams = z.object({ storeId: UUID, wishlistId: UUID });
const WishlistItemParams = z.object({ storeId: UUID, wishlistId: UUID, itemId: UUID });
const ShareTokenParams = z.object({ storeId: UUID, shareToken: z.string().min(1) });
const AbandonedCartParams = z.object({ storeId: UUID, cartId: UUID });

// ── Shared body / querystring schemas ─────────────────────────────────────────

const ListWishlistsQuerystring = z.object({ customer_id: UUID.optional() });

const CreateWishlistBody = z.object({
  customer_id: UUID.optional().nullable(),
  session_id: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
});

const AddWishlistItemBody = z.object({
  product_id: UUID,
  variant_id: UUID.optional().nullable(),
  note: z.string().optional().nullable(),
});

const RecoverCartBody = z.object({ order_id: UUID.optional().nullable() });

// ── Plugin ────────────────────────────────────────────────────────────────────

export const engagementPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── Wishlists (admin-scoped) ───────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/wishlists",
    { preHandler: storeAuthRead("engagement"), schema: { params: StoreParams, querystring: ListWishlistsQuerystring } },
    async (request, reply) => {
      const customerId = request.query.customer_id;
      const wishlists = await listWishlists(request.params.storeId, customerId);
      return reply.send({ wishlists });
    }
  );

  app.post(
    "/commerce/stores/:storeId/wishlists",
    { preHandler: storeAuthRead("engagement"), schema: { params: StoreParams, body: CreateWishlistBody } },
    async (request, reply) => {
      if (!request.body.customer_id && !request.body.session_id) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "customer_id or session_id required" } });
      }

      const wl = await createWishlist(request.params.storeId, request.body);
      if (!wl) return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "failed to create wishlist" } });
      return reply.status(201).send(wl);
    }
  );

  app.get(
    "/commerce/stores/:storeId/wishlists/:wishlistId",
    { preHandler: storeAuthRead("engagement"), schema: { params: WishlistParams } },
    async (request, reply) => {
      const wl = await getWishlist(request.params.storeId, request.params.wishlistId);
      if (!wl) return reply.status(404).send(notFound("wishlist not found"));
      return reply.send(wl);
    }
  );

  app.delete(
    "/commerce/stores/:storeId/wishlists/:wishlistId",
    { preHandler: storeAuthWrite("engagement"), schema: { params: WishlistParams } },
    async (request, reply) => {
      const ok = await deleteWishlist(request.params.storeId, request.params.wishlistId);
      if (!ok) return reply.status(404).send(notFound("wishlist not found"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/wishlists/:wishlistId/items",
    { preHandler: storeAuthRead("engagement"), schema: { params: WishlistParams, body: AddWishlistItemBody } },
    async (request, reply) => {
      const item = await addWishlistItem(
        request.params.storeId,
        request.params.wishlistId,
        request.body
      );
      if (!item) return reply.status(404).send(notFound("wishlist not found"));
      return reply.status(201).send(item);
    }
  );

  app.delete(
    "/commerce/stores/:storeId/wishlists/:wishlistId/items/:itemId",
    { preHandler: storeAuthRead("engagement"), schema: { params: WishlistItemParams } },
    async (request, reply) => {
      const ok = await removeWishlistItem(
        request.params.storeId,
        request.params.wishlistId,
        request.params.itemId
      );
      if (!ok) return reply.status(404).send(notFound("item not found"));
      return reply.send({ ok: true });
    }
  );

  // ── Public share token route ───────────────────────────────────────────────

  app.get(
    "/storefront/:storeId/wishlists/:shareToken",
    { schema: { params: ShareTokenParams } },
    async (request, reply) => {
      const wl = await getWishlistByShareToken(
        request.params.storeId,
        request.params.shareToken
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
    // Body is optional (order_id only); thin safeParse to handle missing body gracefully
    { preHandler: storeAuthAdmin("engagement"), schema: { params: AbandonedCartParams } },
    async (request, reply) => {
      const body = RecoverCartBody.safeParse(request.body ?? {});
      const orderId = body.success ? (body.data.order_id ?? undefined) : undefined;
      const result = await markCartRecovered(
        request.params.storeId,
        request.params.cartId,
        orderId
      );
      if (!result) return reply.status(404).send(notFound("abandoned cart not found or already recovered"));
      return reply.send({ ok: true, recovered_at: result.recovered_at, recovery_order_id: result.recovery_order_id });
    }
  );
};
