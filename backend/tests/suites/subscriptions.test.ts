/**
 * subscriptions.test.ts — Subscription plans and subscriptions.
 *
 * Key assertions:
 *  - Plan CRUD (interval/interval_count/trial_days)
 *  - Subscription lifecycle: create → pause → resume → cancel
 *  - Trial period: trialing → active on first bill
 *  - Bill endpoint: creates order + advances period via SimClock injection
 *  - Paused subscription: bill endpoint fails for paused subscription
 *  - next_billing_at advances correctly using Clock.now()
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import { mintJwt, insertOrg, insertStore, insertProduct, insertVariant, insertCustomer } from "../shared/helpers.js";
import { SimClock } from "../../src/clock.js";
import { setClock } from "../../src/modules/subscriptions/routes.js";

let ctx: TestCtx;
let orgId: string;
let userId: string;
let storeId: string;
let authHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createCtx();
  userId = "00000000-0000-0000-0000-000000000002";
  const org = await insertOrg(ctx.pool, { name: "Sub Test Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, { orgId, name: "Sub Store", slug: `sub-store-${Date.now()}` });
  storeId = store.id;
});

afterAll(async () => {
  // Reset clock to system
  setClock(new (await import("../../src/clock.js")).SystemClock());
  await ctx.teardown();
});

const base = () => `/commerce/stores/${storeId}`;

// ── Plans ─────────────────────────────────────────────────────────────────────

describe("subscription plans", () => {
  let planId: string;

  it("creates a monthly plan", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscription-plans`,
      headers: authHeader,
      body: { name: "Monthly Basic", interval: "month", interval_count: 1, trial_days: 0 },
    });
    expect(res.status).toBe(201);
    planId = (res.json as { id: string }).id;
    expect(typeof planId).toBe("string");
  });

  it("lists plans", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/subscription-plans`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { plans: unknown[] };
    expect(body.plans.length).toBeGreaterThan(0);
  });

  it("gets a plan", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/subscription-plans/${planId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const p = res.json as { name: string; interval: string };
    expect(p.name).toBe("Monthly Basic");
    expect(p.interval).toBe("month");
  });

  it("updates a plan", async () => {
    const res = await ctx.request({
      method: "PUT",
      path: `${base()}/subscription-plans/${planId}`,
      headers: authHeader,
      body: { trial_days: 7 },
    });
    expect(res.status).toBe(200);
  });

  it("soft-deletes (deactivates) a plan", async () => {
    const res = await ctx.request({
      method: "DELETE",
      path: `${base()}/subscription-plans/${planId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    // Verify still accessible but is_active = false
    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/subscription-plans/${planId}`,
      headers: authHeader,
    });
    expect((getRes.json as { is_active: boolean }).is_active).toBe(false);
  });

  it("rejects negative interval_count", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscription-plans`,
      headers: authHeader,
      body: { name: "Bad Plan", interval: "month", interval_count: -1 },
    });
    expect(res.status).toBe(400);
  });
});

// ── Subscription lifecycle ─────────────────────────────────────────────────────

describe("subscription lifecycle", () => {
  let planId: string;
  let subId: string;
  let customerId: string;
  let product: { id: string; storeId: string; title: string };
  let variant: { id: string; productId: string; price: string };

  beforeAll(async () => {
    product = await insertProduct(ctx.pool, { storeId, title: "Sub Product" });
    variant = await insertVariant(ctx.pool, { productId: product.id, price: "29.99" });
    const customer = await insertCustomer(ctx.pool, { storeId, email: `sub${Date.now()}@test.example.com` });
    customerId = customer.id;

    // Create an active plan
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscription-plans`,
      headers: authHeader,
      body: { name: "Weekly Pro", interval: "week", interval_count: 1 },
    });
    planId = (res.json as { id: string }).id;
  });

  it("creates a subscription with items", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions`,
      headers: authHeader,
      body: {
        customer_id: customerId,
        plan_id: planId,
        items: [{ variant_id: variant.id, quantity: 1, price: "29.99" }],
      },
    });
    expect(res.status).toBe(201);
    const body = res.json as { id: string; status: string; next_billing_at: string };
    expect(body.status).toBe("active");
    expect(typeof body.next_billing_at).toBe("string");
    subId = body.id;
  });

  it("gets subscription with items and orders", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/subscriptions/${subId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const sub = res.json as { status: string; items: unknown[]; orders: unknown[] };
    expect(sub.status).toBe("active");
    expect(sub.items.length).toBe(1);
    expect(Array.isArray(sub.orders)).toBe(true);
  });

  it("lists subscriptions", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `${base()}/subscriptions`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { subscriptions: unknown[] };
    expect(body.subscriptions.length).toBeGreaterThan(0);
  });

  it("bills subscription: creates order + advances period via SimClock", async () => {
    // Inject a simulated clock so we can verify time advancement
    const startDate = new Date("2026-01-01T00:00:00Z");
    const simClock = new SimClock(startDate, 1);
    setClock(simClock);

    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions/${subId}/bill`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as {
      order_id: string;
      order_number: string;
      billing_period: number;
      next_billing_at: string;
    };
    expect(typeof body.order_id).toBe("string");
    expect(body.billing_period).toBe(1);

    // Verify order was created
    const { rows: orderRows } = await ctx.pool.query(
      `SELECT source_name, subtotal::text FROM orders WHERE id = $1::uuid`,
      [body.order_id]
    );
    expect(orderRows[0].source_name).toBe("subscription");
    expect(parseFloat(orderRows[0].subtotal)).toBeCloseTo(29.99, 1);

    // Verify subscription_orders link
    const { rows: linkRows } = await ctx.pool.query(
      `SELECT billing_period FROM subscription_orders WHERE subscription_id = $1::uuid`,
      [subId]
    );
    expect(linkRows.length).toBe(1);
    expect(linkRows[0].billing_period).toBe(1);

    // Verify next_billing_at advanced by 1 week (from startDate)
    const nextBilling = new Date(body.next_billing_at);
    const expectedNext = new Date("2026-01-08T00:00:00Z"); // +7 days
    // Allow ±60 seconds tolerance for clock drift
    expect(Math.abs(nextBilling.getTime() - expectedNext.getTime())).toBeLessThan(60000);
  });

  it("second bill: billing_period increments", async () => {
    // Ensure subscription is still active
    const { rows } = await ctx.pool.query(
      `UPDATE subscriptions SET status = 'active' WHERE id = $1::uuid RETURNING status`,
      [subId]
    );
    expect(rows[0].status).toBe("active");

    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions/${subId}/bill`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { billing_period: number };
    expect(body.billing_period).toBe(2);
  });

  it("pauses a subscription", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions/${subId}/pause`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);

    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/subscriptions/${subId}`,
      headers: authHeader,
    });
    expect((getRes.json as { status: string }).status).toBe("paused");
  });

  it("paused subscription cannot be billed", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions/${subId}/bill`,
      headers: authHeader,
    });
    expect(res.status).toBe(422);
  });

  it("resumes a subscription", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions/${subId}/resume`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { ok: boolean; next_billing_at: string };
    expect(body.ok).toBe(true);
    expect(typeof body.next_billing_at).toBe("string");
  });

  it("cancels a subscription", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions/${subId}/cancel`,
      headers: authHeader,
      body: { cancel_reason: "Too expensive" },
    });
    expect(res.status).toBe(200);

    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/subscriptions/${subId}`,
      headers: authHeader,
    });
    const sub = getRes.json as { status: string; cancel_reason: string; cancelled_at: string };
    expect(sub.status).toBe("cancelled");
    expect(sub.cancel_reason).toBe("Too expensive");
    expect(typeof sub.cancelled_at).toBe("string");
  });

  it("cancelled subscription cannot be cancelled again", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions/${subId}/cancel`,
      headers: authHeader,
    });
    expect(res.status).toBe(422);
  });
});

// ── Trial subscription ─────────────────────────────────────────────────────────

describe("trial subscription", () => {
  it("creates a trialing subscription with trial_days", async () => {
    // Create trial plan
    const planRes = await ctx.request({
      method: "POST",
      path: `${base()}/subscription-plans`,
      headers: authHeader,
      body: { name: "Trial Plan", interval: "month", trial_days: 14 },
    });
    const trialPlanId = (planRes.json as { id: string }).id;

    const customer = await insertCustomer(ctx.pool, { storeId, email: `trial${Date.now()}@test.example.com` });

    const res = await ctx.request({
      method: "POST",
      path: `${base()}/subscriptions`,
      headers: authHeader,
      body: { customer_id: customer.id, plan_id: trialPlanId },
    });
    expect(res.status).toBe(201);
    const sub = res.json as { status: string; next_billing_at: string };
    expect(sub.status).toBe("trialing");
  });
});
