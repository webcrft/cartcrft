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

import type { FastifyPluginAsync } from "fastify";
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
  insertAuditLog,
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

export const agentsPlugin: FastifyPluginAsync = async (app) => {

  // ── POST /commerce/stores/:storeId/agents — create agent ─────────────────
  app.post(
    "/commerce/stores/:storeId/agents",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const parsed = CreateAgentBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      try {
        const agent = await createAgent(storeId, parsed.data as import("./types.js").CreateAgentInput);
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
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const q = ListQuerystring.safeParse(request.query);
      const listOpts: { limit?: number; offset?: number } = {};
      if (q.success && q.data.limit !== undefined) listOpts.limit = q.data.limit;
      if (q.success && q.data.offset !== undefined) listOpts.offset = q.data.offset;
      const agents = await listAgents(storeId, listOpts);
      return reply.send({ agents });
    }
  );

  // ── GET /commerce/stores/:storeId/agents/:agentId — get agent ────────────
  app.get(
    "/commerce/stores/:storeId/agents/:agentId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreAgentParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const agent = await getAgent(storeId, params.data.agentId);
      if (!agent) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "agent not found" } });
      }
      return reply.send({ agent });
    }
  );

  // ── PUT /commerce/stores/:storeId/agents/:agentId — update agent ─────────
  app.put(
    "/commerce/stores/:storeId/agents/:agentId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreAgentParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const parsed = UpdateAgentBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      const updated = await updateAgent(storeId, params.data.agentId, parsed.data as import("./types.js").UpdateAgentInput);
      if (!updated) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "agent not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── DELETE /commerce/stores/:storeId/agents/:agentId — revoke agent ──────
  app.delete(
    "/commerce/stores/:storeId/agents/:agentId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreAgentParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const revoked = await revokeAgent(storeId, params.data.agentId);
      if (!revoked) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "agent not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/stores/:storeId/agents/:agentId/audit-log ──────────────
  app.get(
    "/commerce/stores/:storeId/agents/:agentId/audit-log",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreAgentParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const q = ListQuerystring.safeParse(request.query);
      const auditOpts: { agentId?: string; limit?: number; offset?: number; status?: string } = {
        agentId: params.data.agentId,
      };
      if (q.success && q.data.limit !== undefined) auditOpts.limit = q.data.limit;
      if (q.success && q.data.offset !== undefined) auditOpts.offset = q.data.offset;
      if (q.success && q.data.status !== undefined) auditOpts.status = q.data.status;
      const logs = await listAuditLog(storeId, auditOpts);
      return reply.send({ audit_log: logs });
    }
  );

  // ── POST /commerce/stores/:storeId/agents/:agentId/mandates — create ──────
  app.post(
    "/commerce/stores/:storeId/agents/:agentId/mandates",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreAgentParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const parsed = CreateMandateBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      try {
        const mandate = await createMandate(storeId, {
          agent_id: params.data.agentId,
          ...parsed.data,
          payload: parsed.data.payload as import("./types.js").MandatePayload,
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
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreAgentParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const q = ListQuerystring.safeParse(request.query);
      const mandOpts: { limit?: number; offset?: number; type?: string; active?: boolean } = {};
      if (q.success && q.data.limit !== undefined) mandOpts.limit = q.data.limit;
      if (q.success && q.data.offset !== undefined) mandOpts.offset = q.data.offset;
      if (q.success && q.data.type !== undefined) mandOpts.type = q.data.type;
      if (q.success && q.data.active !== undefined) mandOpts.active = q.data.active;
      const mandates = await listMandates(storeId, params.data.agentId, mandOpts);
      return reply.send({ mandates });
    }
  );

  // ── GET /commerce/stores/:storeId/agents/:agentId/mandates/:mandateId/verify
  app.get(
    "/commerce/stores/:storeId/agents/:agentId/mandates/:mandateId/verify",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = MandateParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const result = await verifyMandate(storeId, params.data.mandateId);
      const status = result.valid ? 200 : 422;
      return reply.status(status).send(result);
    }
  );

  // ── DELETE /commerce/stores/:storeId/agents/:agentId/mandates/:mandateId
  app.delete(
    "/commerce/stores/:storeId/agents/:agentId/mandates/:mandateId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = MandateParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const parsed = RevokeBody.safeParse(request.body);
      const revoked = await revokeMandate(
        storeId,
        params.data.mandateId,
        parsed.success ? parsed.data.reason : undefined
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
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const q = ListQuerystring.safeParse(request.query);
      const storeAuditOpts: { agentId?: string; limit?: number; offset?: number; status?: string } = {};
      if (q.success && q.data.agent_id !== undefined) storeAuditOpts.agentId = q.data.agent_id;
      if (q.success && q.data.limit !== undefined) storeAuditOpts.limit = q.data.limit;
      if (q.success && q.data.offset !== undefined) storeAuditOpts.offset = q.data.offset;
      if (q.success && q.data.status !== undefined) storeAuditOpts.status = q.data.status;
      const logs = await listAuditLog(storeId, storeAuditOpts);
      return reply.send({ audit_log: logs });
    }
  );
};
