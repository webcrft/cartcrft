/**
 * discounts — Discount codes + automatic discounts suite.
 *
 * Covers:
 *  - CRUD lifecycle for discount codes (all 5 types)
 *  - ValidateDiscount: active/inactive, date windows, max_uses, percentage math,
 *    max_discount cap, once_per_customer
 *  - 409 on duplicate code
 *  - 404 on get/update/delete of non-existent discount
 *  - Auto-discounts CRUD + field validation
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  del,
  mintJwt,
  insertStore,
  isErrorEnvelope,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup() {
  // Organizations are plain UUIDs (no organizations table in this schema).
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

// ── Discount Code CRUD lifecycle ───────────────────────────────────────────────

describe("Discount codes CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let discountId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /discounts → empty list for new store", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/discounts`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["discounts"])).toBe(true);
    expect((res.json["discounts"] as unknown[]).length).toBe(0);
  });

  it("POST /discounts → creates percentage discount", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      {
        code: "SAVE10",
        type: "percentage",
        value: "10.00",
        max_discount: "50.00",
        is_active: true,
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    discountId = res.json["id"] as string;
  });

  it("GET /discounts/:id → returns correct fields", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/${discountId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["code"]).toBe("SAVE10");
    expect(res.json["type"]).toBe("percentage");
    expect(res.json["value"]).toBe("10.0000");
    expect(res.json["is_active"]).toBe(true);
  });

  it("GET /discounts → 1 discount after creation", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/discounts`, auth);
    expect(res.status).toBe(200);
    expect((res.json["discounts"] as unknown[]).length).toBe(1);
  });

  it("PUT /discounts/:id → updates is_active", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/discounts/${discountId}`,
      { is_active: false },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    const getRes = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/${discountId}`,
      auth
    );
    expect(getRes.json["is_active"]).toBe(false);
  });

  it("DELETE /discounts/:id → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/discounts/${discountId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("GET /discounts/:id → 404 after delete", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/${discountId}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("PUT /discounts/:id → 404 for non-existent", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/discounts/${randomUUID()}`,
      { is_active: true },
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("DELETE /discounts/:id → 404 for non-existent", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/discounts/${randomUUID()}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── All 5 discount types ──────────────────────────────────────────────────────

describe("All 5 discount types", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  for (const type of [
    "percentage",
    "fixed_amount",
    "free_shipping",
    "bogo",
    "buy_x_get_y",
  ] as const) {
    it(`POST /discounts → creates ${type} discount`, async () => {
      const code = `TEST-${type.toUpperCase()}-${Date.now()}`;
      const body: Record<string, unknown> = { code, type };
      if (type === "percentage" || type === "fixed_amount") {
        body["value"] = "15.00";
      }
      const res = await post(
        ctx,
        `/commerce/stores/${storeId}/discounts`,
        body,
        auth
      );
      expect(res.status).toBe(201);
      const id = res.json["id"] as string;

      const getRes = await get(
        ctx,
        `/commerce/stores/${storeId}/discounts/${id}`,
        auth
      );
      expect(getRes.status).toBe(200);
      expect(getRes.json["type"]).toBe(type);
    });
  }
});

// ── Duplicate code conflict ───────────────────────────────────────────────────

describe("Discount code uniqueness", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("POST /discounts → 409 on duplicate code", async () => {
    const code = `DUP-${Date.now()}`;
    const body = { code, type: "fixed_amount", value: "5.00" };

    const first = await post(ctx, `/commerce/stores/${storeId}/discounts`, body, auth);
    expect(first.status).toBe(201);

    const second = await post(ctx, `/commerce/stores/${storeId}/discounts`, body, auth);
    expect(second.status).toBe(409);
    expect(isErrorEnvelope(second)).toBe(true);
  });
});

// ── ValidateDiscount ──────────────────────────────────────────────────────────

describe("ValidateDiscount", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("validate → 404 for unknown code", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=GHOST`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("validate → 404 when discount is inactive", async () => {
    const code = `INACTIVE-${Date.now()}`;
    await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "fixed_amount", value: "10.00", is_active: false },
      auth
    );
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code}`,
      auth
    );
    expect(res.status).toBe(404);
  });

  it("validate → 404 when outside starts_at window (future start)", async () => {
    const code = `FUTURE-${Date.now()}`;
    // starts_at = 1 day from now
    const starts_at = new Date(Date.now() + 86_400_000).toISOString();
    await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "fixed_amount", value: "10.00", starts_at },
      auth
    );
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code}`,
      auth
    );
    expect(res.status).toBe(404);
  });

  it("validate → 404 when past ends_at window", async () => {
    const code = `EXPIRED-${Date.now()}`;
    // ends_at = 1 day ago
    const ends_at = new Date(Date.now() - 86_400_000).toISOString();
    await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "fixed_amount", value: "10.00", ends_at },
      auth
    );
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code}`,
      auth
    );
    expect(res.status).toBe(404);
  });

  it("validate → 404 when max_uses exceeded", async () => {
    const code = `MAXUSED-${Date.now()}`;
    // Create with max_uses=1, uses_count already at 1 via direct SQL
    const createRes = await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "fixed_amount", value: "5.00", max_uses: 1 },
      auth
    );
    const discountId = createRes.json["id"] as string;

    // Manually bump uses_count to max
    await ctx.pool.query(
      `UPDATE discount_codes SET uses_count = 1 WHERE id = $1::uuid`,
      [discountId]
    );

    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code}`,
      auth
    );
    expect(res.status).toBe(404);
  });

  it("validate → returns correct percentage math", async () => {
    const code = `PCT-${Date.now()}`;
    await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "percentage", value: "20.00" },
      auth
    );
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code}&order_total=100.00`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["type"]).toBe("percentage");
    expect(res.json["computed_amount"]).toBe("20.00");
  });

  it("validate → percentage capped by max_discount", async () => {
    const code = `PCAP-${Date.now()}`;
    await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "percentage", value: "50.00", max_discount: "30.00" },
      auth
    );
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code}&order_total=200.00`,
      auth
    );
    expect(res.status).toBe(200);
    // 50% of 200 = 100, capped at 30
    expect(res.json["computed_amount"]).toBe("30.00");
  });

  it("validate → 404 when once_per_customer and customer already used it", async () => {
    const code = `ONCE-${Date.now()}`;
    const createRes = await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "fixed_amount", value: "5.00", once_per_customer: true },
      auth
    );
    const discountId = createRes.json["id"] as string;

    // Insert a customer
    const { rows: custRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email)
       VALUES ($1::uuid, $2)
       RETURNING id::text`,
      [storeId, `once-${Date.now()}@test.example.com`]
    );
    const customerId = custRows[0]!.id;

    // Insert a discount_usages row (simulates prior use)
    await ctx.pool.query(
      `INSERT INTO discount_usages (discount_id, customer_id, amount_saved)
       VALUES ($1::uuid, $2::uuid, '5.00')`,
      [discountId, customerId]
    );

    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code}&customer_id=${customerId}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("validate → 200 for once_per_customer when different customer", async () => {
    const code = `ONCE2-${Date.now()}`;
    const createRes = await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "fixed_amount", value: "5.00", once_per_customer: true },
      auth
    );
    const discountId = createRes.json["id"] as string;

    // Insert a customer that hasn't used it
    const { rows: custRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email)
       VALUES ($1::uuid, $2)
       RETURNING id::text`,
      [storeId, `once2-${Date.now()}@test.example.com`]
    );
    const customerId = custRows[0]!.id;

    // Insert usage for a DIFFERENT customer
    const { rows: otherCustRows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email)
       VALUES ($1::uuid, $2)
       RETURNING id::text`,
      [storeId, `once2-other-${Date.now()}@test.example.com`]
    );
    await ctx.pool.query(
      `INSERT INTO discount_usages (discount_id, customer_id, amount_saved)
       VALUES ($1::uuid, $2::uuid, '5.00')`,
      [discountId, otherCustRows[0]!.id]
    );

    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code}&customer_id=${customerId}`,
      auth
    );
    expect(res.status).toBe(200);
  });

  it("validate → code lookup is case-insensitive", async () => {
    const code = `CASETEST-${Date.now()}`;
    await post(
      ctx,
      `/commerce/stores/${storeId}/discounts`,
      { code, type: "fixed_amount", value: "7.00" },
      auth
    );
    // Lookup with lowercase
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/discounts/validate?code=${code.toLowerCase()}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["code"]).toBe(code);
  });
});

// ── Auto-discounts CRUD ───────────────────────────────────────────────────────

describe("Auto-discounts CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let autoDiscountId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /auto-discounts → empty list for new store", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts`,
      auth
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["discounts"])).toBe(true);
    expect((res.json["discounts"] as unknown[]).length).toBe(0);
  });

  it("POST /auto-discounts → creates auto discount", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts`,
      {
        title: "Summer Sale",
        type: "percentage",
        value: "15.00",
        min_order_total: "50.00",
        priority: 10,
        is_active: true,
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    autoDiscountId = res.json["id"] as string;
  });

  it("GET /auto-discounts/:id → returns correct fields", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts/${autoDiscountId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["title"]).toBe("Summer Sale");
    expect(res.json["type"]).toBe("percentage");
    expect(res.json["priority"]).toBe(10);
    expect(res.json["is_active"]).toBe(true);
  });

  it("GET /auto-discounts → 1 result", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts`,
      auth
    );
    expect(res.status).toBe(200);
    expect((res.json["discounts"] as unknown[]).length).toBe(1);
  });

  it("PUT /auto-discounts/:id → updates title and priority", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts/${autoDiscountId}`,
      { title: "Renamed Sale", priority: 20 },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    const getRes = await get(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts/${autoDiscountId}`,
      auth
    );
    expect(getRes.json["title"]).toBe("Renamed Sale");
    expect(getRes.json["priority"]).toBe(20);
  });

  it("DELETE /auto-discounts/:id → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts/${autoDiscountId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("GET /auto-discounts/:id → 404 after delete", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts/${autoDiscountId}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("POST /auto-discounts → 400 with empty title", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts`,
      { title: "", type: "percentage", value: "10.00" },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("PUT /auto-discounts/:id → 404 for non-existent", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts/${randomUUID()}`,
      { title: "Nope" },
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("DELETE /auto-discounts/:id → 404 for non-existent", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/auto-discounts/${randomUUID()}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── Auto-discounts all 5 types ────────────────────────────────────────────────

describe("Auto-discounts all 5 types", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  for (const type of [
    "percentage",
    "fixed_amount",
    "free_shipping",
    "bogo",
    "buy_x_get_y",
  ] as const) {
    it(`POST /auto-discounts → creates ${type}`, async () => {
      const body: Record<string, unknown> = {
        title: `Auto ${type} ${Date.now()}`,
        type,
      };
      if (type === "percentage" || type === "fixed_amount") {
        body["value"] = "10.00";
      }
      const res = await post(
        ctx,
        `/commerce/stores/${storeId}/auto-discounts`,
        body,
        auth
      );
      expect(res.status).toBe(201);
      const id = res.json["id"] as string;

      const getRes = await get(
        ctx,
        `/commerce/stores/${storeId}/auto-discounts/${id}`,
        auth
      );
      expect(getRes.status).toBe(200);
      expect(getRes.json["type"]).toBe(type);
    });
  }
});
