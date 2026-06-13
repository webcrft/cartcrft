/**
 * payments/routes.ts — Fastify plugin for payments, refunds, providers, gateways.
 *
 * Routes:
 *   GET    /commerce/stores/:storeId/orders/:orderId/payments                 — storeAuthWrite
 *   POST   /commerce/stores/:storeId/orders/:orderId/payments                 — storeAuthWrite
 *   POST   /commerce/stores/:storeId/orders/:orderId/payments/:paymentId/capture — storeAuthAdmin
 *   POST   /commerce/stores/:storeId/orders/:orderId/payments/:paymentId/refund  — storeAuthAdmin
 *   GET    /commerce/stores/:storeId/payment-providers                        — storeAuthAdmin
 *   POST   /commerce/stores/:storeId/payment-providers                        — storeAuthAdmin
 *   DELETE /commerce/stores/:storeId/payment-providers/:providerId            — storeAuthAdmin
 *   GET    /commerce/payment-gateways                                         — requireJwt + superToken
 *   POST   /commerce/payment-gateways                                         — requireJwt + superToken
 *   PUT    /commerce/payment-gateways/:gatewayId/dev-credentials              — requireJwt + superToken
 *   GET    /commerce/payment-gateway-status                                   — requireJwt
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  requireJwt,
  storeAuthWrite,
  storeAuthAdmin,
} from "../../lib/auth/middleware.js";
import { timingSafeCheckSuperToken } from "../../lib/auth/super-token.js";
import {
  listPayments,
  createPayment,
  capturePayment,
  createRefund,
  listProviders,
  upsertProvider,
  deleteProvider,
  listGateways,
  upsertGateway,
  setGatewayDevCredentials,
  getGatewayStatus,
} from "./service.js";

// ── Schemas ────────────────────────────────────────────────────────────────────

const StoreOrderParams = z.object({
  storeId: z.string().uuid(),
  orderId: z.string().uuid(),
});

const PaymentParams = z.object({
  storeId: z.string().uuid(),
  orderId: z.string().uuid(),
  paymentId: z.string().uuid(),
});

const StoreParams = z.object({
  storeId: z.string().uuid(),
});

const ProviderParams = z.object({
  storeId: z.string().uuid(),
  providerId: z.string().uuid(),
});

const GatewayParams = z.object({
  gatewayId: z.string().uuid(),
});

const CreatePaymentBody = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "amount must be a valid decimal string"),
  currency: z.string().length(3).optional(),
  provider_id: z.string().uuid().optional(),
  provider_reference: z.string().max(500).optional(),
  mode: z.enum(["live", "dev"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const CreateRefundBody = z.object({
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "amount must be a valid decimal string"),
  reason: z
    .enum(["customer_request", "defective", "not_received", "other"])
    .optional(),
  notes: z.string().max(16384).optional(),
  restock: z.boolean().optional(),
  provider_reference: z.string().max(500).optional(),
});

const UpsertProviderBody = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(200).optional(),
  type: z
    .enum(["webhook", "stripe", "paystack", "razorpay", "xendit"])
    .optional(),
  config: z.record(z.string(), z.unknown()),
  is_active: z.boolean().optional(),
  webhook_secret: z.string().max(500).optional(),
});

const UpsertGatewayBody = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["paystack", "stripe", "razorpay", "xendit", "flutterwave"]),
  secret_key_enc: z.string().min(1),
  public_key_enc: z.string().optional(),
  webhook_secret_enc: z.string().optional(),
  webhook_secret_secondary_enc: z.string().optional(),
  is_active: z.boolean().optional(),
});

const SetDevCredsBody = z.object({
  dev_secret_key_enc: z.string().min(1),
  dev_public_key_enc: z.string().optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const paymentsPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /commerce/stores/:storeId/orders/:orderId/payments ──────────────────
  app.get(
    "/commerce/stores/:storeId/orders/:orderId/payments",
    {
      preHandler: [storeAuthWrite],
      schema: { params: StoreOrderParams },
    },
    async (request, reply) => {
      const { orderId, storeId } = request.params as z.infer<typeof StoreOrderParams>;
      const payments = await listPayments(orderId, storeId);
      return reply.send({ payments });
    }
  );

  // ── POST /commerce/stores/:storeId/orders/:orderId/payments ─────────────────
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/payments",
    {
      preHandler: [storeAuthWrite],
      schema: { params: StoreOrderParams, body: CreatePaymentBody },
    },
    async (request, reply) => {
      const { orderId, storeId } = request.params as z.infer<typeof StoreOrderParams>;
      const data = request.body as z.infer<typeof CreatePaymentBody>;

      try {
        const result = await createPayment(orderId, storeId, data);
        return reply.status(201).send(result);
      } catch (err: unknown) {
        if (err instanceof Error) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "NOT_FOUND") {
            return reply
              .status(404)
              .send({ error: { code: "NOT_FOUND", message: err.message } });
          }
          if (code === "VALIDATION_ERROR") {
            return reply
              .status(400)
              .send({ error: { code: "VALIDATION_ERROR", message: err.message } });
          }
        }
        throw err;
      }
    }
  );

  // ── POST /commerce/stores/:storeId/orders/:orderId/payments/:paymentId/capture
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/payments/:paymentId/capture",
    {
      preHandler: [storeAuthAdmin],
      schema: { params: PaymentParams },
    },
    async (request, reply) => {
      const { paymentId, orderId, storeId } = request.params as z.infer<typeof PaymentParams>;
      const userId = request.auth?.userId;

      try {
        await capturePayment(paymentId, orderId, storeId, userId);
        return reply.send({ ok: true });
      } catch (err: unknown) {
        if (err instanceof Error) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "NOT_FOUND") {
            return reply
              .status(404)
              .send({ error: { code: "NOT_FOUND", message: err.message } });
          }
          if (code === "CONFLICT") {
            return reply
              .status(409)
              .send({ error: { code: "CONFLICT", message: err.message } });
          }
          if (code === "VALIDATION_ERROR") {
            return reply
              .status(400)
              .send({ error: { code: "VALIDATION_ERROR", message: err.message } });
          }
        }
        throw err;
      }
    }
  );

  // ── POST /commerce/stores/:storeId/orders/:orderId/payments/:paymentId/refund
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/payments/:paymentId/refund",
    {
      preHandler: [storeAuthAdmin],
      schema: { params: PaymentParams, body: CreateRefundBody },
    },
    async (request, reply) => {
      const { paymentId, orderId, storeId } = request.params as z.infer<typeof PaymentParams>;
      const data = request.body as z.infer<typeof CreateRefundBody>;
      const userId = request.auth?.userId;

      // Honor Idempotency-Key header: pass it to the service so duplicate
      // POSTs with the same key return the original refund.
      const idempotencyKeyHeader = request.headers["idempotency-key"];
      const idempotencyKey =
        typeof idempotencyKeyHeader === "string" && idempotencyKeyHeader.trim()
          ? idempotencyKeyHeader.trim()
          : undefined;

      try {
        const result = await createRefund(
          paymentId,
          orderId,
          storeId,
          { ...data, idempotency_key: idempotencyKey },
          userId
        );
        return reply.status(201).send(result);
      } catch (err: unknown) {
        if (err instanceof Error) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "NOT_FOUND") {
            return reply
              .status(404)
              .send({ error: { code: "NOT_FOUND", message: err.message } });
          }
          if (code === "VALIDATION_ERROR") {
            return reply
              .status(400)
              .send({ error: { code: "VALIDATION_ERROR", message: err.message } });
          }
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/payment-providers ─────────────────────────
  app.get(
    "/commerce/stores/:storeId/payment-providers",
    {
      preHandler: [storeAuthAdmin],
      schema: { params: StoreParams },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const providers = await listProviders(storeId);
      return reply.send({ providers });
    }
  );

  // ── POST /commerce/stores/:storeId/payment-providers ────────────────────────
  app.post(
    "/commerce/stores/:storeId/payment-providers",
    {
      preHandler: [storeAuthAdmin],
      schema: { params: StoreParams, body: UpsertProviderBody },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const data = request.body as z.infer<typeof UpsertProviderBody>;
      const id = await upsertProvider(storeId, data);
      return reply.status(201).send({ id });
    }
  );

  // ── DELETE /commerce/stores/:storeId/payment-providers/:providerId ──────────
  app.delete(
    "/commerce/stores/:storeId/payment-providers/:providerId",
    {
      preHandler: [storeAuthAdmin],
      schema: { params: ProviderParams },
    },
    async (request, reply) => {
      const { providerId, storeId } = request.params as z.infer<typeof ProviderParams>;
      const deleted = await deleteProvider(providerId, storeId);
      if (!deleted) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "provider not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/payment-gateways ──────────────────────────────────────────
  // Requires JWT + super-token
  app.get(
    "/commerce/payment-gateways",
    { preHandler: [requireJwt] },
    async (request, reply) => {
      const superToken = request.headers["x-super-token"];
      if (!timingSafeCheckSuperToken(typeof superToken === "string" ? superToken : undefined)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "super-admin access required" } });
      }
      const gateways = await listGateways();
      return reply.send({ gateways });
    }
  );

  // ── POST /commerce/payment-gateways ─────────────────────────────────────────
  app.post(
    "/commerce/payment-gateways",
    {
      preHandler: [requireJwt],
      schema: { body: UpsertGatewayBody },
    },
    async (request, reply) => {
      const superToken = request.headers["x-super-token"];
      if (!timingSafeCheckSuperToken(typeof superToken === "string" ? superToken : undefined)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "super-admin access required" } });
      }

      const data = request.body as z.infer<typeof UpsertGatewayBody>;
      const id = await upsertGateway(data);
      return reply.status(201).send({ id });
    }
  );

  // ── PUT /commerce/payment-gateways/:gatewayId/dev-credentials ───────────────
  app.put(
    "/commerce/payment-gateways/:gatewayId/dev-credentials",
    {
      preHandler: [requireJwt],
      schema: { params: GatewayParams, body: SetDevCredsBody },
    },
    async (request, reply) => {
      const superToken = request.headers["x-super-token"];
      if (!timingSafeCheckSuperToken(typeof superToken === "string" ? superToken : undefined)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "super-admin access required" } });
      }

      const { gatewayId } = request.params as z.infer<typeof GatewayParams>;
      const data = request.body as z.infer<typeof SetDevCredsBody>;

      const updated = await setGatewayDevCredentials(gatewayId, data);
      if (!updated) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "gateway not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/payment-gateway-status ────────────────────────────────────
  // Any authenticated JWT user can call this
  app.get(
    "/commerce/payment-gateway-status",
    { preHandler: [requireJwt] },
    async (_request, reply) => {
      const gateways = await getGatewayStatus();
      return reply.send({ gateways });
    }
  );
};
