/**
 * checkout/routes.ts — Fastify plugin for checkout sessions.
 *
 * Routes (all scoped to /commerce/stores/:storeId):
 *   POST  /checkouts                           — CreateCheckout (storeAuthRead)
 *   GET   /checkouts/:checkoutId               — GetCheckout (storeAuthRead)
 *   PUT   /checkouts/:checkoutId               — UpdateCheckout (storeAuthRead)
 *   POST  /checkouts/:checkoutId/complete      — CompleteCheckout (storeAuthRead)
 *   POST  /checkouts/:checkoutId/payment-session — InitiatePayment STUB 501 (storeAuthRead)
 *
 * The payment-session endpoint is stubbed with 501 PROVIDER_NOT_CONFIGURED
 * until T2.4 implements provider clients.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthRead } from "../../lib/auth/middleware.js";
import { createCheckout, getCheckout, updateCheckout } from "./service.js";
import { completeCheckout, CheckoutError } from "./complete.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreCheckoutParams = z.object({
  storeId: z.string().uuid(),
  checkoutId: z.string().uuid(),
});

const AddressSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  province_code: z.string().optional(),
  zip: z.string().optional(),
  country_code: z.string().optional(),
}).passthrough();

const ShippingRateSchema = z.object({
  id: z.string().uuid().optional(),
}).passthrough();

const CreateCheckoutBody = z.object({
  cart_id: z.string().uuid("cart_id must be a UUID"),
  customer_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  email: z.string().email().optional(),
  shipping_address: AddressSchema.optional(),
  billing_address: AddressSchema.optional(),
  shipping_rate: ShippingRateSchema.optional(),
  discount_code: z.string().optional(),
});

const UpdateCheckoutBody = z.object({
  email: z.string().email().optional(),
  shipping_address: AddressSchema.optional(),
  billing_address: AddressSchema.optional(),
  shipping_rate: ShippingRateSchema.optional(),
  discount_code: z.string().optional(),
}).partial();

// ── Plugin ────────────────────────────────────────────────────────────────────

export const checkoutPlugin: FastifyPluginAsync = async (app) => {

  // ── POST /commerce/stores/:storeId/checkouts ─────────────────────────────
  app.post(
    "/commerce/stores/:storeId/checkouts",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;

      const parsed = CreateCheckoutBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }

      try {
        const result = await createCheckout(storeId, {
          cart_id: parsed.data.cart_id,
          ...(parsed.data.customer_id !== undefined && { customer_id: parsed.data.customer_id }),
          ...(parsed.data.company_id !== undefined && { company_id: parsed.data.company_id }),
          ...(parsed.data.email !== undefined && { email: parsed.data.email }),
          ...(parsed.data.shipping_address !== undefined && { shipping_address: parsed.data.shipping_address as Record<string, unknown> }),
          ...(parsed.data.billing_address !== undefined && { billing_address: parsed.data.billing_address as Record<string, unknown> }),
          ...(parsed.data.shipping_rate !== undefined && { shipping_rate: parsed.data.shipping_rate as Record<string, unknown> }),
          ...(parsed.data.discount_code !== undefined && { discount_code: parsed.data.discount_code }),
        });
        return reply.status(201).send(result);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        if (code === "VALIDATION_ERROR") {
          return reply.status(422).send({ error: { code: "VALIDATION_ERROR", message: (err as Error).message } });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/checkouts/:checkoutId ──────────────────
  app.get(
    "/commerce/stores/:storeId/checkouts/:checkoutId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreCheckoutParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const checkout = await getCheckout(storeId, params.data.checkoutId);
      if (!checkout) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "checkout not found" } });
      }
      return reply.send(checkout);
    }
  );

  // ── PUT /commerce/stores/:storeId/checkouts/:checkoutId ──────────────────
  app.put(
    "/commerce/stores/:storeId/checkouts/:checkoutId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreCheckoutParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const parsed = UpdateCheckoutBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }

      try {
        const result = await updateCheckout(storeId, params.data.checkoutId, {
          ...(parsed.data.email !== undefined && { email: parsed.data.email }),
          ...(parsed.data.shipping_address !== undefined && { shipping_address: parsed.data.shipping_address as Record<string, unknown> }),
          ...(parsed.data.billing_address !== undefined && { billing_address: parsed.data.billing_address as Record<string, unknown> }),
          ...(parsed.data.shipping_rate !== undefined && { shipping_rate: parsed.data.shipping_rate as Record<string, unknown> }),
          ...(parsed.data.discount_code !== undefined && { discount_code: parsed.data.discount_code }),
        });
        return reply.send(result);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        if (code === "VALIDATION_ERROR") {
          return reply.status(422).send({ error: { code: "VALIDATION_ERROR", message: (err as Error).message } });
        }
        throw err;
      }
    }
  );

  // ── POST /commerce/stores/:storeId/checkouts/:checkoutId/complete ────────
  app.post(
    "/commerce/stores/:storeId/checkouts/:checkoutId/complete",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreCheckoutParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      try {
        const result = await completeCheckout(storeId, params.data.checkoutId);
        return reply.send({
          order_id: result.orderId,
          order_number: result.orderNumber,
        });
      } catch (err: unknown) {
        if (err instanceof CheckoutError) {
          switch (err.code) {
            case "NOT_FOUND":
              return reply.status(404).send({ error: { code: "NOT_FOUND", message: err.message } });
            case "DISCOUNT_EXHAUSTED":
              return reply.status(409).send({ error: { code: "DISCOUNT_EXHAUSTED", message: err.message } });
            case "DISCOUNT_ALREADY_USED":
              return reply.status(409).send({ error: { code: "DISCOUNT_ALREADY_USED", message: err.message } });
            case "INSUFFICIENT_INVENTORY":
              return reply.status(409).send({ error: { code: "INSUFFICIENT_INVENTORY", message: err.message } });
          }
        }
        throw err;
      }
    }
  );

  // ── POST /commerce/stores/:storeId/checkouts/:checkoutId/payment-session ──
  // STUB: returns 501 until T2.4 implements provider clients.
  app.post(
    "/commerce/stores/:storeId/checkouts/:checkoutId/payment-session",
    { preHandler: [storeAuthRead] },
    async (_request, reply) => {
      return reply.status(501).send({
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message: "Payment provider integration not yet configured. See T2.4.",
        },
      });
    }
  );
};
