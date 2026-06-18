/**
 * loyalty/routes.ts — Fastify plugin for the native loyalty / points program.
 *
 * Admin (storeAuthAdmin):
 *   GET  /commerce/stores/:storeId/loyalty/config                              — GetConfig
 *   PUT  /commerce/stores/:storeId/loyalty/config                              — UpdateConfig
 *   GET  /commerce/stores/:storeId/loyalty/customers/:customerId               — balance + lifetime
 *   GET  /commerce/stores/:storeId/loyalty/customers/:customerId/ledger        — ledger
 *   POST /commerce/stores/:storeId/loyalty/customers/:customerId/adjust        — manual adjust
 *
 * Customer-scoped (storefront customer bearer token — same guard as customer-auth):
 *   GET  /commerce/stores/:storeId/loyalty/me                                  — my balance
 *   GET  /commerce/stores/:storeId/loyalty/me/ledger                           — my ledger
 *   POST /commerce/stores/:storeId/loyalty/me/redeem                           — redeem points
 *
 * The customer guard reuses the customer-auth bearerAuth() service (store-scoped
 * JWT verification) exactly like customer-auth/routes.ts makeCaAuth().
 */

import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthAdmin } from "../../lib/auth/middleware.js";
import { getPool } from "../../db/pool.js";
import { config } from "../../config/config.js";
import { bearerAuth } from "../customer-auth/service.js";
import {
  getOrCreateConfig,
  updateConfig,
  getBalance,
  listLedger,
  redeemPoints,
  adjustPoints,
} from "./service.js";

// ── Customer bearer auth preHandler (mirrors customer-auth makeCaAuth) ────────

const customerAuth: preHandlerHookHandler = async (request, reply) => {
  const params = request.params as Record<string, string>;
  const storeId = params["storeId"] ?? "";
  const authorization = request.headers["authorization"] ?? "";
  const pool = getPool();
  const secretsKey = config.AUTH_SECRETS_KEY ?? "";

  const claims = await bearerAuth(pool, authorization, storeId, secretsKey);
  if (!claims || claims.store !== storeId) {
    return reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "invalid or expired customer token" },
    });
  }
  request.customer = claims;
};

// ── Zod schemas ────────────────────────────────────────────────────────────────

const StoreParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
});

const StoreCustomerParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
  customerId: z.string().uuid("customerId must be a UUID"),
});

const ListQuerystring = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Earn rate / redeem value are money-rate fields — decimal strings, never float.
const RateString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string (e.g. "1" or "0.01")');

const UpdateConfigBody = z
  .object({
    points_per_currency_unit: RateString.optional(),
    redeem_value_per_point: RateString.optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.points_per_currency_unit !== undefined ||
      b.redeem_value_per_point !== undefined ||
      b.is_active !== undefined,
    { message: "at least one field is required" }
  );

const AdjustBody = z.object({
  points: z.number().int().refine((n) => n !== 0, "points must be non-zero"),
  reason: z.string().max(500).optional(),
});

const RedeemBody = z.object({
  points: z.number().int().positive("points must be a positive integer"),
  reason: z.string().max(500).optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const loyaltyPlugin: FastifyPluginAsyncZod = async (app) => {
  // ── Admin: GET config ──────────────────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/loyalty/config",
    { schema: { params: StoreParams }, preHandler: [storeAuthAdmin("loyalty")] },
    async (request, reply) => {
      const config_ = await getOrCreateConfig(request.params.storeId);
      return reply.send({ config: config_ });
    }
  );

  // ── Admin: PUT config ──────────────────────────────────────────────────────
  app.put(
    "/commerce/stores/:storeId/loyalty/config",
    { schema: { params: StoreParams, body: UpdateConfigBody }, preHandler: [storeAuthAdmin("loyalty")] },
    async (request, reply) => {
      const input: {
        points_per_currency_unit?: string;
        redeem_value_per_point?: string;
        is_active?: boolean;
      } = {};
      if (request.body.points_per_currency_unit !== undefined)
        input.points_per_currency_unit = request.body.points_per_currency_unit;
      if (request.body.redeem_value_per_point !== undefined)
        input.redeem_value_per_point = request.body.redeem_value_per_point;
      if (request.body.is_active !== undefined) input.is_active = request.body.is_active;

      const config_ = await updateConfig(request.params.storeId, input);
      return reply.send({ config: config_ });
    }
  );

  // ── Admin: GET a customer's balance ─────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/loyalty/customers/:customerId",
    { schema: { params: StoreCustomerParams }, preHandler: [storeAuthAdmin("loyalty")] },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const balance = await getBalance(storeId, customerId);
      return reply.send(balance);
    }
  );

  // ── Admin: GET a customer's ledger ──────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/loyalty/customers/:customerId/ledger",
    { schema: { params: StoreCustomerParams, querystring: ListQuerystring }, preHandler: [storeAuthAdmin("loyalty")] },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const opts: { limit?: number; offset?: number } = {};
      if (request.query.limit !== undefined) opts.limit = request.query.limit;
      if (request.query.offset !== undefined) opts.offset = request.query.offset;
      const ledger = await listLedger(storeId, customerId, opts);
      return reply.send({ ledger });
    }
  );

  // ── Admin: POST manual adjust ───────────────────────────────────────────────
  app.post(
    "/commerce/stores/:storeId/loyalty/customers/:customerId/adjust",
    { schema: { params: StoreCustomerParams, body: AdjustBody }, preHandler: [storeAuthAdmin("loyalty")] },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      try {
        const result = await adjustPoints(
          storeId,
          customerId,
          request.body.points,
          request.body.reason
        );
        return reply.send(result);
      } catch (err: unknown) {
        if (sendPointsError(err, reply)) return reply;
        throw err;
      }
    }
  );

  // ── Customer: GET my balance ────────────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/loyalty/me",
    { schema: { params: StoreParams }, preHandler: [customerAuth] },
    async (request, reply) => {
      const { storeId } = request.params;
      const customerId = request.customer!.sub;
      const balance = await getBalance(storeId, customerId);
      return reply.send(balance);
    }
  );

  // ── Customer: GET my ledger ─────────────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/loyalty/me/ledger",
    { schema: { params: StoreParams, querystring: ListQuerystring }, preHandler: [customerAuth] },
    async (request, reply) => {
      const { storeId } = request.params;
      const customerId = request.customer!.sub;
      const opts: { limit?: number; offset?: number } = {};
      if (request.query.limit !== undefined) opts.limit = request.query.limit;
      if (request.query.offset !== undefined) opts.offset = request.query.offset;
      const ledger = await listLedger(storeId, customerId, opts);
      return reply.send({ ledger });
    }
  );

  // ── Customer: POST redeem ───────────────────────────────────────────────────
  app.post(
    "/commerce/stores/:storeId/loyalty/me/redeem",
    { schema: { params: StoreParams, body: RedeemBody }, preHandler: [customerAuth] },
    async (request, reply) => {
      const { storeId } = request.params;
      const customerId = request.customer!.sub;
      try {
        const result = await redeemPoints(
          storeId,
          customerId,
          request.body.points,
          request.body.reason
        );
        return reply.send(result);
      } catch (err: unknown) {
        if (sendPointsError(err, reply)) return reply;
        throw err;
      }
    }
  );
};

// ── Error mapping ──────────────────────────────────────────────────────────────

/**
 * Map a coded loyalty service error to an HTTP response.
 * Returns true when the error was handled (and a response sent), false otherwise.
 */
function sendPointsError(
  err: unknown,
  reply: Parameters<preHandlerHookHandler>[1]
): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  const message = err instanceof Error ? err.message : "loyalty error";
  if (code === "INSUFFICIENT_POINTS") {
    void reply.status(422).send({ error: { code: "INSUFFICIENT_POINTS", message } });
    return true;
  }
  if (code === "INVALID_POINTS") {
    void reply.status(400).send({ error: { code: "INVALID_POINTS", message } });
    return true;
  }
  return false;
}
