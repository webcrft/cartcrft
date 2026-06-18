/**
 * abandoned-checkout.test.ts — Wave 22 Abandoned-CHECKOUT recovery.
 *
 * Distinct from abandoned-CART recovery (recovery.test.ts). Targets the
 * processAbandonedCheckouts worker tick with an injected mailer spy.
 *
 * Assertions:
 *  1. A stale pending checkout WITH an email gets exactly one recovery email
 *     and recovery_notified_at is stamped.
 *  2. A second tick does NOT re-send (idempotent — recovery_notified_at guard).
 *  3. A COMPLETED checkout is never emailed.
 *  4. A pending checkout with NO contact email is skipped.
 *  5. A too-recent pending checkout is skipped (threshold respected).
 *  6. The customer's email is used when the checkout row has no email.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import { insertOrg, insertStore, insertCustomer } from "../shared/helpers.js";
import { SimClock } from "../../src/clock.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { processAbandonedCheckouts } from "../../src/modules/abandoned-checkout/service.js";

let ctx: TestCtx;
let storeId: string;

const THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

beforeAll(async () => {
  ctx = await createCtx();
  const org = await insertOrg(ctx.pool, { name: "Abandoned Checkout Org" });
  const store = await insertStore(ctx.pool, {
    orgId: org.id,
    name: "Abandoned Checkout Store",
    slug: `ac-store-${Date.now()}`,
  });
  storeId = store.id;
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Insert a checkout row directly. updated_at is set at INSERT time (the
 * set_updated_at BEFORE UPDATE trigger does NOT fire on INSERT), so ageMs lets
 * us simulate a checkout that has been idle for a given duration.
 */
async function seedCheckout(opts: {
  email?: string | null;
  customerId?: string | null;
  status?: string;
  ageMs?: number;
}): Promise<string> {
  const updatedAt = opts.ageMs
    ? new Date(Date.now() - opts.ageMs)
    : new Date();
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO checkouts (store_id, customer_id, email, currency, total, status, updated_at, created_at)
     VALUES ($1::uuid, $2::uuid, $3, 'USD', 49.99, $4, $5, $5)
     RETURNING id::text`,
    [
      storeId,
      opts.customerId ?? null,
      opts.email ?? null,
      opts.status ?? "pending",
      updatedAt,
    ]
  );
  return rows[0]!.id;
}

async function notifiedAt(checkoutId: string): Promise<Date | null> {
  const { rows } = await ctx.pool.query<{ recovery_notified_at: Date | null }>(
    `SELECT recovery_notified_at FROM checkouts WHERE id = $1::uuid`,
    [checkoutId]
  );
  return rows[0]?.recovery_notified_at ?? null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("abandoned checkout recovery", () => {
  it("sends exactly one recovery email for a stale pending checkout and stamps recovery_notified_at", async () => {
    const mailer = new ConsoleMailer();
    const email = `ac-aged-${Date.now()}@test.example.com`;
    const checkoutId = await seedCheckout({ email, ageMs: 2 * THRESHOLD_MS });

    const sent = await processAbandonedCheckouts(new Date(), {
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: THRESHOLD_MS,
    });
    expect(sent).toBeGreaterThanOrEqual(1);

    const toUs = mailer.sentMessages.filter((m) => m.to === email);
    expect(toUs.length).toBe(1);
    const msg = toUs[0]!;
    expect(msg.subject).toBe("Complete your checkout");
    expect(msg.bodyHtml).toContain(`/storefront/${storeId}/checkout/${checkoutId}`);
    expect(msg.bodyText).toContain(`/storefront/${storeId}/checkout/${checkoutId}`);

    expect(await notifiedAt(checkoutId)).not.toBeNull();
  });

  it("does NOT re-send on a second tick (idempotent)", async () => {
    const mailer = new ConsoleMailer();
    const email = `ac-idem-${Date.now()}@test.example.com`;
    const checkoutId = await seedCheckout({ email, ageMs: 2 * THRESHOLD_MS });

    // First tick sends one.
    await processAbandonedCheckouts(new Date(), {
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: THRESHOLD_MS,
    });
    expect(mailer.sentMessages.filter((m) => m.to === email).length).toBe(1);

    // Second tick: recovery_notified_at is set → skip.
    mailer.clear();
    await processAbandonedCheckouts(new Date(), {
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: THRESHOLD_MS,
    });
    expect(mailer.sentMessages.filter((m) => m.to === email).length).toBe(0);
    void checkoutId;
  });

  it("never emails a COMPLETED checkout", async () => {
    const mailer = new ConsoleMailer();
    const email = `ac-done-${Date.now()}@test.example.com`;
    const checkoutId = await seedCheckout({
      email,
      ageMs: 2 * THRESHOLD_MS,
      status: "completed",
    });

    await processAbandonedCheckouts(new Date(), {
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: THRESHOLD_MS,
    });
    expect(mailer.sentMessages.filter((m) => m.to === email).length).toBe(0);
    expect(await notifiedAt(checkoutId)).toBeNull();
  });

  it("skips a pending checkout with no contact email", async () => {
    const mailer = new ConsoleMailer();
    const checkoutId = await seedCheckout({
      email: null,
      ageMs: 2 * THRESHOLD_MS,
    });

    await processAbandonedCheckouts(new Date(), {
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: THRESHOLD_MS,
    });
    // Not notified — no email could be resolved.
    expect(await notifiedAt(checkoutId)).toBeNull();
  });

  it("skips a too-recent pending checkout (threshold respected)", async () => {
    const mailer = new ConsoleMailer();
    const email = `ac-fresh-${Date.now()}@test.example.com`;
    const checkoutId = await seedCheckout({
      email,
      ageMs: THRESHOLD_MS - 60_000, // 1 minute under threshold
    });

    await processAbandonedCheckouts(new Date(), {
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: THRESHOLD_MS,
    });
    expect(mailer.sentMessages.filter((m) => m.to === email).length).toBe(0);
    expect(await notifiedAt(checkoutId)).toBeNull();
  });

  it("falls back to the linked customer's email when the checkout has none", async () => {
    const mailer = new ConsoleMailer();
    const email = `ac-cust-${Date.now()}@test.example.com`;
    const customer = await insertCustomer(ctx.pool, { storeId, email });
    const checkoutId = await seedCheckout({
      email: null,
      customerId: customer.id,
      ageMs: 2 * THRESHOLD_MS,
    });

    await processAbandonedCheckouts(new Date(), {
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: THRESHOLD_MS,
    });
    expect(mailer.sentMessages.filter((m) => m.to === email).length).toBe(1);
    expect(await notifiedAt(checkoutId)).not.toBeNull();
  });
});
