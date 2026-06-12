/**
 * b2b/routes.ts — Fastify plugin for B2B commerce routes.
 *
 * Endpoints:
 *  Companies: CRUD under /commerce/stores/:storeId/companies
 *  Company customers: /commerce/stores/:storeId/companies/:companyId/customers
 *  Customer groups: /commerce/stores/:storeId/customer-groups
 *  Quotes: /commerce/stores/:storeId/quotes + lifecycle actions
 *  Purchase orders: /commerce/stores/:storeId/purchase-orders
 *                   /commerce/stores/:storeId/orders/:orderId/purchase-order
 *
 * Auth: all routes require admin-tier (JWT or cc_prv_ commerce:admin).
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin, storeAuthWrite } from "../../lib/auth/middleware.js";
import {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  listCompanyCustomers,
  addCompanyCustomer,
  removeCompanyCustomer,
  listCustomerGroups,
  createCustomerGroup,
  updateCustomerGroup,
  deleteCustomerGroup,
  addGroupMember,
  removeGroupMember,
  listQuotes,
  getQuote,
  createQuote,
  updateQuote,
  sendQuote,
  acceptQuote,
  rejectQuote,
  listPurchaseOrders,
  getPurchaseOrder,
  attachPurchaseOrder,
  updatePurchaseOrder,
} from "./service.js";

const UUID = z.string().uuid();
const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}
function badRequest(msg: string, code = "VALIDATION_ERROR") {
  return { error: { code, message: msg } };
}
function unprocessable(msg: string, code = "INVALID_TRANSITION") {
  return { error: { code, message: msg } };
}

export const b2bPlugin: FastifyPluginAsync = async (app) => {
  const storeParams = z.object({ storeId: UUID });

  // ── Companies ────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/companies",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const companies = await listCompanies(params.data.storeId);
      return reply.send({ companies });
    }
  );

  app.post(
    "/commerce/stores/:storeId/companies",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const body = z
        .object({
          name: z.string().min(1),
          email: z.string().email().optional().nullable(),
          phone: z.string().optional().nullable(),
          tax_id: z.string().optional().nullable(),
          credit_limit: MoneyStr.optional().nullable(),
          payment_terms_days: z.number().int().min(0).optional().nullable(),
          price_list_id: UUID.optional().nullable(),
          metadata: z.record(z.string(), z.unknown()).optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      const id = await createCompany(params.data.storeId, body.data);
      return reply.status(201).send({ id });
    }
  );

  app.get(
    "/commerce/stores/:storeId/companies/:companyId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, companyId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const company = await getCompany(params.data.storeId, params.data.companyId);
      if (!company) return reply.status(404).send(notFound("company not found"));
      return reply.send(company);
    }
  );

  app.put(
    "/commerce/stores/:storeId/companies/:companyId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, companyId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          name: z.string().min(1).optional().nullable(),
          email: z.string().email().optional().nullable(),
          phone: z.string().optional().nullable(),
          tax_id: z.string().optional().nullable(),
          credit_limit: MoneyStr.optional().nullable(),
          payment_terms_days: z.number().int().min(0).optional().nullable(),
          price_list_id: UUID.optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      const ok = await updateCompany(params.data.storeId, params.data.companyId, body.data);
      if (!ok) return reply.status(404).send(notFound("company not found"));
      return reply.send({ ok: true });
    }
  );

  app.delete(
    "/commerce/stores/:storeId/companies/:companyId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, companyId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const ok = await deleteCompany(params.data.storeId, params.data.companyId);
      if (!ok) return reply.status(404).send(notFound("company not found"));
      return reply.send({ ok: true });
    }
  );

  // ── Company customers ────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/companies/:companyId/customers",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, companyId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const customers = await listCompanyCustomers(params.data.storeId, params.data.companyId);
      return reply.send({ customers });
    }
  );

  app.post(
    "/commerce/stores/:storeId/companies/:companyId/customers",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, companyId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          customer_id: UUID,
          role: z.string().default("member"),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      try {
        await addCompanyCustomer(
          params.data.storeId,
          params.data.companyId,
          body.data.customer_id,
          body.data.role
        );
        return reply.status(201).send({ ok: true });
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "NOT_FOUND") {
          return reply.status(404).send(notFound("company not found"));
        }
        throw err;
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/companies/:companyId/customers/:customerId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, companyId: UUID, customerId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      await removeCompanyCustomer(
        params.data.storeId,
        params.data.companyId,
        params.data.customerId
      );
      return reply.send({ ok: true });
    }
  );

  // ── Customer groups ──────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/customer-groups",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const groups = await listCustomerGroups(params.data.storeId);
      return reply.send({ groups });
    }
  );

  app.post(
    "/commerce/stores/:storeId/customer-groups",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const body = z
        .object({
          name: z.string().min(1),
          description: z.string().optional().nullable(),
          price_list_id: UUID.optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      const id = await createCustomerGroup(params.data.storeId, body.data);
      return reply.status(201).send({ id });
    }
  );

  app.put(
    "/commerce/stores/:storeId/customer-groups/:groupId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, groupId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          name: z.string().min(1).optional().nullable(),
          description: z.string().optional().nullable(),
          price_list_id: UUID.optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      const ok = await updateCustomerGroup(
        params.data.storeId,
        params.data.groupId,
        body.data
      );
      if (!ok) return reply.status(404).send(notFound("customer group not found"));
      return reply.send({ ok: true });
    }
  );

  app.delete(
    "/commerce/stores/:storeId/customer-groups/:groupId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, groupId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      await deleteCustomerGroup(params.data.storeId, params.data.groupId);
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/customer-groups/:groupId/members",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, groupId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z.object({ customer_id: UUID }).safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("customer_id required"));
      await addGroupMember(params.data.storeId, params.data.groupId, body.data.customer_id);
      return reply.send({ ok: true });
    }
  );

  app.delete(
    "/commerce/stores/:storeId/customer-groups/:groupId/members/:customerId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, groupId: UUID, customerId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      await removeGroupMember(
        params.data.storeId,
        params.data.groupId,
        params.data.customerId
      );
      return reply.send({ ok: true });
    }
  );

  // ── Quotes ───────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/quotes",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const query = z
        .object({
          status: z.string().optional(),
          company_id: UUID.optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .safeParse(request.query);
      if (!query.success) return reply.status(400).send(badRequest("invalid query"));
      const { quotes, total } = await listQuotes(params.data.storeId, query.data);
      return reply.send({ quotes, total });
    }
  );

  app.get(
    "/commerce/stores/:storeId/quotes/:quoteId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, quoteId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const quote = await getQuote(params.data.storeId, params.data.quoteId);
      if (!quote) return reply.status(404).send(notFound("quote not found"));
      return reply.send(quote);
    }
  );

  app.post(
    "/commerce/stores/:storeId/quotes",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const body = z
        .object({
          company_id: UUID.optional().nullable(),
          customer_id: UUID.optional().nullable(),
          expires_at: z.string().optional().nullable(),
          notes: z.string().optional().nullable(),
          lines: z
            .array(
              z.object({
                variant_id: UUID.optional().nullable(),
                title: z.string().optional().nullable(),
                quantity: z.number().int().min(1).optional(),
                price: z.number().min(0),
                notes: z.string().optional().nullable(),
              })
            )
            .optional(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      const userId = (request as { auth?: { userId?: string } }).auth?.userId ?? "00000000-0000-0000-0000-000000000000";
      const id = await createQuote(params.data.storeId, body.data, userId);
      return reply.status(201).send({ id });
    }
  );

  app.put(
    "/commerce/stores/:storeId/quotes/:quoteId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, quoteId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          status: z.string().optional().nullable(),
          expires_at: z.string().optional().nullable(),
          notes: z.string().optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      const ok = await updateQuote(params.data.storeId, params.data.quoteId, body.data);
      if (!ok) return reply.status(404).send(notFound("quote not found"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/quotes/:quoteId/send",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, quoteId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const ok = await sendQuote(params.data.storeId, params.data.quoteId);
      if (!ok) return reply.status(422).send(unprocessable("quote not found or not in draft status"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/quotes/:quoteId/accept",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, quoteId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      try {
        const result = await acceptQuote(params.data.storeId, params.data.quoteId);
        return reply.send(result);
      } catch (err) {
        if (err instanceof Error) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "NOT_FOUND") return reply.status(404).send(notFound(err.message));
          if (code === "INVALID_TRANSITION" || code === "QUOTE_EXPIRED") {
            return reply.status(422).send(unprocessable(err.message, code));
          }
        }
        throw err;
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/quotes/:quoteId/reject",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, quoteId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const ok = await rejectQuote(params.data.storeId, params.data.quoteId);
      if (!ok) return reply.status(422).send(unprocessable("quote not found or already finalized"));
      return reply.send({ ok: true });
    }
  );

  // ── Purchase orders ──────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/purchase-orders",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = storeParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid storeId"));
      const pos = await listPurchaseOrders(params.data.storeId);
      return reply.send({ purchase_orders: pos });
    }
  );

  app.get(
    "/commerce/stores/:storeId/purchase-orders/:poId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, poId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const po = await getPurchaseOrder(params.data.storeId, params.data.poId);
      if (!po) return reply.status(404).send(notFound("purchase order not found"));
      return reply.send(po);
    }
  );

  app.put(
    "/commerce/stores/:storeId/purchase-orders/:poId",
    { preHandler: storeAuthAdmin },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, poId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          status: z.string().optional().nullable(),
          notes: z.string().optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));
      const ok = await updatePurchaseOrder(params.data.storeId, params.data.poId, body.data);
      if (!ok) return reply.status(404).send(notFound("purchase order not found"));
      return reply.send({ ok: true });
    }
  );

  // Attach PO to an order
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/purchase-order",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, orderId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          po_number: z.string().min(1),
          notes: z.string().optional().nullable(),
        })
        .safeParse(request.body);
      if (!body.success) return reply.status(400).send(badRequest("po_number is required"));
      try {
        const id = await attachPurchaseOrder(
          params.data.storeId,
          params.data.orderId,
          body.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (err instanceof Error) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "NOT_FOUND") return reply.status(404).send(notFound(err.message));
          if (code === "DUPLICATE_PO") {
            return reply.status(409).send({ error: { code, message: err.message } });
          }
        }
        throw err;
      }
    }
  );
};
