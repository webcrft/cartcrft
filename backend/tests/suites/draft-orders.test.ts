/**
 * draft-orders — Draft orders / invoicing suite (Wave 19).
 *
 * Covers the merchant draft → invoice → convert flow:
 *   POST   /commerce/stores/:storeId/draft-orders
 *   GET    /commerce/stores/:storeId/draft-orders[/:id]
 *   PUT    /commerce/stores/:storeId/draft-orders/:id
 *   DELETE /commerce/stores/:storeId/draft-orders/:id
 *   sendInvoice(...)   — with an injected mailer + link-gen spy
 *   convertToOrder(...) — creates a real order via orders/service.createOrder
 *
 * Verifies:
 *   - create computes totals correctly and does NOT change inventory;
 *   - update recomputes totals;
 *   - sendInvoice sets status=invoice_sent + emails the recipient;
 *   - convertToOrder creates a real order with the right total and marks the
 *     draft converted + stamps converted_order_id;
 *   - list/get/delete work;
 *   - converted/cancelled drafts cannot be re-converted.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, del, mintJwt } from "../shared/helpers.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { sendInvoice, convertToOrder } from "../../src/modules/draft-orders/service.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ─────────────────────────────────────────────────────────────────

function bearer(token: string) {
  return { type: "bearer" as const, token };
}

async function authFor(userId: string, orgId: string) {
  return bearer(await mintJwt({ userId, orgId }));
}

async function createStore(auth: { type: "bearer"; token: string }): Promise<string> {
  const res = await post(ctx, "/commerce/stores", { name: `Draft Test Store ${randomUUID()}`, currency: "USD" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  return res.json["id"] as string;
}

/** Insert a product + variant at a given price. Returns variantId. */
async function insertVariant(storeId: string, price: string): Promise<string> {
  const prod = await ctx.pool.query<{ id: string }>(
    `INSERT INTO products (store_id, title, slug) VALUES ($1::uuid, 'P', $2) RETURNING id::text`,
    [storeId, `p-${randomUUID()}`],
  );
  const productId = prod.rows[0]!.id;
  const variant = await ctx.pool.query<{ id: string }>(
    `INSERT INTO product_variants (product_id, title, price) VALUES ($1::uuid, 'Default', $2::numeric) RETURNING id::text`,
    [productId, price],
  );
  return variant.rows[0]!.id;
}

/** Create a warehouse + an inventory level for a variant. Returns on-hand reader. */
async function withInventory(storeId: string, variantId: string, onHand: number) {
  const wh = await ctx.pool.query<{ id: string }>(
    `INSERT INTO warehouses (store_id, name, is_default) VALUES ($1::uuid, 'WH', true) RETURNING id::text`,
    [storeId],
  );
  const warehouseId = wh.rows[0]!.id;
  await ctx.pool.query(
    `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand) VALUES ($1::uuid, $2::uuid, $3)`,
    [variantId, warehouseId, onHand],
  );
  return async () => {
    const { rows } = await ctx.pool.query<{ q: number }>(
      `SELECT quantity_on_hand AS q FROM inventory_levels WHERE variant_id = $1::uuid AND warehouse_id = $2::uuid`,
      [variantId, warehouseId],
    );
    return rows[0]!.q;
  };
}

async function draftRow(id: string) {
  const { rows } = await ctx.pool.query<{
    status: string;
    converted_order_id: string | null;
    invoice_url: string | null;
    total: string;
  }>(
    `SELECT status, converted_order_id::text, invoice_url, total::text FROM draft_orders WHERE id = $1::uuid`,
    [id],
  );
  return rows[0]!;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Draft orders — create, totals, invoice, convert", () => {
  const userId = randomUUID();
  const orgId = randomUUID();

  it("create computes totals correctly and does NOT touch inventory", async () => {
    const auth = await authFor(userId, orgId);
    const storeId = await createStore(auth);
    const variantId = await insertVariant(storeId, "25.00");
    const readOnHand = await withInventory(storeId, variantId, 7);

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/draft-orders`,
      {
        currency: "USD",
        email: "buyer@example.com",
        line_items: [{ variant_id: variantId, title: "Widget", quantity: 3, price: "25.00" }],
        shipping_total: "5.00",
        tax_total: "2.50",
        discount_total: "10.00",
        note: "rush",
      },
      auth,
    );
    expect(res.status).toBe(201);
    // subtotal 75.00; total = 75 - 10 + 2.50 + 5 = 72.50
    expect(res.json["subtotal"]).toBe("75.00");
    expect(res.json["total"]).toBe("72.50");
    expect(res.json["status"]).toBe("draft");

    // Inventory untouched.
    expect(await readOnHand()).toBe(7);
  });

  it("update recomputes totals", async () => {
    const auth = await authFor(userId, orgId);
    const storeId = await createStore(auth);
    const variantId = await insertVariant(storeId, "10.00");

    const created = await post(
      ctx,
      `/commerce/stores/${storeId}/draft-orders`,
      { currency: "USD", line_items: [{ variant_id: variantId, quantity: 1, price: "10.00" }] },
      auth,
    );
    const id = created.json["id"] as string;
    expect(created.json["total"]).toBe("10.00");

    const updated = await put(
      ctx,
      `/commerce/stores/${storeId}/draft-orders/${id}`,
      { line_items: [{ variant_id: variantId, quantity: 4, price: "10.00" }], shipping_total: "3.00" },
      auth,
    );
    expect(updated.status).toBe(200);
    expect(updated.json["subtotal"]).toBe("40.00");
    expect(updated.json["total"]).toBe("43.00");
  });

  it("sendInvoice (injected mailer + link spy) sets invoice_sent and emails", async () => {
    const auth = await authFor(userId, orgId);
    const storeId = await createStore(auth);
    const variantId = await insertVariant(storeId, "20.00");

    const created = await post(
      ctx,
      `/commerce/stores/${storeId}/draft-orders`,
      { currency: "USD", email: "invoice-me@example.com", line_items: [{ variant_id: variantId, quantity: 2, price: "20.00" }] },
      auth,
    );
    const id = created.json["id"] as string;

    const mailer = new ConsoleMailer();
    const draft = await sendInvoice(storeId, id, {
      mailer,
      generateLink: async () => "https://pay.example.com/inv_123",
    });

    expect(draft.status).toBe("invoice_sent");
    expect(draft.invoice_url).toBe("https://pay.example.com/inv_123");
    expect(mailer.sentMessages.length).toBe(1);
    expect(mailer.sentMessages[0]!.to).toBe("invoice-me@example.com");
    expect(mailer.sentMessages[0]!.bodyText).toContain("https://pay.example.com/inv_123");

    expect((await draftRow(id)).status).toBe("invoice_sent");
  });

  it("convertToOrder creates a real order with the right total + marks draft converted", async () => {
    const auth = await authFor(userId, orgId);
    const storeId = await createStore(auth);
    const variantId = await insertVariant(storeId, "30.00");

    const created = await post(
      ctx,
      `/commerce/stores/${storeId}/draft-orders`,
      {
        currency: "USD",
        line_items: [{ variant_id: variantId, quantity: 2, price: "30.00" }],
        shipping_total: "5.00",
        tax_total: "1.00",
        discount_total: "6.00",
      },
      auth,
    );
    const id = created.json["id"] as string;
    // subtotal 60; total = 60 - 6 + 1 + 5 = 60.00
    expect(created.json["total"]).toBe("60.00");

    const result = await convertToOrder(storeId, id, userId);
    expect(result.order_id).toBeTruthy();

    // A real order row exists with the matching total.
    const { rows: orderRows } = await ctx.pool.query<{ total: string; customer_id: string | null }>(
      `SELECT total::text, customer_id::text FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
      [result.order_id, storeId],
    );
    expect(orderRows.length).toBe(1);
    expect(orderRows[0]!.total).toBe("60.00");

    // Draft marked converted + stamped.
    const row = await draftRow(id);
    expect(row.status).toBe("converted");
    expect(row.converted_order_id).toBe(result.order_id);

    // Re-converting a converted draft is rejected.
    await expect(convertToOrder(storeId, id, userId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("list / get / delete work, and a cancelled draft cannot be converted", async () => {
    const auth = await authFor(userId, orgId);
    const storeId = await createStore(auth);
    const variantId = await insertVariant(storeId, "12.00");

    const created = await post(
      ctx,
      `/commerce/stores/${storeId}/draft-orders`,
      { currency: "USD", line_items: [{ variant_id: variantId, quantity: 1, price: "12.00" }] },
      auth,
    );
    const id = created.json["id"] as string;

    // List
    const listRes = await get(ctx, `/commerce/stores/${storeId}/draft-orders`, auth);
    expect(listRes.status).toBe(200);
    expect((listRes.json["drafts"] as unknown[]).length).toBe(1);
    expect(listRes.json["total"]).toBe(1);

    // Get
    const getRes = await get(ctx, `/commerce/stores/${storeId}/draft-orders/${id}`, auth);
    expect(getRes.status).toBe(200);
    expect(getRes.json["id"]).toBe(id);

    // A cancelled draft cannot be converted.
    await ctx.pool.query(`UPDATE draft_orders SET status = 'cancelled' WHERE id = $1::uuid`, [id]);
    await expect(convertToOrder(storeId, id, userId)).rejects.toMatchObject({ code: "CONFLICT" });

    // Delete
    const delRes = await del(ctx, `/commerce/stores/${storeId}/draft-orders/${id}`, auth);
    expect(delRes.status).toBe(200);
    const getAfter = await get(ctx, `/commerce/stores/${storeId}/draft-orders/${id}`, auth);
    expect(getAfter.status).toBe(404);
  });
});
