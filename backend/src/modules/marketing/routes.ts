/**
 * marketing/routes.ts — Fastify plugin for marketing flows / automation.
 *
 * Flow CRUD (store-scoped):
 *   GET    /commerce/stores/:storeId/marketing/flows                  (read)
 *   POST   /commerce/stores/:storeId/marketing/flows                  (write)
 *   GET    /commerce/stores/:storeId/marketing/flows/:flowId          (read)
 *   PUT    /commerce/stores/:storeId/marketing/flows/:flowId          (write)
 *   DELETE /commerce/stores/:storeId/marketing/flows/:flowId          (admin)
 *
 * Runs (read):
 *   GET    /commerce/stores/:storeId/marketing/runs                   (read)
 *   GET    /commerce/stores/:storeId/marketing/flows/:flowId/runs     (read)
 *
 * Test enrollment (admin — manual enroll for testing a flow):
 *   POST   /commerce/stores/:storeId/marketing/flows/:flowId/test-enroll  (admin)
 */

import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthRead, storeAuthWrite, storeAuthAdmin } from "../../lib/auth/middleware.js";
import {
  listFlows,
  getFlow,
  createFlow,
  updateFlow,
  deleteFlow,
  listRuns,
  enrollFlow,
  FlowValidationError,
} from "./service.js";

const UUID = z.string().uuid();

const StoreParams = z.object({ storeId: UUID });
const FlowParams = z.object({ storeId: UUID, flowId: UUID });

const StepSchema = z.object({
  delay_seconds: z.number().int().min(0),
  action: z.enum(["email", "sms"]),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).max(16384),
});

const TriggerEventSchema = z.enum(["order_created", "customer_created", "abandoned_cart"]);

const CreateFlowBody = z.object({
  name: z.string().min(1).max(200),
  trigger_event: TriggerEventSchema,
  steps: z.array(StepSchema).min(1).max(50),
  is_active: z.boolean().optional(),
});

const UpdateFlowBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    trigger_event: TriggerEventSchema.optional(),
    steps: z.array(StepSchema).min(1).max(50).optional(),
    is_active: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.trigger_event !== undefined ||
      b.steps !== undefined ||
      b.is_active !== undefined,
    { message: "at least one field is required" }
  );

const ListRunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const TestEnrollBody = z.object({
  customer_id: UUID,
  trigger_ref: z.string().min(1).max(200).optional(),
});

function sendFlowError(err: unknown, reply: Parameters<preHandlerHookHandler>[1]): boolean {
  if (err instanceof FlowValidationError) {
    void reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.message } });
    return true;
  }
  return false;
}

export const marketingPlugin: FastifyPluginAsyncZod = async (app) => {
  // ── List flows ──────────────────────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/marketing/flows",
    { schema: { params: StoreParams }, preHandler: [storeAuthRead] },
    async (request, reply) => {
      const flows = await listFlows(request.params.storeId);
      return reply.send({ flows });
    }
  );

  // ── Create flow ─────────────────────────────────────────────────────────
  app.post(
    "/commerce/stores/:storeId/marketing/flows",
    { schema: { params: StoreParams, body: CreateFlowBody }, preHandler: [storeAuthWrite] },
    async (request, reply) => {
      try {
        const steps = request.body.steps.map((s) => ({
          delay_seconds: s.delay_seconds,
          action: s.action,
          subject: s.subject ?? null,
          body: s.body,
        }));
        const input = {
          name: request.body.name,
          trigger_event: request.body.trigger_event,
          steps,
          ...(request.body.is_active !== undefined ? { is_active: request.body.is_active } : {}),
        };
        const flow = await createFlow(request.params.storeId, input);
        return reply.status(201).send({ flow });
      } catch (err) {
        if (sendFlowError(err, reply)) return reply;
        throw err;
      }
    }
  );

  // ── Get one flow ────────────────────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/marketing/flows/:flowId",
    { schema: { params: FlowParams }, preHandler: [storeAuthRead] },
    async (request, reply) => {
      const flow = await getFlow(request.params.storeId, request.params.flowId);
      if (!flow) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "flow not found" } });
      }
      return reply.send({ flow });
    }
  );

  // ── Update flow ─────────────────────────────────────────────────────────
  app.put(
    "/commerce/stores/:storeId/marketing/flows/:flowId",
    { schema: { params: FlowParams, body: UpdateFlowBody }, preHandler: [storeAuthWrite] },
    async (request, reply) => {
      try {
        const input: Parameters<typeof updateFlow>[2] = {};
        if (request.body.name !== undefined) input.name = request.body.name;
        if (request.body.trigger_event !== undefined) input.trigger_event = request.body.trigger_event;
        if (request.body.is_active !== undefined) input.is_active = request.body.is_active;
        if (request.body.steps !== undefined) {
          input.steps = request.body.steps.map((s) => ({
            delay_seconds: s.delay_seconds,
            action: s.action,
            subject: s.subject ?? null,
            body: s.body,
          }));
        }
        const flow = await updateFlow(request.params.storeId, request.params.flowId, input);
        if (!flow) {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "flow not found" } });
        }
        return reply.send({ flow });
      } catch (err) {
        if (sendFlowError(err, reply)) return reply;
        throw err;
      }
    }
  );

  // ── Delete flow ─────────────────────────────────────────────────────────
  app.delete(
    "/commerce/stores/:storeId/marketing/flows/:flowId",
    { schema: { params: FlowParams }, preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const ok = await deleteFlow(request.params.storeId, request.params.flowId);
      if (!ok) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "flow not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── List all runs for a store ───────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/marketing/runs",
    { schema: { params: StoreParams, querystring: ListRunsQuery }, preHandler: [storeAuthRead] },
    async (request, reply) => {
      const opts: Parameters<typeof listRuns>[1] = {};
      if (request.query.limit !== undefined) opts.limit = request.query.limit;
      if (request.query.offset !== undefined) opts.offset = request.query.offset;
      const runs = await listRuns(request.params.storeId, opts);
      return reply.send({ runs });
    }
  );

  // ── List runs for a specific flow ───────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/marketing/flows/:flowId/runs",
    { schema: { params: FlowParams, querystring: ListRunsQuery }, preHandler: [storeAuthRead] },
    async (request, reply) => {
      const opts: Parameters<typeof listRuns>[1] = { flowId: request.params.flowId };
      if (request.query.limit !== undefined) opts.limit = request.query.limit;
      if (request.query.offset !== undefined) opts.offset = request.query.offset;
      const runs = await listRuns(request.params.storeId, opts);
      return reply.send({ runs });
    }
  );

  // ── Test-enroll a customer into a flow (admin; for testing) ─────────────
  app.post(
    "/commerce/stores/:storeId/marketing/flows/:flowId/test-enroll",
    { schema: { params: FlowParams, body: TestEnrollBody }, preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const { storeId, flowId } = request.params;
      const flow = await getFlow(storeId, flowId);
      if (!flow) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "flow not found" } });
      }
      if (flow.steps.length === 0) {
        return reply
          .status(400)
          .send({ error: { code: "VALIDATION_ERROR", message: "flow has no steps" } });
      }
      const triggerRef = request.body.trigger_ref ?? `test:${request.body.customer_id}:${Date.now()}`;
      const runId = await enrollFlow(
        storeId,
        flow,
        request.body.customer_id,
        triggerRef,
        new Date()
      );
      if (!runId) {
        return reply.send({ ok: true, enrolled: false, message: "already enrolled for this trigger_ref" });
      }
      return reply.status(201).send({ ok: true, enrolled: true, run_id: runId, trigger_ref: triggerRef });
    }
  );
};
