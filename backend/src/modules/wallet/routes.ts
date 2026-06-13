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

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
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

// H3.2: amount/delta/initial_value are money fields — enforce decimal-string format.
const MoneyString = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string (e.g. \"9.99\")");
// delta can be negative (debit adjustments), so allow optional leading minus.
const MoneyDeltaString = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "must be a signed decimal string (e.g. \"-5.00\" or \"10.00\")");

const IssueCreditBody = z.object({
  currency: z.string().length(3, "currency must be 3 characters"),
  amount: MoneyString,
  notes: z.string().max(500).optional(),
  created_by: z.string().uuid().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  order_id: z.string().uuid().nullable().optional(),
});

const AdjustCreditBody = z.object({
  currency: z.string().length(3, "currency must be 3 characters"),
  delta: MoneyDeltaString,
  notes: z.string().max(500).optional(),
  created_by: z.string().uuid().nullable().optional(),
  order_id: z.string().uuid().nullable().optional(),
});

const CreateGiftCardBody = z.object({
  code: z.string().min(1, "code is required").max(100),
  initial_value: MoneyString,
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

export const walletPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── GET /commerce/stores/:storeId/customers/:customerId/credits ───────────
  app.get(
    "/commerce/stores/:storeId/customers/:customerId/credits",
    {
      schema: { params: StoreCustomerParams, querystring: ListQuerystring },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const currency = request.query.currency;
      const credits = await getCustomerCredits(storeId, customerId, currency);
      return reply.send({ credits });
    }
  );

  // ── POST /commerce/stores/:storeId/customers/:customerId/credits/issue ────
  app.post(
    "/commerce/stores/:storeId/customers/:customerId/credits/issue",
    {
      schema: { params: StoreCustomerParams, body: IssueCreditBody },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      try {
        const result = await issueStoreCredit(storeId, {
          customer_id: customerId,
          currency: request.body.currency,
          amount: request.body.amount,
          notes: request.body.notes,
          created_by: request.body.created_by,
          expires_at: request.body.expires_at,
          order_id: request.body.order_id,
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
    {
      schema: { params: StoreCustomerParams, body: AdjustCreditBody },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      try {
        const result = await adjustStoreCredit(storeId, {
          customer_id: customerId,
          currency: request.body.currency,
          delta: request.body.delta,
          notes: request.body.notes,
          created_by: request.body.created_by,
          order_id: request.body.order_id,
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
    {
      schema: { params: StoreCustomerParams, querystring: ListQuerystring },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const { limit, offset, currency } = request.query;
      const opts: { limit?: number; offset?: number; currency?: string } = {};
      if (limit !== undefined) opts.limit = limit;
      if (offset !== undefined) opts.offset = offset;
      if (currency !== undefined) opts.currency = currency;
      const transactions = await listStoreCreditTransactions(storeId, customerId, opts);
      return reply.send({ transactions });
    }
  );

  // ── Gift card routes ───────────────────────────────────────────────────────

  // ── GET /commerce/stores/:storeId/gift-cards ────────────────────────────
  app.get(
    "/commerce/stores/:storeId/gift-cards",
    {
      schema: { params: StoreParams, querystring: ListQuerystring },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const { limit, offset } = request.query;
      const opts: { limit?: number; offset?: number } = {};
      if (limit !== undefined) opts.limit = limit;
      if (offset !== undefined) opts.offset = offset;
      const giftCards = await listGiftCards(storeId, opts);
      return reply.send({ gift_cards: giftCards });
    }
  );

  // ── POST /commerce/stores/:storeId/gift-cards ────────────────────────────
  app.post(
    "/commerce/stores/:storeId/gift-cards",
    {
      schema: { params: StoreParams, body: CreateGiftCardBody },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      try {
        const id = await createGiftCard(storeId, request.body);
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
    {
      schema: { params: StoreParams, querystring: LookupQuerystring },
      preHandler: [storeAuthRead],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const outcome = await lookupGiftCard(storeId, request.query.code);

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
    {
      schema: { params: GiftCardIdParams },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, giftCardId } = request.params;
      const card = await getGiftCard(storeId, giftCardId);
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
    {
      schema: { params: GiftCardIdParams },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, giftCardId } = request.params;
      const disabled = await disableGiftCard(storeId, giftCardId);
      if (!disabled) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "gift card not found" },
        });
      }
      return reply.send({ ok: true });
    }
  );
};
