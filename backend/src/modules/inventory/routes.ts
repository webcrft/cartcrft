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

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
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

// H3.2: cost_price is a money field — stored as numeric(15,2) — use decimal-string input.
const MoneyString = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string (e.g. \"9.99\")");

const CreateLotBody = z.object({
  variant_id: z.string().uuid(),
  warehouse_id: z.string().uuid(),
  lot_number: z.string().min(1).max(100),
  quantity: z.number().int().min(0),
  expiry_date: z.string().nullish(),
  cost_price: MoneyString.nullish(),
  received_at: z.string().nullish(),
});

const UpdateLotBody = z.object({
  expiry_date: z.string().nullish(),
  quantity: z.number().int().min(0).optional(),
  cost_price: MoneyString.nullish(),
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

export const inventoryPlugin: FastifyPluginAsyncZod = async (app) => {
  const base = "/commerce/stores/:storeId";

  // ── Warehouses ─────────────────────────────────────────────────────────────

  app.get(`${base}/warehouses`, {
    schema: { params: StoreParams },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const warehouses = await listWarehouses(storeId);
    return reply.send({ warehouses });
  });

  app.post(`${base}/warehouses`, {
    schema: { params: StoreParams, body: CreateWarehouseBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const id = await createWarehouse(storeId, request.body);
    return reply.status(201).send({ id });
  });

  app.put(`${base}/warehouses/:warehouseId`, {
    schema: { params: WarehouseParams, body: UpdateWarehouseBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId, warehouseId } = request.params;
    const ok = await updateWarehouse(storeId, warehouseId, request.body);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "warehouse not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/warehouses/:warehouseId`, {
    schema: { params: WarehouseParams },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId, warehouseId } = request.params;
    await deleteWarehouse(storeId, warehouseId);
    return reply.send({ ok: true });
  });

  // ── Inventory levels ────────────────────────────────────────────────────────

  app.get(`${base}/inventory`, {
    schema: { params: StoreParams, querystring: InventoryQuery },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const levels = await listInventoryLevels(storeId, request.query);
    return reply.send({ levels });
  });

  app.post(`${base}/inventory/set`, {
    schema: { params: StoreParams, body: SetInventoryBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const userId = request.auth!.userId;
    const adjustmentId = await setInventoryLevel(storeId, { ...request.body, created_by: userId });
    return reply.send({ ok: true, adjustment_id: adjustmentId });
  });

  app.post(`${base}/inventory/adjust`, {
    schema: { params: StoreParams, body: AdjustInventoryBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const userId = request.auth!.userId;
    const result = await adjustInventory(storeId, { ...request.body, created_by: userId });
    return reply.send({ id: result.id, quantity_available: result.quantity_available, reorder_point: result.reorder_point });
  });

  app.get(`${base}/inventory/adjustments`, {
    schema: { params: StoreParams, querystring: InventoryQuery },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const adjustments = await listInventoryAdjustments(storeId, request.query);
    return reply.send({ adjustments });
  });

  // ── Lots ───────────────────────────────────────────────────────────────────

  app.get(`${base}/inventory/lots`, {
    schema: { params: StoreParams, querystring: LotQuery },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const lots = await listInventoryLots(storeId, request.query);
    return reply.send({ lots });
  });

  app.post(`${base}/inventory/lots`, {
    schema: { params: StoreParams, body: CreateLotBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    // H3.2: parse decimal-string money fields to numbers for the service layer
    const id = await createInventoryLot(storeId, {
      ...request.body,
      cost_price: request.body.cost_price != null ? parseFloat(request.body.cost_price) : undefined,
    });
    if (!id) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "warehouse not found in this store" } });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/inventory/lots/:lotId`, {
    schema: { params: LotParams, body: UpdateLotBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId, lotId } = request.params;
    // H3.2: parse decimal-string money fields to numbers for the service layer
    const ok = await updateInventoryLot(storeId, lotId, {
      ...request.body,
      cost_price: request.body.cost_price != null ? parseFloat(request.body.cost_price) : undefined,
    });
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "lot not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/inventory/lots/:lotId`, {
    schema: { params: LotParams },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId, lotId } = request.params;
    await deleteInventoryLot(storeId, lotId);
    return reply.send({ ok: true });
  });

  // ── Serial numbers ──────────────────────────────────────────────────────────

  app.get(`${base}/inventory/serials`, {
    schema: { params: StoreParams, querystring: SerialQuery },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const serials = await listSerialNumbers(storeId, request.query);
    return reply.send({ serials });
  });

  app.post(`${base}/inventory/serials`, {
    schema: { params: StoreParams, body: BulkCreateSerialsBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const count = await bulkCreateSerialNumbers(storeId, request.body);
    return reply.status(201).send({ count });
  });

  app.get(`${base}/inventory/serials/:serialId`, {
    schema: { params: SerialParams },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId, serialId } = request.params;
    const sn = await getSerialNumber(storeId, serialId);
    if (!sn) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "serial number not found" } });
    return reply.send(sn);
  });

  app.put(`${base}/inventory/serials/:serialId`, {
    schema: { params: SerialParams, body: UpdateSerialBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId, serialId } = request.params;
    const ok = await updateSerialNumber(storeId, serialId, request.body);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "serial number not found" } });
    return reply.send({ ok: true });
  });

  // ── Suppliers ──────────────────────────────────────────────────────────────

  app.get(`${base}/suppliers`, {
    schema: { params: StoreParams },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const suppliers = await listSuppliers(storeId);
    return reply.send({ suppliers });
  });

  app.post(`${base}/suppliers`, {
    schema: { params: StoreParams, body: CreateSupplierBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const id = await createSupplier(storeId, request.body);
    return reply.status(201).send({ id });
  });

  app.put(`${base}/suppliers/:supplierId`, {
    schema: { params: SupplierParams, body: UpdateSupplierBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId, supplierId } = request.params;
    const ok = await updateSupplier(storeId, supplierId, request.body);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "supplier not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/suppliers/:supplierId`, {
    schema: { params: SupplierParams },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId, supplierId } = request.params;
    const ok = await deleteSupplier(storeId, supplierId);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "supplier not found" } });
    return reply.send({ ok: true });
  });
};
