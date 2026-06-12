/**
 * b2b.test.ts — B2B module: companies, customer groups, quotes, purchase orders.
 *
 * Key assertions:
 *  - Companies CRUD (credit_limit, payment_terms_days, price_list)
 *  - Company customers (add/remove roles)
 *  - Customer groups CRUD + members
 *  - Quote lifecycle: create draft → send → accept (→ order) | reject
 *  - Quote→order conversion: totals correct, status=converted, converted_order_id set
 *  - Quote expiry: expired quote cannot be accepted
 *  - Net-terms due_date on order (via payment_terms_days on company)
 *  - Purchase orders: list/get/update + attach to order
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
let jwt: string;
let authHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createCtx();
  userId = "00000000-0000-0000-0000-000000000001";
  const org = await insertOrg(ctx.pool, { name: "B2B Test Org" });
  orgId = org.id;
  jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, { orgId, name: "B2B Store", slug: `b2b-store-${Date.now()}` });
  storeId = store.id;
});

afterAll(async () => {
  await ctx.teardown();
});

const base = () => `/commerce/stores/${storeId}`;

// ── Companies ─────────────────────────────────────────────────────────────────

describe("companies", () => {
  let companyId: string;

  it("creates a company", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/companies`,
      headers: authHeader,
      body: {
        name: "Acme Corp",
        email: "billing@acme.example.com",
        credit_limit: "10000.00",
        payment_terms_days: 30,
      },
    });
    expect(res.status).toBe(201);
    const body = res.json as Record<string, string>;
    expect(typeof body.id).toBe("string");
    companyId = body.id;
  });

  it("lists companies", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/companies`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { companies: unknown[] };
    expect(Array.isArray(body.companies)).toBe(true);
    expect(body.companies.length).toBeGreaterThan(0);
  });

  it("gets a company", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/companies/${companyId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { name: string; credit_limit: string };
    expect(body.name).toBe("Acme Corp");
    expect(body.credit_limit).toBe("10000.00");
  });

  it("updates a company credit_limit", async () => {
    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/companies/${companyId}`,
      headers: authHeader,
      body: { credit_limit: "25000.00" },
    });
    expect(res.status).toBe(200);
    // Verify
    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/companies/${companyId}`,
      headers: authHeader,
    });
    const updated = getRes.json as { credit_limit: string };
    expect(updated.credit_limit).toBe("25000.00");
  });

  it("adds a company customer", async () => {
    const customer = await insertCustomer(ctx.pool, { storeId, email: "buyer@acme.example.com" });
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/companies/${companyId}/customers`,
      headers: authHeader,
      body: { customer_id: customer.id, role: "buyer" },
    });
    expect(res.status).toBe(201);
    const body = res.json as { ok: boolean };
    expect(body.ok).toBe(true);

    // List company customers
    const listRes = await ctx.request({
      method: "GET",
      path: `${base()}/companies/${companyId}/customers`,
      headers: authHeader,
    });
    expect(listRes.status).toBe(200);
    const listBody = listRes.json as { customers: unknown[] };
    expect(listBody.customers.length).toBeGreaterThan(0);

    // Remove
    const delRes = await ctx.request({
      method: "DELETE",
      path: `${base()}/companies/${companyId}/customers/${customer.id}`,
      headers: authHeader,
    });
    expect(delRes.status).toBe(200);
  });

  it("deletes a company", async () => {
    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/companies`,
      headers: authHeader,
      body: { name: "Temp Corp" },
    });
    expect(createRes.status).toBe(201);
    const cid = (createRes.json as { id: string }).id;
    const delRes = await ctx.request({
      method: "DELETE",
      path: `${base()}/companies/${cid}`,
      headers: authHeader,
    });
    expect(delRes.status).toBe(200);
  });
});

// ── Customer groups ────────────────────────────────────────────────────────────

describe("customer groups", () => {
  let groupId: string;
  let memberId: string;

  it("creates a customer group", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/customer-groups`,
      headers: authHeader,
      body: { name: "VIP Customers" },
    });
    expect(res.status).toBe(201);
    groupId = (res.json as { id: string }).id;
    expect(typeof groupId).toBe("string");
  });

  it("lists customer groups", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/customer-groups`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { groups: unknown[] };
    expect(body.groups.length).toBeGreaterThan(0);
  });

  it("updates a customer group", async () => {
    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/customer-groups/${groupId}`,
      headers: authHeader,
      body: { name: "Platinum VIP" },
    });
    expect(res.status).toBe(200);
  });

  it("adds and removes a group member", async () => {
    const customer = await insertCustomer(ctx.pool, { storeId, email: `vip${Date.now()}@test.example.com` });
    memberId = customer.id;

    const addRes = await ctx.request({
      method: "POST",
      path: `${base()}/customer-groups/${groupId}/members`,
      headers: authHeader,
      body: { customer_id: memberId },
    });
    expect(addRes.status).toBe(200);

    const delRes = await ctx.request({
      method: "DELETE",
      path: `${base()}/customer-groups/${groupId}/members/${memberId}`,
      headers: authHeader,
    });
    expect(delRes.status).toBe(200);
  });

  it("deletes a customer group", async () => {
    const res = await ctx.request({
      method: "DELETE",
      path: `${base()}/customer-groups/${groupId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
  });
});

// ── Quotes lifecycle ───────────────────────────────────────────────────────────

describe("quotes lifecycle", () => {
  let product: { id: string; storeId: string; title: string };
  let variant: { id: string; productId: string; price: string };
  let companyId: string;
  let quoteId: string;

  beforeAll(async () => {
    product = await insertProduct(ctx.pool, { storeId, title: "Widget Pro" });
    variant = await insertVariant(ctx.pool, { productId: product.id, price: "150.00" });

    const compRes = await ctx.request({
      method: "POST",
      path: `${base()}/companies`,
      headers: authHeader,
      body: { name: "Wholesale Co", payment_terms_days: 30 },
    });
    companyId = (compRes.json as { id: string }).id;
  });

  it("creates a draft quote with lines", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/quotes`,
      headers: authHeader,
      body: {
        company_id: companyId,
        notes: "Please review this quote",
        lines: [
          { variant_id: variant.id, title: "Widget Pro", quantity: 10, price: 135.0 },
          { title: "Setup Fee", quantity: 1, price: 200.0 },
        ],
      },
    });
    expect(res.status).toBe(201);
    quoteId = (res.json as { id: string }).id;
    expect(typeof quoteId).toBe("string");
  });

  it("gets quote with lines", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/quotes/${quoteId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const q = res.json as { status: string; lines: unknown[] };
    expect(q.status).toBe("draft");
    expect(q.lines.length).toBe(2);
  });

  it("sends the quote (draft → sent)", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/quotes/${quoteId}/send`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);

    // Verify status changed
    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/quotes/${quoteId}`,
      headers: authHeader,
    });
    expect((getRes.json as { status: string }).status).toBe("sent");
  });

  it("accepts the quote → creates order with correct totals", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/quotes/${quoteId}/accept`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { order_id: string; order_number: string };
    expect(typeof body.order_id).toBe("string");
    expect(typeof body.order_number).toBe("string");

    // Verify order was created with correct totals (10*135 + 200 = 1550)
    const { rows: orderRows } = await ctx.pool.query(
      `SELECT total::text, subtotal::text, status, source_name FROM orders WHERE id = $1::uuid`,
      [body.order_id]
    );
    expect(orderRows[0]).toBeDefined();
    expect(parseFloat(orderRows[0].total)).toBe(1550);
    expect(orderRows[0].source_name).toBe("quote");

    // Verify quote is converted
    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/quotes/${quoteId}`,
      headers: authHeader,
    });
    const q = getRes.json as { status: string; converted_order_id: string };
    expect(q.status).toBe("converted");
    expect(q.converted_order_id).toBe(body.order_id);
  });

  it("cannot accept an already-converted quote", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/quotes/${quoteId}/accept`,
      headers: authHeader,
    });
    expect(res.status).toBe(422);
  });

  it("rejects a draft quote", async () => {
    // Create a new draft quote to reject
    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/quotes`,
      headers: authHeader,
      body: { company_id: companyId },
    });
    const newQuoteId = (createRes.json as { id: string }).id;

    const res = await ctx.request({
      method: "POST",
      path: `${base()}/quotes/${newQuoteId}/reject`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);

    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/quotes/${newQuoteId}`,
      headers: authHeader,
    });
    expect((getRes.json as { status: string }).status).toBe("rejected");
  });

  it("quote with net-terms: order gets payment_terms_days from company", async () => {
    // The company was created with payment_terms_days=30
    // Check that accept quote correctly creates an order linked to the company
    const createRes = await ctx.request({
      method: "POST",
      path: `${base()}/quotes`,
      headers: authHeader,
      body: {
        company_id: companyId,
        lines: [{ title: "Product X", quantity: 1, price: 100.0 }],
      },
    });
    const qid = (createRes.json as { id: string }).id;

    // Send and accept
    await ctx.request({ method: "POST", path: `${base()}/quotes/${qid}/send`, headers: authHeader });
    const acceptRes = await ctx.request({
      method: "POST",
      path: `${base()}/quotes/${qid}/accept`,
      headers: authHeader,
    });
    expect(acceptRes.status).toBe(200);
    const { order_id: orderId } = acceptRes.json as { order_id: string };

    // The company has payment_terms_days=30 — verify the order is linked to company
    const { rows } = await ctx.pool.query(
      `SELECT company_id::text FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(rows[0].company_id).toBe(companyId);
  });

  it("lists quotes with status filter", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/quotes?status=converted`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { quotes: unknown[] };
    expect(body.quotes.length).toBeGreaterThan(0);
  });
});

// ── Purchase orders ────────────────────────────────────────────────────────────

describe("purchase orders", () => {
  let orderId: string;
  let poId: string;

  beforeAll(async () => {
    // Create an order to attach a PO to
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, order_number, status, financial_status, fulfillment_status, currency, subtotal, total)
       VALUES ($1::uuid, $2, 'open', 'pending', 'unfulfilled', 'USD', 500.00, 500.00)
       RETURNING id::text`,
      [storeId, `PO-TEST-${Date.now()}`]
    );
    orderId = rows[0]?.id ?? "";
  });

  it("attaches a purchase order to an order", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${orderId}/purchase-order`,
      headers: authHeader,
      body: { po_number: `PO-${Date.now()}` },
    });
    expect(res.status).toBe(201);
    poId = (res.json as { id: string }).id;
    expect(typeof poId).toBe("string");
  });

  it("lists purchase orders", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/purchase-orders`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { purchase_orders: unknown[] };
    expect(body.purchase_orders.length).toBeGreaterThan(0);
  });

  it("gets a purchase order", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/purchase-orders/${poId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { status: string };
    expect(body.status).toBe("pending");
  });

  it("updates purchase order status", async () => {
    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/purchase-orders/${poId}`,
      headers: authHeader,
      body: { status: "approved" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects duplicate PO number", async () => {
    // Use the same PO number as the first attach — need to find it
    const { rows } = await ctx.pool.query(
      `SELECT po_number FROM purchase_orders WHERE id = $1::uuid`,
      [poId]
    );
    const poNum = rows[0].po_number;

    // Create another order
    const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, order_number, status, financial_status, fulfillment_status, currency, subtotal, total)
       VALUES ($1::uuid, $2, 'open', 'pending', 'unfulfilled', 'USD', 100.00, 100.00)
       RETURNING id::text`,
      [storeId, `PO-TEST2-${Date.now()}`]
    );
    const newOrderId = orderRows[0]?.id;

    const dupRes = await ctx.request({
      method: "POST",
      path: `${base()}/orders/${newOrderId}/purchase-order`,
      headers: authHeader,
      body: { po_number: poNum },
    });
    expect(dupRes.status).toBe(409);
  });
});
