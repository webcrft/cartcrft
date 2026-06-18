/**
 * recovery.test.ts — T6.5 Abandoned-cart recovery emails.
 *
 * Assertions:
 *  1. Worker job creates abandoned_carts rows and sends via ConsoleMailer exactly once.
 *  2. Token recover endpoint returns the cart.
 *  3. Resend endpoint works.
 *  4. Threshold is respected (SimClock): carts newer than threshold are NOT processed.
 *  5. Second worker run does NOT re-send (idempotency).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import { mintJwt, insertOrg, insertStore, insertProduct, insertVariant, insertCustomer } from "../shared/helpers.js";
import { SimClock } from "../../src/clock.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { processAbandonedCarts } from "../../src/modules/recovery/service.js";

let ctx: TestCtx;
let orgId: string;
let userId: string;
let storeId: string;
let authHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createCtx();
  userId = "00000000-0000-0000-0000-000000000020";
  const org = await insertOrg(ctx.pool, { name: "Recovery Test Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, {
    orgId,
    name: "Recovery Store",
    slug: `recovery-store-${Date.now()}`,
  });
  storeId = store.id;
});

afterAll(async () => {
  await ctx.teardown();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create an active cart with a line, attached to a customer with an email.
 * If ageMs is provided, the cart is inserted with updated_at set to now() - ageMs
 * (done at INSERT time to avoid the set_updated_at() BEFORE UPDATE trigger).
 */
async function seedCart(opts: {
  emailSuffix?: string;
  ageMs?: number;
}): Promise<{ cartId: string; customerId: string; email: string; variantId: string }> {
  const email = `recovery${opts.emailSuffix ?? Date.now()}@test.example.com`;
  const customer = await insertCustomer(ctx.pool, { storeId, email });
  const product = await insertProduct(ctx.pool, { storeId, title: `Product ${Date.now()}` });
  const variant = await insertVariant(ctx.pool, { productId: product.id, price: "29.99" });

  // Insert cart with optional past updated_at (at INSERT time, trigger does NOT fire)
  const updatedAt = opts.ageMs
    ? new Date(Date.now() - opts.ageMs)
    : new Date();

  const { rows: cartRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO carts (store_id, customer_id, currency, updated_at)
     VALUES ($1::uuid, $2::uuid, 'USD', $3)
     RETURNING id::text`,
    [storeId, customer.id, updatedAt]
  );
  const cartId = cartRows[0]!.id;

  // Add line
  await ctx.pool.query(
    `INSERT INTO cart_lines (cart_id, variant_id, quantity, price)
     VALUES ($1::uuid, $2::uuid, 1, $3::numeric)`,
    [cartId, variant.id, "29.99"]
  );

  return { cartId, customerId: customer.id, email, variantId: variant.id };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("abandoned cart recovery", () => {
  let cartId: string;
  let freshCartId: string;
  let email: string;
  let mailer: ConsoleMailer;
  const THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  beforeAll(async () => {
    mailer = new ConsoleMailer();
    // Create a fresh (recent) cart for threshold test
    const freshCart = await seedCart({ emailSuffix: `-fresh-${Date.now()}` });
    freshCartId = freshCart.cartId;

    // Create an aged cart (2 hours old) for the main recovery tests
    const agedCart = await seedCart({ emailSuffix: `-aged-${Date.now()}`, ageMs: 2 * THRESHOLD_MS });
    cartId = agedCart.cartId;
    email = agedCart.email;
  });

  it("worker does NOT process carts newer than threshold", async () => {
    mailer.clear();
    // freshCartId was just created — updated_at is recent; only look for THIS cart's email
    const freshEmailResult = mailer.sentMessages.filter(
      (m) => m.to.includes("-fresh-")
    );
    // Run worker with a LONGER threshold (3 hours) so neither the fresh cart nor
    // the 2-hour-old aged cart qualifies. Only carts older than 3 hours would be processed.
    const count = await processAbandonedCarts({
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: 3 * THRESHOLD_MS,
    });

    // The fresh cart should NOT have been processed
    const freshAcRows = await ctx.pool.query(
      `SELECT recovery_token FROM abandoned_carts WHERE cart_id = $1::uuid`,
      [freshCartId]
    );
    expect(freshAcRows.rows.length).toBe(0);
    void count;
    void freshEmailResult;
  });

  it("worker processes carts older than threshold and sends exactly one email", async () => {
    mailer.clear();
    const cutoff = new Date(Date.now() - THRESHOLD_MS);

    // Debug: verify the cart IS in the candidates query
    const debugRows = await ctx.pool.query<{ cart_id: string; cart_email: string | null }>(
      `SELECT c.id::text AS cart_id, COALESCE(cu.email, ch.email) AS cart_email
       FROM carts c
       LEFT JOIN customers cu ON cu.id = c.customer_id
       LEFT JOIN LATERAL (
         SELECT email FROM checkouts
         WHERE cart_id = c.id AND email IS NOT NULL
         ORDER BY created_at DESC LIMIT 1
       ) ch ON true
       WHERE c.status = 'active'
         AND c.updated_at < $1
         AND COALESCE(cu.email, ch.email) IS NOT NULL`,
      [cutoff]
    );
    // Verify our aged cart is in the query results
    const ourCart = debugRows.rows.find((r) => r.cart_id === cartId);
    expect(ourCart).toBeTruthy();
    expect(ourCart?.cart_email).toBe(email);

    // cartId is 2 hours old — should be processed
    await processAbandonedCarts({
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: THRESHOLD_MS,
    });

    // The primary assertion: an abandoned_carts row was created
    const acRows = await ctx.pool.query<{ cart_id: string; last_notified_at: Date | null }>(
      `SELECT cart_id::text, last_notified_at FROM abandoned_carts WHERE cart_id = $1::uuid`,
      [cartId]
    );
    expect(acRows.rows.length).toBe(1);

    // The email should have been sent to our test customer
    const sentToUs = mailer.sentMessages.filter((m) => m.to === email);
    expect(sentToUs.length).toBe(1);

    const msg = sentToUs[0]!;
    expect(msg.subject).toBe("You left something behind");
    expect(msg.bodyHtml).toContain("/cart/recover/");
    expect(msg.bodyText).toContain("/cart/recover/");
  });

  it("second worker run does NOT re-send (idempotent)", async () => {
    mailer.clear();
    // Run again — should skip because last_notified_at is now set
    const count = await processAbandonedCarts({
      clock: new SimClock(new Date()),
      mailer,
      thresholdMs: 60 * 60 * 1000,
    });

    const sentToUs = mailer.sentMessages.filter((m) => m.to === email);
    expect(sentToUs.length).toBe(0);
    // If other carts existed in this run they'd be counted, but ours should be 0
    void count; // don't assert total count (other suites may have carts)
  });

  it("GET /storefront/:storeId/cart/recover/:token returns the cart", async () => {
    // Fetch recovery_token from DB
    const { rows: acRows } = await ctx.pool.query<{ recovery_token: string }>(
      `SELECT recovery_token FROM abandoned_carts WHERE cart_id = $1::uuid`,
      [cartId]
    );
    const token = acRows[0]?.recovery_token;
    expect(token).toBeTruthy();

    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/cart/recover/${token}`,
    });
    expect(res.status).toBe(200);
    const body = res.json as { cart: { id: string; lines: unknown[] } };
    expect(body.cart).toBeDefined();
    expect(body.cart.id).toBe(cartId);
    expect(Array.isArray(body.cart.lines)).toBe(true);
    expect(body.cart.lines.length).toBeGreaterThan(0);
  });

  it("GET /storefront/.../recover/:token with invalid token returns 404", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/cart/recover/deadbeefdeadbeefdeadbeef`,
    });
    expect(res.status).toBe(404);
  });

  it("POST resend endpoint re-sends the recovery email", async () => {
    mailer.clear();

    // Get the abandoned_cart row id
    const { rows: acRows } = await ctx.pool.query<{
      id: string;
      recovery_token: string;
    }>(
      `SELECT id::text, recovery_token FROM abandoned_carts WHERE cart_id = $1::uuid`,
      [cartId]
    );
    const abandonedCartId = acRows[0]?.id;
    expect(abandonedCartId).toBeTruthy();

    // FIX 5: resends are now bounded by a minimum interval since last_notified_at.
    // The worker already sent one email seconds ago, so backdate last_notified_at
    // to simulate a legitimate later admin resend (still under the count cap).
    await ctx.pool.query(
      `UPDATE abandoned_carts
         SET last_notified_at = now() - interval '2 hours'
       WHERE id = $1::uuid`,
      [abandonedCartId]
    );

    // Inject the mailer into the service module (shared singleton)
    const { setMailer } = await import("../../src/modules/recovery/service.js");
    setMailer(mailer);

    const res = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/abandoned-carts/${abandonedCartId}/resend`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { ok: boolean };
    expect(body.ok).toBe(true);

    // Should have sent the email
    const sentToUs = mailer.sentMessages.filter((m) => m.to === email);
    expect(sentToUs.length).toBe(1);
  });

  it("resend with invalid id returns 404", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/commerce/stores/${storeId}/abandoned-carts/00000000-0000-0000-0000-000000000000/resend`,
      headers: authHeader,
    });
    expect(res.status).toBe(404);
  });
});

describe("recovery threshold boundary", () => {
  const THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

  it("cart just under threshold is NOT processed", async () => {
    const mailer2 = new ConsoleMailer();
    // Create cart that is JUST under threshold (59 min 30 sec old)
    const cart = await seedCart({
      emailSuffix: `-under-${Date.now()}`,
      ageMs: THRESHOLD_MS - 30_000, // 30s under threshold
    });

    await processAbandonedCarts({
      clock: new SimClock(new Date()),
      mailer: mailer2,
      thresholdMs: THRESHOLD_MS,
    });
    const sent = mailer2.sentMessages.filter((m) => m.to === cart.email);
    expect(sent.length).toBe(0);
  });

  it("cart just over threshold IS processed", async () => {
    const mailer3 = new ConsoleMailer();
    // Create cart that is JUST over threshold (1 hour + 30 seconds old)
    const cart = await seedCart({
      emailSuffix: `-over-${Date.now()}`,
      ageMs: THRESHOLD_MS + 30_000, // 30s over threshold
    });

    await processAbandonedCarts({
      clock: new SimClock(new Date()),
      mailer: mailer3,
      thresholdMs: THRESHOLD_MS,
    });
    const sent = mailer3.sentMessages.filter((m) => m.to === cart.email);
    expect(sent.length).toBe(1);
  });
});
