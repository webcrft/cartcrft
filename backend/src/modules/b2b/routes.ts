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

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
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
  listCompanyCatalogAccess,
  grantCatalogAccess,
  revokeCatalogAccess,
  assignPriceList,
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
// H3.2: money fields are decimal strings, never floats
const MoneyStr = z.string().regex(/^\d+(\.\d{1,2})?$/);

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}
function unprocessable(msg: string, code = "INVALID_TRANSITION") {
  return { error: { code, message: msg } };
}

// ── Shared param schemas ──────────────────────────────────────────────────────

const StoreParams = z.object({ storeId: UUID });
const CompanyParams = z.object({ storeId: UUID, companyId: UUID });
const CompanyCustomerParams = z.object({ storeId: UUID, companyId: UUID, customerId: UUID });
const CatalogAccessParams = z.object({ storeId: UUID, companyId: UUID, accessId: UUID });
const GroupParams = z.object({ storeId: UUID, groupId: UUID });
const GroupMemberParams = z.object({ storeId: UUID, groupId: UUID, customerId: UUID });
const QuoteParams = z.object({ storeId: UUID, quoteId: UUID });
const PoParams = z.object({ storeId: UUID, poId: UUID });
const OrderParams = z.object({ storeId: UUID, orderId: UUID });

// ── Shared body schemas ───────────────────────────────────────────────────────

const CreateCompanyBody = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  tax_id: z.string().optional().nullable(),
  credit_limit: MoneyStr.optional().nullable(),
  payment_terms_days: z.number().int().min(0).optional().nullable(),
  price_list_id: UUID.optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

const UpdateCompanyBody = z.object({
  name: z.string().min(1).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().optional().nullable(),
  tax_id: z.string().optional().nullable(),
  credit_limit: MoneyStr.optional().nullable(),
  payment_terms_days: z.number().int().min(0).optional().nullable(),
  price_list_id: UUID.optional().nullable(),
});

const AddCompanyCustomerBody = z.object({
  customer_id: UUID,
  role: z.string().default("member"),
});

const CreateGroupBody = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  price_list_id: UUID.optional().nullable(),
});

const UpdateGroupBody = z.object({
  name: z.string().min(1).optional().nullable(),
  description: z.string().optional().nullable(),
  price_list_id: UUID.optional().nullable(),
});

const AddGroupMemberBody = z.object({ customer_id: UUID });

// Wave-17: exactly one of product_id / collection_id (refined below).
const GrantCatalogAccessBody = z
  .object({
    product_id: UUID.optional(),
    collection_id: UUID.optional(),
  })
  .refine(
    (b) => (b.product_id != null) !== (b.collection_id != null),
    { message: "exactly one of product_id or collection_id is required" }
  );

const AssignPriceListBody = z.object({
  price_list_id: UUID.optional().nullable(),
});

const QuotesQuerystring = z.object({
  status: z.string().optional(),
  company_id: UUID.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateQuoteBody = z.object({
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
        // H3.2: quote line prices are money strings
        price: MoneyStr,
        notes: z.string().optional().nullable(),
      })
    )
    .optional(),
});

const UpdateQuoteBody = z.object({
  status: z.string().optional().nullable(),
  expires_at: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const UpdatePoBody = z.object({
  status: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

const AttachPoBody = z.object({
  po_number: z.string().min(1),
  notes: z.string().optional().nullable(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const b2bPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── Companies ────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/companies",
    { preHandler: storeAuthAdmin, schema: { params: StoreParams } },
    async (request, reply) => {
      const companies = await listCompanies(request.params.storeId);
      return reply.send({ companies });
    }
  );

  app.post(
    "/commerce/stores/:storeId/companies",
    { preHandler: storeAuthAdmin, schema: { params: StoreParams, body: CreateCompanyBody } },
    async (request, reply) => {
      const id = await createCompany(request.params.storeId, request.body);
      return reply.status(201).send({ id });
    }
  );

  app.get(
    "/commerce/stores/:storeId/companies/:companyId",
    { preHandler: storeAuthAdmin, schema: { params: CompanyParams } },
    async (request, reply) => {
      const company = await getCompany(request.params.storeId, request.params.companyId);
      if (!company) return reply.status(404).send(notFound("company not found"));
      return reply.send(company);
    }
  );

  app.put(
    "/commerce/stores/:storeId/companies/:companyId",
    { preHandler: storeAuthAdmin, schema: { params: CompanyParams, body: UpdateCompanyBody } },
    async (request, reply) => {
      const ok = await updateCompany(request.params.storeId, request.params.companyId, request.body);
      if (!ok) return reply.status(404).send(notFound("company not found"));
      return reply.send({ ok: true });
    }
  );

  app.delete(
    "/commerce/stores/:storeId/companies/:companyId",
    { preHandler: storeAuthAdmin, schema: { params: CompanyParams } },
    async (request, reply) => {
      const ok = await deleteCompany(request.params.storeId, request.params.companyId);
      if (!ok) return reply.status(404).send(notFound("company not found"));
      return reply.send({ ok: true });
    }
  );

  // ── Company customers ────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/companies/:companyId/customers",
    { preHandler: storeAuthAdmin, schema: { params: CompanyParams } },
    async (request, reply) => {
      const customers = await listCompanyCustomers(request.params.storeId, request.params.companyId);
      return reply.send({ customers });
    }
  );

  app.post(
    "/commerce/stores/:storeId/companies/:companyId/customers",
    { preHandler: storeAuthAdmin, schema: { params: CompanyParams, body: AddCompanyCustomerBody } },
    async (request, reply) => {
      try {
        await addCompanyCustomer(
          request.params.storeId,
          request.params.companyId,
          request.body.customer_id,
          request.body.role
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
    { preHandler: storeAuthAdmin, schema: { params: CompanyCustomerParams } },
    async (request, reply) => {
      await removeCompanyCustomer(
        request.params.storeId,
        request.params.companyId,
        request.params.customerId
      );
      return reply.send({ ok: true });
    }
  );

  // ── Company catalog access (Wave-17: per-company catalog gating) ──────────────

  app.get(
    "/commerce/stores/:storeId/companies/:companyId/catalog-access",
    { preHandler: storeAuthAdmin, schema: { params: CompanyParams } },
    async (request, reply) => {
      const access = await listCompanyCatalogAccess(
        request.params.storeId,
        request.params.companyId
      );
      return reply.send({ access });
    }
  );

  app.post(
    "/commerce/stores/:storeId/companies/:companyId/catalog-access",
    { preHandler: storeAuthAdmin, schema: { params: CompanyParams, body: GrantCatalogAccessBody } },
    async (request, reply) => {
      try {
        const id = await grantCatalogAccess(
          request.params.storeId,
          request.params.companyId,
          request.body
        );
        // id === null means the row already existed (idempotent grant).
        return reply.status(201).send({ id });
      } catch (err) {
        if (err instanceof Error) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "NOT_FOUND") return reply.status(404).send(notFound("company not found"));
          if (code === "INVALID_INPUT") {
            return reply.status(422).send(unprocessable(err.message, "INVALID_INPUT"));
          }
        }
        throw err;
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/companies/:companyId/catalog-access/:accessId",
    { preHandler: storeAuthAdmin, schema: { params: CatalogAccessParams } },
    async (request, reply) => {
      const ok = await revokeCatalogAccess(
        request.params.storeId,
        request.params.companyId,
        request.params.accessId
      );
      if (!ok) return reply.status(404).send(notFound("catalog access rule not found"));
      return reply.send({ ok: true });
    }
  );

  // Assign (or clear with null) the company's price list.
  app.put(
    "/commerce/stores/:storeId/companies/:companyId/price-list",
    { preHandler: storeAuthWrite, schema: { params: CompanyParams, body: AssignPriceListBody } },
    async (request, reply) => {
      const ok = await assignPriceList(
        request.params.storeId,
        request.params.companyId,
        request.body.price_list_id ?? null
      );
      if (!ok) return reply.status(404).send(notFound("company not found"));
      return reply.send({ ok: true });
    }
  );

  // ── Customer groups ──────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/customer-groups",
    { preHandler: storeAuthAdmin, schema: { params: StoreParams } },
    async (request, reply) => {
      const groups = await listCustomerGroups(request.params.storeId);
      return reply.send({ groups });
    }
  );

  app.post(
    "/commerce/stores/:storeId/customer-groups",
    { preHandler: storeAuthAdmin, schema: { params: StoreParams, body: CreateGroupBody } },
    async (request, reply) => {
      const id = await createCustomerGroup(request.params.storeId, request.body);
      return reply.status(201).send({ id });
    }
  );

  app.put(
    "/commerce/stores/:storeId/customer-groups/:groupId",
    { preHandler: storeAuthAdmin, schema: { params: GroupParams, body: UpdateGroupBody } },
    async (request, reply) => {
      const ok = await updateCustomerGroup(
        request.params.storeId,
        request.params.groupId,
        request.body
      );
      if (!ok) return reply.status(404).send(notFound("customer group not found"));
      return reply.send({ ok: true });
    }
  );

  app.delete(
    "/commerce/stores/:storeId/customer-groups/:groupId",
    { preHandler: storeAuthAdmin, schema: { params: GroupParams } },
    async (request, reply) => {
      await deleteCustomerGroup(request.params.storeId, request.params.groupId);
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/customer-groups/:groupId/members",
    { preHandler: storeAuthAdmin, schema: { params: GroupParams, body: AddGroupMemberBody } },
    async (request, reply) => {
      await addGroupMember(request.params.storeId, request.params.groupId, request.body.customer_id);
      return reply.send({ ok: true });
    }
  );

  app.delete(
    "/commerce/stores/:storeId/customer-groups/:groupId/members/:customerId",
    { preHandler: storeAuthAdmin, schema: { params: GroupMemberParams } },
    async (request, reply) => {
      await removeGroupMember(
        request.params.storeId,
        request.params.groupId,
        request.params.customerId
      );
      return reply.send({ ok: true });
    }
  );

  // ── Quotes ───────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/quotes",
    { preHandler: storeAuthAdmin, schema: { params: StoreParams, querystring: QuotesQuerystring } },
    async (request, reply) => {
      const { quotes, total } = await listQuotes(request.params.storeId, request.query);
      return reply.send({ quotes, total });
    }
  );

  app.get(
    "/commerce/stores/:storeId/quotes/:quoteId",
    { preHandler: storeAuthAdmin, schema: { params: QuoteParams } },
    async (request, reply) => {
      const quote = await getQuote(request.params.storeId, request.params.quoteId);
      if (!quote) return reply.status(404).send(notFound("quote not found"));
      return reply.send(quote);
    }
  );

  app.post(
    "/commerce/stores/:storeId/quotes",
    { preHandler: storeAuthAdmin, schema: { params: StoreParams, body: CreateQuoteBody } },
    async (request, reply) => {
      const userId = (request as { auth?: { userId?: string } }).auth?.userId ?? "00000000-0000-0000-0000-000000000000";
      const id = await createQuote(request.params.storeId, request.body, userId);
      return reply.status(201).send({ id });
    }
  );

  app.put(
    "/commerce/stores/:storeId/quotes/:quoteId",
    { preHandler: storeAuthAdmin, schema: { params: QuoteParams, body: UpdateQuoteBody } },
    async (request, reply) => {
      const ok = await updateQuote(request.params.storeId, request.params.quoteId, request.body);
      if (!ok) return reply.status(404).send(notFound("quote not found"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/quotes/:quoteId/send",
    { preHandler: storeAuthAdmin, schema: { params: QuoteParams } },
    async (request, reply) => {
      const ok = await sendQuote(request.params.storeId, request.params.quoteId);
      if (!ok) return reply.status(422).send(unprocessable("quote not found or not in draft status"));
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/commerce/stores/:storeId/quotes/:quoteId/accept",
    { preHandler: storeAuthAdmin, schema: { params: QuoteParams } },
    async (request, reply) => {
      try {
        const result = await acceptQuote(request.params.storeId, request.params.quoteId);
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
    { preHandler: storeAuthAdmin, schema: { params: QuoteParams } },
    async (request, reply) => {
      const ok = await rejectQuote(request.params.storeId, request.params.quoteId);
      if (!ok) return reply.status(422).send(unprocessable("quote not found or already finalized"));
      return reply.send({ ok: true });
    }
  );

  // ── Purchase orders ──────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/purchase-orders",
    { preHandler: storeAuthAdmin, schema: { params: StoreParams } },
    async (request, reply) => {
      const pos = await listPurchaseOrders(request.params.storeId);
      return reply.send({ purchase_orders: pos });
    }
  );

  app.get(
    "/commerce/stores/:storeId/purchase-orders/:poId",
    { preHandler: storeAuthAdmin, schema: { params: PoParams } },
    async (request, reply) => {
      const po = await getPurchaseOrder(request.params.storeId, request.params.poId);
      if (!po) return reply.status(404).send(notFound("purchase order not found"));
      return reply.send(po);
    }
  );

  app.put(
    "/commerce/stores/:storeId/purchase-orders/:poId",
    { preHandler: storeAuthAdmin, schema: { params: PoParams, body: UpdatePoBody } },
    async (request, reply) => {
      const ok = await updatePurchaseOrder(request.params.storeId, request.params.poId, request.body);
      if (!ok) return reply.status(404).send(notFound("purchase order not found"));
      return reply.send({ ok: true });
    }
  );

  // Attach PO to an order
  app.post(
    "/commerce/stores/:storeId/orders/:orderId/purchase-order",
    { preHandler: storeAuthWrite, schema: { params: OrderParams, body: AttachPoBody } },
    async (request, reply) => {
      try {
        const id = await attachPurchaseOrder(
          request.params.storeId,
          request.params.orderId,
          request.body
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
