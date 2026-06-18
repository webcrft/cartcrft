/**
 * tax/routes.ts — Fastify plugin for tax management.
 *
 * Routes per parity-endpoints.md T2.6:
 *   GET/POST        /commerce/stores/:storeId/tax-categories
 *   DELETE          /commerce/stores/:storeId/tax-categories/:categoryId
 *   GET/POST        /commerce/stores/:storeId/tax-zones
 *   PUT/DELETE      /commerce/stores/:storeId/tax-zones/:zoneId
 *   GET/POST        /commerce/stores/:storeId/tax-zones/:zoneId/rates
 *   PUT/DELETE      /commerce/stores/:storeId/tax-zones/:zoneId/rates/:rateId
 *
 * All endpoints require storeAuthAdmin.
 * Tax computation (calcTax) lives in lib/tax.ts and is consumed by checkout.
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthAdmin, storeAuthWrite, storeAuthRead } from "../../lib/auth/middleware.js";
import {
  listTaxCategories,
  createTaxCategory,
  deleteTaxCategory,
  listTaxZones,
  createTaxZone,
  updateTaxZone,
  deleteTaxZone,
  listTaxRates,
  createTaxRate,
  updateTaxRate,
  deleteTaxRate,
  listDutyRates,
  createDutyRate,
  updateDutyRate,
  deleteDutyRate,
  previewLandedCost,
} from "./service.js";

// ── Schemas ───────────────────────────────────────────────────────────────────

const StoreParams = z.object({ storeId: z.string().uuid() });
const CategoryParams = z.object({ storeId: z.string().uuid(), categoryId: z.string().uuid() });
const ZoneParams = z.object({ storeId: z.string().uuid(), zoneId: z.string().uuid() });
const ZoneRateParams = z.object({ storeId: z.string().uuid(), zoneId: z.string().uuid(), rateId: z.string().uuid() });

const CreateCategoryBody = z.object({
  name: z.string().min(1).max(255),
  code: z.string().min(1).max(64),
});

const RegionSchema = z.object({
  country_code: z.string().length(2),
  province_code: z.string().max(10).nullish(),
});

const CreateZoneBody = z.object({
  name: z.string().min(1).max(255),
  regions: z.array(RegionSchema).optional(),
});

const UpdateZoneBody = z.object({
  name: z.string().min(1).max(255).optional(),
  regions: z.array(RegionSchema).optional(),
});

const CreateRateBody = z.object({
  name: z.string().min(1).max(255),
  rate_pct: z.number().min(0).max(100),
  category_id: z.string().uuid().nullish(),
  is_inclusive: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

const UpdateRateBody = z.object({
  name: z.string().min(1).max(255).nullish(),
  rate_pct: z.number().min(0).max(100).nullish(),
  is_inclusive: z.boolean().nullish(),
  is_active: z.boolean().nullish(),
  category_id: z.string().uuid().nullish(),
});

// ── Duty-rate schemas ───────────────────────────────────────────────────────────

const DutyRateParams = z.object({ storeId: z.string().uuid(), rateId: z.string().uuid() });

const ListDutyQuery = z.object({
  destination_country: z.string().length(2).optional(),
});

const CreateDutyBody = z.object({
  destination_country: z.string().length(2),
  category: z.string().max(255).nullish(),
  rate_pct: z.number().min(0).max(100),
  de_minimis_value: z.number().min(0).nullish(),
  is_active: z.boolean().optional(),
});

const UpdateDutyBody = z.object({
  destination_country: z.string().length(2).nullish(),
  category: z.string().max(255).nullish(),
  rate_pct: z.number().min(0).max(100).nullish(),
  de_minimis_value: z.number().min(0).nullish(),
  is_active: z.boolean().nullish(),
});

const LandedCostBody = z.object({
  subtotal: z.number().min(0),
  destination_country: z.string().length(2),
  origin_country: z.string().length(2).optional(),
  province_code: z.string().max(10).optional(),
  categories: z.array(z.string().max(255)).optional(),
});

const LandedCostQuery = z.object({
  subtotal: z.coerce.number().min(0),
  destination_country: z.string().length(2),
  origin_country: z.string().length(2).optional(),
  province_code: z.string().max(10).optional(),
  categories: z.union([z.string(), z.array(z.string())]).optional(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const taxPlugin: FastifyPluginAsyncZod = async (app) => {
  const base = "/commerce/stores/:storeId";

  // ── Tax categories ──────────────────────────────────────────────────────────

  app.get(`${base}/tax-categories`, {
    schema: { params: StoreParams },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    return reply.send({ categories: await listTaxCategories(storeId) });
  });

  app.post(`${base}/tax-categories`, {
    schema: { params: StoreParams, body: CreateCategoryBody },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const result = await createTaxCategory(storeId, request.body);
    if (result.duplicate) {
      return reply.status(409).send({ error: { code: "CONFLICT", message: "a tax category with that code already exists" } });
    }
    return reply.status(201).send({ id: result.id });
  });

  app.delete(`${base}/tax-categories/:categoryId`, {
    schema: { params: CategoryParams },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId, categoryId } = request.params;
    const deleted = await deleteTaxCategory(storeId, categoryId);
    if (!deleted) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "tax category not found" } });
    return reply.send({ ok: true });
  });

  // ── Tax zones ───────────────────────────────────────────────────────────────

  app.get(`${base}/tax-zones`, {
    schema: { params: StoreParams },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    return reply.send({ zones: await listTaxZones(storeId) });
  });

  app.post(`${base}/tax-zones`, {
    schema: { params: StoreParams, body: CreateZoneBody },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const id = await createTaxZone(storeId, request.body);
    return reply.status(201).send({ id });
  });

  app.put(`${base}/tax-zones/:zoneId`, {
    schema: { params: ZoneParams, body: UpdateZoneBody },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId, zoneId } = request.params;
    await updateTaxZone(storeId, zoneId, request.body);
    return reply.send({ ok: true });
  });

  app.delete(`${base}/tax-zones/:zoneId`, {
    schema: { params: ZoneParams },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId, zoneId } = request.params;
    await deleteTaxZone(storeId, zoneId);
    return reply.send({ ok: true });
  });

  // ── Tax rates ───────────────────────────────────────────────────────────────

  app.get(`${base}/tax-zones/:zoneId/rates`, {
    schema: { params: ZoneParams },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId, zoneId } = request.params;
    return reply.send({ rates: await listTaxRates(storeId, zoneId) });
  });

  app.post(`${base}/tax-zones/:zoneId/rates`, {
    schema: { params: ZoneParams, body: CreateRateBody },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId, zoneId } = request.params;
    const id = await createTaxRate(storeId, zoneId, request.body);
    if (!id) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "tax zone not found" } });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/tax-zones/:zoneId/rates/:rateId`, {
    schema: { params: ZoneRateParams, body: UpdateRateBody },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId, zoneId, rateId } = request.params;
    const ok = await updateTaxRate(storeId, zoneId, rateId, request.body);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "tax rate not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/tax-zones/:zoneId/rates/:rateId`, {
    schema: { params: ZoneRateParams },
    preHandler: [storeAuthAdmin("tax")],
  }, async (request, reply) => {
    const { storeId, zoneId, rateId } = request.params;
    await deleteTaxRate(storeId, zoneId, rateId);
    return reply.send({ ok: true });
  });

  // ── Duty rates (import duties / landed cost) ─────────────────────────────────

  app.get(`${base}/tax/duty-rates`, {
    schema: { params: StoreParams, querystring: ListDutyQuery },
    preHandler: [storeAuthRead("tax")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const { destination_country } = request.query;
    return reply.send({ duty_rates: await listDutyRates(storeId, destination_country) });
  });

  app.post(`${base}/tax/duty-rates`, {
    schema: { params: StoreParams, body: CreateDutyBody },
    preHandler: [storeAuthWrite("tax")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const id = await createDutyRate(storeId, request.body);
    return reply.status(201).send({ id });
  });

  app.put(`${base}/tax/duty-rates/:rateId`, {
    schema: { params: DutyRateParams, body: UpdateDutyBody },
    preHandler: [storeAuthWrite("tax")],
  }, async (request, reply) => {
    const { storeId, rateId } = request.params;
    const ok = await updateDutyRate(storeId, rateId, request.body);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "duty rate not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/tax/duty-rates/:rateId`, {
    schema: { params: DutyRateParams },
    preHandler: [storeAuthWrite("tax")],
  }, async (request, reply) => {
    const { storeId, rateId } = request.params;
    const ok = await deleteDutyRate(storeId, rateId);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "duty rate not found" } });
    return reply.send({ ok: true });
  });

  // ── Landed-cost preview (storefront estimate; read-only) ─────────────────────
  // Duties are NOT yet wired into the actual order total at checkout/complete —
  // that is a follow-up owned by the checkout module.

  app.post(`${base}/tax/landed-cost`, {
    schema: { params: StoreParams, body: LandedCostBody },
    preHandler: [storeAuthRead("tax")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const b = request.body;
    const preview = await previewLandedCost(storeId, {
      subtotal: b.subtotal,
      destinationCountry: b.destination_country,
      ...(b.origin_country ? { originCountry: b.origin_country } : {}),
      ...(b.province_code ? { provinceCode: b.province_code } : {}),
      ...(b.categories ? { categories: b.categories } : {}),
    });
    return reply.send(preview);
  });

  app.get(`${base}/tax/landed-cost`, {
    schema: { params: StoreParams, querystring: LandedCostQuery },
    preHandler: [storeAuthRead("tax")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const q = request.query;
    const categories = q.categories === undefined
      ? undefined
      : Array.isArray(q.categories) ? q.categories : [q.categories];
    const preview = await previewLandedCost(storeId, {
      subtotal: q.subtotal,
      destinationCountry: q.destination_country,
      ...(q.origin_country ? { originCountry: q.origin_country } : {}),
      ...(q.province_code ? { provinceCode: q.province_code } : {}),
      ...(categories ? { categories } : {}),
    });
    return reply.send(preview);
  });
};
