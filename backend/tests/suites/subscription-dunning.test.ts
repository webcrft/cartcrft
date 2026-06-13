/**
 * subscription-dunning.test.ts — H3.5: Subscription billing attempts table + dunning.
 *
 * Tests that:
 *  A. A failed bill records a failed attempt row in subscription_billing_attempts
 *     and transitions the subscription to past_due status.
 *  B. Subsequent failed attempts accumulate correctly (attempt_number increments).
 *  C. A successful billing after past_due records a success attempt and clears
 *     the subscription back to active.
 *  D. The scheduler path (via setSubscriptionPastDue called by the scheduler on
 *     billSubscription failure) also records an attempt row.
 *  E. Attempt_number is monotonically increasing per subscription.
 *
 * Strategy:
 *  - createCtx() boots the app against an isolated DB schema with all migrations
 *    applied (including 0017_subscription_billing_attempts).
 *  - Direct service calls (billSubscription, setSubscriptionPastDue) are used
 *    so we can test the dunning path without needing a payment provider.
 *  - SimClock keeps period math deterministic.
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
import {
  billSubscription,
  setSubscriptionPastDue,
  DUNNING_MAX_FAILED_ATTEMPTS,
} from "../../src/modules/subscriptions/service.js";

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

  const userId = "00000000-0000-0000-0000-000000000007";
  const org = await insertOrg(ctx.pool, { name: "Dunning Test Org" });
  const jwt = await mintJwt({ userId, orgId: org.id });
  authHeader = { authorization: `Bearer ${jwt}` };

  const store = await insertStore(ctx.pool, {
    orgId: org.id,
    name: "Dunning Store",
    slug: `dunning-store-${Date.now()}`,
  });
  storeId = store.id;

  const product = await insertProduct(ctx.pool, { storeId, title: "Dunning Item" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, price: "29.99" });
  variantId = variant.id;

  const customer = await insertCustomer(ctx.pool, {
    storeId,
    email: `dunning${Date.now()}@test.example.com`,
  });
  customerId = customer.id;

  // Create a monthly plan
  const planRes = await ctx.request({
    method: "POST",
    path: `/commerce/stores/${storeId}/subscription-plans`,
    headers: authHeader,
    body: { name: "Monthly Dunning", interval: "month", interval_count: 1 },
  });
  expect(planRes.status).toBe(201);
  planId = (planRes.json as { id: string }).id;
});

afterAll(async () => {
  await ctx.teardown();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a subscription and patch it to be active with next_billing_at in the past. */
async function createActiveSubscription(): Promise<string> {
  const res = await ctx.request({
    method: "POST",
    path: `/commerce/stores/${storeId}/subscriptions`,
    headers: authHeader,
    body: {
      customer_id: customerId,
      plan_id: planId,
      items: [{ variant_id: variantId, quantity: 1, price: "29.99" }],
    },
  });
  expect(res.status).toBe(201);
  const subId = (res.json as { id: string }).id;

  // Set it active and past-due for billing
  await ctx.pool.query(
    `UPDATE subscriptions
       SET status = 'active', next_billing_at = now() - interval '1 second'
     WHERE id = $1::uuid`,
    [subId]
  );

  return subId;
}

/** Count attempt rows for a subscription. */
async function countAttempts(subId: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM subscription_billing_attempts
     WHERE subscription_id = $1::uuid`,
    [subId]
  );
  return parseInt(rows[0]?.count ?? "0", 10);
}

/** Fetch all attempt rows for a subscription ordered by attempt_number. */
async function getAttempts(subId: string): Promise<
  Array<{
    attempt_number: number;
    status: string;
    error_message: string | null;
    store_id: string;
  }>
> {
  const { rows } = await ctx.pool.query(
    `SELECT attempt_number, status, error_message, store_id::text
     FROM subscription_billing_attempts
     WHERE subscription_id = $1::uuid
     ORDER BY attempt_number`,
    [subId]
  );
  return rows as Array<{
    attempt_number: number;
    status: string;
    error_message: string | null;
    store_id: string;
  }>;
}

/** Get the current status of a subscription. */
async function getSubStatus(subId: string): Promise<string> {
  const { rows } = await ctx.pool.query<{ status: string }>(
    `SELECT status FROM subscriptions WHERE id = $1::uuid`,
    [subId]
  );
  return rows[0]?.status ?? "unknown";
}

// ── A. Failed bill records a failed attempt and transitions to past_due ───────

describe("dunning — failed billing attempt", () => {
  let subId: string;

  beforeAll(async () => {
    subId = await createActiveSubscription();
  });

  it("setSubscriptionPastDue records a failed attempt row", async () => {
    const before = await countAttempts(subId);
    expect(before).toBe(0);

    await setSubscriptionPastDue(storeId, subId, "Card declined");

    const after = await countAttempts(subId);
    expect(after).toBe(1);
  });

  it("the failed attempt has status=failed and correct error_message", async () => {
    const attempts = await getAttempts(subId);
    expect(attempts.length).toBe(1);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].error_message).toBe("Card declined");
    expect(attempts[0].attempt_number).toBe(1);
  });

  it("the attempt row has the correct store_id", async () => {
    const attempts = await getAttempts(subId);
    expect(attempts[0].store_id).toBe(storeId);
  });

  it("the subscription is now past_due", async () => {
    const status = await getSubStatus(subId);
    expect(status).toBe("past_due");
  });
});

// ── B. Multiple failed attempts accumulate; attempt_number increments ─────────

describe("dunning — multiple failures accumulate", () => {
  let subId: string;

  beforeAll(async () => {
    subId = await createActiveSubscription();
    // Simulate DUNNING_MAX_FAILED_ATTEMPTS failures
    for (let i = 0; i < DUNNING_MAX_FAILED_ATTEMPTS; i++) {
      await setSubscriptionPastDue(storeId, subId, `Failure ${i + 1}`);
    }
  });

  it(`records ${DUNNING_MAX_FAILED_ATTEMPTS} failed attempt rows`, async () => {
    const count = await countAttempts(subId);
    expect(count).toBe(DUNNING_MAX_FAILED_ATTEMPTS);
  });

  it("attempt_number is monotonically increasing (1-based)", async () => {
    const attempts = await getAttempts(subId);
    expect(attempts.length).toBe(DUNNING_MAX_FAILED_ATTEMPTS);
    for (let i = 0; i < DUNNING_MAX_FAILED_ATTEMPTS; i++) {
      expect(attempts[i].attempt_number).toBe(i + 1);
      expect(attempts[i].status).toBe("failed");
      expect(attempts[i].error_message).toBe(`Failure ${i + 1}`);
    }
  });

  it("subscription remains past_due after multiple failures", async () => {
    const status = await getSubStatus(subId);
    expect(status).toBe("past_due");
  });
});

// ── C. Successful billing after past_due clears dunning ───────────────────────

describe("dunning — success after past_due clears status", () => {
  let subId: string;
  const clock = new SimClock(new Date(), 1);

  beforeAll(async () => {
    subId = await createActiveSubscription();

    // First: simulate a failure to push into past_due
    await setSubscriptionPastDue(storeId, subId, "Initial failure");
    expect(await getSubStatus(subId)).toBe("past_due");

    // Now bill successfully (billSubscription accepts past_due subs for retry)
    await billSubscription(storeId, subId, clock);
  });

  it("records a success attempt row", async () => {
    const attempts = await getAttempts(subId);
    const successAttempts = attempts.filter((a) => a.status === "success");
    expect(successAttempts.length).toBe(1);
    expect(successAttempts[0].error_message).toBeNull();
  });

  it("success attempt has attempt_number = 2 (after the failed attempt)", async () => {
    const attempts = await getAttempts(subId);
    expect(attempts.length).toBe(2);
    expect(attempts[0].status).toBe("failed");
    expect(attempts[0].attempt_number).toBe(1);
    expect(attempts[1].status).toBe("success");
    expect(attempts[1].attempt_number).toBe(2);
  });

  it("subscription is restored to active after successful billing", async () => {
    const status = await getSubStatus(subId);
    expect(status).toBe("active");
  });

  it("subscription next_billing_at is now in the future", async () => {
    const { rows } = await ctx.pool.query<{ next_billing_at: Date }>(
      `SELECT next_billing_at FROM subscriptions WHERE id = $1::uuid`,
      [subId]
    );
    expect(rows[0]?.next_billing_at.getTime()).toBeGreaterThan(Date.now());
  });
});

// ── D. Successful billing (no prior failure) also records a success attempt ───

describe("dunning — successful billing records success attempt", () => {
  let subId: string;
  const clock = new SimClock(new Date(), 1);

  beforeAll(async () => {
    subId = await createActiveSubscription();
    await billSubscription(storeId, subId, clock);
  });

  it("records one success attempt row on first successful bill", async () => {
    const count = await countAttempts(subId);
    expect(count).toBe(1);
  });

  it("the attempt has status=success and null error_message", async () => {
    const attempts = await getAttempts(subId);
    expect(attempts[0].status).toBe("success");
    expect(attempts[0].error_message).toBeNull();
    expect(attempts[0].attempt_number).toBe(1);
    expect(attempts[0].store_id).toBe(storeId);
  });

  it("subscription status remains active after successful billing", async () => {
    const status = await getSubStatus(subId);
    expect(status).toBe("active");
  });
});

// ── E. DUNNING_MAX_FAILED_ATTEMPTS is exported and equals 3 ──────────────────

describe("dunning — constant", () => {
  it("DUNNING_MAX_FAILED_ATTEMPTS is 3", () => {
    expect(DUNNING_MAX_FAILED_ATTEMPTS).toBe(3);
  });
});
