/**
 * shipping.test.ts — Shipping management suite.
 *
 * Covers:
 *  - Shipping zones + regions CRUD
 *  - Static rates CRUD
 *  - Available rates: zone matching (country, province specificity), weight/total bounds
 *  - Shipping providers CRUD
 *  - Collection points CRUD
 *  - Shipment lifecycle: create, update status, tracking events
 *  - Carrier tracking push webhook (no auth / HMAC-based)
 *  - Fulfillment orders CRUD
 *
 * Note: BobGo live-rate merging is tested at service level; HTTP tests focus
 * on the static-rate path to avoid network dependencies.
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
  insertProduct,
  insertVariant,
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
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

// Insert a minimal order (needed for shipments)
async function insertOrder(storeId: string) {
  const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders (store_id, order_number, currency, subtotal, total)
     VALUES ($1::uuid, $2, 'ZAR', 0, 0)
     RETURNING id::text`,
    [storeId, orderNumber]
  );
  return rows[0]!.id;
}

// ── Shipping zones CRUD ────────────────────────────────────────────────────────

describe("Shipping zones CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let zoneId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /shipping-zones → empty list for new store", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/shipping-zones`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["zones"])).toBe(true);
    expect((res.json["zones"] as unknown[]).length).toBe(0);
  });

  it("POST /shipping-zones → creates zone with regions", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones`,
      {
        name: "South Africa",
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

  it("GET /shipping-zones → returns zone with regions", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/shipping-zones`, auth);
    expect(res.status).toBe(200);
    const zones = res.json["zones"] as Record<string, unknown>[];
    expect(zones.length).toBe(1);
    const zone = zones[0]!;
    expect(zone["name"]).toBe("South Africa");
    const regions = zone["regions"] as Record<string, unknown>[];
    expect(regions.length).toBe(2);
  });

  it("PUT /shipping-zones/:id → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zoneId}`,
      { name: "South Africa Updated" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("PUT /shipping-zones/:id → replaces regions", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zoneId}`,
      {
        regions: [{ country_code: "ZA" }, { country_code: "LS" }],
      },
      auth
    );
    expect(res.status).toBe(200);

    const listRes = await get(ctx, `/commerce/stores/${storeId}/shipping-zones`, auth);
    const zones = listRes.json["zones"] as Record<string, unknown>[];
    const zone = zones.find((z) => z["id"] === zoneId);
    const regions = zone!["regions"] as Record<string, unknown>[];
    expect(regions.length).toBe(2);
    const codes = regions.map((r) => r["country_code"]);
    expect(codes).toContain("ZA");
    expect(codes).toContain("LS");
  });

  it("DELETE /shipping-zones/:id → removes zone", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zoneId}`,
      auth
    );
    expect(res.status).toBe(200);
  });
});

// ── Static shipping rates CRUD ─────────────────────────────────────────────────

describe("Static shipping rates CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let zoneId = "";
  let rateId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;

    const zoneRes = await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones`,
      { name: "Test Zone", regions: [{ country_code: "ZA" }] },
      auth
    );
    zoneId = zoneRes.json["id"] as string;
  });

  it("GET /shipping-zones/:zoneId/rates → empty initially", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zoneId}/rates`,
      auth
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["shipping_rates"])).toBe(true);
    expect((res.json["shipping_rates"] as unknown[]).length).toBe(0);
  });

  it("POST /shipping-zones/:zoneId/rates → creates rate", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zoneId}/rates`,
      {
        name: "Standard Shipping",
        price: 79,
        min_weight_g: 0,
        max_weight_g: 5000,
        is_active: true,
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    rateId = res.json["id"] as string;
  });

  it("PUT /shipping-zones/:zoneId/rates/:rateId → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zoneId}/rates/${rateId}`,
      { name: "Updated Rate" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /shipping-zones/:zoneId/rates/:rateId → 200", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zoneId}/rates/${rateId}`,
      auth
    );
    expect(res.status).toBe(200);
  });
});

// ── Available rates — zone matching ───────────────────────────────────────────

describe("Available rates — zone matching", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;

    // Zone 1: ZA (all provinces)
    const z1Res = await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones`,
      { name: "ZA National", regions: [{ country_code: "ZA" }] },
      auth
    );
    const z1Id = z1Res.json["id"] as string;
    await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${z1Id}/rates`,
      { name: "National Standard", price: 80, is_active: true },
      auth
    );

    // Zone 2: ZA:GP (province-specific)
    const z2Res = await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones`,
      { name: "ZA Gauteng", regions: [{ country_code: "ZA", province_code: "GP" }] },
      auth
    );
    const z2Id = z2Res.json["id"] as string;
    await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${z2Id}/rates`,
      { name: "Gauteng Express", price: 50, is_active: true },
      auth
    );

    // Zone 3: UK (different country)
    const z3Res = await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones`,
      { name: "UK", regions: [{ country_code: "GB" }] },
      auth
    );
    const z3Id = z3Res.json["id"] as string;
    await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${z3Id}/rates`,
      { name: "UK Standard", price: 200, is_active: true },
      auth
    );
  });

  it("country match: ZA → returns ZA rates only", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-rates/available?country_code=ZA`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["shipping_rates"] as Record<string, unknown>[];
    const names = rates.map((r) => r["name"]);
    expect(names).toContain("National Standard");
    expect(names).not.toContain("UK Standard");
  });

  it("province specificity: ZA+GP → returns both national and GP-specific rates", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-rates/available?country_code=ZA&province_code=GP`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["shipping_rates"] as Record<string, unknown>[];
    const names = rates.map((r) => r["name"]);
    expect(names).toContain("National Standard");
    expect(names).toContain("Gauteng Express");
  });

  it("province specificity: ZA+WC → returns only national (no WC-specific zone)", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-rates/available?country_code=ZA&province_code=WC`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["shipping_rates"] as Record<string, unknown>[];
    const names = rates.map((r) => r["name"]);
    expect(names).toContain("National Standard");
    expect(names).not.toContain("Gauteng Express");
  });

  it("no match: US → empty list", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-rates/available?country_code=US`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["shipping_rates"] as Record<string, unknown>[];
    expect(rates.length).toBe(0);
  });
});

// ── Available rates — weight/total bounds ─────────────────────────────────────

describe("Available rates — weight and order-total bounds", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;

    const zRes = await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones`,
      { name: "Bounds Test Zone", regions: [{ country_code: "ZA" }] },
      auth
    );
    const zId = zRes.json["id"] as string;

    // Light rate: up to 1kg
    await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zId}/rates`,
      { name: "Light", price: 30, min_weight_g: 0, max_weight_g: 1000, is_active: true },
      auth
    );
    // Heavy rate: 1kg–5kg
    await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zId}/rates`,
      { name: "Heavy", price: 80, min_weight_g: 1001, max_weight_g: 5000, is_active: true },
      auth
    );
    // Free shipping: min order total R500
    await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-zones/${zId}/rates`,
      { name: "Free Shipping", price: 0, min_order_total: 500, is_active: true },
      auth
    );
  });

  it("weight=500g → only Light rate returned", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-rates/available?country_code=ZA&weight_g=500`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["shipping_rates"] as Record<string, unknown>[];
    const names = rates.map((r) => r["name"]);
    expect(names).toContain("Light");
    expect(names).not.toContain("Heavy");
  });

  it("weight=2000g → only Heavy rate returned", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-rates/available?country_code=ZA&weight_g=2000`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["shipping_rates"] as Record<string, unknown>[];
    const names = rates.map((r) => r["name"]);
    expect(names).not.toContain("Light");
    expect(names).toContain("Heavy");
  });

  it("order_total=600 → Free Shipping included", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-rates/available?country_code=ZA&order_total=600`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["shipping_rates"] as Record<string, unknown>[];
    const names = rates.map((r) => r["name"]);
    expect(names).toContain("Free Shipping");
  });

  it("order_total=100 → Free Shipping NOT included", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/shipping-rates/available?country_code=ZA&order_total=100`,
      auth
    );
    expect(res.status).toBe(200);
    const rates = res.json["shipping_rates"] as Record<string, unknown>[];
    const names = rates.map((r) => r["name"]);
    expect(names).not.toContain("Free Shipping");
  });
});

// ── Shipping providers CRUD ────────────────────────────────────────────────────

describe("Shipping providers CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let providerId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /shipping-providers → empty list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/shipping-providers`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["providers"])).toBe(true);
  });

  it("POST /shipping-providers → creates provider", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/shipping-providers`,
      {
        name: "BobGo SA",
        type: "webhook",
        is_active: true,
        config: { provider: "bobgo", api_key: "test-api-key" },
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    providerId = res.json["id"] as string;
  });

  it("GET /shipping-providers → 1 result", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/shipping-providers`, auth);
    expect(res.status).toBe(200);
    const providers = res.json["providers"] as Record<string, unknown>[];
    expect(providers.some((p) => p["id"] === providerId)).toBe(true);
  });

  it("DELETE /shipping-providers/:id → 200", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/shipping-providers/${providerId}`,
      auth
    );
    expect(res.status).toBe(200);
  });
});

// ── Collection points CRUD ─────────────────────────────────────────────────────

describe("Collection points CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let pointId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /collection-points → empty list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/collection-points`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["points"])).toBe(true);
  });

  it("POST /collection-points → creates point", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/collection-points`,
      {
        name: "Cape Town CBD",
        country_code: "ZA",
        city: "Cape Town",
        is_active: true,
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    pointId = res.json["id"] as string;
  });

  it("PUT /collection-points/:id → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/collection-points/${pointId}`,
      { name: "Cape Town CBD Updated" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /collection-points/:id → 200", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/collection-points/${pointId}`,
      auth
    );
    expect(res.status).toBe(200);
  });
});

// ── Shipment lifecycle ─────────────────────────────────────────────────────────

describe("Shipment lifecycle", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let orderId = "";
  let shipmentId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
    orderId = await insertOrder(storeId);
  });

  it("GET /orders/:orderId/shipments → empty list", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/shipments`,
      auth
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["shipments"])).toBe(true);
    expect((res.json["shipments"] as unknown[]).length).toBe(0);
  });

  it("POST /orders/:orderId/shipments → creates shipment", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/shipments`,
      {
        carrier: "DHL",
        tracking_number: "1234567890",
        status: "pending",
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    shipmentId = res.json["id"] as string;
  });

  it("GET /orders/:orderId/shipments → 1 shipment", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/shipments`,
      auth
    );
    expect(res.status).toBe(200);
    expect((res.json["shipments"] as unknown[]).length).toBe(1);
  });

  it("PUT /orders/:orderId/shipments/:id → update status to dispatched", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/shipments/${shipmentId}`,
      { status: "dispatched" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("GET /orders/:orderId/shipments/:id/tracking → returns tracking events list", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/shipments/${shipmentId}/tracking`,
      auth
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["events"])).toBe(true);
  });

  it("POST /webhooks/:storeId/tracking/:shipmentId → accepts carrier push (no auth)", async () => {
    const res = await ctx.request({
      method: "POST",
      path: `/webhooks/${storeId}/tracking/${shipmentId}`,
      body: {
        status: "in_transit",
        location: "Johannesburg Hub",
        description: "Package arrived at sorting facility",
        timestamp: new Date().toISOString(),
      },
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(typeof res.json["id"]).toBe("string");
  });

  it("GET /orders/:orderId/shipments/:id/tracking → tracking event appears after push", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/shipments/${shipmentId}/tracking`,
      auth
    );
    expect(res.status).toBe(200);
    const events = res.json["events"] as Record<string, unknown>[];
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Fulfillment orders CRUD ────────────────────────────────────────────────────

describe("Fulfillment orders CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let orderId = "";
  let foId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
    orderId = await insertOrder(storeId);
  });

  it("GET /orders/:orderId/fulfillment-orders → empty list", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/fulfillment-orders`,
      auth
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["fulfillment_orders"])).toBe(true);
  });

  it("POST /orders/:orderId/fulfillment-orders → creates FO", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/fulfillment-orders`,
      {
        status: "open",
        lines: [],
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    foId = res.json["id"] as string;
  });

  it("PUT /fulfillment-orders/:foId → update status to in_progress", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/fulfillment-orders/${foId}`,
      { status: "in_progress" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });
});
