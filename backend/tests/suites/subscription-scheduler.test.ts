/**
 * subscription-scheduler.test.ts — H2.3: Subscription billing scheduler + FX refresh.
 *
 * Tests the scheduler function directly (not via HTTP) to isolate the job logic.
 *
 * Scenarios:
 *  A. Due subscription is auto-billed exactly once → one recurring order, billing_period=1,
 *     next_billing_at advances.
 *  B. Not-yet-due subscription (next_billing_at in the future) is skipped.
 *  C. Double-tick on the same subscription produces only one order (idempotency via
 *     SKIP LOCKED + subscription_orders unique constraint, and advancing next_billing_at
 *     past the clock value after the first bill).
 *  D. FX refresh upserts rates row into exchange_rates (fetch mocked).
 *
 * Strategy:
 *  - createCtx() boots the app against an isolated DB schema (mirrors all other suites).
 *  - Clock: SimClock with a fixed epoch (no scale) so we control "now" precisely.
 *  - Subscription scheduler: called as startSubscriptionScheduler({ clock, intervalMs })
 *    then we wait for a tick to complete.
 *  - FX refresh: EXCHANGE_RATE_API_URL_OVERRIDE points to a tiny in-process HTTP server
 *    that returns a canned response.
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
import { SimClock } from "../../src/clock.js";
import { startSubscriptionScheduler } from "../../src/modules/subscriptions/scheduler.js";
import { runFxRefresh, setFxApiUrlOverride } from "../../src/modules/exchange-rates/fx-refresh.js";
import http from "node:http";

// ── Context ───────────────────────────────────────────────────────────────────

let ctx: TestCtx;
let storeId: string;
let authHeader: Record<string, string>;

// Shared fixtures
let variantId: string;
let customerId: string;
let planId: string;

beforeAll(async () => {
  ctx = await createCtx();

  const userId = "00000000-0000-0000-0000-000000000003";
  const org = await insertOrg(ctx.pool, { name: "Scheduler Test Org" });
  const jwt = await mintJwt({ userId, orgId: org.id });
  authHeader = { authorization: `Bearer ${jwt}` };

  const store = await insertStore(ctx.pool, {
    orgId: org.id,
    name: "Scheduler Store",
    slug: `sched-store-${Date.now()}`,
  });
  storeId = store.id;

  const product = await insertProduct(ctx.pool, { storeId, title: "Recurring Item" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, price: "19.99" }); // price stored as numeric string in DB
  variantId = variant.id;

  const customer = await insertCustomer(ctx.pool, { storeId, email: `sched${Date.now()}@test.example.com` });
  customerId = customer.id;

  // Create a monthly plan
  const planRes = await ctx.request({
    method: "POST",
    path: `/commerce/stores/${storeId}/subscription-plans`,
    headers: authHeader,
    body: { name: "Monthly Sched", interval: "month", interval_count: 1 },
  });
  expect(planRes.status).toBe(201);
  planId = (planRes.json as { id: string }).id;
});

afterAll(async () => {
  // Restore any FX override
  setFxApiUrlOverride(null);
  await ctx.teardown();
});

// ── Helper: create a subscription set to be due now ───────────────────────────

async function createDueSubscription(opts: {
  past?: boolean; // true = next_billing_at in the past (due); false = future (not due)
} = {}): Promise<string> {
  const res = await ctx.request({
    method: "POST",
    path: `/commerce/stores/${storeId}/subscriptions`,
    headers: authHeader,
    body: {
      customer_id: customerId,
      plan_id: planId,
      items: [{ variant_id: variantId, quantity: 1, price: 19.99 }],
    },
  });
  expect(res.status).toBe(201);
  const subId = (res.json as { id: string }).id;

  // Patch next_billing_at directly in the DB
  const offset = opts.past === false ? "1 year" : "-1 second";
  await ctx.pool.query(
    `UPDATE subscriptions
       SET next_billing_at = now() + $2::interval,
           status = 'active'
     WHERE id = $1::uuid`,
    [subId, offset]
  );

  return subId;
}

/** Wait for a subscription to have at least N orders. Polls up to maxWaitMs. */
async function waitForOrders(
  subId: string,
  minCount: number,
  maxWaitMs = 10_000
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM subscription_orders WHERE subscription_id = $1::uuid`,
      [subId]
    );
    const count = parseInt(rows[0]?.count ?? "0", 10);
    if (count >= minCount) return count;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Return final count even if below threshold (assertion will fail with real value)
  const { rows } = await ctx.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM subscription_orders WHERE subscription_id = $1::uuid`,
    [subId]
  );
  return parseInt(rows[0]?.count ?? "0", 10);
}

// ── A. Due subscription gets billed ───────────────────────────────────────────

describe("subscription scheduler — due subscription", () => {
  let subId: string;
  let stopScheduler: () => void;

  beforeAll(async () => {
    subId = await createDueSubscription({ past: true });
  });

  afterAll(() => {
    if (stopScheduler) stopScheduler();
  });

  it("auto-bills a due active subscription exactly once", async () => {
    // Use a SimClock set to "now" so the scheduler's clock.now() >= next_billing_at
    const clock = new SimClock(new Date(), 1);

    // Short interval so the first tick fires promptly in the test
    stopScheduler = startSubscriptionScheduler({
      clock,
      intervalMs: 2_000,
      initialDelayMs: 0,
    });

    // Wait for the order to appear
    const orderCount = await waitForOrders(subId, 1, 12_000);
    expect(orderCount).toBe(1);
  });

  it("created order has source_name = subscription and correct total", async () => {
    const { rows } = await ctx.pool.query(
      `SELECT o.source_name, o.subtotal::text, o.total::text
       FROM subscription_orders so
       JOIN orders o ON o.id = so.order_id
       WHERE so.subscription_id = $1::uuid
       ORDER BY so.billing_period`,
      [subId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_name).toBe("subscription");
    expect(parseFloat(rows[0].subtotal)).toBeCloseTo(19.99, 1);
  });

  it("advances next_billing_at to the future after billing", async () => {
    const { rows } = await ctx.pool.query<{ next_billing_at: Date }>(
      `SELECT next_billing_at FROM subscriptions WHERE id = $1::uuid`,
      [subId]
    );
    const nextBilling = rows[0]?.next_billing_at;
    expect(nextBilling).toBeDefined();
    // next_billing_at should be in the future (past the bill moment)
    expect(nextBilling.getTime()).toBeGreaterThan(Date.now());
  });
});

// ── B. Not-yet-due subscription is skipped ────────────────────────────────────

describe("subscription scheduler — future subscription skipped", () => {
  let subId: string;
  let stopScheduler: () => void;

  beforeAll(async () => {
    subId = await createDueSubscription({ past: false });
  });

  afterAll(() => {
    if (stopScheduler) stopScheduler();
  });

  it("does not bill a subscription whose next_billing_at is in the future", async () => {
    const clock = new SimClock(new Date(), 1);

    stopScheduler = startSubscriptionScheduler({
      clock,
      intervalMs: 2_000,
      initialDelayMs: 0,
    });

    // Give the scheduler 3 seconds to run at least once
    await new Promise((r) => setTimeout(r, 3_000));

    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM subscription_orders WHERE subscription_id = $1::uuid`,
      [subId]
    );
    const count = parseInt(rows[0]?.count ?? "0", 10);
    expect(count).toBe(0);
  });
});

// ── C. Idempotency: double-tick does not double-bill ──────────────────────────

describe("subscription scheduler — idempotency", () => {
  let subId: string;
  let stopScheduler: () => void;

  beforeAll(async () => {
    subId = await createDueSubscription({ past: true });
  });

  afterAll(() => {
    if (stopScheduler) stopScheduler();
  });

  it("a due subscription is billed at most once even with rapid ticks", async () => {
    // After the first tick bills the sub, next_billing_at advances to ~1 month
    // in the future, so subsequent ticks (which use clock.now() ≈ "now") skip it.
    const clock = new SimClock(new Date(), 1);

    stopScheduler = startSubscriptionScheduler({
      clock,
      intervalMs: 300, // very fast polling
      initialDelayMs: 0,
    });

    // Wait long enough for multiple ticks to run
    await new Promise((r) => setTimeout(r, 4_000));

    const count = await waitForOrders(subId, 1, 8_000);
    // Exactly one billing cycle — not two
    expect(count).toBe(1);
  });
});

// ── D. FX refresh upserts exchange rates ──────────────────────────────────────

describe("fx-refresh job", () => {
  let mockServer: http.Server;
  let mockServerUrl: string;

  beforeAll(async () => {
    // Spin up a tiny HTTP server that returns a canned ExchangeRate-API response
    await new Promise<void>((resolve) => {
      mockServer = http.createServer((_req, res) => {
        const body = JSON.stringify({
          result: "success",
          base_code: "USD",
          conversion_rates: {
            ZAR: 18.5,
            EUR: 0.92,
            GBP: 0.79,
            CAD: 1.36,
            JPY: 149.5,
            AUD: 1.55,
          },
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      });
      mockServer.listen(0, "127.0.0.1", () => {
        const addr = mockServer.address() as { port: number };
        mockServerUrl = `http://127.0.0.1:${addr.port}/v6/testkey/latest/USD`;
        resolve();
      });
    });

    // Override the FX API URL so runFxRefresh hits our mock server
    setFxApiUrlOverride(mockServerUrl);
  });

  afterAll(async () => {
    setFxApiUrlOverride(null);
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it("upserts exchange rates into the exchange_rates table", async () => {
    const before = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM exchange_rates`
    );
    const countBefore = parseInt(before.rows[0]?.count ?? "0", 10);

    const result = await runFxRefresh("test-key");

    expect(result.ok).toBe(true);
    expect(result.currencies).toBeGreaterThan(0);

    const after = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM exchange_rates`
    );
    const countAfter = parseInt(after.rows[0]?.count ?? "0", 10);
    expect(countAfter).toBe(countBefore + 1);
  });

  it("stored rates contain ZAR and EUR with correct values", async () => {
    const { rows } = await ctx.pool.query<{ rates: Record<string, number>; base: string }>(
      `SELECT base, rates FROM exchange_rates ORDER BY fetched_at DESC LIMIT 1`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].base.trim()).toBe("USD");
    const rates = rows[0].rates;
    expect(typeof rates["ZAR"]).toBe("number");
    expect(rates["ZAR"]).toBeCloseTo(18.5, 1);
    expect(typeof rates["EUR"]).toBe("number");
    expect(rates["EUR"]).toBeCloseTo(0.92, 2);
  });

  it("second refresh appends another row (snapshot pattern)", async () => {
    const before = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM exchange_rates`
    );
    const countBefore = parseInt(before.rows[0]?.count ?? "0", 10);

    await runFxRefresh("test-key");

    const after = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM exchange_rates`
    );
    const countAfter = parseInt(after.rows[0]?.count ?? "0", 10);
    expect(countAfter).toBe(countBefore + 1);
  });

  it("gracefully handles upstream error (non-success result field)", async () => {
    // Temporarily override URL to return an error response
    const errorServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "error", "error-type": "invalid-key" }));
    });

    await new Promise<void>((resolve) => {
      errorServer.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = errorServer.address() as { port: number };
    setFxApiUrlOverride(`http://127.0.0.1:${addr.port}/error`);

    const result = await runFxRefresh("bad-key");
    expect(result.ok).toBe(false);

    // Restore the original mock URL
    setFxApiUrlOverride(mockServerUrl);

    await new Promise<void>((resolve) => errorServer.close(() => resolve()));
  });
});
