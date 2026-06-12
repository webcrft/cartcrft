/**
 * tax.test.ts — Tax configuration suite.
 *
 * Covers:
 *  - Tax categories CRUD (with duplicate-code detection)
 *  - Tax zones + regions CRUD
 *  - Tax rates CRUD (inclusive/exclusive, rate_pct validation)
 *  - Zone resolution: country_code match, province_code wildcard vs specific
 *  - Inclusive vs exclusive math via lib/tax.ts (calcTax)
 *
 * Ported from webcrft-mono/backend/tests/suites/commerce_tax.go.
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
import { calcTax } from "../../src/lib/tax.js";

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

// ── Tax categories CRUD ────────────────────────────────────────────────────────

describe("Tax categories CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let categoryId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /tax-categories → empty list for new store", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/tax-categories`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["categories"])).toBe(true);
    expect((res.json["categories"] as unknown[]).length).toBe(0);
  });

  it("POST /tax-categories → creates category", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-categories`,
      { name: "Standard Goods", code: "STD" },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    categoryId = res.json["id"] as string;
  });

  it("GET /tax-categories → 1 category after create", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/tax-categories`, auth);
    expect(res.status).toBe(200);
    const cats = res.json["categories"] as Record<string, unknown>[];
    expect(cats.length).toBe(1);
    expect(cats[0]!["code"]).toBe("STD");
  });

  it("POST /tax-categories → 409 on duplicate code", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-categories`,
      { name: "Another Name", code: "STD" },
      auth
    );
    expect(res.status).toBe(409);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("DELETE /tax-categories/:id → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/tax-categories/${categoryId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("GET /tax-categories → empty after delete", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/tax-categories`, auth);
    expect(res.status).toBe(200);
    expect((res.json["categories"] as unknown[]).length).toBe(0);
  });

  it("DELETE /tax-categories/:id → 404 for non-existent", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/tax-categories/${randomUUID()}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── Tax zones + regions CRUD ────────────────────────────────────────────────────

describe("Tax zones CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let zoneId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /tax-zones → empty list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/tax-zones`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["zones"])).toBe(true);
    expect((res.json["zones"] as unknown[]).length).toBe(0);
  });

  it("POST /tax-zones → creates zone with regions", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones`,
      {
        name: "South Africa VAT",
        regions: [
          { country_code: "ZA" },
          { country_code: "ZA", province_code: "GP" },
        ],
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    zoneId = res.json["id"] as string;
  });

  it("GET /tax-zones → returns zone with regions attached", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/tax-zones`, auth);
    expect(res.status).toBe(200);
    const zones = res.json["zones"] as Record<string, unknown>[];
    expect(zones.length).toBe(1);
    const zone = zones[0]!;
    expect(zone["name"]).toBe("South Africa VAT");
    const regions = zone["regions"] as Record<string, unknown>[];
    expect(regions.length).toBe(2);
  });

  it("PUT /tax-zones/:id → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}`,
      { name: "South Africa VAT (Updated)" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("PUT /tax-zones/:id → replaces regions", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}`,
      { regions: [{ country_code: "ZA" }] },
      auth
    );
    expect(res.status).toBe(200);

    const listRes = await get(ctx, `/commerce/stores/${storeId}/tax-zones`, auth);
    const zones = listRes.json["zones"] as Record<string, unknown>[];
    const zone = zones.find((z) => z["id"] === zoneId);
    const regions = zone!["regions"] as Record<string, unknown>[];
    expect(regions.length).toBe(1);
  });

  it("DELETE /tax-zones/:id → removes zone", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });
});

// ── Tax rates CRUD ─────────────────────────────────────────────────────────────

describe("Tax rates CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let zoneId = "";
  let rateId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;

    const zRes = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones`,
      { name: "Rates Test Zone", regions: [{ country_code: "ZA" }] },
      auth
    );
    zoneId = zRes.json["id"] as string;
  });

  it("GET /tax-zones/:zoneId/rates → empty initially", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates`,
      auth
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["rates"])).toBe(true);
    expect((res.json["rates"] as unknown[]).length).toBe(0);
  });

  it("POST /tax-zones/:zoneId/rates → creates exclusive rate", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates`,
      {
        name: "South Africa VAT",
        rate_pct: 15.0,
        is_inclusive: false,
        is_active: true,
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    rateId = res.json["id"] as string;
  });

  it("GET /tax-zones/:zoneId/rates → 1 rate after create", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["rates"] as Record<string, unknown>[];
    expect(rates.length).toBe(1);
    expect(rates[0]!["name"]).toBe("South Africa VAT");
    expect(Number(rates[0]!["rate_pct"])).toBe(15);
  });

  it("PUT /tax-zones/:zoneId/rates/:rateId → updates rate_pct", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates/${rateId}`,
      { rate_pct: 20.0 },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("POST /tax-zones/:zoneId/rates → 400 on rate_pct > 100", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates`,
      { name: "Invalid", rate_pct: 150, is_active: true },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("POST /tax-zones/:zoneId/rates → 400 on rate_pct < 0", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates`,
      { name: "Negative", rate_pct: -5, is_active: true },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("DELETE /tax-zones/:zoneId/rates/:rateId → 200", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneId}/rates/${rateId}`,
      auth
    );
    expect(res.status).toBe(200);
  });
});

// ── Zone resolution + inclusive vs exclusive math (via calcTax) ──────────────

describe("Tax computation — zone resolution and math (lib/tax.ts)", () => {
  let storeId = "";
  let zoneIdZA = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    const auth = s.auth;

    // Create ZA national zone
    const zRes = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones`,
      { name: "ZA National", regions: [{ country_code: "ZA" }] },
      auth
    );
    zoneIdZA = zRes.json["id"] as string;

    // Add a 15% exclusive rate
    await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneIdZA}/rates`,
      { name: "VAT 15%", rate_pct: 15.0, is_inclusive: false, is_active: true },
      auth
    );

    // Add a 10% inclusive rate
    await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zoneIdZA}/rates`,
      { name: "Levy 10%", rate_pct: 10.0, is_inclusive: true, is_active: true },
      auth
    );
  });

  it("calcTax: no country → zero tax", async () => {
    const result = await calcTax(ctx.pool, storeId, 100, "", "");
    expect(result.taxTotal).toBe(0);
    expect(result.taxLines.length).toBe(0);
  });

  it("calcTax: ZA country match → finds rates", async () => {
    const result = await calcTax(ctx.pool, storeId, 100, "ZA", "");
    expect(result.taxLines.length).toBe(2);
  });

  it("calcTax: exclusive 15% on R100 → taxTotal=15.00", async () => {
    const result = await calcTax(ctx.pool, storeId, 100, "ZA", "");
    const vat = result.taxLines.find((l) => l.name === "VAT 15%");
    expect(vat).toBeDefined();
    expect(vat!.is_inclusive).toBe(false);
    expect(vat!.amount).toBeCloseTo(15.0, 2);
    // taxTotal only sums exclusive amounts
    expect(result.taxTotal).toBeCloseTo(15.0, 2);
  });

  it("calcTax: inclusive 10% on R100 → amount extracted (not in taxTotal)", async () => {
    const result = await calcTax(ctx.pool, storeId, 100, "ZA", "");
    const levy = result.taxLines.find((l) => l.name === "Levy 10%");
    expect(levy).toBeDefined();
    expect(levy!.is_inclusive).toBe(true);
    // inclusive: 100 - 100/(1 + 0.10) = 100 - 90.91 = 9.09
    expect(levy!.amount).toBeCloseTo(9.09, 1);
    // inclusive amount NOT in taxTotal
    expect(result.taxTotal).toBeCloseTo(15.0, 2); // only VAT 15%
  });

  it("calcTax: no match for US → zero tax", async () => {
    const result = await calcTax(ctx.pool, storeId, 100, "US", "");
    expect(result.taxTotal).toBe(0);
    expect(result.taxLines.length).toBe(0);
  });

  it("calcTax: province wildcard — ZA zone matches ZA+GP", async () => {
    // ZA national zone has no province restriction — should match ZA+GP
    const result = await calcTax(ctx.pool, storeId, 100, "ZA", "GP");
    expect(result.taxLines.length).toBe(2);
  });
});

// ── Inclusive vs exclusive: edge cases ────────────────────────────────────────

describe("Tax math — edge cases", () => {
  let storeId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    const auth = s.auth;

    // Single exclusive rate
    const zRes = await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones`,
      { name: "Edge Zone", regions: [{ country_code: "DE" }] },
      auth
    );
    const zId = zRes.json["id"] as string;
    await post(
      ctx,
      `/commerce/stores/${storeId}/tax-zones/${zId}/rates`,
      { name: "DE VAT", rate_pct: 19.0, is_inclusive: false, is_active: true },
      auth
    );
  });

  it("calcTax: 19% exclusive on R200 = R38", async () => {
    const result = await calcTax(ctx.pool, storeId, 200, "DE", "");
    const vat = result.taxLines.find((l) => l.name === "DE VAT");
    expect(vat).toBeDefined();
    expect(vat!.amount).toBeCloseTo(38.0, 2);
    expect(result.taxTotal).toBeCloseTo(38.0, 2);
  });

  it("calcTax: taxable=0 → tax=0", async () => {
    const result = await calcTax(ctx.pool, storeId, 0, "DE", "");
    expect(result.taxTotal).toBe(0);
    for (const line of result.taxLines) {
      expect(line.amount).toBe(0);
    }
  });
});
