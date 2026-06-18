/**
 * loyalty — native points program suite.
 *
 * Covers:
 *  - Config: GET auto-creates defaults; PUT changes the earn rate.
 *  - Earn (via the exported earnPointsForOrder service): computes points,
 *    credits balance + lifetime, writes a ledger row; idempotent per order.
 *  - Earn rate change takes effect on subsequent earns.
 *  - Redeem (customer-scoped): debits balance, returns correct monetary value,
 *    rejects when insufficient (422 INSUFFICIENT_POINTS).
 *  - Admin adjust + balance / ledger reads.
 *  - Customer-scoped me/balance + me/ledger.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  mintJwt,
  insertStore,
  insertCustomer,
  isErrorEnvelope,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

const TEST_JWT_SECRET = "test-jwt-secret-256bits-loyaltyaaa";

// ── Setup helpers ────────────────────────────────────────────────────────────

async function setup() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const customer = await insertCustomer(ctx.pool, { storeId: store.id });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  // Configure a per-store JWT secret so we can mint a customer bearer token.
  const { encodeSecretValue } = await import("../../src/lib/secrets.js");
  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const encodedSecret = encodeSecretValue(TEST_JWT_SECRET, secretsKey) ?? TEST_JWT_SECRET;
  await ctx.pool.query(
    `UPDATE stores SET auth_enabled = true, auth_jwt_secret = $2 WHERE id = $1::uuid`,
    [store.id, encodedSecret]
  );

  return { orgId, store, customer, userId, auth };
}

/** Mint a storefront customer bearer token for the given store/customer. */
async function customerToken(storeId: string, customerId: string, email: string) {
  const { issueCustomerJwt } = await import("../../src/modules/customer-auth/service.js");
  const token = await issueCustomerJwt(
    TEST_JWT_SECRET,
    customerId,
    email,
    false,
    storeId,
    [],
    60
  );
  return { type: "bearer" as const, token };
}

/** Earn points directly through the exported service (order hook is a follow-up). */
async function earn(storeId: string, customerId: string, orderId: string, total: string) {
  const { earnPointsForOrder } = await import("../../src/modules/loyalty/service.js");
  return earnPointsForOrder(storeId, customerId, orderId, total);
}

function configUrl(storeId: string) {
  return `/commerce/stores/${storeId}/loyalty/config`;
}
function adminCustomerUrl(storeId: string, customerId: string) {
  return `/commerce/stores/${storeId}/loyalty/customers/${customerId}`;
}

// ── Config ───────────────────────────────────────────────────────────────────

describe("loyalty config", () => {
  it("GET auto-creates defaults (1 pt / unit, 0.01 / pt, active)", async () => {
    const s = await setup();
    const res = await get(ctx, configUrl(s.store.id), s.auth);
    expect(res.status).toBe(200);
    const cfg = res.json["config"] as Record<string, unknown>;
    expect(parseFloat(cfg["points_per_currency_unit"] as string)).toBe(1);
    expect(parseFloat(cfg["redeem_value_per_point"] as string)).toBe(0.01);
    expect(cfg["is_active"]).toBe(true);
  });

  it("PUT updates the earn rate + redeem value", async () => {
    const s = await setup();
    const res = await put(
      ctx,
      configUrl(s.store.id),
      { points_per_currency_unit: "2", redeem_value_per_point: "0.05" },
      s.auth
    );
    expect(res.status).toBe(200);
    const cfg = res.json["config"] as Record<string, unknown>;
    expect(parseFloat(cfg["points_per_currency_unit"] as string)).toBe(2);
    expect(parseFloat(cfg["redeem_value_per_point"] as string)).toBe(0.05);
  });
});

// ── Earn ─────────────────────────────────────────────────────────────────────

describe("loyalty earn (earnPointsForOrder)", () => {
  it("computes points = floor(total × rate), credits balance + lifetime, writes ledger", async () => {
    const s = await setup();
    const orderId = randomUUID();
    // default rate 1 → 49.99 × 1 = floor(49.99) = 49 points
    const result = await earn(s.store.id, s.customer.id, orderId, "49.99");
    expect(result.pointsEarned).toBe(49);
    expect(result.alreadyEarned).toBe(false);
    expect(result.account.balance_points).toBe(49);
    expect(result.account.lifetime_points).toBe(49);
    expect(result.entry).not.toBeNull();
    expect(result.entry!.entry_type).toBe("earn");
    expect(result.entry!.points).toBe(49);
    expect(result.entry!.balance_after).toBe(49);
    expect(result.entry!.order_id).toBe(orderId);

    // Admin balance read reflects the earn.
    const res = await get(ctx, adminCustomerUrl(s.store.id, s.customer.id), s.auth);
    expect(res.status).toBe(200);
    expect(res.json["balance_points"]).toBe(49);
    expect(res.json["lifetime_points"]).toBe(49);
  });

  it("is idempotent per order_id (no double-earn on replay)", async () => {
    const s = await setup();
    const orderId = randomUUID();
    const first = await earn(s.store.id, s.customer.id, orderId, "100.00");
    expect(first.pointsEarned).toBe(100);

    const replay = await earn(s.store.id, s.customer.id, orderId, "100.00");
    expect(replay.alreadyEarned).toBe(true);
    expect(replay.pointsEarned).toBe(0);
    expect(replay.account.balance_points).toBe(100);
    expect(replay.account.lifetime_points).toBe(100);

    // Exactly one earn ledger row for this order.
    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM loyalty_ledger
       WHERE store_id = $1::uuid AND customer_id = $2::uuid AND order_id = $3::uuid AND entry_type = 'earn'`,
      [s.store.id, s.customer.id, orderId]
    );
    expect(rows[0].n).toBe(1);
  });

  it("config earn-rate change affects subsequent earns", async () => {
    const s = await setup();
    // Bump rate to 3 pts / unit.
    await put(ctx, configUrl(s.store.id), { points_per_currency_unit: "3" }, s.auth);
    const result = await earn(s.store.id, s.customer.id, randomUUID(), "10.00");
    expect(result.pointsEarned).toBe(30);
  });
});

// ── Redeem (customer-scoped) ──────────────────────────────────────────────────

describe("loyalty redeem (customer-scoped)", () => {
  it("debits balance + returns correct monetary value", async () => {
    const s = await setup();
    await earn(s.store.id, s.customer.id, randomUUID(), "500.00"); // 500 points, redeem 0.01/pt
    const cAuth = await customerToken(s.store.id, s.customer.id, s.customer.email);

    const res = await post(
      ctx,
      `/commerce/stores/${s.store.id}/loyalty/me/redeem`,
      { points: 200 },
      cAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["value"]).toBe("2.00"); // 200 × 0.01
    const account = res.json["account"] as Record<string, unknown>;
    expect(account["balance_points"]).toBe(300);
    // lifetime unchanged by redeem
    expect(account["lifetime_points"]).toBe(500);
    const entry = res.json["entry"] as Record<string, unknown>;
    expect(entry["entry_type"]).toBe("redeem");
    expect(entry["points"]).toBe(-200);
    expect(entry["balance_after"]).toBe(300);
  });

  it("rejects redeem when balance is insufficient (422)", async () => {
    const s = await setup();
    await earn(s.store.id, s.customer.id, randomUUID(), "10.00"); // 10 points
    const cAuth = await customerToken(s.store.id, s.customer.id, s.customer.email);

    const res = await post(
      ctx,
      `/commerce/stores/${s.store.id}/loyalty/me/redeem`,
      { points: 999 },
      cAuth
    );
    expect(res.status).toBe(422);
    expect(isErrorEnvelope(res)).toBe(true);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("INSUFFICIENT_POINTS");
  });

  it("GET /loyalty/me returns the customer's balance", async () => {
    const s = await setup();
    await earn(s.store.id, s.customer.id, randomUUID(), "42.00"); // 42 points
    const cAuth = await customerToken(s.store.id, s.customer.id, s.customer.email);

    const res = await get(ctx, `/commerce/stores/${s.store.id}/loyalty/me`, cAuth);
    expect(res.status).toBe(200);
    expect(res.json["balance_points"]).toBe(42);

    const ledgerRes = await get(ctx, `/commerce/stores/${s.store.id}/loyalty/me/ledger`, cAuth);
    expect(ledgerRes.status).toBe(200);
    const ledger = ledgerRes.json["ledger"] as unknown[];
    expect(ledger.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects redeem without a valid customer token (401)", async () => {
    const s = await setup();
    const res = await post(
      ctx,
      `/commerce/stores/${s.store.id}/loyalty/me/redeem`,
      { points: 1 },
      { type: "bearer", token: "not-a-real-token" }
    );
    expect(res.status).toBe(401);
  });
});

// ── Admin adjust + ledger ─────────────────────────────────────────────────────

describe("loyalty admin adjust + ledger", () => {
  it("positive adjust credits balance + lifetime and writes ledger", async () => {
    const s = await setup();
    const res = await post(
      ctx,
      `${adminCustomerUrl(s.store.id, s.customer.id)}/adjust`,
      { points: 250, reason: "Goodwill" },
      s.auth
    );
    expect(res.status).toBe(200);
    const account = res.json["account"] as Record<string, unknown>;
    expect(account["balance_points"]).toBe(250);
    expect(account["lifetime_points"]).toBe(250);
    const entry = res.json["entry"] as Record<string, unknown>;
    expect(entry["entry_type"]).toBe("adjust");
    expect(entry["points"]).toBe(250);
  });

  it("negative adjust below zero rejected (422)", async () => {
    const s = await setup();
    const res = await post(
      ctx,
      `${adminCustomerUrl(s.store.id, s.customer.id)}/adjust`,
      { points: -50 },
      s.auth
    );
    expect(res.status).toBe(422);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("INSUFFICIENT_POINTS");
  });

  it("ledger lists entries most-recent-first", async () => {
    const s = await setup();
    await earn(s.store.id, s.customer.id, randomUUID(), "20.00"); // 20
    await post(ctx, `${adminCustomerUrl(s.store.id, s.customer.id)}/adjust`, { points: 5 }, s.auth);

    const res = await get(
      ctx,
      `${adminCustomerUrl(s.store.id, s.customer.id)}/ledger`,
      s.auth
    );
    expect(res.status).toBe(200);
    const ledger = res.json["ledger"] as Array<Record<string, unknown>>;
    expect(ledger.length).toBe(2);
    for (let i = 1; i < ledger.length; i++) {
      const prev = new Date(ledger[i - 1]!["created_at"] as string).getTime();
      const curr = new Date(ledger[i]!["created_at"] as string).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });
});
