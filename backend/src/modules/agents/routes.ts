/**
 * agents/routes.ts — Fastify plugin for agent registry + mandates.
 *
 * All routes scoped to /commerce/stores/:storeId/agents (storeAuthAdmin).
 *
 * Agent endpoints:
 *   POST   /agents                          — create (returns keypair; private key shown once)
 *   GET    /agents                          — list
 *   GET    /agents/:agentId                 — get
 *   PUT    /agents/:agentId                 — update (scopes, spend_limit, is_active, etc.)
 *   DELETE /agents/:agentId                 — revoke (sets status=disabled)
 *   GET    /agents/:agentId/audit-log       — audit log for agent
 *
 * Mandate endpoints:
 *   POST   /agents/:agentId/mandates        — create mandate (intent|cart|payment)
 *   GET    /agents/:agentId/mandates        — list mandates
 *   GET    /agents/:agentId/mandates/:mandateId/verify — verify full chain
 *   DELETE /agents/:agentId/mandates/:mandateId        — revoke mandate
 *
 * Store-level audit log:
 *   GET    /audit-log                       — all audit events for store
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthAdmin } from "../../lib/auth/middleware.js";
import {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  revokeAgent,
  createMandate,
  listMandates,
  verifyMandate,
  revokeMandate,
  listAuditLog,
} from "./service.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreAgentParams = z.object({
  storeId: z.string().uuid(),
  agentId: z.string().uuid(),
});

const StoreParams = z.object({
  storeId: z.string().uuid(),
});

const MandateParams = z.object({
  storeId: z.string().uuid(),
  agentId: z.string().uuid(),
  mandateId: z.string().uuid(),
});

const CreateAgentBody = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(80).optional(),
  description: z.string().max(1000).optional(),
  agent_type: z.enum(["webhook", "internal", "mcp", "scheduled", "event_driven"]).optional(),
  endpoint_url: z.string().url().optional(),
  auth_type: z.enum(["bearer", "hmac", "api_key", "none"]).optional(),
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  max_retries: z.number().int().min(0).max(10).optional(),
  retry_backoff_ms: z.number().int().min(0).optional(),
  cron_expression: z.string().optional(),
  event_triggers: z.array(z.string()).optional(),
  scopes: z.array(z.string()).optional(),
  spend_limit: z.string().regex(/^\d+(\.\d{1,2})?$/, "spend_limit must be a decimal string").optional(),
  spend_window: z.string().regex(/^\d+[hdm]$/, "spend_window must be like 24h, 7d, 30m").optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateAgentBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  endpoint_url: z.string().url().optional().nullable(),
  auth_type: z.enum(["bearer", "hmac", "api_key", "none"]).optional(),
  timeout_ms: z.number().int().min(100).max(300_000).optional(),
  max_retries: z.number().int().min(0).max(10).optional(),
  retry_backoff_ms: z.number().int().min(0).optional(),
  cron_expression: z.string().optional().nullable(),
  event_triggers: z.array(z.string()).optional(),
  status: z.enum(["active", "paused", "error", "disabled"]).optional(),
  scopes: z.array(z.string()).optional(),
  spend_limit: z.string().regex(/^\d+(\.\d{1,2})?$/).optional().nullable(),
  spend_window: z.string().regex(/^\d+[hdm]$/).optional().nullable(),
  config: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Accept any JSON object for payload; server-side validation in createMandate() enforces shape.
const MandatePayloadSchema = z.record(z.string(), z.unknown());

const CreateMandateBody = z.object({
  mandate_type: z.enum(["intent", "cart", "payment"]),
  payload: MandatePayloadSchema,
  parent_mandate_id: z.string().uuid().optional(),
  signature: z.string().optional(), // hex-encoded ed25519 signature
  name: z.string().min(1).max(255).optional(),
  scopes: z.array(z.string()).optional(),
  resource_type: z.string().optional(),
  resource_ids: z.array(z.string().uuid()).optional(),
  rate_limit_rpm: z.number().int().min(1).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const ListQuerystring = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  agent_id: z.string().uuid().optional(),
  status: z.string().optional(),
  type: z.string().optional(),
  active: z.coerce.boolean().optional(),
});

const RevokeBody = z.object({
  reason: z.string().max(500).optional(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const agentsPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── POST /commerce/stores/:storeId/agents — create agent ─────────────────
  app.post(
    "/commerce/stores/:storeId/agents",
    { preHandler: [storeAuthAdmin], schema: { params: StoreParams, body: CreateAgentBody } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      try {
        const agent = await createAgent(storeId, request.body as import("./types.js").CreateAgentInput);
        // private_key_pem is included in the response only on creation
        return reply.status(201).send({ agent });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "23505") {
          return reply.status(409).send({ error: { code: "DUPLICATE_SLUG", message: "agent slug already exists" } });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/agents — list agents ───────────────────
  app.get(
    "/commerce/stores/:storeId/agents",
    { preHandler: [storeAuthAdmin], schema: { params: StoreParams, querystring: ListQuerystring } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const listOpts: { limit?: number; offset?: number } = {};
      if (request.query.limit !== undefined) listOpts.limit = request.query.limit;
      if (request.query.offset !== undefined) listOpts.offset = request.query.offset;
      const agents = await listAgents(storeId, listOpts);
      return reply.send({ agents });
    }
  );

  // ── GET /commerce/stores/:storeId/agents/:agentId — get agent ────────────
  app.get(
    "/commerce/stores/:storeId/agents/:agentId",
    { preHandler: [storeAuthAdmin], schema: { params: StoreAgentParams } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const agent = await getAgent(storeId, request.params.agentId);
      if (!agent) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "agent not found" } });
      }
      return reply.send({ agent });
    }
  );

  // ── PUT /commerce/stores/:storeId/agents/:agentId — update agent ─────────
  app.put(
    "/commerce/stores/:storeId/agents/:agentId",
    { preHandler: [storeAuthAdmin], schema: { params: StoreAgentParams, body: UpdateAgentBody } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const updated = await updateAgent(storeId, request.params.agentId, request.body as import("./types.js").UpdateAgentInput);
      if (!updated) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "agent not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── DELETE /commerce/stores/:storeId/agents/:agentId — revoke agent ──────
  app.delete(
    "/commerce/stores/:storeId/agents/:agentId",
    { preHandler: [storeAuthAdmin], schema: { params: StoreAgentParams } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const revoked = await revokeAgent(storeId, request.params.agentId);
      if (!revoked) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "agent not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/stores/:storeId/agents/:agentId/audit-log ──────────────
  app.get(
    "/commerce/stores/:storeId/agents/:agentId/audit-log",
    { preHandler: [storeAuthAdmin], schema: { params: StoreAgentParams, querystring: ListQuerystring } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const auditOpts: { agentId?: string; limit?: number; offset?: number; status?: string } = {
        agentId: request.params.agentId,
      };
      if (request.query.limit !== undefined) auditOpts.limit = request.query.limit;
      if (request.query.offset !== undefined) auditOpts.offset = request.query.offset;
      if (request.query.status !== undefined) auditOpts.status = request.query.status;
      const logs = await listAuditLog(storeId, auditOpts);
      return reply.send({ audit_log: logs });
    }
  );

  // ── POST /commerce/stores/:storeId/agents/:agentId/mandates — create ──────
  app.post(
    "/commerce/stores/:storeId/agents/:agentId/mandates",
    { preHandler: [storeAuthAdmin], schema: { params: StoreAgentParams, body: CreateMandateBody } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      try {
        const mandate = await createMandate(storeId, {
          agent_id: request.params.agentId,
          ...request.body,
          payload: request.body.payload as import("./types.js").MandatePayload,
        } as import("./types.js").CreateMandateInput);
        return reply.status(201).send({ mandate });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        if (code === "AGENT_INACTIVE") {
          return reply.status(422).send({ error: { code: "AGENT_INACTIVE", message: (err as Error).message } });
        }
        if (code === "MANDATE_CHAIN_INVALID") {
          return reply.status(422).send({ error: { code: "MANDATE_CHAIN_INVALID", message: (err as Error).message } });
        }
        if (code === "SIGNATURE_INVALID") {
          return reply.status(422).send({ error: { code: "SIGNATURE_INVALID", message: (err as Error).message } });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/agents/:agentId/mandates — list ─────────
  app.get(
    "/commerce/stores/:storeId/agents/:agentId/mandates",
    { preHandler: [storeAuthAdmin], schema: { params: StoreAgentParams, querystring: ListQuerystring } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const mandOpts: { limit?: number; offset?: number; type?: string; active?: boolean } = {};
      if (request.query.limit !== undefined) mandOpts.limit = request.query.limit;
      if (request.query.offset !== undefined) mandOpts.offset = request.query.offset;
      if (request.query.type !== undefined) mandOpts.type = request.query.type;
      if (request.query.active !== undefined) mandOpts.active = request.query.active;
      const mandates = await listMandates(storeId, request.params.agentId, mandOpts);
      return reply.send({ mandates });
    }
  );

  // ── GET /commerce/stores/:storeId/agents/:agentId/mandates/:mandateId/verify
  app.get(
    "/commerce/stores/:storeId/agents/:agentId/mandates/:mandateId/verify",
    { preHandler: [storeAuthAdmin], schema: { params: MandateParams } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const result = await verifyMandate(storeId, request.params.mandateId);
      const status = result.valid ? 200 : 422;
      return reply.status(status).send(result);
    }
  );

  // ── DELETE /commerce/stores/:storeId/agents/:agentId/mandates/:mandateId
  app.delete(
    "/commerce/stores/:storeId/agents/:agentId/mandates/:mandateId",
    // Body is optional (reason only); thin safeParse to handle missing body gracefully
    { preHandler: [storeAuthAdmin], schema: { params: MandateParams } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const body = RevokeBody.safeParse(request.body ?? {});
      const revoked = await revokeMandate(
        storeId,
        request.params.mandateId,
        body.success ? body.data.reason : undefined
      );
      if (!revoked) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "mandate not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/stores/:storeId/agents/audit-log — store-level agent audit log ─
  app.get(
    "/commerce/stores/:storeId/agents/audit-log",
    { preHandler: [storeAuthAdmin], schema: { params: StoreParams, querystring: ListQuerystring } },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const storeAuditOpts: { agentId?: string; limit?: number; offset?: number; status?: string } = {};
      if (request.query.agent_id !== undefined) storeAuditOpts.agentId = request.query.agent_id;
      if (request.query.limit !== undefined) storeAuditOpts.limit = request.query.limit;
      if (request.query.offset !== undefined) storeAuditOpts.offset = request.query.offset;
      if (request.query.status !== undefined) storeAuditOpts.status = request.query.status;
      const logs = await listAuditLog(storeId, storeAuditOpts);
      return reply.send({ audit_log: logs });
    }
  );
};
