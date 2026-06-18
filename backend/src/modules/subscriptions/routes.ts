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

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
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
// H3.2: money fields are decimal strings, never floats
const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}
function unprocessable(msg: string, code = "INVALID_TRANSITION") {
  return { error: { code, message: msg } };
}

// ── Shared param schemas ──────────────────────────────────────────────────────

const StoreParams = z.object({ storeId: UUID });
const PlanParams = z.object({ storeId: UUID, planId: UUID });
const SubParams = z.object({ storeId: UUID, subId: UUID });

// ── Shared body / querystring schemas ─────────────────────────────────────────

const CreatePlanBody = z.object({
  name: z.string().min(1),
  interval: z.enum(["day", "week", "month", "year"]),
  interval_count: z.number().int().min(1).optional(),
  trial_days: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
});

const UpdatePlanBody = z.object({
  name: z.string().min(1).optional().nullable(),
  trial_days: z.number().int().min(0).optional().nullable(),
  is_active: z.boolean().optional().nullable(),
});

const ListSubsQuerystring = z.object({
  status: z.string().optional(),
  customer_id: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateSubBody = z.object({
  customer_id: UUID,
  plan_id: UUID,
  items: z
    .array(
      z.object({
        variant_id: UUID,
        quantity: z.number().int().min(1).optional(),
        // H3.2: subscription item prices are money strings
        price: MoneyStr,
      })
    )
    .optional(),
});

const CancelSubBody = z.object({ cancel_reason: z.string().optional() });

// ── Plugin ────────────────────────────────────────────────────────────────────

export const subscriptionsPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── Subscription Plans ─────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/subscription-plans",
    { preHandler: storeAuthAdmin("subscriptions"), schema: { params: StoreParams } },
    async (request, reply) => {
      const plans = await listSubscriptionPlans(request.params.storeId);
      return reply.send({ plans });
    }
  );

  app.get(
    "/commerce/stores/:storeId/subscription-plans/:planId",
    { preHandler: storeAuthAdmin("subscriptions"), schema: { params: PlanParams } },
    async (request, reply) => {
      const plan = await getSubscriptionPlan(request.params.storeId, request.params.planId);
      if (!plan) return reply.status(404).send(notFound("subscription plan not found"));
      return reply.send(plan);
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscription-plans",
    { preHandler: storeAuthAdmin("subscriptions"), schema: { params: StoreParams, body: CreatePlanBody } },
    async (request, reply) => {
      const id = await createSubscriptionPlan(request.params.storeId, request.body);
      return reply.status(201).send({ id });
    }
  );

  app.put(
    "/commerce/stores/:storeId/subscription-plans/:planId",
    { preHandler: storeAuthAdmin("subscriptions"), schema: { params: PlanParams, body: UpdatePlanBody } },
    async (request, reply) => {
      await updateSubscriptionPlan(request.params.storeId, request.params.planId, request.body);
      return reply.send({ ok: true });
    }
  );

  app.delete(
    "/commerce/stores/:storeId/subscription-plans/:planId",
    { preHandler: storeAuthAdmin("subscriptions"), schema: { params: PlanParams } },
    async (request, reply) => {
      await deleteSubscriptionPlan(request.params.storeId, request.params.planId);
      return reply.send({ ok: true });
    }
  );

  // ── Subscriptions ──────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/subscriptions",
    { preHandler: storeAuthWrite("subscriptions"), schema: { params: StoreParams, querystring: ListSubsQuerystring } },
    async (request, reply) => {
      const { subscriptions, total } = await listSubscriptions(request.params.storeId, request.query);
      return reply.send({ subscriptions, total });
    }
  );

  app.get(
    "/commerce/stores/:storeId/subscriptions/:subId",
    { preHandler: storeAuthWrite("subscriptions"), schema: { params: SubParams } },
    async (request, reply) => {
      const sub = await getSubscription(request.params.storeId, request.params.subId);
      if (!sub) return reply.status(404).send(notFound("subscription not found"));
      return reply.send(sub);
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions",
    { preHandler: storeAuthWrite("subscriptions"), schema: { params: StoreParams, body: CreateSubBody } },
    async (request, reply) => {
      try {
        const result = await createSubscription(
          request.params.storeId,
          request.body,
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
    { preHandler: storeAuthWrite("subscriptions"), schema: { params: SubParams } },
    async (request, reply) => {
      const ok = await pauseSubscription(request.params.storeId, request.params.subId);
      if (!ok) return reply.status(422).send(unprocessable("subscription not found or not in an allowed state for paused"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions/:subId/resume",
    { preHandler: storeAuthWrite("subscriptions"), schema: { params: SubParams } },
    async (request, reply) => {
      const result = await resumeSubscription(
        request.params.storeId,
        request.params.subId,
        getClock()
      );
      if (!result) return reply.status(422).send(unprocessable("subscription not found or not paused"));
      return reply.send({ ok: true, next_billing_at: result.next_billing_at });
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions/:subId/cancel",
    // Body is optional (cancel_reason only); thin safeParse to handle missing body gracefully
    { preHandler: storeAuthWrite("subscriptions"), schema: { params: SubParams } },
    async (request, reply) => {
      const body = CancelSubBody.safeParse(request.body ?? {});
      const reason = body.success ? body.data.cancel_reason : undefined;
      const ok = await cancelSubscription(request.params.storeId, request.params.subId, reason);
      if (!ok) return reply.status(422).send(unprocessable("subscription not found or already cancelled"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/subscriptions/:subId/bill",
    { preHandler: storeAuthAdmin("subscriptions"), schema: { params: SubParams } },
    async (request, reply) => {
      try {
        const result = await billSubscription(
          request.params.storeId,
          request.params.subId,
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
