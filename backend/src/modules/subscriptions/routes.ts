/**
 * subscriptions/routes.ts — Fastify plugin for subscription plans and subscriptions.
 *
 * Routes:
 *  Plans CRUD: /commerce/stores/:storeId/subscription-plans
 *  Subscriptions CRUD: /commerce/stores/:storeId/subscriptions
 *  Lifecycle: pause / resume / cancel / bill
 *
 * Auth: admin for plans; write for subscriptions (matching source semantics).
 * Clock injection: the `getClock()` helper returns the Clock instance; tests
 * override via `setClock()` exported below.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin, storeAuthWrite } from "../../lib/auth/middleware.js";
import type { Clock } from "../../clock.js";
import { SystemClock } from "../../clock.js";
import {
  listSubscriptionPlans,
  getSubscriptionPlan,
  createSubscriptionPlan,
  updateSubscriptionPlan,
  deleteSubscriptionPlan,
  listSubscriptions,
  getSubscription,
  createSubscription,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  billSubscription,
} from "./service.js";

// ── Clock injection (for billingsim / tests) ──────────────────────────────────

let _clock: Clock = new SystemClock();

/** Get the current Clock instance (injected or default SystemClock). */
export function getClock(): Clock {
  return _clock;
}

/** Set the Clock instance — called by tests with a SimClock. */
export function setClock(c: Clock): void {
  _clock = c;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const UUID = z.string().uuid();

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}
function badRequest(msg: string, code = "VALIDATION_ERROR") {
  return { error: { code, message: msg } };
}
function unprocessable(msg: string, code = "INVALID_TRANSITION") {
  return { error: { code, message: msg } };
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const subscriptionsPlugin: FastifyPluginAsync = async (app) => {
  const storeParams = z.object({ storeId: UUID });

  // ── Subscription Plans ─────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/subscription-plans",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const plans = await listSubscriptionPlans(params.data.storeId);
      return reply.send({ plans });
    }
  );

  app.get(
    "/commerce/stores/:storeId/subscription-plans/:planId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, planId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const plan = await getSubscriptionPlan(params.data.storeId, params.data.planId);
      if (!plan) return reply.status(404).send(notFound("subscription plan not found"));
      return reply.send(plan);
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscription-plans",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const body = z
        .object({
          name: z.string().min(1),
          interval: z.enum(["day", "week", "month", "year"]),
          interval_count: z.number().int().min(1).optional(),
          trial_days: z.number().int().min(0).optional(),
          is_active: z.boolean().optional(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("name and interval are required"));
      const id = await createSubscriptionPlan(params.data.storeId, body.data);
      return reply.status(201).send({ id });
    }
  );

  app.put(
    "/commerce/stores/:storeId/subscription-plans/:planId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, planId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          name: z.string().min(1).optional().nullable(),
          trial_days: z.number().int().min(0).optional().nullable(),
          is_active: z.boolean().optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      await updateSubscriptionPlan(params.data.storeId, params.data.planId, body.data);
      return reply.send({ ok: true });
    }
  );

  app.delete(
    "/commerce/stores/:storeId/subscription-plans/:planId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, planId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      await deleteSubscriptionPlan(params.data.storeId, params.data.planId);
      return reply.send({ ok: true });
    }
  );

  // ── Subscriptions ──────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/subscriptions",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const query = z
        .object({
          status: z.string().optional(),
          customer_id: UUID.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .safeParse(request.query);
      if (!query.success) return reply.status(400).send(badRequest("invalid query"));
      const { subscriptions, total } = await listSubscriptions(params.data.storeId, query.data);
      return reply.send({ subscriptions, total });
    }
  );

  app.get(
    "/commerce/stores/:storeId/subscriptions/:subId",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, subId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const sub = await getSubscription(params.data.storeId, params.data.subId);
      if (!sub) return reply.status(404).send(notFound("subscription not found"));
      return reply.send(sub);
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const body = z
        .object({
          customer_id: UUID,
          plan_id: UUID,
          items: z
            .array(
              z.object({
                variant_id: UUID,
                quantity: z.number().int().min(1).optional(),
                price: z.number().min(0),
              })
            )
            .optional(),
        })
        .safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(badRequest("customer_id and plan_id are required"));
      }
      try {
        const result = await createSubscription(
          params.data.storeId,
          body.data,
          getClock()
        );
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "NOT_FOUND") {
          return reply.status(404).send(notFound(err.message));
        }
        throw err;
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions/:subId/pause",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, subId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const ok = await pauseSubscription(params.data.storeId, params.data.subId);
      if (!ok) return reply.status(422).send(unprocessable("subscription not found or not in an allowed state for paused"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions/:subId/resume",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, subId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const result = await resumeSubscription(
        params.data.storeId,
        params.data.subId,
        getClock()
      );
      if (!result) return reply.status(422).send(unprocessable("subscription not found or not paused"));
      return reply.send({ ok: true, next_billing_at: result.next_billing_at });
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions/:subId/cancel",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, subId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({ cancel_reason: z.string().optional() })
        .safeParse(request.body ?? {});
      const reason = body.success ? body.data.cancel_reason : undefined;
      const ok = await cancelSubscription(params.data.storeId, params.data.subId, reason);
      if (!ok) return reply.status(422).send(unprocessable("subscription not found or already cancelled"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions/:subId/bill",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, subId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      try {
        const result = await billSubscription(
          params.data.storeId,
          params.data.subId,
          getClock()
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "INVALID_TRANSITION") {
          return reply.status(422).send(unprocessable(err.message));
        }
        throw err;
      }
    }
  );
};
