/**
 * back-in-stock — Vitest integration suite (Wave 18.2).
 *
 * Covers the storefront back-in-stock subscription flow + restock worker:
 *   POST   /commerce/stores/:storeId/back-in-stock      (subscribe)
 *   GET    /commerce/stores/:storeId/back-in-stock      (customer list)
 *   DELETE /commerce/stores/:storeId/back-in-stock/:id  (customer cancel)
 *   processRestocks() — the worker tick (with an injected mailer spy)
 *
 * Verifies:
 *   - subscribe to an out-of-stock variant creates one active row;
 *   - processRestocks does NOTHING while stock stays 0;
 *   - after raising on-hand >0 it notifies exactly once with the right
 *     recipient + marks the subscription notified;
 *   - a second tick does NOT re-notify;
 *   - dedup: double-subscribe yields a single row;
 *   - cancel works (and a cancelled sub is not notified).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, del, mintJwt, insertProduct, insertVariant } from "../shared/helpers.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { SimClock } from "../../src/clock.js";
import { setMailerForTesting } from "../../src/modules/customer-auth/service.js";
import { encodeSecretValue } from "../../src/lib/secrets.js";
import { processRestocks } from "../../src/modules/back-in-stock/service.js";

let ctx: TestCtx;
const customerAuthMailer = new ConsoleMailer();
const TEST_JWT_SECRET = "test-jwt-secret-256bits-longerthis";

beforeAll(async () => {
  setMailerForTesting(customerAuthMailer);
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ─────────────────────────────────────────────────────────────────

function bearer(token: string) {
  return { type: "bearer" as const, token };
}

async function setupStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const adminToken = await mintJwt({ userId, orgId });
  const auth = bearer(adminToken);

  const res = await post(ctx, "/commerce/stores", { name: "BIS Test Store", currency: "USD" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  const storeId = (res.json as Record<string, unknown>)["id"] as string;

  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const encodedSecret = encodeSecretValue(TEST_JWT_SECRET, secretsKey) ?? TEST_JWT_SECRET;
  await ctx.pool.query(
    `UPDATE stores
        SET auth_enabled = true,
            auth_jwt_secret = $2,
            auth_email_password_enabled = true,
            auth_require_email_verification = false
      WHERE id = $1::uuid`,
    [storeId, encodedSecret],
  );

  return { storeId, auth };
}

/** Create a verified customer and log in, returning the access token. */
async function makeCustomer(storeId: string): Promise<{ customerId: string; email: string; token: string }> {
  const email = `bis-${randomUUID()}@example.com`;
  const { hashPasswordSync } = await import("../../src/modules/customer-auth/service.js");
  const hash = hashPasswordSync("Password123!");
  const ins = await ctx.pool.query<{ id: string }>(
    `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
     VALUES ($1::uuid, $2, $3, 'email', true, true)
     RETURNING id::text`,
    [storeId, email, hash],
  );
  const customerId = ins.rows[0]!.id;

  const loginRes = await post(ctx, `/commerce/stores/${storeId}/auth/login`, { email, password: "Password123!" });
  if (loginRes.status !== 200) throw new Error(`login failed: ${JSON.stringify(loginRes.body)}`);
  const token = (loginRes.json as Record<string, unknown>)["access_token"] as string;
  return { customerId, email, token };
}

/** Create a warehouse + a variant with a given on-hand. Returns the variant id. */
async function makeVariant(storeId: string, onHand: number): Promise<{ variantId: string; warehouseId: string }> {
  const product = await insertProduct(ctx.pool, { storeId });
  const variant = await insertVariant(ctx.pool, { productId: product.id });

  const wh = await ctx.pool.query<{ id: string }>(
    `INSERT INTO warehouses (store_id, name, is_default) VALUES ($1::uuid, 'Main WH', true) RETURNING id::text`,
    [storeId],
  );
  const warehouseId = wh.rows[0]!.id;

  await ctx.pool.query(
    `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
     VALUES ($1::uuid, $2::uuid, $3)`,
    [variant.id, warehouseId, onHand],
  );

  return { variantId: variant.id, warehouseId };
}

async function setOnHand(variantId: string, warehouseId: string, qty: number): Promise<void> {
  await ctx.pool.query(
    `UPDATE inventory_levels SET quantity_on_hand = $1, updated_at = now()
      WHERE variant_id = $2::uuid AND warehouse_id = $3::uuid`,
    [qty, variantId, warehouseId],
  );
}

async function subRow(id: string) {
  const { rows } = await ctx.pool.query<{ status: string; notified_at: string | null; last_known_on_hand: number | null }>(
    `SELECT status, notified_at, last_known_on_hand FROM back_in_stock_subscriptions WHERE id = $1::uuid`,
    [id],
  );
  return rows[0]!;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Back-in-stock — subscribe, restock notify-once, cancel, dedup", () => {
  it("subscribe (customer) to an out-of-stock variant → one active row", async () => {
    const { storeId } = await setupStore();
    const cust = await makeCustomer(storeId);
    const { variantId } = await makeVariant(storeId, 0);

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/back-in-stock`,
      { variant_id: variantId },
      bearer(cust.token),
    );
    expect(res.status).toBe(201);
    expect(res.json["status"]).toBe("active");

    const { rows } = await ctx.pool.query(
      `SELECT id FROM back_in_stock_subscriptions WHERE store_id = $1::uuid AND variant_id = $2::uuid`,
      [storeId, variantId],
    );
    expect(rows.length).toBe(1);
  });

  it("dedup: double-subscribe = a single row", async () => {
    const { storeId } = await setupStore();
    const cust = await makeCustomer(storeId);
    const { variantId } = await makeVariant(storeId, 0);

    await post(ctx, `/commerce/stores/${storeId}/back-in-stock`, { variant_id: variantId }, bearer(cust.token));
    await post(ctx, `/commerce/stores/${storeId}/back-in-stock`, { variant_id: variantId }, bearer(cust.token));

    const { rows } = await ctx.pool.query(
      `SELECT id FROM back_in_stock_subscriptions WHERE store_id = $1::uuid AND variant_id = $2::uuid`,
      [storeId, variantId],
    );
    expect(rows.length).toBe(1);
  });

  it("processRestocks does NOTHING while stock stays 0, notifies ONCE after restock, no re-notify", async () => {
    const { storeId } = await setupStore();
    const cust = await makeCustomer(storeId);
    const { variantId, warehouseId } = await makeVariant(storeId, 0);

    const subRes = await post(
      ctx,
      `/commerce/stores/${storeId}/back-in-stock`,
      { variant_id: variantId },
      bearer(cust.token),
    );
    const subId = subRes.json["id"] as string;

    const mailer = new ConsoleMailer();
    const clock = new SimClock(new Date());

    // Stock still 0 → no notification.
    let sent = await processRestocks(storeId, { mailer, clock });
    expect(sent).toBe(0);
    expect(mailer.sentMessages.length).toBe(0);
    expect((await subRow(subId)).status).toBe("active");

    // Restock → one notification to the customer's email.
    await setOnHand(variantId, warehouseId, 5);
    sent = await processRestocks(storeId, { mailer, clock });
    expect(sent).toBe(1);
    expect(mailer.sentMessages.length).toBe(1);
    expect(mailer.sentMessages[0]!.to).toBe(cust.email);
    expect(mailer.sentMessages[0]!.subject.toLowerCase()).toContain("back in stock");

    const after = await subRow(subId);
    expect(after.status).toBe("notified");
    expect(after.notified_at).not.toBeNull();

    // Second tick (still in stock) → no re-notify.
    mailer.clear();
    sent = await processRestocks(storeId, { mailer, clock });
    expect(sent).toBe(0);
    expect(mailer.sentMessages.length).toBe(0);
  });

  it("public (email-only) subscribe works and the worker notifies that email", async () => {
    const { storeId, auth } = await setupStore();
    const { variantId, warehouseId } = await makeVariant(storeId, 0);
    const email = `anon-${randomUUID()}@example.com`;

    // Public subscribe uses the storefront-read guard (admin JWT accepted) with
    // an explicit email and no customer bearer.
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/back-in-stock`,
      { variant_id: variantId, email },
      auth,
    );
    expect(res.status).toBe(201);

    const mailer = new ConsoleMailer();
    const clock = new SimClock(new Date());

    await setOnHand(variantId, warehouseId, 3);
    const sent = await processRestocks(storeId, { mailer, clock });
    expect(sent).toBe(1);
    expect(mailer.sentMessages[0]!.to).toBe(email);
  });

  it("customer list returns own subscriptions; cancel works and prevents notify", async () => {
    const { storeId } = await setupStore();
    const cust = await makeCustomer(storeId);
    const { variantId, warehouseId } = await makeVariant(storeId, 0);

    const subRes = await post(
      ctx,
      `/commerce/stores/${storeId}/back-in-stock`,
      { variant_id: variantId },
      bearer(cust.token),
    );
    const subId = subRes.json["id"] as string;

    // List
    const listRes = await get(ctx, `/commerce/stores/${storeId}/back-in-stock`, bearer(cust.token));
    expect(listRes.status).toBe(200);
    const subs = listRes.json["subscriptions"] as Record<string, unknown>[];
    expect(subs.length).toBe(1);
    expect(subs[0]!["id"]).toBe(subId);

    // Cancel
    const cancelRes = await del(ctx, `/commerce/stores/${storeId}/back-in-stock/${subId}`, bearer(cust.token));
    expect(cancelRes.status).toBe(200);
    expect((await subRow(subId)).status).toBe("cancelled");

    // A cancelled subscription is not notified on restock.
    const mailer = new ConsoleMailer();
    await setOnHand(variantId, warehouseId, 9);
    const sent = await processRestocks(storeId, { mailer, clock: new SimClock(new Date()) });
    expect(sent).toBe(0);
    expect(mailer.sentMessages.length).toBe(0);
  });
});
