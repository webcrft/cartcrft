/**
 * segments/routes.ts — Fastify plugin for customer segmentation.
 *
 * Routes:
 *   GET    /commerce/stores/:storeId/segments                       (read)
 *   POST   /commerce/stores/:storeId/segments                       (write)
 *   GET    /commerce/stores/:storeId/segments/:segmentId            (read)
 *   PUT    /commerce/stores/:storeId/segments/:segmentId            (write)
 *   DELETE /commerce/stores/:storeId/segments/:segmentId            (admin)
 *   GET    /commerce/stores/:storeId/segments/:segmentId/members    (read, paginated)
 *   GET    /commerce/stores/:storeId/customers/:customerId/segments (read)
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthRead, storeAuthWrite, storeAuthAdmin } from "../../lib/auth/middleware.js";
import {
  listSegments,
  getSegment,
  createSegment,
  updateSegment,
  deleteSegment,
  evaluateSegment,
  customerSegments,
  SegmentRuleError,
} from "./service.js";
import type { SegmentRules } from "./types.js";

const UUID = z.string().uuid();

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}
function badRequest(msg: string) {
  return { error: { code: "VALIDATION_ERROR", message: msg } };
}

// ── Rule schema (Zod mirror of types.ts) ──────────────────────────────────────

const NumericCondition = z.object({
  field: z.enum(["total_spent", "order_count", "last_order_days_ago", "created_days_ago"]),
  op: z.enum([">=", "<=", ">", "<", "="]),
  value: z.number().finite(),
});

const StringCondition = z.object({
  field: z.enum(["has_tag", "email_domain"]),
  op: z.literal("="),
  value: z.string().min(1),
});

const Condition = z.union([NumericCondition, StringCondition]);

const RulesSchema = z.object({
  match: z.enum(["all", "any"]),
  conditions: z.array(Condition).max(50),
});

// ── Param / body / query schemas ──────────────────────────────────────────────

const StoreParams = z.object({ storeId: UUID });
const SegmentParams = z.object({ storeId: UUID, segmentId: UUID });
const CustomerParams = z.object({ storeId: UUID, customerId: UUID });

const CreateSegmentBody = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  rules: RulesSchema,
  is_active: z.boolean().optional(),
});

const UpdateSegmentBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  rules: RulesSchema.optional(),
  is_active: z.boolean().optional(),
});

const MembersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const segmentsPlugin: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/commerce/stores/:storeId/segments",
    { preHandler: storeAuthRead("segments"), schema: { params: StoreParams } },
    async (request, reply) => {
      const segments = await listSegments(request.params.storeId);
      return reply.send({ segments });
    }
  );

  app.post(
    "/commerce/stores/:storeId/segments",
    { preHandler: storeAuthWrite("segments"), schema: { params: StoreParams, body: CreateSegmentBody } },
    async (request, reply) => {
      try {
        const segment = await createSegment(request.params.storeId, {
          name: request.body.name,
          description: request.body.description ?? null,
          rules: request.body.rules as SegmentRules,
          ...(request.body.is_active !== undefined ? { is_active: request.body.is_active } : {}),
        });
        return reply.status(201).send(segment);
      } catch (err) {
        if (err instanceof SegmentRuleError) return reply.status(400).send(badRequest(err.message));
        if (isUniqueViolation(err)) {
          return reply.status(409).send({ error: { code: "CONFLICT", message: "a segment with this name already exists" } });
        }
        throw err;
      }
    }
  );

  app.get(
    "/commerce/stores/:storeId/segments/:segmentId",
    { preHandler: storeAuthRead("segments"), schema: { params: SegmentParams } },
    async (request, reply) => {
      const segment = await getSegment(request.params.storeId, request.params.segmentId);
      if (!segment) return reply.status(404).send(notFound("segment not found"));
      return reply.send(segment);
    }
  );

  app.put(
    "/commerce/stores/:storeId/segments/:segmentId",
    { preHandler: storeAuthWrite("segments"), schema: { params: SegmentParams, body: UpdateSegmentBody } },
    async (request, reply) => {
      try {
        const segment = await updateSegment(request.params.storeId, request.params.segmentId, {
          ...(request.body.name !== undefined ? { name: request.body.name } : {}),
          ...(request.body.description !== undefined ? { description: request.body.description } : {}),
          ...(request.body.rules !== undefined ? { rules: request.body.rules as SegmentRules } : {}),
          ...(request.body.is_active !== undefined ? { is_active: request.body.is_active } : {}),
        });
        if (!segment) return reply.status(404).send(notFound("segment not found"));
        return reply.send(segment);
      } catch (err) {
        if (err instanceof SegmentRuleError) return reply.status(400).send(badRequest(err.message));
        if (isUniqueViolation(err)) {
          return reply.status(409).send({ error: { code: "CONFLICT", message: "a segment with this name already exists" } });
        }
        throw err;
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/segments/:segmentId",
    { preHandler: storeAuthAdmin("segments"), schema: { params: SegmentParams } },
    async (request, reply) => {
      const ok = await deleteSegment(request.params.storeId, request.params.segmentId);
      if (!ok) return reply.status(404).send(notFound("segment not found"));
      return reply.send({ ok: true });
    }
  );

  app.get(
    "/commerce/stores/:storeId/segments/:segmentId/members",
    { preHandler: storeAuthRead("segments"), schema: { params: SegmentParams, querystring: MembersQuery } },
    async (request, reply) => {
      const result = await evaluateSegment(request.params.storeId, request.params.segmentId, {
        ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
        ...(request.query.offset !== undefined ? { offset: request.query.offset } : {}),
      });
      if (!result) return reply.status(404).send(notFound("segment not found"));
      return reply.send(result);
    }
  );

  app.get(
    "/commerce/stores/:storeId/customers/:customerId/segments",
    { preHandler: storeAuthRead("segments"), schema: { params: CustomerParams } },
    async (request, reply) => {
      const segments = await customerSegments(request.params.storeId, request.params.customerId);
      return reply.send({ segments });
    }
  );
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "23505"
  );
}
