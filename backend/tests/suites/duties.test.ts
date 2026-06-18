/**
 * duties.test.ts — Import duties / landed-cost (DDP) suite.
 *
 * Covers (additive T11.1):
 *  - calcDuties (lib/tax.ts): cross-border applies the rate; same-country zero;
 *    de_minimis waives below threshold; category filtering; multiple rates sum;
 *    missing/no rates → zero; malicious input is parameterized-safe.
 *  - Duty-rate CRUD endpoints (store-scoped).
 *  - Landed-cost preview endpoint (GET + POST).
 *
 * Does not touch the existing calcTax / calcTaxAuto path.
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
} from "../shared/helpers.js";
import { calcDuties } from "../../src/lib/tax.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

/** Insert a duty_rates row directly (bypasses RLS via the test pool). */
async function insertDuty(
  storeId: string,
  data: {
    destination_country: string;
    category?: string | null;
    rate_pct: number;
    de_minimis_value?: number | null;
    is_active?: boolean;
  }
) {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO duty_rates
       (store_id, destination_country, category, rate_pct, de_minimis_value, is_active)
     VALUES ($1::uuid, $2, $3, $4, $5, COALESCE($6, true))
     RETURNING id::text`,
    [
      storeId,
      data.destination_country,
      data.category ?? null,
      data.rate_pct,
      data.de_minimis_value ?? null,
      data.is_active ?? null,
    ]
  );
  return rows[0]!.id;
}

// ── calcDuties (lib/tax.ts) ─────────────────────────────────────────────────────

describe("calcDuties — cross-border duty computation (lib/tax.ts)", () => {
  let storeId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
  });

  it("no destination → zero", async () => {
    await insertDuty(storeId, { destination_country: "US", rate_pct: 10 });
    const res = await calcDuties(ctx.pool, storeId, 100, "");
    expect(res.dutyTotal).toBe(0);
    expect(res.dutyLines.length).toBe(0);
  });

  it("cross-border applies the rate", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", rate_pct: 10 });
    const res = await calcDuties(ctx.pool, s.store.id, 100, "US", { originCountry: "ZA" });
    expect(res.dutyTotal).toBe(10);
    expect(res.dutyLines.length).toBe(1);
    expect(res.dutyLines[0]!.rate_pct).toBe(10);
    expect(res.dutyLines[0]!.amount).toBe(10);
    expect(res.dutyLines[0]!.country).toBe("US");
  });

  it("same-country (origin === destination) → zero", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", rate_pct: 10 });
    const res = await calcDuties(ctx.pool, s.store.id, 100, "US", { originCountry: "US" });
    expect(res.dutyTotal).toBe(0);
    expect(res.dutyLines.length).toBe(0);
  });

  it("no originCountry → still applies (no same-country guard)", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "GB", rate_pct: 5 });
    const res = await calcDuties(ctx.pool, s.store.id, 200, "GB");
    expect(res.dutyTotal).toBe(10);
  });

  it("de_minimis waives duty at/below threshold", async () => {
    const s = await setup();
    await insertDuty(s.store.id, {
      destination_country: "US",
      rate_pct: 10,
      de_minimis_value: 150,
    });
    // declaredValue 100 <= 150 → waived
    const below = await calcDuties(ctx.pool, s.store.id, 100, "US", { originCountry: "ZA" });
    expect(below.dutyTotal).toBe(0);
    expect(below.dutyLines.length).toBe(1);
    expect(below.dutyLines[0]!.amount).toBe(0);
    // declaredValue 200 > 150 → applies
    const above = await calcDuties(ctx.pool, s.store.id, 200, "US", { originCountry: "ZA" });
    expect(above.dutyTotal).toBe(20);
  });

  it("category filtering: set-category rate applies only when category present", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", category: "electronics", rate_pct: 10 });
    await insertDuty(s.store.id, { destination_country: "US", category: "apparel", rate_pct: 20 });

    const matched = await calcDuties(ctx.pool, s.store.id, 100, "US", {
      originCountry: "ZA",
      categories: ["electronics"],
    });
    expect(matched.dutyTotal).toBe(10);
    expect(matched.dutyLines.length).toBe(1);

    // no categories provided → set-category rates do not apply
    const none = await calcDuties(ctx.pool, s.store.id, 100, "US", { originCountry: "ZA" });
    expect(none.dutyTotal).toBe(0);
    expect(none.dutyLines.length).toBe(0);
  });

  it("null-category rate applies regardless of categories", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", category: null, rate_pct: 5 });
    const res = await calcDuties(ctx.pool, s.store.id, 100, "US", {
      originCountry: "ZA",
      categories: ["anything"],
    });
    expect(res.dutyTotal).toBe(5);
  });

  it("multiple matched rates sum", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", category: null, rate_pct: 5 });
    await insertDuty(s.store.id, { destination_country: "US", category: "electronics", rate_pct: 10 });
    const res = await calcDuties(ctx.pool, s.store.id, 100, "US", {
      originCountry: "ZA",
      categories: ["electronics"],
    });
    // 5% + 10% on 100 = 15
    expect(res.dutyTotal).toBe(15);
    expect(res.dutyLines.length).toBe(2);
  });

  it("inactive rates are ignored", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", rate_pct: 10, is_active: false });
    const res = await calcDuties(ctx.pool, s.store.id, 100, "US", { originCountry: "ZA" });
    expect(res.dutyTotal).toBe(0);
  });

  it("no rates for destination → zero", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", rate_pct: 10 });
    const res = await calcDuties(ctx.pool, s.store.id, 100, "DE", { originCountry: "ZA" });
    expect(res.dutyTotal).toBe(0);
    expect(res.dutyLines.length).toBe(0);
  });

  it("destination is case-insensitive", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", rate_pct: 10 });
    const res = await calcDuties(ctx.pool, s.store.id, 100, "us", { originCountry: "za" });
    expect(res.dutyTotal).toBe(10);
  });

  it("malicious / injection input is parameterized-safe and never throws", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", rate_pct: 10 });
    const evil = "US'; DROP TABLE duty_rates; --";
    const res = await calcDuties(ctx.pool, s.store.id, 100, evil, { originCountry: "ZA" });
    expect(res.dutyTotal).toBe(0);
    // table still exists / original rate still queryable
    const ok = await calcDuties(ctx.pool, s.store.id, 100, "US", { originCountry: "ZA" });
    expect(ok.dutyTotal).toBe(10);
  });

  it("rounds to 2dp", async () => {
    const s = await setup();
    await insertDuty(s.store.id, { destination_country: "US", rate_pct: 7.5 });
    const res = await calcDuties(ctx.pool, s.store.id, 33.33, "US", { originCountry: "ZA" });
    // 33.33 * 7.5 / 100 = 2.49975 → 2.50
    expect(res.dutyTotal).toBe(2.5);
  });
});

// ── Duty-rate CRUD endpoints ─────────────────────────────────────────────────────

describe("Duty-rate CRUD endpoints", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let rateId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /tax/duty-rates → empty for new store", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/tax/duty-rates`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["duty_rates"])).toBe(true);
    expect((res.json["duty_rates"] as unknown[]).length).toBe(0);
  });

  it("POST /tax/duty-rates → creates rate", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax/duty-rates`,
      { destination_country: "US", category: "electronics", rate_pct: 12.5, de_minimis_value: 800 },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    rateId = res.json["id"] as string;
  });

  it("GET /tax/duty-rates → lists the created rate", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/tax/duty-rates`, auth);
    expect(res.status).toBe(200);
    const list = res.json["duty_rates"] as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(list[0]!["destination_country"]).toBe("US");
    expect(list[0]!["category"]).toBe("electronics");
  });

  it("GET /tax/duty-rates?destination_country=DE → filtered empty", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/tax/duty-rates?destination_country=DE`, auth);
    expect(res.status).toBe(200);
    expect((res.json["duty_rates"] as unknown[]).length).toBe(0);
  });

  it("PUT /tax/duty-rates/:rateId → updates rate", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/tax/duty-rates/${rateId}`,
      { rate_pct: 15, is_active: false },
      auth
    );
    expect(res.status).toBe(200);
    const list = await get(ctx, `/commerce/stores/${storeId}/tax/duty-rates`, auth);
    const row = (list.json["duty_rates"] as Record<string, unknown>[])[0]!;
    expect(Number(row["rate_pct"])).toBe(15);
    expect(row["is_active"]).toBe(false);
  });

  it("PUT /tax/duty-rates/:rateId → 404 for unknown id", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/tax/duty-rates/${randomUUID()}`,
      { rate_pct: 1 },
      auth
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /tax/duty-rates/:rateId → removes rate", async () => {
    const res = await del(ctx, `/commerce/stores/${storeId}/tax/duty-rates/${rateId}`, auth);
    expect(res.status).toBe(200);
    const list = await get(ctx, `/commerce/stores/${storeId}/tax/duty-rates`, auth);
    expect((list.json["duty_rates"] as unknown[]).length).toBe(0);
  });

  it("DELETE /tax/duty-rates/:rateId → 404 when already gone", async () => {
    const res = await del(ctx, `/commerce/stores/${storeId}/tax/duty-rates/${rateId}`, auth);
    expect(res.status).toBe(404);
  });
});

// ── Landed-cost preview endpoint ─────────────────────────────────────────────────

describe("Landed-cost preview endpoint", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
    await insertDuty(storeId, { destination_country: "US", rate_pct: 10 });
  });

  it("POST /tax/landed-cost → returns duties + dutyLines", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax/landed-cost`,
      { subtotal: 100, destination_country: "US", origin_country: "ZA" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["duties"]).toBe(10);
    expect(Array.isArray(res.json["dutyLines"])).toBe(true);
    expect((res.json["dutyLines"] as unknown[]).length).toBe(1);
    // combined view includes tax fields (zero here — no tax rates configured)
    expect(res.json["tax"]).toBe(0);
    expect(Array.isArray(res.json["taxLines"])).toBe(true);
  });

  it("POST /tax/landed-cost → same-country origin yields zero duties", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax/landed-cost`,
      { subtotal: 100, destination_country: "US", origin_country: "US" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["duties"]).toBe(0);
  });

  it("GET /tax/landed-cost → query-string variant works", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/tax/landed-cost?subtotal=250&destination_country=US&origin_country=ZA`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["duties"]).toBe(25);
  });
});
