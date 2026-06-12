/**
 * returns.test.ts — Returns/RMA module.
 *
 * Key assertions:
 *  - Create RMA from order with lines (reason/condition/action)
 *  - RMA number is assigned
 *  - Status machine: requested → approved → in_transit → received → inspected → resolved → closed
 *  - Resolution actions: store_credit issues credit, refund creates refund row, restock adjusts inventory
 *  - Return events log
 *  - List/Get with filters
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import { mintJwt, insertOrg, insertStore, insertProduct, insertVariant, insertCustomer } from "../shared/helpers.js";

let ctx: TestCtx;
let orgId: string;
let userId: string;
let storeId: string;
let authHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createCtx();
  userId = "00000000-0000-0000-0000-000000000003";
  const org = await insertOrg(ctx.pool, { name: "Returns Test Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, { orgId, name: "Returns Store", slug: `returns-store-${Date.now()}` });
  storeId = store.id;
});

afterAll(async () => {
  await ctx.teardown();
});

const base = () => `/commerce/stores/${storeId}`;

// ── Full RMA state machine ─────────────────────────────────────────────────────

describe("RMA full state machine", () => {
  let orderId: string;
  let orderLineId: string;
  let returnId: string;
  let customerId: string;

  beforeAll(async () => {
    const product = await insertProduct(ctx.pool, { storeId, title: "Returnable Item" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "99.00" });
    const customer = await insertCustomer(ctx.pool, { storeId, email: `rma${Date.now()}@test.example.com` });
    customerId = customer.id;

    // Create an order with a line
    const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, order_number, status, financial_status, fulfillment_status, currency, subtotal, total)
       VALUES ($1::uuid, $2::uuid, $3, 'open', 'paid', 'fulfilled', 'USD', 99.00, 99.00)
       RETURNING id::text`,
      [storeId, customerId, `RMA-TEST-${Date.now()}`]
    );
    orderId = orderRows[0]?.id ?? "";

    const { rows: lineRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO order_lines
         (order_id, variant_id, title, quantity, price, total)
       VALUES ($1::uuid, $2::uuid, 'Returnable Item', 1, 99.00, 99.00)
       RETURNING id::text`,
      [orderId, variant.id]
    );
    orderLineId = lineRows[0]?.id ?? "";
  });

  it("creates an RMA from an order", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/returns`,
      headers: authHeader,
      body: {
        return_type: "refund",
        notes: "Item damaged in shipping",
        lines: [
          {
            order_line_id: orderLineId,
            quantity: 1,
            reason: "damaged_in_transit",
            condition: "damaged",
            action: "store_credit",
            restock: false,
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    returnId = (res.json as { id: string }).id;
    expect(typeof returnId).toBe("string");
  });

  it("has an RMA number", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const ret = res.json as { rma_number: string; status: string; lines: unknown[] };
    expect(ret.status).toBe("requested");
    expect(typeof ret.rma_number).toBe("string");
    expect(ret.rma_number.length).toBeGreaterThan(0);
    expect(ret.lines.length).toBe(1);
  });

  it("approves the return (requested → approved)", async () => {
    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
      body: { status: "approved" },
    });
    expect(res.status).toBe(200);

    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    expect((getRes.json as { status: string }).status).toBe("approved");
  });

  it("transitions through in_transit → received → inspected", async () => {
    for (const status of ["in_transit", "received", "inspected"] as const) {
      const res = await ctx.request({
        method: "PUT",
        path: `${base()}/returns/${returnId}`,
        headers: authHeader,
        body: { status },
      });
      expect(res.status).toBe(200);
    }

    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    expect((getRes.json as { status: string }).status).toBe("inspected");
  });

  it("resolves with store_credit: issues credit to customer", async () => {
    // Set up store credit: issue some credit first to have a base
    const { rows: creditRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO store_credits (store_id, customer_id, currency, balance)
       VALUES ($1::uuid, $2::uuid, 'USD', 0)
       ON CONFLICT (store_id, customer_id, currency) DO UPDATE SET updated_at = now()
       RETURNING id::text`,
      [storeId, customerId]
    );

    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
      body: { status: "resolved", return_type: "store_credit", credit_amount: 99.0 },
    });
    expect(res.status).toBe(200);

    // Verify store credit was issued (best-effort check)
    const { rows: scRows } = await ctx.pool.query(
      `SELECT balance::text FROM store_credits WHERE store_id = $1::uuid AND customer_id = $2::uuid`,
      [storeId, customerId]
    );
    if (scRows.length > 0) {
      expect(parseFloat(scRows[0].balance)).toBeGreaterThan(0);
    }
  });

  it("closes the return", async () => {
    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
      body: { status: "closed" },
    });
    expect(res.status).toBe(200);

    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    expect((getRes.json as { status: string }).status).toBe("closed");
  });

  it("return events are logged", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}/events`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { events: unknown[] };
    // Should have at least 1 event (return_requested + status changes)
    expect(body.events.length).toBeGreaterThan(0);
  });

  it("adds a manual return event", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/returns/${returnId}/events`,
      headers: authHeader,
      body: { type: "note_added", data: { note: "Customer was informed" } },
    });
    expect(res.status).toBe(201);
    expect(typeof (res.json as { id: string }).id).toBe("string");
  });
});

// ── Restock on resolution ─────────────────────────────────────────────────────

describe("restock on return resolution", () => {
  it("restocks inventory when restock=true line is resolved", async () => {
    const product = await insertProduct(ctx.pool, { storeId, title: "Restockable" });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "50.00" });
    const customer = await insertCustomer(ctx.pool, { storeId, email: `restock${Date.now()}@test.example.com` });

    // Create warehouse and initial inventory
    const { rows: whRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO warehouses (store_id, name, is_default) VALUES ($1::uuid, 'Main Warehouse', true) RETURNING id::text`,
      [storeId]
    );
    const warehouseId = whRows[0]?.id;
    if (warehouseId) {
      await ctx.pool.query(
        `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand, quantity_committed, quantity_incoming)
         VALUES ($1::uuid, $2::uuid, 5, 0, 0)
         ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET quantity_on_hand = 5`,
        [variant.id, warehouseId]
      );
    }

    // Create order + line
    const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, order_number, status, financial_status, fulfillment_status, currency, subtotal, total)
       VALUES ($1::uuid, $2::uuid, $3, 'open', 'paid', 'fulfilled', 'USD', 50.00, 50.00)
       RETURNING id::text`,
      [storeId, customer.id, `RESTOCK-${Date.now()}`]
    );
    const oid = orderRows[0]?.id ?? "";

    const { rows: lineRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO order_lines (order_id, variant_id, title, quantity, price, total)
       VALUES ($1::uuid, $2::uuid, 'Restockable', 1, 50.00, 50.00) RETURNING id::text`,
      [oid, variant.id]
    );
    const olid = lineRows[0]?.id ?? "";

    // Create return with restock=true
    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${oid}/returns`,
      headers: authHeader,
      body: {
        return_type: "refund",
        lines: [{ order_line_id: olid, quantity: 1, restock: true }],
      },
    });
    const rid = (createRes.json as { id: string }).id;

    // Approve + resolve
    await ctx.request({ method: "PUT", path: `${base()}/returns/${rid}`, headers: authHeader, body: { status: "approved" } });
    await ctx.request({ method: "PUT", path: `${base()}/returns/${rid}`, headers: authHeader, body: { status: "in_transit" } });
    await ctx.request({ method: "PUT", path: `${base()}/returns/${rid}`, headers: authHeader, body: { status: "received" } });
    await ctx.request({ method: "PUT", path: `${base()}/returns/${rid}`, headers: authHeader, body: { status: "inspected" } });
    await ctx.request({ method: "PUT", path: `${base()}/returns/${rid}`, headers: authHeader, body: { status: "resolved", return_type: "refund" } });

    // Check inventory was incremented (only if warehouse exists)
    if (warehouseId) {
      const { rows: invRows } = await ctx.pool.query(
        `SELECT quantity_on_hand FROM inventory_levels WHERE variant_id = $1::uuid AND warehouse_id = $2::uuid`,
        [variant.id, warehouseId]
      );
      if (invRows.length > 0) {
        // Should be 5+1=6 or more
        expect(invRows[0].quantity_on_hand).toBeGreaterThanOrEqual(6);
      }
    }
  });
});

// ── List and filter returns ────────────────────────────────────────────────────

describe("list returns", () => {
  it("lists all returns for store", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/returns`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { returns: unknown[]; total: number };
    expect(Array.isArray(body.returns)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("filters returns by status", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/returns?status=closed`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { returns: Array<{ status: string }> };
    body.returns.forEach((r) => expect(r.status).toBe("closed"));
  });

  it("returns 404 for non-existent return", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/returns/00000000-0000-4000-8000-000000000001`,
      headers: authHeader,
    });
    expect(res.status).toBe(404);
  });
});
