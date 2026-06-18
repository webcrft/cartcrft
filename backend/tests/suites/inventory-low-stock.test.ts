/**
 * inventory-low-stock.test.ts — reorder-point low-stock alert suite.
 *
 * Covers detectLowStock() (inventory/service.ts) with an INJECTED dispatch spy:
 *  - fires inventory.low once with the correct payload + writes an alert row
 *  - re-running while still low does NOT re-fire (idempotent)
 *  - recovering above reorder_point then dropping again DOES re-fire
 *  - the 24h cooldown re-fires a still-low item
 *  - reorder_point = 0 / NULL and untracked variants never fire
 *
 * Seeds warehouses + inventory_levels directly via ctx.pool (mirroring the
 * existing inventory suite's fixture style). detectLowStock uses getPool(), which
 * the harness has pointed at the search_path-scoped test pool.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { insertStore, insertProduct, insertVariant } from "../shared/helpers.js";
import { detectLowStock, LOW_STOCK_COOLDOWN_MS } from "../../src/modules/inventory/service.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Fixtures ────────────────────────────────────────────────────────────────────

interface DispatchCall {
  storeId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/** A dispatch spy matching dispatchStoreEvent's signature. */
function makeSpy() {
  const calls: DispatchCall[] = [];
  const dispatch = (
    storeId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): void => {
    calls.push({ storeId, eventType, payload });
  };
  return { calls, dispatch };
}

async function insertWarehouse(storeId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO warehouses (store_id, name, is_default)
     VALUES ($1::uuid, $2, true) RETURNING id::text`,
    [storeId, "Low-stock WH"]
  );
  return rows[0]!.id;
}

async function setLevel(
  variantId: string,
  warehouseId: string,
  onHand: number,
  reorderPoint: number | null
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand, reorder_point)
     VALUES ($1::uuid, $2::uuid, $3, $4)
     ON CONFLICT (variant_id, warehouse_id) DO UPDATE
       SET quantity_on_hand = $3, reorder_point = $4, updated_at = now()`,
    [variantId, warehouseId, onHand, reorderPoint]
  );
}

async function setTrackInventory(variantId: string, track: boolean): Promise<void> {
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = $2 WHERE id = $1::uuid`,
    [variantId, track]
  );
}

async function alertRow(variantId: string, warehouseId: string) {
  const { rows } = await ctx.pool.query<{
    store_id: string;
    last_on_hand: number | null;
    last_alerted_at: Date | null;
  }>(
    `SELECT store_id::text, last_on_hand, last_alerted_at
     FROM inventory_low_alerts WHERE variant_id = $1::uuid AND warehouse_id = $2::uuid`,
    [variantId, warehouseId]
  );
  return rows[0] ?? null;
}

/** Fresh store + tracked variant + warehouse. */
async function seedVariant() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const product = await insertProduct(ctx.pool, { storeId: store.id });
  const variant = await insertVariant(ctx.pool, { productId: product.id });
  const warehouseId = await insertWarehouse(store.id);
  return { storeId: store.id, variantId: variant.id, warehouseId };
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("detectLowStock — fires once on transition into low", () => {
  it("emits inventory.low with the correct payload and writes an alert row", async () => {
    const { storeId, variantId, warehouseId } = await seedVariant();
    await setLevel(variantId, warehouseId, 3, 10); // on_hand 3 <= reorder 10

    const spy = makeSpy();
    const fired = await detectLowStock(storeId, { dispatch: spy.dispatch });

    expect(fired).toBe(1);
    expect(spy.calls.length).toBe(1);
    const call = spy.calls[0]!;
    expect(call.storeId).toBe(storeId);
    expect(call.eventType).toBe("inventory.low");
    expect(call.payload["variant_id"]).toBe(variantId);
    expect(call.payload["warehouse_id"]).toBe(warehouseId);
    expect(call.payload["on_hand"]).toBe(3);
    expect(call.payload["reorder_point"]).toBe(10);

    const row = await alertRow(variantId, warehouseId);
    expect(row).not.toBeNull();
    expect(row!.store_id).toBe(storeId);
    expect(row!.last_on_hand).toBe(3);
    expect(row!.last_alerted_at).not.toBeNull();
  });
});

describe("detectLowStock — idempotent while still low", () => {
  it("does NOT re-fire on a second run within cooldown", async () => {
    const { storeId, variantId, warehouseId } = await seedVariant();
    await setLevel(variantId, warehouseId, 2, 5);

    const first = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: first.dispatch })).toBe(1);

    const second = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: second.dispatch })).toBe(0);
    expect(second.calls.length).toBe(0);

    // Still-low refresh keeps last_on_hand current.
    const row = await alertRow(variantId, warehouseId);
    expect(row!.last_on_hand).toBe(2);
  });
});

describe("detectLowStock — recover then drop re-fires", () => {
  it("re-fires after stock rises above reorder_point and drops again", async () => {
    const { storeId, variantId, warehouseId } = await seedVariant();
    await setLevel(variantId, warehouseId, 2, 5);

    const a = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: a.dispatch })).toBe(1);

    // Recover above reorder_point — detectLowStock records the recovery so the
    // alert state's last_on_hand goes above reorder_point.
    await setLevel(variantId, warehouseId, 20, 5);
    const b = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: b.dispatch })).toBe(0);
    const recovered = await alertRow(variantId, warehouseId);
    expect(recovered!.last_on_hand).toBe(20); // above reorder_point

    // Drop again → NEW transition into low → re-fires.
    await setLevel(variantId, warehouseId, 1, 5);
    const c = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: c.dispatch })).toBe(1);
    expect(c.calls[0]!.payload["on_hand"]).toBe(1);
  });
});

describe("detectLowStock — cooldown re-fires a still-low item", () => {
  it("re-fires once the cooldown has elapsed even without recovery", async () => {
    const { storeId, variantId, warehouseId } = await seedVariant();
    await setLevel(variantId, warehouseId, 2, 5);

    const t0 = new Date("2026-01-01T00:00:00Z");
    const a = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: a.dispatch, now: () => t0 })).toBe(1);

    // Just before cooldown → no re-fire.
    const tBefore = new Date(t0.getTime() + LOW_STOCK_COOLDOWN_MS - 60_000);
    const b = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: b.dispatch, now: () => tBefore })).toBe(0);

    // Past cooldown → re-fire.
    const tAfter = new Date(t0.getTime() + LOW_STOCK_COOLDOWN_MS + 60_000);
    const c = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: c.dispatch, now: () => tAfter })).toBe(1);
  });
});

describe("detectLowStock — never fires for ineligible rows", () => {
  it("reorder_point = 0 never fires", async () => {
    const { storeId, variantId, warehouseId } = await seedVariant();
    await setLevel(variantId, warehouseId, 0, 0);

    const spy = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: spy.dispatch })).toBe(0);
    expect(await alertRow(variantId, warehouseId)).toBeNull();
  });

  it("reorder_point NULL never fires", async () => {
    const { storeId, variantId, warehouseId } = await seedVariant();
    await setLevel(variantId, warehouseId, 0, null);

    const spy = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: spy.dispatch })).toBe(0);
  });

  it("untracked variant never fires", async () => {
    const { storeId, variantId, warehouseId } = await seedVariant();
    await setTrackInventory(variantId, false);
    await setLevel(variantId, warehouseId, 1, 10);

    const spy = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: spy.dispatch })).toBe(0);
  });

  it("on_hand above reorder_point never fires", async () => {
    const { storeId, variantId, warehouseId } = await seedVariant();
    await setLevel(variantId, warehouseId, 50, 10);

    const spy = makeSpy();
    expect(await detectLowStock(storeId, { dispatch: spy.dispatch })).toBe(0);
  });
});
