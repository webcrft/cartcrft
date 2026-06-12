/**
 * inventory.test.ts — Inventory management suite.
 *
 * Covers:
 *  - Warehouses CRUD lifecycle
 *  - Inventory levels: set + audit row (inventory_adjustments), negative-stock guard
 *  - Inventory adjust: delta + reason, audit trail
 *  - Inventory lots: CRUD + FEFO ordering (expiry_date ASC NULLS LAST, received_at ASC)
 *  - Serial numbers: bulk-create, list, get, update (status lifecycle)
 *  - Suppliers CRUD
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  del,
  patch,
  mintJwt,
  insertStore,
  insertProduct,
  insertVariant,
  isErrorEnvelope,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

async function setupWithVariant() {
  const s = await setup();
  const product = await insertProduct(ctx.pool, { storeId: s.store.id });
  const variant = await insertVariant(ctx.pool, { productId: product.id });
  return { ...s, product, variant };
}

// ── Warehouses CRUD ────────────────────────────────────────────────────────────

describe("Warehouses CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let warehouseId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /warehouses → empty list for new store", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/warehouses`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["warehouses"])).toBe(true);
    expect((res.json["warehouses"] as unknown[]).length).toBe(0);
  });

  it("POST /warehouses → creates warehouse", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/warehouses`,
      { name: "Main Warehouse", code: "MAIN", is_active: true, is_default: true },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    warehouseId = res.json["id"] as string;
  });

  it("GET /warehouses → 1 warehouse after create", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/warehouses`, auth);
    expect(res.status).toBe(200);
    expect((res.json["warehouses"] as unknown[]).length).toBe(1);
    const wh = (res.json["warehouses"] as Record<string, unknown>[])[0]!;
    expect(wh["name"]).toBe("Main Warehouse");
    expect(wh["is_default"]).toBe(true);
  });

  it("PUT /warehouses/:id → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/warehouses/${warehouseId}`,
      { name: "Updated Warehouse" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /warehouses/:id → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/warehouses/${warehouseId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("GET /warehouses → empty after delete", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/warehouses`, auth);
    expect(res.status).toBe(200);
    expect((res.json["warehouses"] as unknown[]).length).toBe(0);
  });
});

// ── Inventory set + audit trail ────────────────────────────────────────────────

describe("Inventory set + audit trail", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let warehouseId = "";
  let variantId = "";

  beforeAll(async () => {
    const s = await setupWithVariant();
    storeId = s.store.id;
    auth = s.auth;
    variantId = s.variant.id;

    // Create warehouse
    const whRes = await post(
      ctx,
      `/commerce/stores/${storeId}/warehouses`,
      { name: "Audit Test WH", is_default: true },
      auth
    );
    warehouseId = whRes.json["id"] as string;
  });

  it("POST /inventory/set → sets inventory level", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/set`,
      { variant_id: variantId, warehouse_id: warehouseId, quantity: 50 },
      auth
    );
    expect(res.status).toBe(200);
    expect(typeof res.json["adjustment_id"]).toBe("string");
  });

  it("GET /inventory → shows quantity_on_hand=50", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/inventory`, auth);
    expect(res.status).toBe(200);
    const levels = res.json["levels"] as Record<string, unknown>[];
    const level = levels.find(
      (l) => l["variant_id"] === variantId && l["warehouse_id"] === warehouseId
    );
    expect(level).toBeDefined();
    expect(Number(level!["quantity_on_hand"])).toBe(50);
  });

  it("GET /inventory/adjustments → audit row created", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/inventory/adjustments`,
      auth
    );
    expect(res.status).toBe(200);
    const adjustments = res.json["adjustments"] as Record<string, unknown>[];
    const audit = adjustments.find(
      (a) =>
        a["variant_id"] === variantId &&
        a["warehouse_id"] === warehouseId &&
        a["reason"] === "initial_count"
    );
    expect(audit).toBeDefined();
    expect(Number(audit!["quantity_delta"])).toBe(50);
  });
});

// ── Inventory adjust + negative-stock guard ────────────────────────────────────

describe("Inventory adjust + negative-stock guard", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let warehouseId = "";
  let variantId = "";

  beforeAll(async () => {
    const s = await setupWithVariant();
    storeId = s.store.id;
    auth = s.auth;
    variantId = s.variant.id;

    const whRes = await post(
      ctx,
      `/commerce/stores/${storeId}/warehouses`,
      { name: "Adjust Test WH", is_default: true },
      auth
    );
    warehouseId = whRes.json["id"] as string;

    // Set initial level = 10
    await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/set`,
      { variant_id: variantId, warehouse_id: warehouseId, quantity: 10 },
      auth
    );
  });

  it("POST /inventory/adjust → increments quantity", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/adjust`,
      {
        variant_id: variantId,
        warehouse_id: warehouseId,
        quantity_delta: 5,
        reason: "received",
      },
      auth
    );
    expect(res.status).toBe(200);
    expect(Number(res.json["quantity_available"])).toBe(15);
  });

  it("GET /inventory/adjustments → adjustment audit row with reason=received", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/inventory/adjustments`,
      auth
    );
    expect(res.status).toBe(200);
    const adjustments = res.json["adjustments"] as Record<string, unknown>[];
    const audit = adjustments.find(
      (a) =>
        a["variant_id"] === variantId &&
        a["warehouse_id"] === warehouseId &&
        a["reason"] === "received"
    );
    expect(audit).toBeDefined();
    expect(Number(audit!["quantity_delta"])).toBe(5);
  });

  it("POST /inventory/adjust → negative-stock guard: qty never below 0", async () => {
    // Current qty = 15, subtract 100 — should clamp to 0
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/adjust`,
      {
        variant_id: variantId,
        warehouse_id: warehouseId,
        quantity_delta: -100,
        reason: "correction",
      },
      auth
    );
    expect(res.status).toBe(200);
    expect(Number(res.json["quantity_available"])).toBeGreaterThanOrEqual(0);
  });

  it("POST /inventory/adjust → rejects zero delta", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/adjust`,
      {
        variant_id: variantId,
        warehouse_id: warehouseId,
        quantity_delta: 0,
        reason: "correction",
      },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── Inventory lots (FEFO ordering) ────────────────────────────────────────────

describe("Inventory lots — FEFO ordering", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let warehouseId = "";
  let variantId = "";

  beforeAll(async () => {
    const s = await setupWithVariant();
    storeId = s.store.id;
    auth = s.auth;
    variantId = s.variant.id;

    const whRes = await post(
      ctx,
      `/commerce/stores/${storeId}/warehouses`,
      { name: "Lots Test WH", is_default: true },
      auth
    );
    warehouseId = whRes.json["id"] as string;

    // Set initial inventory level
    await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/set`,
      { variant_id: variantId, warehouse_id: warehouseId, quantity: 100 },
      auth
    );
  });

  it("GET /inventory/lots → empty list initially", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/inventory/lots`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["lots"])).toBe(true);
  });

  it("POST /inventory/lots → creates lot with expiry date", async () => {
    const expiry = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10); // 30 days from now
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/lots`,
      {
        variant_id: variantId,
        warehouse_id: warehouseId,
        lot_number: "LOT-A",
        quantity: 30,
        expiry_date: expiry,
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
  });

  it("FEFO: lots ordered by expiry_date ASC NULLS LAST, received_at ASC", async () => {
    // Create 3 lots: far future expiry, near future expiry, no expiry (null)
    const nearExpiry = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const farExpiry = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);

    await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/lots`,
      { variant_id: variantId, warehouse_id: warehouseId, lot_number: "LOT-FAR", quantity: 10, expiry_date: farExpiry },
      auth
    );
    await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/lots`,
      { variant_id: variantId, warehouse_id: warehouseId, lot_number: "LOT-NEAR", quantity: 10, expiry_date: nearExpiry },
      auth
    );
    await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/lots`,
      { variant_id: variantId, warehouse_id: warehouseId, lot_number: "LOT-NULL", quantity: 10 },
      auth
    );

    const res = await get(ctx, `/commerce/stores/${storeId}/inventory/lots`, auth);
    expect(res.status).toBe(200);
    const lots = res.json["lots"] as Record<string, unknown>[];
    const numbered = lots.filter(
      (l) => l["lot_number"] === "LOT-NEAR" || l["lot_number"] === "LOT-FAR" || l["lot_number"] === "LOT-NULL"
    );

    // NEAR comes before FAR; NULL last
    const nearIdx = numbered.findIndex((l) => l["lot_number"] === "LOT-NEAR");
    const farIdx = numbered.findIndex((l) => l["lot_number"] === "LOT-FAR");
    const nullIdx = numbered.findIndex((l) => l["lot_number"] === "LOT-NULL");
    expect(nearIdx).toBeLessThan(farIdx);
    expect(nullIdx).toBeGreaterThan(farIdx);
  });

  it("DELETE /inventory/lots/:id → removes lot", async () => {
    const createRes = await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/lots`,
      { variant_id: variantId, warehouse_id: warehouseId, lot_number: "LOT-DEL", quantity: 5 },
      auth
    );
    const lotId = createRes.json["id"] as string;

    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/inventory/lots/${lotId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });
});

// ── Serial numbers lifecycle ────────────────────────────────────────────────────

describe("Serial numbers lifecycle", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let warehouseId = "";
  let variantId = "";

  beforeAll(async () => {
    const s = await setupWithVariant();
    storeId = s.store.id;
    auth = s.auth;
    variantId = s.variant.id;

    const whRes = await post(
      ctx,
      `/commerce/stores/${storeId}/warehouses`,
      { name: "Serials Test WH", is_default: true },
      auth
    );
    warehouseId = whRes.json["id"] as string;

    // Set inventory
    await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/set`,
      { variant_id: variantId, warehouse_id: warehouseId, quantity: 50 },
      auth
    );
  });

  it("POST /inventory/serials → bulk creates serial numbers", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/serials`,
      {
        variant_id: variantId,
        warehouse_id: warehouseId,
        serial_numbers: ["SN-001", "SN-002", "SN-003"],
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["count"]).toBe("number");
    expect(res.json["count"]).toBe(3);
  });

  it("GET /inventory/serials → lists serial numbers", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/inventory/serials`, auth);
    expect(res.status).toBe(200);
    const serials = res.json["serials"] as Record<string, unknown>[];
    const sns = serials.filter(
      (s) =>
        s["serial_number"] === "SN-001" ||
        s["serial_number"] === "SN-002" ||
        s["serial_number"] === "SN-003"
    );
    expect(sns.length).toBe(3);
    // Default status = available
    expect(sns[0]!["status"]).toBe("available");
  });

  it("GET /inventory/serials/:id → returns serial with fields", async () => {
    const listRes = await get(ctx, `/commerce/stores/${storeId}/inventory/serials`, auth);
    const serials = listRes.json["serials"] as Record<string, unknown>[];
    const sn001 = serials.find((s) => s["serial_number"] === "SN-001");
    expect(sn001).toBeDefined();
    const serialId = sn001!["id"] as string;

    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/inventory/serials/${serialId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["serial_number"]).toBe("SN-001");
    expect(res.json["status"]).toBe("available");
    expect(res.json["variant_id"]).toBe(variantId);
  });

  it("PUT /inventory/serials/:id → status transition available → sold", async () => {
    const listRes = await get(ctx, `/commerce/stores/${storeId}/inventory/serials`, auth);
    const serials = listRes.json["serials"] as Record<string, unknown>[];
    const sn002 = serials.find((s) => s["serial_number"] === "SN-002");
    const serialId = sn002!["id"] as string;

    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/inventory/serials/${serialId}`,
      { status: "sold" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    const getRes = await get(
      ctx,
      `/commerce/stores/${storeId}/inventory/serials/${serialId}`,
      auth
    );
    expect(getRes.json["status"]).toBe("sold");
  });

  it("POST /inventory/serials → duplicate serial_number: ON CONFLICT DO NOTHING", async () => {
    // Inserting the same serial again should not error; count should be 0 (all duplicates)
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/inventory/serials`,
      {
        variant_id: variantId,
        warehouse_id: warehouseId,
        serial_numbers: ["SN-001"],
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(res.json["count"]).toBe(0); // already exists, ON CONFLICT DO NOTHING
  });
});

// ── Suppliers CRUD ─────────────────────────────────────────────────────────────

describe("Suppliers CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let supplierId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /suppliers → empty list for new store", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/suppliers`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["suppliers"])).toBe(true);
    expect((res.json["suppliers"] as unknown[]).length).toBe(0);
  });

  it("POST /suppliers → creates supplier", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/suppliers`,
      {
        name: "Acme Supplies",
        email: "contact@acme.example.com",
        is_active: true,
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    supplierId = res.json["id"] as string;
  });

  it("GET /suppliers → 1 result after create", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/suppliers`, auth);
    expect(res.status).toBe(200);
    const suppliers = res.json["suppliers"] as Record<string, unknown>[];
    expect(suppliers.length).toBe(1);
    expect(suppliers[0]!["name"]).toBe("Acme Supplies");
  });

  it("PUT /suppliers/:id → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/suppliers/${supplierId}`,
      { name: "Acme Supplies Updated" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /suppliers/:id → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/suppliers/${supplierId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /suppliers/:id → 404 for non-existent", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/suppliers/${randomUUID()}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});
