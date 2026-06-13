/**
 * apikeys/routes.ts — Fastify plugin for API key CRUD.
 *
 * Routes (all require JWT auth — org-level key management):
 *   GET    /api-keys                  — list org's active API keys
 *   POST   /api-keys                  — issue a new key (full key returned once)
 *   PATCH  /api-keys/:keyId           — update name/scopes/store_id/expires_at
 *   DELETE /api-keys/:keyId           — revoke key (soft delete)
 *
 * The cartcrft port maps webcrft's /api-keys endpoints 1:1
 * (renamed prefixes wc_ → cc_, table platform_api_keys → api_keys,
 * site_id → store_id).
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireJwt } from "../../lib/auth/middleware.js";
import {
  createApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  validateScopes,
} from "./service.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateKeyBody = z.object({
  name: z.string().min(1, "name is required").max(255),
  key_type: z.enum(["public", "private"]).optional(),
  scopes: z.array(z.string()).optional(),
  store_id: z.string().uuid().nullable().optional(),
  expires_at: z.string().nullable().optional(), // RFC3339 or null
});

const UpdateKeyBody = z
  .object({
    name: z.string().min(1).max(255).optional(),
    scopes: z.array(z.string()).optional(),
    store_id: z.string().uuid().nullable().optional(),
    expires_at: z.string().nullable().optional(), // RFC3339, "" = clear, null = clear
  })
  .passthrough(); // we use raw JSON to detect explicit null for store_id / expires_at

const KeyIdParams = z.object({
  keyId: z.string().uuid("keyId must be a UUID"),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const apiKeysPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /api-keys ─────────────────────────────────────────────────────────
  app.get(
    "/api-keys",
    { preHandler: [requireJwt] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const keys = await listApiKeys(orgId);
      return reply.send({ keys });
    }
  );

  // ── POST /api-keys ────────────────────────────────────────────────────────
  app.post(
    "/api-keys",
    {
      preHandler: [requireJwt],
      schema: { body: CreateKeyBody },
    },
    async (request, reply) => {
      const { orgId, userId } = request.auth!;
      const { name, key_type, scopes, store_id, expires_at } = request.body as z.infer<typeof CreateKeyBody>;

      // Validate key_type
      const keyType = key_type ?? "private";
      if (keyType !== "public" && keyType !== "private") {
        return reply.status(400).send({
          error: {
            code: "INVALID_KEY_TYPE",
            message: "key_type must be 'public' or 'private'",
          },
        });
      }

      // Validate scopes.
      const scopeList = scopes ?? [];
      const scopeErr = validateScopes(keyType, scopeList);
      if (scopeErr) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_SCOPES", message: scopeErr } });
      }

      // Validate expires_at format if provided.
      if (expires_at) {
        const t = Date.parse(expires_at);
        if (isNaN(t)) {
          return reply.status(400).send({
            error: {
              code: "INVALID_EXPIRES_AT",
              message: "expires_at must be RFC3339 (e.g. 2027-01-01T00:00:00Z)",
            },
          });
        }
      }

      try {
        const result = await createApiKey(orgId, userId ?? null, {
          name,
          key_type: keyType,
          scopes: scopeList,
          store_id: store_id ?? null,
          expires_at: expires_at ?? null,
        });
        return reply.status(201).send(result);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "INVALID_SCOPES"
        ) {
          return reply
            .status(400)
            .send({ error: { code: "INVALID_SCOPES", message: err.message } });
        }
        throw err;
      }
    }
  );

  // ── PATCH /api-keys/:keyId ────────────────────────────────────────────────
  // Note: The PATCH route uses raw body inspection to distinguish "omitted"
  // from "explicit null" for store_id / expires_at. We add params schema for
  // OpenAPI but keep manual body handling to preserve null-vs-omitted semantics.
  app.patch(
    "/api-keys/:keyId",
    {
      preHandler: [requireJwt],
      schema: { params: KeyIdParams },
    },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { keyId } = request.params as z.infer<typeof KeyIdParams>;

      // Parse as raw object to distinguish "omitted" from "explicit null".
      const raw = request.body as Record<string, unknown>;

      const updateInput: Parameters<typeof updateApiKey>[2] = {};

      if (typeof raw["name"] === "string") {
        updateInput.name = raw["name"];
      }
      if (Array.isArray(raw["scopes"])) {
        updateInput.scopes = raw["scopes"] as string[];
      }
      // store_id: explicit null or "" → clear; UUID string → set; omitted → don't touch
      if ("store_id" in raw) {
        if (raw["store_id"] === null || raw["store_id"] === "") {
          updateInput.store_id_clear = true;
        } else if (typeof raw["store_id"] === "string") {
          updateInput.store_id = raw["store_id"];
        }
      }
      // expires_at: explicit null or "" → clear; RFC3339 string → set
      if ("expires_at" in raw) {
        if (
          raw["expires_at"] === null ||
          raw["expires_at"] === ""
        ) {
          updateInput.expires_at_clear = true;
        } else if (typeof raw["expires_at"] === "string") {
          const t = Date.parse(raw["expires_at"]);
          if (isNaN(t)) {
            return reply.status(400).send({
              error: {
                code: "INVALID_EXPIRES_AT",
                message: "expires_at must be RFC3339 or empty string to clear",
              },
            });
          }
          updateInput.expires_at = raw["expires_at"];
        }
      }

      if (
        Object.keys(updateInput).length === 0
      ) {
        return reply
          .status(400)
          .send({ error: { code: "BAD_REQUEST", message: "no fields to update" } });
      }

      try {
        const updated = await updateApiKey(keyId, orgId, updateInput);
        if (!updated) {
          return reply.status(404).send({
            error: {
              code: "NOT_FOUND",
              message: "key not found or already revoked",
            },
          });
        }
        return reply.send({ ok: true });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "INVALID_SCOPES"
        ) {
          return reply
            .status(400)
            .send({ error: { code: "INVALID_SCOPES", message: err.message } });
        }
        throw err;
      }
    }
  );

  // ── DELETE /api-keys/:keyId ───────────────────────────────────────────────
  app.delete(
    "/api-keys/:keyId",
    {
      preHandler: [requireJwt],
      schema: { params: KeyIdParams },
    },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { keyId } = request.params as z.infer<typeof KeyIdParams>;

      const revoked = await revokeApiKey(keyId, orgId);
      if (!revoked) {
        return reply.status(404).send({
          error: {
            code: "NOT_FOUND",
            message: "key not found or already revoked",
          },
        });
      }
      return reply.send({ ok: true });
    }
  );
};
