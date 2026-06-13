/**
 * discounts/routes.ts — Fastify plugin for discount codes + automatic discounts.
 *
 * Discount codes (auth=admin except validate=read):
 *   GET    /commerce/stores/:storeId/discounts           — ListDiscounts
 *   POST   /commerce/stores/:storeId/discounts           — CreateDiscount
 *   GET    /commerce/stores/:storeId/discounts/validate  — ValidateDiscount (read)
 *   GET    /commerce/stores/:storeId/discounts/:discountId — GetDiscount
 *   PUT    /commerce/stores/:storeId/discounts/:discountId — UpdateDiscount
 *   DELETE /commerce/stores/:storeId/discounts/:discountId — DeleteDiscount
 *
 * IMPORTANT: /validate is registered BEFORE /:discountId to avoid Fastify
 * treating "validate" as a discountId param value.
 *
 * Automatic discounts (auth=admin):
 *   GET    /commerce/stores/:storeId/auto-discounts                     — ListAutoDiscounts
 *   POST   /commerce/stores/:storeId/auto-discounts                     — CreateAutoDiscount
 *   GET    /commerce/stores/:storeId/auto-discounts/:discountId         — GetAutoDiscount
 *   PUT    /commerce/stores/:storeId/auto-discounts/:discountId         — UpdateAutoDiscount
 *   DELETE /commerce/stores/:storeId/auto-discounts/:discountId         — DeleteAutoDiscount
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthAdmin, storeAuthRead } from "../../lib/auth/middleware.js";
import {
  listDiscounts,
  getDiscount,
  createDiscount,
  updateDiscount,
  deleteDiscount,
  validateDiscount,
  listAutoDiscounts,
  getAutoDiscount,
  createAutoDiscount,
  updateAutoDiscount,
  deleteAutoDiscount,
} from "./service.js";

// ── Zod schemas ────────────────────────────────────────────────────────────────

const DiscountTypeEnum = z.enum([
  "percentage",
  "fixed_amount",
  "free_shipping",
  "bogo",
  "buy_x_get_y",
]);

const AppliesToEnum = z.enum([
  "order",
  "specific_products",
  "specific_collections",
  "specific_customers",
  "customer_group",
]);

const AutoAppliesToEnum = z.enum([
  "order",
  "specific_products",
  "specific_collections",
  "customer_group",
]);

const CustomerEligibilityEnum = z.enum([
  "all",
  "specific_customers",
  "customer_groups",
]);

const StoreDiscountParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
});

const DiscountIdParams = z.object({
  storeId: z.string().uuid("storeId must be a UUID"),
  discountId: z.string().uuid("discountId must be a UUID"),
});

const ListQuerystring = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const ValidateQuerystring = z.object({
  code: z.string().min(1, "code is required"),
  customer_id: z.string().uuid().optional(),
  order_total: z.string().optional(),
});

const CreateDiscountBody = z.object({
  code: z.string().min(1, "code is required").max(100),
  type: DiscountTypeEnum,
  value: z.string().optional(),
  min_order_total: z.string().optional(),
  min_qty: z.number().int().positive().optional(),
  max_discount: z.string().optional(),
  max_uses: z.number().int().positive().optional(),
  once_per_customer: z.boolean().optional(),
  applies_to: AppliesToEnum.optional(),
  applies_to_ids: z.array(z.string().uuid()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  created_by: z.string().uuid().nullable().optional(),
});

const UpdateDiscountBody = z.object({
  code: z.string().min(1).max(100).optional(),
  type: DiscountTypeEnum.optional(),
  value: z.string().nullable().optional(),
  min_order_total: z.string().nullable().optional(),
  min_qty: z.number().int().positive().nullable().optional(),
  max_discount: z.string().nullable().optional(),
  max_uses: z.number().int().positive().nullable().optional(),
  once_per_customer: z.boolean().optional(),
  applies_to: AppliesToEnum.optional(),
  applies_to_ids: z.array(z.string().uuid()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
});

const CreateAutoDiscountBody = z.object({
  title: z.string().min(1, "title is required").max(255),
  type: DiscountTypeEnum,
  value: z.string().optional(),
  min_order_total: z.string().optional(),
  min_qty: z.number().int().positive().optional(),
  max_discount: z.string().optional(),
  max_uses: z.number().int().positive().optional(),
  once_per_customer: z.boolean().optional(),
  applies_to: AutoAppliesToEnum.optional(),
  applies_to_ids: z.array(z.string().uuid()).optional(),
  customer_eligibility: CustomerEligibilityEnum.optional(),
  eligible_ids: z.array(z.string().uuid()).optional(),
  allow_stacking: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
  created_by: z.string().uuid().nullable().optional(),
});

const UpdateAutoDiscountBody = z.object({
  title: z.string().min(1).max(255).optional(),
  type: DiscountTypeEnum.optional(),
  value: z.string().nullable().optional(),
  min_order_total: z.string().nullable().optional(),
  min_qty: z.number().int().positive().nullable().optional(),
  max_discount: z.string().nullable().optional(),
  max_uses: z.number().int().positive().nullable().optional(),
  once_per_customer: z.boolean().optional(),
  applies_to: AutoAppliesToEnum.optional(),
  applies_to_ids: z.array(z.string().uuid()).optional(),
  customer_eligibility: CustomerEligibilityEnum.optional(),
  eligible_ids: z.array(z.string().uuid()).optional(),
  allow_stacking: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  starts_at: z.string().nullable().optional(),
  ends_at: z.string().nullable().optional(),
  is_active: z.boolean().optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const discountsPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── GET /commerce/stores/:storeId/discounts ──────────────────────────────
  app.get(
    "/commerce/stores/:storeId/discounts",
    {
      schema: { params: StoreDiscountParams, querystring: ListQuerystring },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const { limit, offset } = request.query;
      const opts: { limit?: number; offset?: number } = {};
      if (limit !== undefined) opts.limit = limit;
      if (offset !== undefined) opts.offset = offset;
      const discounts = await listDiscounts(storeId, opts);
      return reply.send({ discounts });
    }
  );

  // ── POST /commerce/stores/:storeId/discounts ─────────────────────────────
  app.post(
    "/commerce/stores/:storeId/discounts",
    {
      schema: { params: StoreDiscountParams, body: CreateDiscountBody },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      try {
        const id = await createDiscount(storeId, request.body);
        return reply.status(201).send({ id });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "DUPLICATE_CODE"
        ) {
          return reply.status(409).send({
            error: { code: "DUPLICATE_CODE", message: err.message },
          });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/discounts/validate ────────────────────
  // MUST be registered before /:discountId to avoid param conflict.
  app.get(
    "/commerce/stores/:storeId/discounts/validate",
    {
      schema: { params: StoreDiscountParams, querystring: ValidateQuerystring },
      preHandler: [storeAuthRead],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const { code, customer_id, order_total } = request.query;

      const outcome = await validateDiscount(storeId, {
        code,
        customer_id,
        order_total,
      });

      if (outcome === null) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "discount not found or not applicable" },
        });
      }

      if ("reason" in outcome) {
        return reply.status(404).send({
          error: {
            code: outcome.reason,
            message: "discount not applicable for this customer",
          },
        });
      }

      return reply.send(outcome.result);
    }
  );

  // ── GET /commerce/stores/:storeId/discounts/:discountId ──────────────────
  app.get(
    "/commerce/stores/:storeId/discounts/:discountId",
    {
      schema: { params: DiscountIdParams },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, discountId } = request.params;
      const discount = await getDiscount(storeId, discountId);
      if (!discount) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "discount not found" },
        });
      }
      return reply.send(discount);
    }
  );

  // ── PUT /commerce/stores/:storeId/discounts/:discountId ──────────────────
  app.put(
    "/commerce/stores/:storeId/discounts/:discountId",
    {
      schema: { params: DiscountIdParams, body: UpdateDiscountBody },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, discountId } = request.params;
      try {
        const updated = await updateDiscount(storeId, discountId, request.body);
        if (!updated) {
          return reply.status(404).send({
            error: { code: "NOT_FOUND", message: "discount not found" },
          });
        }
        return reply.send({ ok: true });
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "DUPLICATE_CODE"
        ) {
          return reply.status(409).send({
            error: { code: "DUPLICATE_CODE", message: err.message },
          });
        }
        throw err;
      }
    }
  );

  // ── DELETE /commerce/stores/:storeId/discounts/:discountId ───────────────
  app.delete(
    "/commerce/stores/:storeId/discounts/:discountId",
    {
      schema: { params: DiscountIdParams },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, discountId } = request.params;
      const deleted = await deleteDiscount(storeId, discountId);
      if (!deleted) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "discount not found" },
        });
      }
      return reply.send({ ok: true });
    }
  );

  // ── Auto-discount routes ───────────────────────────────────────────────────

  // ── GET /commerce/stores/:storeId/auto-discounts ─────────────────────────
  app.get(
    "/commerce/stores/:storeId/auto-discounts",
    {
      schema: { params: StoreDiscountParams, querystring: ListQuerystring },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const { limit, offset } = request.query;
      const opts: { limit?: number; offset?: number } = {};
      if (limit !== undefined) opts.limit = limit;
      if (offset !== undefined) opts.offset = offset;
      const discounts = await listAutoDiscounts(storeId, opts);
      return reply.send({ discounts });
    }
  );

  // ── POST /commerce/stores/:storeId/auto-discounts ────────────────────────
  app.post(
    "/commerce/stores/:storeId/auto-discounts",
    {
      schema: { params: StoreDiscountParams, body: CreateAutoDiscountBody },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId } = request.params;
      const id = await createAutoDiscount(storeId, request.body);
      return reply.status(201).send({ id });
    }
  );

  // ── GET /commerce/stores/:storeId/auto-discounts/:discountId ────────────
  app.get(
    "/commerce/stores/:storeId/auto-discounts/:discountId",
    {
      schema: { params: DiscountIdParams },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, discountId } = request.params;
      const discount = await getAutoDiscount(storeId, discountId);
      if (!discount) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "auto-discount not found" },
        });
      }
      return reply.send(discount);
    }
  );

  // ── PUT /commerce/stores/:storeId/auto-discounts/:discountId ────────────
  app.put(
    "/commerce/stores/:storeId/auto-discounts/:discountId",
    {
      schema: { params: DiscountIdParams, body: UpdateAutoDiscountBody },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, discountId } = request.params;
      const updated = await updateAutoDiscount(storeId, discountId, request.body);
      if (!updated) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "auto-discount not found" },
        });
      }
      return reply.send({ ok: true });
    }
  );

  // ── DELETE /commerce/stores/:storeId/auto-discounts/:discountId ─────────
  app.delete(
    "/commerce/stores/:storeId/auto-discounts/:discountId",
    {
      schema: { params: DiscountIdParams },
      preHandler: [storeAuthAdmin],
    },
    async (request, reply) => {
      const { storeId, discountId } = request.params;
      const deleted = await deleteAutoDiscount(storeId, discountId);
      if (!deleted) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "auto-discount not found" },
        });
      }
      return reply.send({ ok: true });
    }
  );
};
