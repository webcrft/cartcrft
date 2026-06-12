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

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin } from "../../lib/auth/middleware.js";
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

// ── Plugin ────────────────────────────────────────────────────────────────────

export const taxPlugin: FastifyPluginAsync = async (app) => {
  const base = "/commerce/stores/:storeId";

  // ── Tax categories ──────────────────────────────────────────────────────────

  app.get(`${base}/tax-categories`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    return reply.send({ categories: await listTaxCategories(storeId) });
  });

  app.post(`${base}/tax-categories`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const body = CreateCategoryBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "name and code are required", details: body.error.issues } });
    }
    const result = await createTaxCategory(storeId, body.data);
    if (result.duplicate) {
      return reply.status(409).send({ error: { code: "CONFLICT", message: "a tax category with that code already exists" } });
    }
    return reply.status(201).send({ id: result.id });
  });

  app.delete(`${base}/tax-categories/:categoryId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, categoryId } = CategoryParams.parse(request.params);
    const deleted = await deleteTaxCategory(storeId, categoryId);
    if (!deleted) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "tax category not found" } });
    return reply.send({ ok: true });
  });

  // ── Tax zones ───────────────────────────────────────────────────────────────

  app.get(`${base}/tax-zones`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    return reply.send({ zones: await listTaxZones(storeId) });
  });

  app.post(`${base}/tax-zones`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const body = CreateZoneBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const id = await createTaxZone(storeId, body.data);
    return reply.status(201).send({ id });
  });

  app.put(`${base}/tax-zones/:zoneId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, zoneId } = ZoneParams.parse(request.params);
    const body = UpdateZoneBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    await updateTaxZone(storeId, zoneId, body.data);
    return reply.send({ ok: true });
  });

  app.delete(`${base}/tax-zones/:zoneId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, zoneId } = ZoneParams.parse(request.params);
    await deleteTaxZone(storeId, zoneId);
    return reply.send({ ok: true });
  });

  // ── Tax rates ───────────────────────────────────────────────────────────────

  app.get(`${base}/tax-zones/:zoneId/rates`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, zoneId } = ZoneParams.parse(request.params);
    return reply.send({ rates: await listTaxRates(storeId, zoneId) });
  });

  app.post(`${base}/tax-zones/:zoneId/rates`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, zoneId } = ZoneParams.parse(request.params);
    const body = CreateRateBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const id = await createTaxRate(storeId, zoneId, body.data);
    if (!id) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "tax zone not found" } });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/tax-zones/:zoneId/rates/:rateId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, zoneId, rateId } = ZoneRateParams.parse(request.params);
    const body = UpdateRateBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const ok = await updateTaxRate(storeId, zoneId, rateId, body.data);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "tax rate not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/tax-zones/:zoneId/rates/:rateId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, zoneId, rateId } = ZoneRateParams.parse(request.params);
    await deleteTaxRate(storeId, zoneId, rateId);
    return reply.send({ ok: true });
  });
};
