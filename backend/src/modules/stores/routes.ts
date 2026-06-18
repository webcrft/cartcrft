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
      schema: { querystring: ListQuerystring },
    },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const q = request.query as z.infer<typeof ListQuerystring>;
      const storeListOpts: { limit?: number; offset?: number } = {};
      if (q.limit !== undefined) storeListOpts.limit = q.limit;
      if (q.offset !== undefined) storeListOpts.offset = q.offset;
      const stores = await listStores(orgId, storeListOpts);
      return reply.send({ stores });
    }
  );

  // ── POST /commerce/stores ─────────────────────────────────────────────────
  app.post(
    "/commerce/stores",
    {
      preHandler: [requireJwt],
      schema: { body: CreateStoreBody },
    },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const data = request.body as z.infer<typeof CreateStoreBody>;

      try {
        const storeId = await createStore(orgId, {
          name: data.name,
          ...(data.slug !== undefined && { slug: data.slug }),
          ...(data.currency !== undefined && { currency: data.currency }),
          ...(data.timezone !== undefined && { timezone: data.timezone }),
          ...(data.country_code !== undefined && { country_code: data.country_code }),
          ...(data.email !== undefined && { email: data.email }),
          ...(data.phone !== undefined && { phone: data.phone }),
          ...(data.weight_unit !== undefined && { weight_unit: data.weight_unit }),
          ...(data.enable_currency_conversion !== undefined && {
            enable_currency_conversion: data.enable_currency_conversion,
          }),
          ...(data.metadata !== undefined && { metadata: data.metadata }),
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
      preHandler: [storeAuthAdmin("store")],
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof StoreIdParams>;
      const store = await getStore(params.storeId);
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
      preHandler: [storeAuthAdmin("store")],
      schema: { params: StoreIdParams, body: UpdateStoreBody },
    },
    async (request, reply) => {
      const params = request.params as z.infer<typeof StoreIdParams>;
      const data = request.body as z.infer<typeof UpdateStoreBody>;

      try {
        const updateInput: import("./types.js").UpdateStoreInput = {};
        if (data.name !== undefined) updateInput.name = data.name;
        if (data.slug !== undefined) updateInput.slug = data.slug;
        if (data.currency !== undefined) updateInput.currency = data.currency;
        if (data.timezone !== undefined) updateInput.timezone = data.timezone;
        if (data.country_code !== undefined) updateInput.country_code = data.country_code;
        if (data.email !== undefined) updateInput.email = data.email;
        if (data.phone !== undefined) updateInput.phone = data.phone;
        if (data.weight_unit !== undefined) updateInput.weight_unit = data.weight_unit;
        if (data.is_active !== undefined) updateInput.is_active = data.is_active;
        if (data.enable_currency_conversion !== undefined)
          updateInput.enable_currency_conversion = data.enable_currency_conversion;
        if (data.domain !== undefined) updateInput.domain = data.domain;
        if (data.metadata !== undefined) updateInput.metadata = data.metadata;
        if (data.agents_require_mandate !== undefined)
          updateInput.agents_require_mandate = data.agents_require_mandate;

        const updated = await updateStore(params.storeId, updateInput);
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
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const params = request.params as z.infer<typeof StoreIdParams>;

      // JWT callers must own the store (org check).
      const { storeExistsInOrg } = await import("./service.js");
      const owned = await storeExistsInOrg(params.storeId, orgId);
      if (!owned) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "store not found" } });
      }

      const deleted = await deleteStore(params.storeId);
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
    {
      preHandler: [requireJwt],
      schema: { params: StoreIdParams, body: TakedownBody },
    },
    async (request, reply) => {
      const superToken = request.headers["x-super-token"];
      if (!timingSafeCheckSuperToken(typeof superToken === "string" ? superToken : undefined)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "super-admin access required" } });
      }

      const params = request.params as z.infer<typeof StoreIdParams>;
      const data = request.body as z.infer<typeof TakedownBody>;

      await takedownStore(params.storeId, data.reason);
      return reply.send({ ok: true });
    }
  );

  // ── Super: POST /super/commerce/stores/:storeId/restore ──────────────────
  app.post(
    "/super/commerce/stores/:storeId/restore",
    {
      preHandler: [requireJwt],
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      const superToken = request.headers["x-super-token"];
      if (!timingSafeCheckSuperToken(typeof superToken === "string" ? superToken : undefined)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "super-admin access required" } });
      }

      const params = request.params as z.infer<typeof StoreIdParams>;

      await restoreStore(params.storeId);
      return reply.send({ ok: true });
    }
  );
};
