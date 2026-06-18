/**
 * marketing-flows.test.ts — Wave 8 marketing flows / automation.
 *
 * Coverage:
 *  1. Flow CRUD + step validation (HTTP routes).
 *  2. enrollFlow idempotency — same (flow, trigger_ref) twice → one run.
 *  3. processDueRuns with INJECTED mailer/sms stubs:
 *     - advances steps respecting delays,
 *     - sends the right action (email vs sms),
 *     - completes after the last step,
 *     - records last_error + retries, then fails after MAX attempts.
 *  4. Trigger discovery enrolls a new order / new customer.
 *
 * All sends go through injected deps — no real providers are hit.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import { mintJwt, insertOrg, insertStore, insertCustomer } from "../shared/helpers.js";
import { SimClock } from "../../src/clock.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import {
  createFlow,
  enrollFlow,
  processDueRuns,
  discoverAndEnroll,
  type SmsSender,
} from "../../src/modules/marketing/service.js";
import type { FlowStep } from "../../src/modules/marketing/types.js";

let ctx: TestCtx;
let orgId: string;
let storeId: string;
let authHeader: Record<string, string>;

const userId = "00000000-0000-0000-0000-000000000080";

beforeAll(async () => {
  ctx = await createCtx();
  const org = await insertOrg(ctx.pool, { name: "Marketing Test Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, {
    orgId,
    name: "Marketing Store",
    slug: `marketing-store-${Date.now()}`,
  });
  storeId = store.id;
});

afterAll(async () => {
  await ctx.teardown();
});

// ── Test stubs ────────────────────────────────────────────────────────────────

interface SentSms {
  to: string;
  body: string;
}

class StubSms implements SmsSender {
  public sent: SentSms[] = [];
  public failNext = 0; // number of upcoming sends that should throw

  async sendSms(params: { to: string; body: string }): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("stub sms failure");
    }
    this.sent.push(params);
  }
  clear(): void {
    this.sent = [];
  }
}

function runRow(pool: TestCtx["pool"], runId: string) {
  return pool
    .query<{
      current_step: number;
      status: string;
      next_run_at: string | null;
      attempts: number;
      last_error: string | null;
    }>(
      `SELECT current_step, status, next_run_at, attempts, last_error
       FROM marketing_flow_runs WHERE id = $1::uuid`,
      [runId]
    )
    .then((r) => r.rows[0]!);
}

// ── 1. Flow CRUD + step validation (HTTP) ───────────────────────────────────

describe("marketing flow CRUD + validation", () => {
  it("creates a flow with valid steps", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/marketing/flows`,
      headers: authHeader,
      body: {
        name: "Welcome series",
        trigger_event: "customer_created",
        steps: [
          { delay_seconds: 0, action: "email", subject: "Welcome!", body: "Thanks for joining" },
          { delay_seconds: 3600, action: "email", subject: "Day 1", body: "Here is a tip" },
        ],
      },
    });
    expect(res.status).toBe(201);
    const body = res.json as { flow: { id: string; steps: unknown[] } };
    expect(body.flow.id).toBeTruthy();
    expect(body.flow.steps.length).toBe(2);
  });

  it("rejects an email step without a subject", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/marketing/flows`,
      headers: authHeader,
      body: {
        name: "Bad flow",
        trigger_event: "order_created",
        steps: [{ delay_seconds: 0, action: "email", body: "no subject" }],
      },
    });
    // Service-level validation returns 400 (email requires subject).
    expect(res.status).toBe(400);
  });

  it("rejects a negative delay (schema)", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/marketing/flows`,
      headers: authHeader,
      body: {
        name: "Bad delay",
        trigger_event: "order_created",
        steps: [{ delay_seconds: -5, action: "sms", body: "hi" }],
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown action (schema)", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/marketing/flows`,
      headers: authHeader,
      body: {
        name: "Bad action",
        trigger_event: "order_created",
        steps: [{ delay_seconds: 0, action: "carrier-pigeon", body: "hi" }],
      },
    });
    expect(res.status).toBe(400);
  });

  it("lists, gets, updates, and deletes a flow", async () => {
    const created = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/marketing/flows`,
      headers: authHeader,
      body: {
        name: "CRUD flow",
        trigger_event: "abandoned_cart",
        steps: [{ delay_seconds: 0, action: "sms", body: "Come back!" }],
        is_active: false,
      },
    });
    const flowId = (created.json as { flow: { id: string } }).flow.id;

    const list = await ctx.request({
      method: "GET",
      path: `/commerce/stores/${storeId}/marketing/flows`,
      headers: authHeader,
    });
    expect(list.status).toBe(200);
    expect((list.json as { flows: unknown[] }).flows.length).toBeGreaterThan(0);

    const got = await ctx.request({
      method: "GET",
      path: `/commerce/stores/${storeId}/marketing/flows/${flowId}`,
      headers: authHeader,
    });
    expect(got.status).toBe(200);
    expect((got.json as { flow: { is_active: boolean } }).flow.is_active).toBe(false);

    const upd = await ctx.request({
      method: "PUT",
      path: `/commerce/stores/${storeId}/marketing/flows/${flowId}`,
      headers: authHeader,
      body: { is_active: true, name: "CRUD flow v2" },
    });
    expect(upd.status).toBe(200);
    expect((upd.json as { flow: { name: string } }).flow.name).toBe("CRUD flow v2");

    const del = await ctx.request({
      method: "DELETE",
      path: `/commerce/stores/${storeId}/marketing/flows/${flowId}`,
      headers: authHeader,
    });
    expect(del.status).toBe(200);

    const goneGet = await ctx.request({
      method: "GET",
      path: `/commerce/stores/${storeId}/marketing/flows/${flowId}`,
      headers: authHeader,
    });
    expect(goneGet.status).toBe(404);
  });
});

// ── 2. enrollFlow idempotency ───────────────────────────────────────────────

describe("enrollFlow idempotency", () => {
  it("enrolling the same trigger_ref twice yields one run", async () => {
    const steps: FlowStep[] = [
      { delay_seconds: 0, action: "email", subject: "Hi", body: "body" },
    ];
    const flow = await createFlow(storeId, {
      name: `Idem flow ${Date.now()}`,
      trigger_event: "order_created",
      steps,
    });
    const customer = await insertCustomer(ctx.pool, { storeId, email: `idem-${Date.now()}@t.example.com` });
    const triggerRef = `order-${Date.now()}`;
    const now = new Date();

    const first = await enrollFlow(storeId, flow, customer.id, triggerRef, now);
    const second = await enrollFlow(storeId, flow, customer.id, triggerRef, now);

    expect(first).toBeTruthy();
    expect(second).toBeNull(); // ON CONFLICT DO NOTHING

    const { rows } = await ctx.pool.query(
      `SELECT id FROM marketing_flow_runs WHERE flow_id = $1::uuid AND trigger_ref = $2`,
      [flow.id, triggerRef]
    );
    expect(rows.length).toBe(1);
  });
});

// ── 3. processDueRuns with injected senders ─────────────────────────────────

describe("processDueRuns step execution", () => {
  it("advances steps with delays, sends the right channel, and completes", async () => {
    const mailer = new ConsoleMailer();
    const sms = new StubSms();
    const clock = new SimClock(new Date());

    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `proc-${Date.now()}@t.example.com`,
    });
    // give the customer a phone for the sms step
    await ctx.pool.query(`UPDATE customers SET phone = '+15555550100' WHERE id = $1::uuid`, [
      customer.id,
    ]);

    const flow = await createFlow(storeId, {
      name: `Proc flow ${Date.now()}`,
      trigger_event: "customer_created",
      steps: [
        { delay_seconds: 0, action: "email", subject: "Step 1", body: "first" },
        { delay_seconds: 3600, action: "sms", subject: null, body: "second" },
      ],
    });

    const triggerRef = `cust-${Date.now()}`;
    const runId = await enrollFlow(storeId, flow, customer.id, triggerRef, clock.now());
    expect(runId).toBeTruthy();

    // Step 0 is due immediately (delay 0). Other suites may leave due runs in
    // this store, so assert on THIS run's effects (email to our customer) rather
    // than the global sent count.
    await processDueRuns(storeId, { mailer, sms, clock });
    expect(mailer.sentMessages.filter((m) => m.to === customer.email).length).toBe(1);
    expect(mailer.sentMessages.find((m) => m.to === customer.email)?.subject).toBe("Step 1");

    let row = await runRow(ctx.pool, runId!);
    expect(row.current_step).toBe(1);
    expect(row.status).toBe("active");

    // Step 1 is NOT due yet (3600s out) — our sms must not have fired.
    await processDueRuns(storeId, { mailer, sms, clock });
    expect(sms.sent.length).toBe(0);

    // Advance the clock past the delay → step 1 (sms) fires + run completes.
    clock.advance(3601 * 1000);
    await processDueRuns(storeId, { mailer, sms, clock });
    expect(sms.sent.length).toBe(1);
    expect(sms.sent[0]!.body).toBe("second");

    row = await runRow(ctx.pool, runId!);
    expect(row.status).toBe("completed");
    expect(row.next_run_at).toBeNull();
  });

  it("records last_error and retries, then fails after MAX attempts", async () => {
    const mailer = new ConsoleMailer();
    const sms = new StubSms();
    const clock = new SimClock(new Date());

    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `fail-${Date.now()}@t.example.com`,
    });
    await ctx.pool.query(`UPDATE customers SET phone = '+15555550199' WHERE id = $1::uuid`, [
      customer.id,
    ]);

    const flow = await createFlow(storeId, {
      name: `Fail flow ${Date.now()}`,
      trigger_event: "customer_created",
      steps: [{ delay_seconds: 0, action: "sms", subject: null, body: "will fail" }],
    });

    const runId = await enrollFlow(storeId, flow, customer.id, `fref-${Date.now()}`, clock.now());

    // Make every send throw.
    sms.failNext = 99;

    // Attempt 1 — records error, stays active.
    await processDueRuns(storeId, { mailer, sms, clock });
    let row = await runRow(ctx.pool, runId!);
    expect(row.attempts).toBe(1);
    expect(row.status).toBe("active");
    expect(row.last_error).toContain("stub sms failure");

    // Attempt 2 — still active (MAX is 3).
    await processDueRuns(storeId, { mailer, sms, clock });
    row = await runRow(ctx.pool, runId!);
    expect(row.attempts).toBe(2);
    expect(row.status).toBe("active");

    // Attempt 3 — reaches MAX → failed.
    await processDueRuns(storeId, { mailer, sms, clock });
    row = await runRow(ctx.pool, runId!);
    expect(row.attempts).toBe(3);
    expect(row.status).toBe("failed");
    expect(row.next_run_at).toBeNull();
  });
});

// ── 4. Trigger discovery ────────────────────────────────────────────────────

describe("trigger discovery", () => {
  it("enrolls a newly-created customer into a customer_created flow", async () => {
    const clock = new SimClock(new Date());
    const flow = await createFlow(storeId, {
      name: `Discovery customer ${Date.now()}`,
      trigger_event: "customer_created",
      steps: [{ delay_seconds: 0, action: "email", subject: "Welcome", body: "hello" }],
    });

    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `disc-cust-${Date.now()}@t.example.com`,
    });

    const enrolled = await discoverAndEnroll(storeId, { clock });
    expect(enrolled).toBeGreaterThanOrEqual(1);

    const { rows } = await ctx.pool.query(
      `SELECT id FROM marketing_flow_runs WHERE flow_id = $1::uuid AND trigger_ref = $2`,
      [flow.id, customer.id]
    );
    expect(rows.length).toBe(1);

    // Re-running discovery does NOT double-enroll.
    await discoverAndEnroll(storeId, { clock });
    const { rows: rows2 } = await ctx.pool.query(
      `SELECT id FROM marketing_flow_runs WHERE flow_id = $1::uuid AND trigger_ref = $2`,
      [flow.id, customer.id]
    );
    expect(rows2.length).toBe(1);
  });

  it("enrolls a new order into an order_created flow", async () => {
    const clock = new SimClock(new Date());
    const flow = await createFlow(storeId, {
      name: `Discovery order ${Date.now()}`,
      trigger_event: "order_created",
      steps: [{ delay_seconds: 0, action: "email", subject: "Thanks", body: "for your order" }],
    });

    const customer = await insertCustomer(ctx.pool, {
      storeId,
      email: `disc-order-${Date.now()}@t.example.com`,
    });
    const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, order_number, currency, subtotal, total)
       VALUES ($1::uuid, $2::uuid, $3, 'USD', 10.00, 10.00)
       RETURNING id::text`,
      [storeId, customer.id, `MKT-${Date.now()}`]
    );
    const orderId = orderRows[0]!.id;

    const enrolled = await discoverAndEnroll(storeId, { clock });
    expect(enrolled).toBeGreaterThanOrEqual(1);

    const { rows } = await ctx.pool.query(
      `SELECT customer_id::text FROM marketing_flow_runs
       WHERE flow_id = $1::uuid AND trigger_ref = $2`,
      [flow.id, orderId]
    );
    expect(rows.length).toBe(1);
    expect((rows[0] as { customer_id: string }).customer_id).toBe(customer.id);
  });
});
