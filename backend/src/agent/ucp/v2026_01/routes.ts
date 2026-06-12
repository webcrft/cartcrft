/**
 * UCP 2026-01 — Fastify plugin for versioned UCP endpoints.
 *
 * Routes are relative (no /ucp prefix) — the parent ucpPlugin registers
 * this under /ucp (unversioned) and /ucp/v2026-01 (explicit version).
 *
 * Effective endpoints (with parent prefix):
 *   GET   /ucp/:storeId/catalog                  — paginated product entities
 *   GET   /ucp/:storeId/catalog/:productId        — single product (all variants)
 *   POST  /ucp/:storeId/checkout                 — create checkout entity
 *   PATCH /ucp/:storeId/checkout/:checkoutId     — update buyer/address/fulfillment
 *   POST  /ucp/:storeId/checkout/:checkoutId/submit — submit checkout → order
 *
 * Auth: cc_pub_ or cc_prv_ with commerce:read (storeAuthRead).
 * UCP-Version: "2026-01" response header on all responses.
 *
 * Spec version: 2026-01 NRF baseline, provisional.
 */

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { storeAuthRead } from "../../../lib/auth/middleware.js";
import { getUcpCatalog, getUcpProduct } from "./catalog.js";
import {
  createUcpCheckout,
  getUcpCheckout,
  updateUcpCheckout,
  submitUcpCheckout,
  UcpError,
  type CreateCheckoutInput,
  type UpdateCheckoutInput,
  type SubmitCheckoutInput,
} from "./checkout.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreIdParams = z.object({
  storeId: z.string().uuid(),
});

const ProductParams = z.object({
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
});

const CheckoutParams = z.object({
  storeId: z.string().uuid(),
  checkoutId: z.string().uuid(),
});

const CatalogQuerystring = z.object({
  page: z.coerce.number().int().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(250).optional(),
});

const AddressSchema = z
  .object({
    name: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    address1: z.string().optional(),
    address2: z.string().optional(),
    city: z.string().optional(),
    state_or_province: z.string().optional(),
    postal_code: z.string().optional(),
    country_code: z.string().length(2).optional(),
  })
  .passthrough();

const LineItemSchema = z.object({
  variant_id: z.string().uuid("variant_id must be a UUID"),
  quantity: z.number().int().min(1).max(10000),
  unit_price: z.string().optional(),
});

const BuyerSchema = z.object({
  email: z.string().email().optional(),
  shipping_address: AddressSchema.optional(),
  billing_address: AddressSchema.optional(),
});

const CreateCheckoutBody = z.object({
  line_items: z.array(LineItemSchema).min(1, "line_items must not be empty"),
  buyer: BuyerSchema.optional(),
  selected_fulfillment_id: z.string().uuid().optional(),
});

const UpdateCheckoutBody = z.object({
  buyer: BuyerSchema.optional(),
  selected_fulfillment_id: z.string().uuid().optional(),
});

const SubmitCheckoutBody = z.object({
  payment_token: z.string().optional(),
  mode: z.enum(["test", "live"]).optional(),
});

// ── Helper — map UcpError to HTTP response ────────────────────────────────────

function sendUcpError(reply: FastifyReply, err: unknown): ReturnType<FastifyReply["send"]> {
  if (err instanceof UcpError) {
    const body: Record<string, unknown> = {
      error: {
        code: err.code,
        message: err.message,
      },
    };
    if (err.field) {
      (body["error"] as Record<string, unknown>)["field"] = err.field;
    }
    return reply.status(err.httpStatus).send(body);
  }
  throw err;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const ucpV2026_01Plugin: FastifyPluginAsync = async (app) => {
  // UCP-Version header on all responses from this plugin scope
  app.addHook("onSend", async (_req, reply) => {
    void reply.header("UCP-Version", "2026-01");
  });

  // ── GET /:storeId/catalog ──────────────────────────────────────────────────
  app.get(
    "/:storeId/catalog",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: StoreIdParams,
        querystring: CatalogQuerystring,
      },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreIdParams>;
      const { page, page_size } = request.query as z.infer<typeof CatalogQuerystring>;

      try {
        const catalog = await getUcpCatalog(storeId, page, page_size);
        return reply.send(catalog);
      } catch (err) {
        return sendUcpError(reply, err);
      }
    }
  );

  // ── GET /:storeId/catalog/:productId ───────────────────────────────────────
  app.get(
    "/:storeId/catalog/:productId",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: ProductParams,
      },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;

      try {
        const result = await getUcpProduct(storeId, productId);
        if (!result) {
          return reply.status(404).send({
            error: { code: "ENTITY_NOT_FOUND", message: "Product not found" },
          });
        }
        return reply.send(result);
      } catch (err) {
        return sendUcpError(reply, err);
      }
    }
  );

  // ── POST /:storeId/checkout — create ──────────────────────────────────────
  app.post(
    "/:storeId/checkout",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: StoreIdParams,
        body: CreateCheckoutBody,
      },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreIdParams>;
      const body = request.body as CreateCheckoutInput;
      const idempotencyKeyValue = request.headers["idempotency-key"] as string | undefined;

      try {
        const checkout = await createUcpCheckout(storeId, body, idempotencyKeyValue);
        return reply.status(201).send({ checkout });
      } catch (err) {
        return sendUcpError(reply, err);
      }
    }
  );

  // ── PATCH /:storeId/checkout/:checkoutId — update ─────────────────────────
  app.patch(
    "/:storeId/checkout/:checkoutId",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: CheckoutParams,
        body: UpdateCheckoutBody,
      },
    },
    async (request, reply) => {
      const { storeId, checkoutId } = request.params as z.infer<typeof CheckoutParams>;
      const body = request.body as UpdateCheckoutInput;

      try {
        const checkout = await updateUcpCheckout(storeId, checkoutId, body);
        return reply.send({ checkout });
      } catch (err) {
        return sendUcpError(reply, err);
      }
    }
  );

  // ── POST /:storeId/checkout/:checkoutId/submit ────────────────────────────
  app.post(
    "/:storeId/checkout/:checkoutId/submit",
    {
      preHandler: [storeAuthRead],
      schema: {
        params: CheckoutParams,
        body: SubmitCheckoutBody,
      },
    },
    async (request, reply) => {
      const { storeId, checkoutId } = request.params as z.infer<typeof CheckoutParams>;
      const body = request.body as SubmitCheckoutInput;
      const idempotencyKeyValue = request.headers["idempotency-key"] as string | undefined;

      try {
        const result = await submitUcpCheckout(storeId, checkoutId, body, idempotencyKeyValue);
        return reply.send({
          checkout: result.checkout,
          order_reference: {
            order_id: result.orderId,
            order_number: result.orderNumber,
          },
        });
      } catch (err) {
        return sendUcpError(reply, err);
      }
    }
  );
};
