/**
 * return-store-credit.test.ts — Wave-20: auto-issue store credit on return resolution.
 *
 * Key assertions:
 *  - Resolving a return as store_credit for a known customer with a positive amount
 *    increases the customer's store-credit balance by that amount and writes a
 *    wallet ledger (store_credit_transactions) 'issue' entry.
 *  - Re-resolving / retrying the same return does NOT double-credit (idempotent —
 *    keyed on return_requests.store_credit_issued_at).
 *  - A refund-type resolution does NOT issue store credit (regression guard).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import {
  mintJwt,
  insertOrg,
  insertStore,
  insertProduct,
  insertVariant,
  insertCustomer,
} from "../shared/helpers.js";

let ctx: TestCtx;
let orgId: string;
let userId: string;
let storeId: string;
let authHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createCtx();
  userId = "00000000-0000-0000-0000-000000000007";
  const org = await insertOrg(ctx.pool, { name: "Return Store-Credit Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, {
    orgId,
    name: "RSC Store",
    slug: `rsc-store-${Date.now()}`,
  });
  storeId = store.id;
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

const base = () => `/commerce/stores/${storeId}`;

/** Create an order + single line for `customerId` and return their ids. */
async function makeOrderWithLine(customerId: string, price: string): Promise<{
  orderId: string;
  orderLineId: string;
}> {
  const product = await insertProduct(ctx.pool, { storeId, title: "RSC Item" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, price });

  const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders
       (store_id, customer_id, order_number, status, financial_status, fulfillment_status, currency, subtotal, total)
     VALUES ($1::uuid, $2::uuid, $3, 'open', 'paid', 'fulfilled', 'USD', $4::numeric, $4::numeric)
     RETURNING id::text`,
    [storeId, customerId, `RSC-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, price]
  );
  const orderId = orderRows[0]!.id;

  const { rows: lineRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO order_lines (order_id, variant_id, title, quantity, price, total)
     VALUES ($1::uuid, $2::uuid, 'RSC Item', 1, $3::numeric, $3::numeric)
     RETURNING id::text`,
    [orderId, variant.id, price]
  );
  return { orderId, orderLineId: lineRows[0]!.id };
}

/** Create a return for `orderId` and walk it to the `inspected` state. */
async function createReturnAtInspected(
  orderId: string,
  orderLineId: string
): Promise<string> {
  const createRes = await ctx.request({
    method: "POST",
    path: `${base()}/orders/${orderId}/returns`,
    headers: authHeader,
    body: {
      return_type: "store_credit",
      lines: [{ order_line_id: orderLineId, quantity: 1, action: "store_credit", restock: false }],
    },
  });
  expect(createRes.status).toBe(201);
  const returnId = (createRes.json as { id: string }).id;

  for (const status of ["approved", "in_transit", "received", "inspected"] as const) {
    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
      body: { status },
    });
    expect(res.status).toBe(200);
  }
  return returnId;
}

async function readBalance(customerId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ balance: string }>(
    `SELECT balance::text FROM store_credits
     WHERE store_id = $1::uuid AND customer_id = $2::uuid AND currency = 'USD'`,
    [storeId, customerId]
  );
  return rows.length > 0 ? parseFloat(rows[0]!.balance) : 0;
}

async function countIssueLedgerEntries(customerId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM store_credit_transactions sct
     JOIN store_credits sc ON sc.id = sct.store_credit_id
     WHERE sc.store_id = $1::uuid AND sc.customer_id = $2::uuid AND sct.type = 'issue'`,
    [storeId, customerId]
  );
  return parseInt(rows[0]?.count ?? "0", 10);
}

describe("auto-issue store credit on return resolution", () => {
  it("resolving as store_credit issues the amount + writes a ledger entry", async () => {
    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `rsc-issue${Date.now()}@test.example.com`,
    });
    const { orderId, orderLineId } = await makeOrderWithLine(customer.id, "99.00");
    const returnId = await createReturnAtInspected(orderId, orderLineId);

    const before = await readBalance(customer.id);
    const ledgerBefore = await countIssueLedgerEntries(customer.id);

    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
      body: { status: "resolved", return_type: "store_credit", credit_amount: "99.00" },
    });
    expect(res.status).toBe(200);

    const after = await readBalance(customer.id);
    expect(after).toBeCloseTo(before + 99.0, 2);

    const ledgerAfter = await countIssueLedgerEntries(customer.id);
    expect(ledgerAfter).toBe(ledgerBefore + 1);

    // Idempotency marker is set on the return.
    const { rows: markerRows } = await ctx.pool.query<{ issued: string | null }>(
      `SELECT store_credit_issued_at::text AS issued FROM return_requests WHERE id = $1::uuid`,
      [returnId]
    );
    expect(markerRows[0]?.issued).not.toBeNull();
  });

  it("re-resolving the same return does NOT double-credit (idempotent)", async () => {
    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `rsc-idem${Date.now()}@test.example.com`,
    });
    const { orderId, orderLineId } = await makeOrderWithLine(customer.id, "40.00");
    const returnId = await createReturnAtInspected(orderId, orderLineId);

    const before = await readBalance(customer.id);

    // First resolution → credits 40.
    const r1 = await ctx.request({
      method: "PUT",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
      body: { status: "resolved", return_type: "store_credit", credit_amount: "40.00" },
    });
    expect(r1.status).toBe(200);
    expect(await readBalance(customer.id)).toBeCloseTo(before + 40.0, 2);
    const ledgerAfterFirst = await countIssueLedgerEntries(customer.id);

    // Retry the resolve transition twice more → must NOT add more credit.
    for (let i = 0; i < 2; i++) {
      const rN = await ctx.request({
        method: "PUT",
        path: `${base()}/returns/${returnId}`,
        headers: authHeader,
        body: { status: "resolved", return_type: "store_credit", credit_amount: "40.00" },
      });
      expect(rN.status).toBe(200);
    }

    expect(await readBalance(customer.id)).toBeCloseTo(before + 40.0, 2);
    expect(await countIssueLedgerEntries(customer.id)).toBe(ledgerAfterFirst);
  });

  it("a refund-type resolution does NOT issue store credit (regression guard)", async () => {
    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `rsc-refund${Date.now()}@test.example.com`,
    });
    const { orderId, orderLineId } = await makeOrderWithLine(customer.id, "55.00");

    // Create as refund type and walk to inspected.
    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/returns`,
      headers: authHeader,
      body: {
        return_type: "refund",
        lines: [{ order_line_id: orderLineId, quantity: 1, action: "refund", restock: false }],
      },
    });
    expect(createRes.status).toBe(201);
    const returnId = (createRes.json as { id: string }).id;
    for (const status of ["approved", "in_transit", "received", "inspected"] as const) {
      await ctx.request({
        method: "PUT",
        path: `${base()}/returns/${returnId}`,
        headers: authHeader,
        body: { status },
      });
    }

    const before = await readBalance(customer.id);
    const ledgerBefore = await countIssueLedgerEntries(customer.id);

    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
      body: { status: "resolved", return_type: "refund", credit_amount: "55.00" },
    });
    expect(res.status).toBe(200);

    expect(await readBalance(customer.id)).toBeCloseTo(before, 2);
    expect(await countIssueLedgerEntries(customer.id)).toBe(ledgerBefore);

    // No idempotency marker either.
    const { rows: markerRows } = await ctx.pool.query<{ issued: string | null }>(
      `SELECT store_credit_issued_at::text AS issued FROM return_requests WHERE id = $1::uuid`,
      [returnId]
    );
    expect(markerRows[0]?.issued).toBeNull();
  });
});
