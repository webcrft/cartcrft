/**
 * return-labels.test.ts — Wave 14: prepaid RETURN shipping labels via Shippo.
 *
 * The Shippo client is INJECTED via deps (generateReturnLabel's deps.makeShippoClient),
 * so no test touches the real Shippo API. Covers:
 *  - an approved return generates + stores a label (label_url + tracking + carrier)
 *  - a second call is idempotent (no second purchase; already_existed=true)
 *  - a non-approved (requested) return is rejected with INVALID_STATE
 *  - missing api_key / warehouse → coded errors (NO_PROVIDER / NO_WAREHOUSE)
 *  - the POST .../label route surfaces the label and the GET exposes the fields
 *  - a unit test that the real ShippoClient.purchaseLabel POSTs to /transactions/
 *    with the rate id + Bearer ShippoToken header (global fetch mocked)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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
import {
  generateReturnLabel,
  ReturnLabelError,
} from "../../src/modules/returns/service.js";
import type {
  ShippoClient,
  ShippoRate,
  ShippoTransaction,
  ShippoShipmentRequest,
} from "../../src/providers/shipping/shippo.js";
import { ShippoClient as RealShippoClient } from "../../src/providers/shipping/shippo.js";

let ctx: TestCtx;
let orgId: string;
let storeId: string;
let authHeader: Record<string, string>;

const userId = "00000000-0000-0000-0000-000000000004";

beforeAll(async () => {
  ctx = await createCtx();
  const org = await insertOrg(ctx.pool, { name: "Return Labels Org" });
  orgId = org.id;
  const jwt = await mintJwt({ userId, orgId });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, {
    orgId,
    name: "Return Labels Store",
    slug: `return-labels-${Date.now()}`,
  });
  storeId = store.id;
});

afterAll(async () => {
  await ctx.teardown();
});

const base = () => `/commerce/stores/${storeId}`;

// ── Fake injectable Shippo client ──────────────────────────────────────────────

interface FakeCounters {
  getRates: number;
  purchaseLabel: number;
  lastRateId?: string;
}

function makeFakeShippo(counters: FakeCounters): (apiKey: string) => ShippoClient {
  const rates: ShippoRate[] = [
    {
      object_id: "rate_expensive",
      amount: "12.00",
      currency: "USD",
      provider: "FedEx",
      servicelevel: { name: "Ground", token: "fedex_ground" },
    },
    {
      object_id: "rate_cheap",
      amount: "4.25",
      currency: "USD",
      provider: "USPS",
      servicelevel: { name: "Priority", token: "usps_priority" },
    },
  ];
  const txn: ShippoTransaction = {
    object_id: "txn_fake",
    status: "SUCCESS",
    tracking_number: "RTN-TRACK-123",
    tracking_url_provider: "https://track.example/RTN-TRACK-123",
    label_url: "https://shippo.example/return-label.pdf",
    rate: "rate_cheap",
  };
  const fake: ShippoClient = {
    async getRates(_req: ShippoShipmentRequest) {
      counters.getRates += 1;
      return rates;
    },
    async purchaseLabel(rateObjectId: string) {
      counters.purchaseLabel += 1;
      counters.lastRateId = rateObjectId;
      return txn;
    },
    async getTransaction() {
      return txn;
    },
  } as unknown as ShippoClient;
  return () => fake;
}

/**
 * Set up a store with a default warehouse, an active shippo provider, and an
 * approved return whose order has a customer shipping_address. Returns the
 * returnId + a handle to remove/clear the provider/warehouse for negative cases.
 */
async function seedApprovedReturn(opts: {
  withProvider?: boolean;
  apiKey?: string | null;
  withWarehouse?: boolean;
}): Promise<{ returnId: string; orderId: string }> {
  const product = await insertProduct(ctx.pool, { storeId, title: "Label Item" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, price: "30.00" });
  const customer = await insertCustomer(ctx.pool, {
    storeId,
    email: `lbl${Date.now()}-${Math.random().toString(36).slice(2)}@test.example.com`,
  });

  const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders
       (store_id, customer_id, order_number, status, financial_status, fulfillment_status,
        currency, subtotal, total, shipping_address)
     VALUES ($1::uuid, $2::uuid, $3, 'open', 'paid', 'fulfilled', 'USD', 30.00, 30.00, $4::jsonb)
     RETURNING id::text`,
    [
      storeId,
      customer.id,
      `LBL-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      JSON.stringify({
        name: "Jane Buyer",
        address1: "742 Evergreen Terrace",
        city: "Springfield",
        province_code: "IL",
        zip: "62704",
        country_code: "US",
        phone: "+15551234567",
        email: "jane@example.com",
      }),
    ]
  );
  const orderId = orderRows[0]!.id;

  const { rows: lineRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO order_lines (order_id, variant_id, title, quantity, price, total)
     VALUES ($1::uuid, $2::uuid, 'Label Item', 1, 30.00, 30.00) RETURNING id::text`,
    [orderId, variant.id]
  );
  const orderLineId = lineRows[0]!.id;

  // Create return via the API and approve it.
  const createRes = await ctx.request({
    method: "POST",
    path: `${base()}/orders/${orderId}/returns`,
    headers: authHeader,
    body: { return_type: "refund", lines: [{ order_line_id: orderLineId, quantity: 1 }] },
  });
  const returnId = (createRes.json as { id: string }).id;
  await ctx.request({
    method: "PUT",
    path: `${base()}/returns/${returnId}`,
    headers: authHeader,
    body: { status: "approved" },
  });

  // Default warehouse.
  if (opts.withWarehouse !== false) {
    await ctx.pool.query(
      `INSERT INTO warehouses (store_id, name, is_default, address)
       VALUES ($1::uuid, 'Returns WH', true, $2::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        storeId,
        JSON.stringify({
          name: "Returns WH",
          street_address: "1 Dock St",
          city: "Memphis",
          province_code: "TN",
          postal_code: "38103",
          country_code: "US",
        }),
      ]
    );
  }

  // Active shippo provider.
  if (opts.withProvider !== false) {
    const apiKey = opts.apiKey === undefined ? "shippo_test_key" : opts.apiKey;
    await ctx.pool.query(
      `INSERT INTO shipping_providers (store_id, name, type, config, is_active)
       VALUES ($1::uuid, 'Shippo', 'webhook', $2::jsonb, true)`,
      [storeId, JSON.stringify(apiKey ? { provider: "shippo", api_key: apiKey } : { provider: "shippo" })]
    );
  }

  return { returnId, orderId };
}

async function clearProviders() {
  await ctx.pool.query(`DELETE FROM shipping_providers WHERE store_id = $1::uuid`, [storeId]);
}
async function clearWarehouses() {
  await ctx.pool.query(`DELETE FROM warehouses WHERE store_id = $1::uuid`, [storeId]);
}

afterEach(async () => {
  // Reset shared store-level fixtures between cases.
  await clearProviders();
  await clearWarehouses();
});

// ── Service-level tests with injected fake client ──────────────────────────────

describe("generateReturnLabel (injected Shippo client)", () => {
  it("generates and stores a label for an approved return; picks cheapest rate", async () => {
    const counters: FakeCounters = { getRates: 0, purchaseLabel: 0 };
    const { returnId } = await seedApprovedReturn({});

    const label = await generateReturnLabel(storeId, returnId, {
      makeShippoClient: makeFakeShippo(counters),
    });

    expect(label.already_existed).toBe(false);
    expect(label.return_label_url).toBe("https://shippo.example/return-label.pdf");
    expect(label.return_tracking_number).toBe("RTN-TRACK-123");
    expect(label.return_carrier).toBe("USPS"); // cheapest rate provider
    expect(counters.getRates).toBe(1);
    expect(counters.purchaseLabel).toBe(1);
    expect(counters.lastRateId).toBe("rate_cheap");

    // Persisted on the return.
    const { rows } = await ctx.pool.query<{
      return_label_url: string;
      return_tracking_number: string;
      return_carrier: string;
      return_label_purchased_at: Date | null;
    }>(
      `SELECT return_label_url, return_tracking_number, return_carrier, return_label_purchased_at
       FROM return_requests WHERE id = $1::uuid`,
      [returnId]
    );
    expect(rows[0]?.return_label_url).toBe("https://shippo.example/return-label.pdf");
    expect(rows[0]?.return_tracking_number).toBe("RTN-TRACK-123");
    expect(rows[0]?.return_carrier).toBe("USPS");
    expect(rows[0]?.return_label_purchased_at).not.toBeNull();
  });

  it("is idempotent: a second call returns the existing label without re-purchasing", async () => {
    const counters: FakeCounters = { getRates: 0, purchaseLabel: 0 };
    const { returnId } = await seedApprovedReturn({});
    const deps = { makeShippoClient: makeFakeShippo(counters) };

    const first = await generateReturnLabel(storeId, returnId, deps);
    const second = await generateReturnLabel(storeId, returnId, deps);

    expect(first.already_existed).toBe(false);
    expect(second.already_existed).toBe(true);
    expect(second.return_label_url).toBe(first.return_label_url);
    expect(second.return_tracking_number).toBe(first.return_tracking_number);
    // Only ONE purchase total across both calls.
    expect(counters.purchaseLabel).toBe(1);
    expect(counters.getRates).toBe(1);
  });

  it("rejects a non-approved (requested) return with INVALID_STATE", async () => {
    const counters: FakeCounters = { getRates: 0, purchaseLabel: 0 };
    const { returnId } = await seedApprovedReturn({});
    // Roll back to 'requested' to make it ineligible.
    await ctx.pool.query(
      `UPDATE return_requests SET status = 'requested' WHERE id = $1::uuid`,
      [returnId]
    );

    await expect(
      generateReturnLabel(storeId, returnId, { makeShippoClient: makeFakeShippo(counters) })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(counters.purchaseLabel).toBe(0);
  });

  it("errors clearly when no shippo provider / api_key is configured (NO_PROVIDER)", async () => {
    const counters: FakeCounters = { getRates: 0, purchaseLabel: 0 };
    // No provider at all.
    const { returnId } = await seedApprovedReturn({ withProvider: false });

    await expect(
      generateReturnLabel(storeId, returnId, { makeShippoClient: makeFakeShippo(counters) })
    ).rejects.toMatchObject({ code: "NO_PROVIDER" });

    // Provider present but missing api_key.
    await ctx.pool.query(
      `INSERT INTO shipping_providers (store_id, name, type, config, is_active)
       VALUES ($1::uuid, 'Shippo', 'webhook', $2::jsonb, true)`,
      [storeId, JSON.stringify({ provider: "shippo" })]
    );
    await expect(
      generateReturnLabel(storeId, returnId, { makeShippoClient: makeFakeShippo(counters) })
    ).rejects.toMatchObject({ code: "NO_PROVIDER" });
    expect(counters.purchaseLabel).toBe(0);
  });

  it("errors clearly when no default warehouse is configured (NO_WAREHOUSE)", async () => {
    const counters: FakeCounters = { getRates: 0, purchaseLabel: 0 };
    const { returnId } = await seedApprovedReturn({ withWarehouse: false });

    await expect(
      generateReturnLabel(storeId, returnId, { makeShippoClient: makeFakeShippo(counters) })
    ).rejects.toBeInstanceOf(ReturnLabelError);
    await expect(
      generateReturnLabel(storeId, returnId, { makeShippoClient: makeFakeShippo(counters) })
    ).rejects.toMatchObject({ code: "NO_WAREHOUSE" });
    expect(counters.purchaseLabel).toBe(0);
  });
});

// ── Route + read surface (real route path; provider seeded but rejected pre-Shippo) ─

describe("returns label route + read surface", () => {
  it("the GET return exposes the label fields", async () => {
    const counters: FakeCounters = { getRates: 0, purchaseLabel: 0 };
    const { returnId } = await seedApprovedReturn({});
    await generateReturnLabel(storeId, returnId, {
      makeShippoClient: makeFakeShippo(counters),
    });

    const getRes = await ctx.request({
      method: "GET",
      path: `${base()}/returns/${returnId}`,
      headers: authHeader,
    });
    expect(getRes.status).toBe(200);
    const ret = getRes.json as {
      return_label_url: string | null;
      return_tracking_number: string | null;
      return_carrier: string | null;
    };
    expect(ret.return_label_url).toBe("https://shippo.example/return-label.pdf");
    expect(ret.return_tracking_number).toBe("RTN-TRACK-123");
    expect(ret.return_carrier).toBe("USPS");
  });

  it("POST .../label returns 409 for a non-approved return via the route", async () => {
    const { returnId } = await seedApprovedReturn({});
    await ctx.pool.query(
      `UPDATE return_requests SET status = 'requested' WHERE id = $1::uuid`,
      [returnId]
    );
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/returns/${returnId}/label`,
      headers: authHeader,
    });
    expect(res.status).toBe(409);
    expect((res.json as { error: { code: string } }).error.code).toBe("INVALID_STATE");
  });

  it("POST .../label returns 422 when no provider configured", async () => {
    const { returnId } = await seedApprovedReturn({ withProvider: false });
    const res = await ctx.request({
      method: "POST",
      path: `${base()}/returns/${returnId}/label`,
      headers: authHeader,
    });
    expect(res.status).toBe(422);
    expect((res.json as { error: { code: string } }).error.code).toBe("NO_PROVIDER");
  });
});

// ── Unit test: real ShippoClient.purchaseLabel POSTs to /transactions/ ─────────

describe("ShippoClient.purchaseLabel (real client, mocked fetch)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /transactions/ with the rate id and ShippoToken auth", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as URL).toString();
      calls.push({ url: urlStr, init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            object_id: "txn_real",
            status: "SUCCESS",
            tracking_number: "T-REAL",
            tracking_url_provider: "",
            label_url: "https://shippo.example/l.pdf",
            rate: "rate_cheap",
          }),
      } as unknown as Response;
    });

    const client = new RealShippoClient("ShippoTokenValue");
    const txn = await client.purchaseLabel("rate_cheap");

    expect(txn.object_id).toBe("txn_real");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.goshippo.com/transactions/");
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.rate).toBe("rate_cheap");
    expect(body.async).toBe(false);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("ShippoToken ShippoTokenValue");
  });
});
