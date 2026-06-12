/**
 * wallet/routes.ts — Fastify plugin for store credits + gift cards.
 *
 * Store credits (auth=admin):
 *   GET  /commerce/stores/:storeId/customers/:customerId/credits              — GetCustomerCredits
 *   POST /commerce/stores/:storeId/customers/:customerId/credits/issue        — IssueStoreCredit
 *   POST /commerce/stores/:storeId/customers/:customerId/credits/adjust       — AdjustStoreCredit
 *   GET  /commerce/stores/:storeId/customers/:customerId/credits/transactions — ListStoreCreditTransactions
 *
 * Gift cards (auth=admin except lookup=read):
 *   GET  /commerce/stores/:storeId/gift-cards                      — ListGiftCards
 *   POST /commerce/stores/:storeId/gift-cards                      — CreateGiftCard
 *   GET  /commerce/stores/:storeId/gift-cards/lookup               — LookupGiftCard (read)
 *   GET  /commerce/stores/:storeId/gift-cards/:giftCardId          — GetGiftCard
 *   POST /commerce/stores/:storeId/gift-cards/:giftCardId/disable  — DisableGiftCard
 *
 * NOTE: /gift-cards/lookup is registered BEFORE /gift-cards/:giftCardId to
 * prevent Fastify from interpreting "lookup" as a giftCardId param.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin, storeAuthRead } from "../../lib/auth/middleware.js";
import {
  getCustomerCredits,
  issueStoreCredit,
  adjustStoreCredit,
  listStoreCreditTransactions,
  listGiftCards,
  createGiftCard,
  lookupGiftCard,
  getGiftCard,
  disableGiftCard,
} from "./service.js";

// ── Zod schemas ────────────────────────────────────────────────────────────────

const StoreCustomerParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
  customerId: z.string().uuid("customerId must be a UUID"),
});

const StoreParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
});

const GiftCardIdParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
  giftCardId: z.string().uuid("giftCardId must be a UUID"),
});

const ListQuerystring = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
});

const IssueCreditBody = z.object({
  currency: z.string().length(3, "currency must be 3 characters"),
  amount: z.string().min(1, "amount is required"),
  notes: z.string().max(500).optional(),
  created_by: z.string().uuid().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  order_id: z.string().uuid().nullable().optional(),
});

const AdjustCreditBody = z.object({
  currency: z.string().length(3, "currency must be 3 characters"),
  delta: z.string().min(1, "delta is required"),
  notes: z.string().max(500).optional(),
  created_by: z.string().uuid().nullable().optional(),
  order_id: z.string().uuid().nullable().optional(),
});

const CreateGiftCardBody = z.object({
  code: z.string().min(1, "code is required").max(100),
  initial_value: z.string().min(1, "initial_value is required"),
  currency: z.string().length(3, "currency must be 3 characters"),
  issued_to: z.string().uuid().nullable().optional(),
  issued_by_order_id: z.string().uuid().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
});

const LookupQuerystring = z.object({
  code: z.string().min(1, "code is required"),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const walletPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /commerce/stores/:storeId/customers/:customerId/credits ───────────
  app.get(
    "/commerce/stores/:storeId/customers/:customerId/credits",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreCustomerParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }
      const query = ListQuerystring.safeParse(request.query);
      const currency = query.success ? query.data.currency : undefined;

      const credits = await getCustomerCredits(
        params.data.storeId,
        params.data.customerId,
        currency
      );
      return reply.send({ credits });
    }
  );

  // ── POST /commerce/stores/:storeId/customers/:customerId/credits/issue ────
  app.post(
    "/commerce/stores/:storeId/customers/:customerId/credits/issue",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreCustomerParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const parsed = IssueCreditBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: parsed.error.issues,
          },
        });
      }

      try {
        const result = await issueStoreCredit(params.data.storeId, {
          customer_id: params.data.customerId,
          currency: parsed.data.currency,
          amount: parsed.data.amount,
          notes: parsed.data.notes,
          created_by: parsed.data.created_by,
          expires_at: parsed.data.expires_at,
          order_id: parsed.data.order_id,
        });
        return reply.status(201).send(result);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "INVALID_AMOUNT"
        ) {
          return reply.status(400).send({
            error: { code: "INVALID_AMOUNT", message: err.message },
          });
        }
        throw err;
      }
    }
  );

  // ── POST /commerce/stores/:storeId/customers/:customerId/credits/adjust ───
  app.post(
    "/commerce/stores/:storeId/customers/:customerId/credits/adjust",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreCustomerParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }

      const parsed = AdjustCreditBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: parsed.error.issues,
          },
        });
      }

      try {
        const result = await adjustStoreCredit(params.data.storeId, {
          customer_id: params.data.customerId,
          currency: parsed.data.currency,
          delta: parsed.data.delta,
          notes: parsed.data.notes,
          created_by: parsed.data.created_by,
          order_id: parsed.data.order_id,
        });
        return reply.send(result);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "INSUFFICIENT_CREDIT") {
          return reply.status(422).send({
            error: {
              code: "INSUFFICIENT_CREDIT",
              message: err instanceof Error ? err.message : "insufficient credit",
            },
          });
        }
        if (code === "WALLET_NOT_FOUND") {
          return reply.status(404).send({
            error: {
              code: "NOT_FOUND",
              message: err instanceof Error ? err.message : "wallet not found",
            },
          });
        }
        if (code === "INVALID_AMOUNT") {
          return reply.status(400).send({
            error: {
              code: "INVALID_AMOUNT",
              message: err instanceof Error ? err.message : "invalid amount",
            },
          });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/customers/:customerId/credits/transactions
  app.get(
    "/commerce/stores/:storeId/customers/:customerId/credits/transactions",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreCustomerParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }
      const query = ListQuerystring.safeParse(request.query);
      const opts: { limit?: number; offset?: number; currency?: string } = {};
      if (query.success) {
        if (query.data.limit !== undefined) opts.limit = query.data.limit;
        if (query.data.offset !== undefined) opts.offset = query.data.offset;
        if (query.data.currency !== undefined) opts.currency = query.data.currency;
      }

      const transactions = await listStoreCreditTransactions(
        params.data.storeId,
        params.data.customerId,
        opts
      );
      return reply.send({ transactions });
    }
  );

  // ── Gift card routes ───────────────────────────────────────────────────────

  // ── GET /commerce/stores/:storeId/gift-cards ────────────────────────────
  app.get(
    "/commerce/stores/:storeId/gift-cards",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }
      const query = ListQuerystring.safeParse(request.query);
      const opts: { limit?: number; offset?: number } = {};
      if (query.success) {
        if (query.data.limit !== undefined) opts.limit = query.data.limit;
        if (query.data.offset !== undefined) opts.offset = query.data.offset;
      }
      const giftCards = await listGiftCards(params.data.storeId, opts);
      return reply.send({ gift_cards: giftCards });
    }
  );

  // ── POST /commerce/stores/:storeId/gift-cards ────────────────────────────
  app.post(
    "/commerce/stores/:storeId/gift-cards",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      const parsed = CreateGiftCardBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: parsed.error.issues,
          },
        });
      }

      try {
        const id = await createGiftCard(params.data.storeId, parsed.data);
        return reply.status(201).send({ id });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "DUPLICATE_CODE"
        ) {
          return reply.status(409).send({
            error: { code: "DUPLICATE_CODE", message: err.message },
          });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/gift-cards/lookup ─────────────────────
  // Registered BEFORE /:giftCardId to avoid param conflict.
  app.get(
    "/commerce/stores/:storeId/gift-cards/lookup",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      const query = LookupQuerystring.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: query.error.issues,
          },
        });
      }

      const outcome = await lookupGiftCard(params.data.storeId, query.data.code);

      if (outcome === null) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "gift card not found" },
        });
      }

      if ("error" in outcome) {
        return reply.status(422).send({
          error: {
            code: outcome.error,
            message:
              outcome.error === "GIFT_CARD_DISABLED"
                ? "gift card is disabled"
                : "gift card has expired",
          },
        });
      }

      return reply.send(outcome.card);
    }
  );

  // ── GET /commerce/stores/:storeId/gift-cards/:giftCardId ────────────────
  app.get(
    "/commerce/stores/:storeId/gift-cards/:giftCardId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = GiftCardIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }
      const card = await getGiftCard(params.data.storeId, params.data.giftCardId);
      if (!card) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "gift card not found" },
        });
      }
      return reply.send(card);
    }
  );

  // ── POST /commerce/stores/:storeId/gift-cards/:giftCardId/disable ────────
  app.post(
    "/commerce/stores/:storeId/gift-cards/:giftCardId/disable",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = GiftCardIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid params" },
        });
      }
      const disabled = await disableGiftCard(
        params.data.storeId,
        params.data.giftCardId
      );
      if (!disabled) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "gift card not found" },
        });
      }
      return reply.send({ ok: true });
    }
  );
};
