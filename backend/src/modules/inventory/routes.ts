/**
 * inventory/routes.ts — Fastify plugin for inventory management.
 *
 * Routes (all admin auth):
 *   GET    /commerce/stores/:storeId/warehouses
 *   POST   /commerce/stores/:storeId/warehouses
 *   PUT    /commerce/stores/:storeId/warehouses/:warehouseId
 *   DELETE /commerce/stores/:storeId/warehouses/:warehouseId
 *   GET    /commerce/stores/:storeId/inventory
 *   POST   /commerce/stores/:storeId/inventory/set
 *   POST   /commerce/stores/:storeId/inventory/adjust
 *   GET    /commerce/stores/:storeId/inventory/adjustments
 *   GET    /commerce/stores/:storeId/inventory/lots
 *   POST   /commerce/stores/:storeId/inventory/lots
 *   PUT    /commerce/stores/:storeId/inventory/lots/:lotId
 *   DELETE /commerce/stores/:storeId/inventory/lots/:lotId
 *   GET    /commerce/stores/:storeId/inventory/serials
 *   POST   /commerce/stores/:storeId/inventory/serials
 *   GET    /commerce/stores/:storeId/inventory/serials/:serialId
 *   PUT    /commerce/stores/:storeId/inventory/serials/:serialId
 *   GET    /commerce/stores/:storeId/suppliers
 *   POST   /commerce/stores/:storeId/suppliers
 *   PUT    /commerce/stores/:storeId/suppliers/:supplierId
 *   DELETE /commerce/stores/:storeId/suppliers/:supplierId
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin, storeAuthWrite } from "../../lib/auth/middleware.js";
import {
  listWarehouses,
  createWarehouse,
  updateWarehouse,
  deleteWarehouse,
  listInventoryLevels,
  setInventoryLevel,
  adjustInventory,
  listInventoryAdjustments,
  listInventoryLots,
  createInventoryLot,
  updateInventoryLot,
  deleteInventoryLot,
  listSerialNumbers,
  bulkCreateSerialNumbers,
  getSerialNumber,
  updateSerialNumber,
  listSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  ADJUSTMENT_REASONS,
} from "./service.js";

// ── Schemas ───────────────────────────────────────────────────────────────────

const StoreParams = z.object({ storeId: z.string().uuid() });
const WarehouseParams = z.object({ storeId: z.string().uuid(), warehouseId: z.string().uuid() });
const LotParams = z.object({ storeId: z.string().uuid(), lotId: z.string().uuid() });
const SerialParams = z.object({ storeId: z.string().uuid(), serialId: z.string().uuid() });
const SupplierParams = z.object({ storeId: z.string().uuid(), supplierId: z.string().uuid() });

const CreateWarehouseBody = z.object({
  name: z.string().min(1).max(255),
  code: z.string().max(64).nullish(),
  is_active: z.boolean().optional(),
  is_default: z.boolean().optional(),
  fulfills_online: z.boolean().optional(),
  address: z.record(z.string(), z.unknown()).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const UpdateWarehouseBody = CreateWarehouseBody.partial();

const SetInventoryBody = z.object({
  variant_id: z.string().uuid(),
  warehouse_id: z.string().uuid(),
  quantity: z.number().int().min(0),
});

const AdjustInventoryBody = z.object({
  variant_id: z.string().uuid(),
  warehouse_id: z.string().uuid(),
  quantity_delta: z.number().int().refine((n) => n !== 0, "quantity_delta must be non-zero"),
  reason: z.enum(ADJUSTMENT_REASONS),
  notes: z.string().max(1000).optional(),
});

const InventoryQuery = z.object({
  variant_id: z.string().uuid().optional(),
  warehouse_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const LotQuery = z.object({
  variant_id: z.string().uuid().optional(),
  warehouse_id: z.string().uuid().optional(),
});

const CreateLotBody = z.object({
  variant_id: z.string().uuid(),
  warehouse_id: z.string().uuid(),
  lot_number: z.string().min(1).max(100),
  quantity: z.number().int().min(0),
  expiry_date: z.string().nullish(),
  cost_price: z.number().positive().nullish(),
  received_at: z.string().nullish(),
});

const UpdateLotBody = z.object({
  expiry_date: z.string().nullish(),
  quantity: z.number().int().min(0).optional(),
  cost_price: z.number().positive().nullish(),
});

const SerialQuery = z.object({
  variant_id: z.string().uuid().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const BulkCreateSerialsBody = z.object({
  variant_id: z.string().uuid(),
  warehouse_id: z.string().uuid().optional(),
  serial_numbers: z.array(z.string().min(1).max(200)).min(1),
});

const UpdateSerialBody = z.object({
  status: z.enum(["available", "sold", "reserved", "damaged", "returned"]).optional(),
});

const CreateSupplierBody = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().nullish(),
  phone: z.string().max(64).nullish(),
  address: z.record(z.string(), z.unknown()).nullish(),
  currency: z.string().length(3).nullish(),
  notes: z.string().max(16384).nullish(),
  is_active: z.boolean().optional(),
});

const UpdateSupplierBody = CreateSupplierBody.partial();

// ── Plugin ────────────────────────────────────────────────────────────────────

export const inventoryPlugin: FastifyPluginAsync = async (app) => {
  const base = "/commerce/stores/:storeId";

  // ── Warehouses ─────────────────────────────────────────────────────────────

  app.get(`${base}/warehouses`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const warehouses = await listWarehouses(storeId);
    return reply.send({ warehouses });
  });

  app.post(`${base}/warehouses`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const body = CreateWarehouseBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const id = await createWarehouse(storeId, body.data);
    return reply.status(201).send({ id });
  });

  app.put(`${base}/warehouses/:warehouseId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, warehouseId } = WarehouseParams.parse(request.params);
    const body = UpdateWarehouseBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const ok = await updateWarehouse(storeId, warehouseId, body.data);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "warehouse not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/warehouses/:warehouseId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, warehouseId } = WarehouseParams.parse(request.params);
    await deleteWarehouse(storeId, warehouseId);
    return reply.send({ ok: true });
  });

  // ── Inventory levels ────────────────────────────────────────────────────────

  app.get(`${base}/inventory`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const q = InventoryQuery.safeParse(request.query);
    const levels = await listInventoryLevels(storeId, q.success ? q.data : {});
    return reply.send({ levels });
  });

  app.post(`${base}/inventory/set`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const body = SetInventoryBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const userId = request.auth!.userId;
    const adjustmentId = await setInventoryLevel(storeId, { ...body.data, created_by: userId });
    return reply.send({ ok: true, adjustment_id: adjustmentId });
  });

  app.post(`${base}/inventory/adjust`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const body = AdjustInventoryBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const userId = request.auth!.userId;
    const result = await adjustInventory(storeId, { ...body.data, created_by: userId });
    return reply.send({ id: result.id, quantity_available: result.quantity_available, reorder_point: result.reorder_point });
  });

  app.get(`${base}/inventory/adjustments`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const q = InventoryQuery.safeParse(request.query);
    const adjustments = await listInventoryAdjustments(storeId, q.success ? q.data : {});
    return reply.send({ adjustments });
  });

  // ── Lots ───────────────────────────────────────────────────────────────────

  app.get(`${base}/inventory/lots`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const q = LotQuery.safeParse(request.query);
    const lots = await listInventoryLots(storeId, q.success ? q.data : {});
    return reply.send({ lots });
  });

  app.post(`${base}/inventory/lots`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const body = CreateLotBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const id = await createInventoryLot(storeId, body.data);
    if (!id) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "warehouse not found in this store" } });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/inventory/lots/:lotId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, lotId } = LotParams.parse(request.params);
    const body = UpdateLotBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const ok = await updateInventoryLot(storeId, lotId, body.data);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "lot not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/inventory/lots/:lotId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, lotId } = LotParams.parse(request.params);
    await deleteInventoryLot(storeId, lotId);
    return reply.send({ ok: true });
  });

  // ── Serial numbers ──────────────────────────────────────────────────────────

  app.get(`${base}/inventory/serials`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const q = SerialQuery.safeParse(request.query);
    const serials = await listSerialNumbers(storeId, q.success ? q.data : {});
    return reply.send({ serials });
  });

  app.post(`${base}/inventory/serials`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const body = BulkCreateSerialsBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const count = await bulkCreateSerialNumbers(storeId, body.data);
    return reply.status(201).send({ count });
  });

  app.get(`${base}/inventory/serials/:serialId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, serialId } = SerialParams.parse(request.params);
    const sn = await getSerialNumber(storeId, serialId);
    if (!sn) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "serial number not found" } });
    return reply.send(sn);
  });

  app.put(`${base}/inventory/serials/:serialId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, serialId } = SerialParams.parse(request.params);
    const body = UpdateSerialBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const ok = await updateSerialNumber(storeId, serialId, body.data);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "serial number not found" } });
    return reply.send({ ok: true });
  });

  // ── Suppliers ──────────────────────────────────────────────────────────────

  app.get(`${base}/suppliers`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const suppliers = await listSuppliers(storeId);
    return reply.send({ suppliers });
  });

  app.post(`${base}/suppliers`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId } = StoreParams.parse(request.params);
    const body = CreateSupplierBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const id = await createSupplier(storeId, body.data);
    return reply.status(201).send({ id });
  });

  app.put(`${base}/suppliers/:supplierId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, supplierId } = SupplierParams.parse(request.params);
    const body = UpdateSupplierBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "validation failed", details: body.error.issues } });
    }
    const ok = await updateSupplier(storeId, supplierId, body.data);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "supplier not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/suppliers/:supplierId`, { preHandler: [storeAuthAdmin] }, async (request, reply) => {
    const { storeId, supplierId } = SupplierParams.parse(request.params);
    const ok = await deleteSupplier(storeId, supplierId);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "supplier not found" } });
    return reply.send({ ok: true });
  });
};
