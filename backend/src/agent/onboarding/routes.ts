/**
 * agent/onboarding/routes.ts — Fastify plugin for agent-surface onboarding (B7).
 *
 * Org/store-scoped, write-auth (storeAuthWrite — cc_prv_ commerce:write or JWT;
 * cc_pub_ rejected). RLS in 0022 + withTx enforce tenant isolation at the DB
 * layer (org A cannot touch org B's connections).
 *
 * Routes (under /commerce/stores/:storeId):
 *   GET    /agent-surfaces                          — list connections
 *   GET    /agent-surfaces/:surface/connect         — 2-click connect descriptor
 *   POST   /agent-surfaces                          — create/update a connection
 *   POST   /agent-surfaces/:surface/mock-connect    — dev-only mock OAuth complete
 *   GET    /agent-surfaces/:surface/oauth/callback  — OAuth redirect callback
 *   POST   /agent-surfaces/:id/submit-feed          — generate + submit feed now
 *   DELETE /agent-surfaces/:id                       — disconnect
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthWrite } from "../../lib/auth/middleware.js";
import { config } from "../../config/config.js";
import {
  listConnections,
  upsertConnection,
  deleteConnection,
  submitFeed,
  connectInstructions,
  mockConnect,
} from "./service.js";
import { AGENT_SURFACES } from "./types.js";

const SurfaceEnum = z.enum(["google_merchant", "chatgpt_acp"]);

const StoreIdParams = z.object({ storeId: z.string().uuid() });
const SurfaceParams = z.object({
  storeId: z.string().uuid(),
  surface: SurfaceEnum,
});
const ConnParams = z.object({
  storeId: z.string().uuid(),
  id: z.string().uuid(),
});

const CreateBody = z.object({
  surface: SurfaceEnum,
  external_account_id: z.string().optional(),
  credentials: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  status: z
    .enum(["disconnected", "pending", "connected", "error"])
    .optional(),
});

const MockConnectBody = z.object({
  external_account_id: z.string().min(1),
});

const OAuthCallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

export const onboardingPlugin: FastifyPluginAsyncZod = async (app) => {
  const base = "/commerce/stores/:storeId/agent-surfaces";

  // ── List connections (+ available surfaces) ────────────────────────────────
  app.get(
    base,
    { preHandler: [storeAuthWrite], schema: { params: StoreIdParams } },
    async (request, reply) => {
      const connections = await listConnections(request.params.storeId);
      return reply.send({ surfaces: AGENT_SURFACES, connections });
    }
  );

  // ── 2-click connect descriptor (OAuth URL / instructions) ──────────────────
  app.get(
    `${base}/:surface/connect`,
    { preHandler: [storeAuthWrite], schema: { params: SurfaceParams } },
    async (request, reply) => {
      const info = connectInstructions(
        request.params.storeId,
        request.params.surface
      );
      return reply.send({ connect: info });
    }
  );

  // ── Create / update a connection ───────────────────────────────────────────
  app.post(
    base,
    { preHandler: [storeAuthWrite], schema: { params: StoreIdParams, body: CreateBody } },
    async (request, reply) => {
      const conn = await upsertConnection(request.params.storeId, request.body);
      return reply.status(201).send({ connection: conn });
    }
  );

  // ── Dev-only mock OAuth completion (mirrors customer-auth mock-oauth) ───────
  if (config.APP_ENV !== "production") {
    app.post(
      `${base}/:surface/mock-connect`,
      { preHandler: [storeAuthWrite], schema: { params: SurfaceParams, body: MockConnectBody } },
      async (request, reply) => {
        const conn = await mockConnect(
          request.params.storeId,
          request.params.surface,
          request.body.external_account_id
        );
        return reply.status(201).send({ connection: conn });
      }
    );
  }

  // ── OAuth redirect callback (Google). Stores a pending connection; the real
  //    token exchange is credential-gated (needs client secret). In dev this
  //    just records the account so the wizard can proceed. ─────────────────────
  app.get(
    `${base}/:surface/oauth/callback`,
    { preHandler: [storeAuthWrite], schema: { params: SurfaceParams, querystring: OAuthCallbackQuery } },
    async (request, reply) => {
      if (request.query.error) {
        return reply.status(400).send({
          error: { code: "OAUTH_DENIED", message: request.query.error },
        });
      }
      // The authorization code would be exchanged for tokens here using
      // GOOGLE_OAUTH_CLIENT_SECRET. That exchange is credential-gated; record
      // a pending connection carrying the code in config for completion.
      const conn = await upsertConnection(request.params.storeId, {
        surface: request.params.surface,
        status: "pending",
        config: { oauth_code_received: Boolean(request.query.code) },
      });
      return reply.send({ connection: conn });
    }
  );

  // ── Submit feed now (generate + push to surface) ───────────────────────────
  app.post(
    `${base}/:id/submit-feed`,
    { preHandler: [storeAuthWrite], schema: { params: ConnParams } },
    async (request, reply) => {
      try {
        const result = await submitFeed(request.params.storeId, request.params.id);
        return reply.send({ result });
      } catch (err) {
        const e = err as Error & { code?: string };
        if (e.code === "NOT_FOUND") {
          return reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: "connection not found" } });
        }
        if (e.code === "CREDENTIALS_REQUIRED") {
          return reply.status(409).send({
            error: { code: "CREDENTIALS_REQUIRED", message: e.message },
          });
        }
        throw err;
      }
    }
  );

  // ── Disconnect ─────────────────────────────────────────────────────────────
  app.delete(
    `${base}/:id`,
    { preHandler: [storeAuthWrite], schema: { params: ConnParams } },
    async (request, reply) => {
      const ok = await deleteConnection(request.params.storeId, request.params.id);
      if (!ok) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "connection not found" } });
      }
      return reply.send({ ok: true });
    }
  );
};
