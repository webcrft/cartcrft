/**
 * back-in-stock/routes.ts — Storefront back-in-stock subscription endpoints.
 *
 * Mounts under /commerce/stores/:storeId/back-in-stock:
 *   POST   .../back-in-stock        subscribe (public storefront key OR customer
 *                                   bearer). A customer bearer attaches
 *                                   customer_id; otherwise an email is required.
 *   GET    .../back-in-stock        list the authenticated customer's subs
 *                                   (customer bearer required).
 *   DELETE .../back-in-stock/:id    cancel one of the customer's subs
 *                                   (customer bearer required).
 *
 * Subscribe is intentionally lenient on auth so anonymous storefront visitors
 * can subscribe with just an email (mirrors the public cart/recovery pattern);
 * list/cancel are customer-scoped because they expose a customer's own data.
 */

import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getPool } from "../../db/pool.js";
import { config } from "../../config/config.js";
import { storeAuthRead } from "../../lib/auth/middleware.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import { bearerAuth, type CustomerClaims } from "../customer-auth/service.js";
import { subscribe, listSubscriptions, cancel } from "./service.js";

// ── Customer bearer preHandler (mirrors customer-auth/routes.ts makeCaAuth) ──

/**
 * Resolve a storefront customer bearer token onto request.customer. Unlike the
 * customer-auth plugin's guard this is REQUIRED-by-caller: routes that need a
 * customer attach `caBearerRequired`; the subscribe route resolves it
 * optionally so anonymous email subscribes still work.
 */
async function resolveCustomer(
  authorization: string,
  storeId: string
): Promise<CustomerClaims | null> {
  const pool = getPool();
  const secretsKey = config.AUTH_SECRETS_KEY ?? "";
  const claims = await bearerAuth(pool, authorization, storeId, secretsKey);
  if (!claims || claims.store !== storeId) return null;
  return claims;
}

// storeAuthRead is overloaded (preHandler | factory). Narrow it to the plain
// async preHandler form for direct invocation inside subscribeAuth.
const readGuard = storeAuthRead as unknown as (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

const caBearerRequired: preHandlerHookHandler = async (request, reply) => {
  const params = request.params as Record<string, string>;
  const storeId = params["storeId"] ?? "";
  const authorization = request.headers["authorization"] ?? "";
  const claims = await resolveCustomer(authorization, storeId);
  if (!claims) {
    return reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "invalid or expired customer token" },
    });
  }
  request.customer = claims;
};

/**
 * Subscribe-route guard: accept a storefront CUSTOMER bearer (attaches
 * request.customer) OR fall back to the standard storefront-read guard
 * (public cc_pub_ key / admin JWT). This lets a logged-in customer subscribe
 * with their token and an anonymous storefront visitor subscribe with a public
 * key + email. A customer token is tried first because storeAuthRead does not
 * understand customer JWTs.
 */
const subscribeAuth: preHandlerHookHandler = async (request, reply) => {
  const params = request.params as Record<string, string>;
  const storeId = params["storeId"] ?? "";
  const authorization = request.headers["authorization"] ?? "";

  const claims = await resolveCustomer(authorization, storeId);
  if (claims) {
    request.customer = claims;
    return;
  }
  // Not a customer token → defer to the storefront-read guard (public key/JWT).
  // storeAuthRead is itself a preHandler; its async resolver ignores the Fastify
  // `done` callback, so invoking it with (request, reply) is safe.
  await readGuard(request, reply);
};

// ── Schemas ───────────────────────────────────────────────────────────────

const StoreIdParams = z.object({ storeId: z.string().uuid() });
const SubIdParams = z.object({
  storeId: z.string().uuid(),
  id: z.string().uuid(),
});

const SubscribeBody = z.object({
  variant_id: z.string().uuid(),
  email: z.string().email().optional(),
});

// ── Plugin ───────────────────────────────────────────────────────────────

export const backInStockPlugin: FastifyPluginAsyncZod = async (app) => {
  const base = "/commerce/stores/:storeId/back-in-stock";

  // POST — subscribe. Public storefront key gates the route; a customer bearer
  // (if present) attaches customer_id. Without a customer, an email is required.
  app.post(
    base,
    {
      preHandler: [subscribeAuth],
      schema: { params: StoreIdParams, body: SubscribeBody },
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const body = request.body;

      const customerId = request.customer?.sub;

      if (!customerId && !body.email) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "email is required when not authenticated as a customer",
          },
        });
      }

      const result = await subscribe(storeId, {
        variantId: body.variant_id,
        ...(customerId !== undefined ? { customerId } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
      });
      return reply.status(201).send(result);
    }
  );

  // GET — list the authenticated customer's subscriptions.
  app.get(
    base,
    {
      preHandler: [caBearerRequired],
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const customerId = request.customer!.sub;
      const subscriptions = await listSubscriptions(storeId, { customerId });
      return reply.send({ subscriptions });
    }
  );

  // DELETE — cancel one of the customer's subscriptions.
  app.delete(
    `${base}/:id`,
    {
      preHandler: [caBearerRequired],
      schema: { params: SubIdParams },
    },
    async (request, reply) => {
      const { storeId, id } = request.params;
      const customerId = request.customer!.sub;
      const ok = await cancel(storeId, id, customerId);
      if (!ok) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "subscription not found" },
        });
      }
      return reply.send({ ok: true });
    }
  );
};
