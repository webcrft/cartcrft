/**
 * stores/routes.ts — Fastify plugin for stores CRUD.
 *
 * Routes:
 *   GET    /commerce/stores           — list org's stores (JWT)
 *   POST   /commerce/stores           — create store (JWT)
 *   GET    /commerce/stores/:storeId  — get store (storeAuthAdmin)
 *   PUT    /commerce/stores/:storeId  — update store (storeAuthAdmin)
 *   DELETE /commerce/stores/:storeId  — delete store (JWT)
 *
 * Super endpoints (env-gated SUPER_TOKEN):
 *   POST /super/commerce/stores/:storeId/takedown
 *   POST /super/commerce/stores/:storeId/restore
 *
 * Module pattern: routes = Fastify plugin with zod schemas; service = SQL.
 * No business logic in routes.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  requireJwt,
  storeAuthAdmin,
} from "../../lib/auth/middleware.js";
import { timingSafeCheckSuperToken } from "../../lib/auth/super-token.js";
import {
  listStores,
  getStore,
  createStore,
  updateStore,
  deleteStore,
  takedownStore,
  restoreStore,
} from "./service.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const CreateStoreBody = z.object({
  name: z.string().min(1, "name is required").max(255),
  slug: z.string().min(1).max(80).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().max(64).optional(),
  country_code: z.string().length(2).optional(),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  phone: z.string().max(32).optional(),
  weight_unit: z.enum(["g", "kg", "lb", "oz"]).optional(),
  enable_currency_conversion: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateStoreBody = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(80).optional(),
  currency: z.string().length(3).optional(),
  timezone: z.string().max(64).optional(),
  country_code: z.string().length(2).optional(),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  phone: z.string().max(32).optional(),
  weight_unit: z.enum(["g", "kg", "lb", "oz"]).optional(),
  is_active: z.boolean().optional(),
  enable_currency_conversion: z.boolean().optional(),
  domain: z.string().max(253).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** When true, agent-attributed checkouts require a valid mandate chain. */
  agents_require_mandate: z.boolean().optional(),
});

const StoreIdParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
});

const ListQuerystring = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const TakedownBody = z.object({
  reason: z.string().min(1, "reason is required").max(500),
});

// (Local checkSuperToken wrapper removed — routes now call
//  timingSafeCheckSuperToken directly via the shared helper.)

// ── Plugin ────────────────────────────────────────────────────────────────────

export const storesPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /commerce/stores ─────────────────────────────────────────────────
  app.get(
    "/commerce/stores",
    {
      preHandler: [requireJwt],
    },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const query = ListQuerystring.safeParse(request.query);
      const storeListOpts: { limit?: number; offset?: number } = {};
      if (query.success && query.data.limit !== undefined)
        storeListOpts.limit = query.data.limit;
      if (query.success && query.data.offset !== undefined)
        storeListOpts.offset = query.data.offset;
      const stores = await listStores(orgId, storeListOpts);
      return reply.send({ stores });
    }
  );

  // ── POST /commerce/stores ─────────────────────────────────────────────────
  app.post(
    "/commerce/stores",
    {
      preHandler: [requireJwt],
    },
    async (request, reply) => {
      const { orgId } = request.auth!;

      const parsed = CreateStoreBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: parsed.error.issues,
          },
        });
      }

      try {
        const storeId = await createStore(orgId, {
          name: parsed.data.name,
          ...(parsed.data.slug !== undefined && { slug: parsed.data.slug }),
          ...(parsed.data.currency !== undefined && { currency: parsed.data.currency }),
          ...(parsed.data.timezone !== undefined && { timezone: parsed.data.timezone }),
          ...(parsed.data.country_code !== undefined && { country_code: parsed.data.country_code }),
          ...(parsed.data.email !== undefined && { email: parsed.data.email }),
          ...(parsed.data.phone !== undefined && { phone: parsed.data.phone }),
          ...(parsed.data.weight_unit !== undefined && { weight_unit: parsed.data.weight_unit }),
          ...(parsed.data.enable_currency_conversion !== undefined && {
            enable_currency_conversion: parsed.data.enable_currency_conversion,
          }),
          ...(parsed.data.metadata !== undefined && { metadata: parsed.data.metadata }),
        });
        return reply.status(201).send({ id: storeId });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "DUPLICATE_SLUG"
        ) {
          return reply.status(409).send({
            error: {
              code: "DUPLICATE_SLUG",
              message: err.message,
            },
          });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId ─────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId",
    {
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }
      const store = await getStore(params.data.storeId);
      if (!store) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "store not found" } });
      }
      return reply.send(store);
    }
  );

  // ── PUT /commerce/stores/:storeId ─────────────────────────────────────────
  app.put(
    "/commerce/stores/:storeId",
    {
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      const parsed = UpdateStoreBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: parsed.error.issues,
          },
        });
      }

      try {
        const updateInput: import("./types.js").UpdateStoreInput = {};
        const d = parsed.data;
        if (d.name !== undefined) updateInput.name = d.name;
        if (d.slug !== undefined) updateInput.slug = d.slug;
        if (d.currency !== undefined) updateInput.currency = d.currency;
        if (d.timezone !== undefined) updateInput.timezone = d.timezone;
        if (d.country_code !== undefined) updateInput.country_code = d.country_code;
        if (d.email !== undefined) updateInput.email = d.email;
        if (d.phone !== undefined) updateInput.phone = d.phone;
        if (d.weight_unit !== undefined) updateInput.weight_unit = d.weight_unit;
        if (d.is_active !== undefined) updateInput.is_active = d.is_active;
        if (d.enable_currency_conversion !== undefined)
          updateInput.enable_currency_conversion = d.enable_currency_conversion;
        if (d.domain !== undefined) updateInput.domain = d.domain;
        if (d.metadata !== undefined) updateInput.metadata = d.metadata;
        if (d.agents_require_mandate !== undefined)
          updateInput.agents_require_mandate = d.agents_require_mandate;

        const updated = await updateStore(params.data.storeId, updateInput);
        if (!updated) {
          return reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: "store not found" } });
        }
        return reply.send({ ok: true });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "CURRENCY_LOCKED"
        ) {
          return reply.status(409).send({
            error: { code: "CURRENCY_LOCKED", message: err.message },
          });
        }
        throw err;
      }
    }
  );

  // ── DELETE /commerce/stores/:storeId ──────────────────────────────────────
  app.delete(
    "/commerce/stores/:storeId",
    {
      preHandler: [requireJwt],
    },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      // JWT callers must own the store (org check).
      const { storeExistsInOrg } = await import("./service.js");
      const owned = await storeExistsInOrg(params.data.storeId, orgId);
      if (!owned) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "store not found" } });
      }

      const deleted = await deleteStore(params.data.storeId);
      if (!deleted) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "store not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── Super: POST /super/commerce/stores/:storeId/takedown ─────────────────
  // Auth chain: requireJwt (first) verifies a valid platform JWT, then the
  // x-super-token header is validated with a constant-time comparison —
  // matching the pattern used by the payments super-routes.
  app.post(
    "/super/commerce/stores/:storeId/takedown",
    { preHandler: [requireJwt] },
    async (request, reply) => {
      const superToken = request.headers["x-super-token"];
      if (!timingSafeCheckSuperToken(typeof superToken === "string" ? superToken : undefined)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "super-admin access required" } });
      }

      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      const parsed = TakedownBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "reason is required" },
        });
      }

      await takedownStore(params.data.storeId, parsed.data.reason);
      return reply.send({ ok: true });
    }
  );

  // ── Super: POST /super/commerce/stores/:storeId/restore ──────────────────
  app.post(
    "/super/commerce/stores/:storeId/restore",
    { preHandler: [requireJwt] },
    async (request, reply) => {
      const superToken = request.headers["x-super-token"];
      if (!timingSafeCheckSuperToken(typeof superToken === "string" ? superToken : undefined)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "super-admin access required" } });
      }

      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      await restoreStore(params.data.storeId);
      return reply.send({ ok: true });
    }
  );
};
