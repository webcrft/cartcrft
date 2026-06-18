/**
 * customers/routes.ts — Fastify plugin for admin customer management.
 *
 * All routes are under /commerce/stores/:storeId/customers and require
 * storeAuthAdmin or storeAuthWrite tier.
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  storeAuthAdmin,
  storeAuthWrite,
} from "../../lib/auth/middleware.js";
import { getPool, getReadDb } from "../../db/pool.js";
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  blockCustomer,
  unblockCustomer,
  addCustomerAddress,
  deleteCustomerAddress,
  listCustomerTags,
  setCustomerTags,
  listAuditLog,
} from "./service.js";
import { createInvitation } from "../customer-auth/service.js";

// ── Schemas ───────────────────────────────────────────────────────────────────

const StoreIdParams = z.object({
  storeId: z.string().uuid(),
});

const CustomerIdParams = z.object({
  storeId: z.string().uuid(),
  customerId: z.string().uuid(),
});

const AddressIdParams = z.object({
  storeId: z.string().uuid(),
  customerId: z.string().uuid(),
  addressId: z.string().uuid(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  q: z.string().optional(),
});

const CreateCustomerBody = z.object({
  email: z.string().email(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  display_name: z.string().max(200).optional(),
  phone: z.string().max(32).optional(),
  is_admin: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdateCustomerBody = z.object({
  email: z.string().email().optional(),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  display_name: z.string().max(200).optional(),
  phone: z.string().max(32).optional(),
  is_admin: z.boolean().optional(),
  is_active: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const BlockBody = z.object({
  reason: z.string().max(500).optional(),
});

const AddressBody = z.object({
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  company: z.string().max(200).optional(),
  address1: z.string().max(300).optional(),
  address2: z.string().max(300).optional(),
  city: z.string().max(100).optional(),
  province: z.string().max(100).optional(),
  zip: z.string().max(20).optional(),
  country_code: z.string().length(2).optional(),
  phone: z.string().max(32).optional(),
  is_default: z.boolean().optional(),
});

const TagsBody = z.object({
  tags: z.array(z.string().max(100)).max(50),
});

const InviteBody = z.object({
  email: z.string().email(),
});

const AuditLogQuery = z.object({
  customer_id: z.string().uuid().optional(),
  event: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const customersPlugin: FastifyPluginAsyncZod = async (app) => {
  const base = "/commerce/stores/:storeId";

  // GET /commerce/stores/:storeId/customers
  app.get(
    `${base}/customers`,
    {
      schema: { params: StoreIdParams, querystring: ListQuery },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const q = request.query;
      // RLS-enforced read path (P4/item-2).
      const pool = getReadDb();
      const result = await listCustomers(pool, storeId, q as { limit?: number; offset?: number; q?: string });
      return reply.send(result);
    }
  );

  // POST /commerce/stores/:storeId/customers
  app.post(
    `${base}/customers`,
    {
      schema: { params: StoreIdParams, body: CreateCustomerBody },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const pool = getPool();
      const id = await createCustomer(pool, storeId, request.body as import("./service.js").CreateCustomerInput);
      return reply.status(201).send({ id });
    }
  );

  // POST /commerce/stores/:storeId/customers/invite
  app.post(
    `${base}/customers/invite`,
    {
      schema: { params: StoreIdParams, body: InviteBody },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const pool = getPool();
      await createInvitation(pool, storeId, request.body.email);
      return reply.status(200).send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/customers/:customerId
  app.get(
    `${base}/customers/:customerId`,
    {
      schema: { params: CustomerIdParams },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      // RLS-enforced read path (P4/item-2).
      const pool = getReadDb();
      const customer = await getCustomer(pool, storeId, customerId);
      if (!customer) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "customer not found" } });
      }
      return reply.send({ customer });
    }
  );

  // PUT /commerce/stores/:storeId/customers/:customerId
  app.put(
    `${base}/customers/:customerId`,
    {
      schema: { params: CustomerIdParams, body: UpdateCustomerBody },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const pool = getPool();
      const ok = await updateCustomer(pool, storeId, customerId, request.body as import("./service.js").UpdateCustomerInput);
      if (!ok) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "customer not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // POST /commerce/stores/:storeId/customers/:customerId/block
  app.post(
    `${base}/customers/:customerId/block`,
    {
      schema: { params: CustomerIdParams, body: BlockBody },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const pool = getPool();
      const ok = await blockCustomer(pool, storeId, customerId, request.body.reason ?? "");
      if (!ok) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "customer not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // POST /commerce/stores/:storeId/customers/:customerId/unblock
  app.post(
    `${base}/customers/:customerId/unblock`,
    {
      schema: { params: CustomerIdParams },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const pool = getPool();
      const ok = await unblockCustomer(pool, storeId, customerId);
      if (!ok) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "customer not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/customers/:customerId
  app.delete(
    `${base}/customers/:customerId`,
    {
      schema: { params: CustomerIdParams },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const pool = getPool();
      const ok = await deleteCustomer(pool, storeId, customerId);
      if (!ok) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "customer not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // POST /commerce/stores/:storeId/customers/:customerId/addresses
  app.post(
    `${base}/customers/:customerId/addresses`,
    {
      schema: { params: CustomerIdParams, body: AddressBody },
      preHandler: [storeAuthWrite("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const pool = getPool();
      try {
        const id = await addCustomerAddress(pool, storeId, customerId, request.body as import("./service.js").AddressInput);
        return reply.status(201).send({ id });
      } catch (err) {
        if (err instanceof Error && err.message === "customer not found") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "customer not found" } });
        }
        throw err;
      }
    }
  );

  // DELETE /commerce/stores/:storeId/customers/:customerId/addresses/:addressId
  app.delete(
    `${base}/customers/:customerId/addresses/:addressId`,
    {
      schema: { params: AddressIdParams },
      preHandler: [storeAuthWrite("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId, addressId } = request.params;
      const pool = getPool();
      const ok = await deleteCustomerAddress(pool, storeId, customerId, addressId);
      if (!ok) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "address not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/customers/:customerId/tags
  app.get(
    `${base}/customers/:customerId/tags`,
    {
      schema: { params: CustomerIdParams },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      // RLS-enforced read path (P4/item-2).
      const pool = getReadDb();
      const tags = await listCustomerTags(pool, storeId, customerId);
      return reply.send({ tags });
    }
  );

  // PUT /commerce/stores/:storeId/customers/:customerId/tags
  app.put(
    `${base}/customers/:customerId/tags`,
    {
      schema: { params: CustomerIdParams, body: TagsBody },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId, customerId } = request.params;
      const pool = getPool();
      const ok = await setCustomerTags(pool, storeId, customerId, request.body.tags);
      if (!ok) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "customer not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/audit-log
  app.get(
    `${base}/audit-log`,
    {
      schema: { params: StoreIdParams, querystring: AuditLogQuery },
      preHandler: [storeAuthAdmin("customers")],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const q = request.query;
      // RLS-enforced read path (P4/item-2).
      const pool = getReadDb();
      const entries = await listAuditLog(pool, storeId, {
        customerId: q.customer_id as string | undefined,
        event: q.event as string | undefined,
        limit: q.limit as number | undefined,
      });
      return reply.send({ entries });
    }
  );
};
