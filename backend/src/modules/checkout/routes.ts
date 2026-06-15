/**
 * checkout/routes.ts — Fastify plugin for checkout sessions.
 *
 * Routes (all scoped to /commerce/stores/:storeId):
 *   POST  /checkouts                           — CreateCheckout (storeAuthRead)
 *   GET   /checkouts/:checkoutId               — GetCheckout (storeAuthRead)
 *   PUT   /checkouts/:checkoutId               — UpdateCheckout (storeAuthRead)
 *   POST  /checkouts/:checkoutId/complete      — CompleteCheckout (storeAuthRead)
 *   POST  /checkouts/:checkoutId/payment-session — InitiatePayment (storeAuthRead)
 *
 * The payment-session endpoint resolves the store's active payment provider
 * from payment_providers (first active by position), calls the matching
 * session creator, persists the result in checkouts.payment_session, and
 * returns the provider-shaped payload.  Returns 501 PROVIDER_NOT_CONFIGURED
 * only when no active provider exists.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthRead } from "../../lib/auth/middleware.js";
import { createCheckout, getCheckout, updateCheckout } from "./service.js";
import { completeCheckout, CheckoutError } from "./complete.js";
import { getPool } from "../../db/pool.js";
import {
  createStripeSession,
  createPaystackSession,
  createRazorpaySession,
  createXenditSession,
} from "../payments/service.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreIdParams = z.object({
  storeId: z.string().uuid(),
});

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
    {
      preHandler: [storeAuthRead],
      schema: { params: StoreIdParams, body: CreateCheckoutBody },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const data = request.body as z.infer<typeof CreateCheckoutBody>;

      try {
        const result = await createCheckout(storeId, {
          cart_id: data.cart_id,
          ...(data.customer_id !== undefined && { customer_id: data.customer_id }),
          ...(data.company_id !== undefined && { company_id: data.company_id }),
          ...(data.email !== undefined && { email: data.email }),
          ...(data.shipping_address !== undefined && { shipping_address: data.shipping_address as Record<string, unknown> }),
          ...(data.billing_address !== undefined && { billing_address: data.billing_address as Record<string, unknown> }),
          ...(data.shipping_rate !== undefined && { shipping_rate: data.shipping_rate as Record<string, unknown> }),
          ...(data.discount_code !== undefined && { discount_code: data.discount_code }),
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
    {
      preHandler: [storeAuthRead],
      schema: { params: StoreCheckoutParams },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { checkoutId } = request.params as z.infer<typeof StoreCheckoutParams>;

      const checkout = await getCheckout(storeId, checkoutId);
      if (!checkout) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "checkout not found" } });
      }
      return reply.send(checkout);
    }
  );

  // ── PUT /commerce/stores/:storeId/checkouts/:checkoutId ──────────────────
  app.put(
    "/commerce/stores/:storeId/checkouts/:checkoutId",
    {
      preHandler: [storeAuthRead],
      schema: { params: StoreCheckoutParams, body: UpdateCheckoutBody },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { checkoutId } = request.params as z.infer<typeof StoreCheckoutParams>;
      const data = request.body as z.infer<typeof UpdateCheckoutBody>;

      try {
        const result = await updateCheckout(storeId, checkoutId, {
          ...(data.email !== undefined && { email: data.email }),
          ...(data.shipping_address !== undefined && { shipping_address: data.shipping_address as Record<string, unknown> }),
          ...(data.billing_address !== undefined && { billing_address: data.billing_address as Record<string, unknown> }),
          ...(data.shipping_rate !== undefined && { shipping_rate: data.shipping_rate as Record<string, unknown> }),
          ...(data.discount_code !== undefined && { discount_code: data.discount_code }),
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
    {
      preHandler: [storeAuthRead],
      schema: { params: StoreCheckoutParams },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { checkoutId } = request.params as z.infer<typeof StoreCheckoutParams>;

      try {
        // Pass agentCtx (set by agentAttributionHook in app.ts) so
        // completeCheckout can enforce spend limits and mandate chains.
        const result = await completeCheckout(storeId, checkoutId, request.agentCtx);
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
            case "MANDATE_SPEND_LIMIT_EXCEEDED":
              return reply.status(402).send({ error: { code: "MANDATE_SPEND_LIMIT_EXCEEDED", message: err.message } });
            case "MANDATE_REQUIRED":
              return reply.status(402).send({ error: { code: "MANDATE_REQUIRED", message: err.message } });
            case "CREDIT_LIMIT_EXCEEDED":
              return reply.status(422).send({ error: { code: "CREDIT_LIMIT_EXCEEDED", message: err.message } });
          }
        }
        throw err;
      }
    }
  );

  // ── POST /commerce/stores/:storeId/checkouts/:checkoutId/payment-session ──
  app.post(
    "/commerce/stores/:storeId/checkouts/:checkoutId/payment-session",
    {
      preHandler: [storeAuthRead],
      schema: { params: StoreCheckoutParams },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { checkoutId } = request.params as z.infer<typeof StoreCheckoutParams>;

      // ── 1. Load the checkout ──────────────────────────────────────────────
      const pool = getPool();
      const { rows: coRows } = await pool.query<{
        id: string;
        total: string;
        currency: string;
        email: string | null;
        status: string;
      }>(
        `SELECT id::text, total::text, currency, email, status
         FROM checkouts
         WHERE id = $1::uuid AND store_id = $2::uuid`,
        [checkoutId, storeId]
      );

      if (!coRows[0]) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Checkout not found" },
        });
      }

      const checkout = coRows[0];
      if (checkout.status !== "pending") {
        return reply.status(409).send({
          error: { code: "CHECKOUT_NOT_PENDING", message: "Checkout is not in pending state" },
        });
      }

      // ── 2. Resolve the store's first active payment provider ──────────────
      const { rows: provRows } = await pool.query<{
        id: string;
        type: string;
        slug: string | null;
      }>(
        `SELECT id::text, type, slug
         FROM payment_providers
         WHERE store_id = $1::uuid AND is_active = true
         ORDER BY position ASC, created_at ASC
         LIMIT 1`,
        [storeId]
      );

      if (!provRows[0]) {
        return reply.status(501).send({
          error: {
            code: "PROVIDER_NOT_CONFIGURED",
            message: "No active payment provider configured for this store.",
          },
        });
      }

      const provider = provRows[0];
      const totalAmount = parseFloat(checkout.total);
      const currency = checkout.currency;
      const email = checkout.email ?? undefined;

      // ── 3. Create provider session and build response payload ─────────────
      let sessionData: Record<string, unknown>;

      try {
        switch (provider.type) {
          case "stripe": {
            // Stripe: amount in cents (integer)
            const amountCents = Math.round(totalAmount * 100);
            const result = await createStripeSession(storeId, checkoutId, amountCents, currency, email);
            sessionData = {
              provider: "stripe",
              client_secret: result.clientSecret,
              payment_intent_id: result.paymentIntentId,
            };
            break;
          }
          case "paystack": {
            // Paystack: amount in kobo/cents (smallest unit, integer)
            const amountKobo = Math.round(totalAmount * 100);
            const paystackEmail = email ?? "";
            if (!paystackEmail) {
              return reply.status(422).send({
                error: { code: "VALIDATION_ERROR", message: "Paystack requires a customer email on the checkout" },
              });
            }
            const result = await createPaystackSession(storeId, checkoutId, amountKobo, currency, paystackEmail);
            sessionData = {
              provider: "paystack",
              authorization_url: result.authorizationUrl,
              reference: result.reference,
            };
            break;
          }
          case "razorpay": {
            // Razorpay: amount in smallest unit (paise for INR), integer
            const amountSmallest = Math.round(totalAmount * 100);
            const result = await createRazorpaySession(storeId, checkoutId, amountSmallest, currency);
            // P2-15: use JSONB ->> operator to extract only key_id (avoids fetching full config object).
            const { rows: cfgRows } = await pool.query<{ key_id: string | null }>(
              `SELECT config->>'key_id' AS key_id FROM payment_providers WHERE id = $1::uuid`,
              [provider.id]
            );
            sessionData = {
              provider: "razorpay",
              order_id: result.razorpayOrderId,
              amount: result.amount,
              currency: result.currency,
              key_id: cfgRows[0]?.key_id ?? "",
            };
            break;
          }
          case "xendit": {
            // Xendit: amount in full currency units (NOT cents)
            const result = await createXenditSession(storeId, checkoutId, totalAmount, currency, email);
            sessionData = {
              provider: "xendit",
              invoice_url: result.invoiceUrl,
              invoice_id: result.invoiceId,
            };
            break;
          }
          default: {
            // custom / webhook-only providers — no client-side session
            return reply.status(501).send({
              error: {
                code: "PROVIDER_NOT_CONFIGURED",
                message: `Provider type '${provider.type}' does not support client-side payment sessions.`,
              },
            });
          }
        }
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "PROVIDER_NOT_CONFIGURED") {
          return reply.status(501).send({
            error: { code: "PROVIDER_NOT_CONFIGURED", message: (err as Error).message },
          });
        }
        throw err;
      }

      // ── 4. Persist session data into checkouts.payment_session ────────────
      await pool.query(
        `UPDATE checkouts SET payment_session = $1::jsonb, updated_at = now()
         WHERE id = $2::uuid AND store_id = $3::uuid`,
        [JSON.stringify(sessionData), checkoutId, storeId]
      );

      // ── 5. Return provider-shaped response ────────────────────────────────
      return reply.status(200).send(sessionData);
    }
  );
};
