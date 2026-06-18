/**
 * recovery/routes.ts — Abandoned-cart recovery endpoints.
 *
 * Public:
 *   GET /storefront/:storeId/cart/recover/:token
 *     → returns the cart (items summary); does NOT auto-mark recovered — that
 *       happens at checkout complete. Marks the carts row status='active' so
 *       the customer can resume.
 *
 * Admin:
 *   POST /commerce/stores/:storeId/abandoned-carts/:abandonedCartId/resend
 *     → resend the recovery email for an existing abandoned_carts row.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin } from "../../lib/auth/middleware.js";
import {
  getCartByRecoveryToken,
  resendRecoveryEmail,
} from "./service.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const RecoverParams = z.object({
  storeId: z.string().uuid(),
  token: z.string().min(1),
});

const ResendParams = z.object({
  storeId: z.string().uuid(),
  abandonedCartId: z.string().uuid(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const recoveryPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /storefront/:storeId/cart/recover/:token ──────────────────────────
  // Public endpoint — no auth required. The recovery token IS the auth.
  app.get(
    "/storefront/:storeId/cart/recover/:token",
    async (request, reply) => {
      const params = RecoverParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const cart = await getCartByRecoveryToken(
        params.data.storeId,
        params.data.token
      );
      if (!cart) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "recovery token not found or expired" },
        });
      }

      return reply.send({ cart });
    }
  );

  // ── POST /commerce/stores/:storeId/abandoned-carts/:abandonedCartId/resend ─
  app.post(
    "/commerce/stores/:storeId/abandoned-carts/:abandonedCartId/resend",
    { preHandler: [storeAuthAdmin("recovery")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = ResendParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      try {
        const result = await resendRecoveryEmail(
          storeId,
          params.data.abandonedCartId
        );
        if (!result.ok) {
          return reply.status(422).send({
            error: { code: "RESEND_FAILED", message: result.message },
          });
        }
        return reply.send({ ok: true, message: result.message });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({
            error: { code: "NOT_FOUND", message: (err as Error).message },
          });
        }
        throw err;
      }
    }
  );
};
