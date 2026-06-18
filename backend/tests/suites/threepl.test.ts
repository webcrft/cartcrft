/**
 * threepl.test.ts — Wave 10 3PL / fulfillment-network adapter.
 *
 * Coverage:
 *  - 3PL provider CRUD over the REST routes (enable/configure/list/delete).
 *  - submitOrderToThreePl with an INJECTED fake connector: creates a
 *    threepl_fulfillments row with external_id + status + submitted_at, is
 *    idempotent (re-submit returns the existing row, no duplicate), and records
 *    last_error + status='error' on connector failure.
 *  - syncThreePlStatuses advances status + tracking from the connector.
 *  - ShipBobClient maps an order → request, sets Bearer auth + the right URL, and
 *    normalizes ShipBob status → the CartCrft enum (global fetch mocked — never
 *    hits ShipBob).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  put,
  post,
  del,
  mintJwt,
  insertStore,
} from "../shared/helpers.js";
import {
  submitOrderToThreePl,
  syncThreePlStatuses,
  upsertThreePlProvider,
} from "../../src/modules/threepl/service.js";
import type {
  FulfillmentProvider,
  FulfillmentContext,
  SubmitResult,
  StatusResult,
} from "../../src/modules/threepl/connector.js";
import {
  ShipBobClient,
  ShipBobAPIError,
  newShipBobClient,
  toShipBobOrder,
  normalizeShipBobStatus,
  extractShipBobStatus,
} from "../../src/providers/fulfillment/shipbob.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

async function setup() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

/** Insert an order with a shipping address + one shippable line (sku/qty). */
async function seedOrder(
  storeId: string,
  opts: { sku?: string; qty?: number } = {}
): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders
       (store_id, order_number, currency, subtotal, total, shipping_address)
     VALUES ($1::uuid, $2, 'USD', 10.00, 10.00, $3::jsonb)
     RETURNING id::text`,
    [
      storeId,
      `3PL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      JSON.stringify({
        name: "Ada Lovelace",
        address1: "1 Analytical Engine St",
        city: "London",
        province_code: "LDN",
        country_code: "GB",
        zip: "EC1A",
        email: "ada@example.com",
      }),
    ]
  );
  const orderId = rows[0]!.id;
  await ctx.pool.query(
    `INSERT INTO order_lines
       (order_id, title, sku, quantity, price, total, requires_shipping)
     VALUES ($1::uuid, $2, $3, $4, 10.00, 10.00, true)`,
    [orderId, "Widget", opts.sku ?? "SKU-1", opts.qty ?? 2]
  );
  return orderId;
}

// ── Provider CRUD ─────────────────────────────────────────────────────────────

describe("3PL provider CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /threepl/providers → empty list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/threepl/providers`, auth);
    expect(res.status).toBe(200);
    expect((res.json["providers"] as unknown[]).length).toBe(0);
  });

  it("PUT /threepl/providers/shipbob → creates + configures", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/threepl/providers/shipbob`,
      { is_active: true, config: { shipping_method: "Standard", access_token: "tok-1" } },
      auth
    );
    expect(res.status).toBe(200);
    const provider = res.json["provider"] as Record<string, unknown>;
    expect(provider["provider"]).toBe("shipbob");
    expect(provider["is_active"]).toBe(true);
    expect((provider["config"] as Record<string, unknown>)["shipping_method"]).toBe("Standard");
  });

  it("PUT again → updates (upsert, not duplicate)", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/threepl/providers/shipbob`,
      { is_active: false, config: { shipping_method: "Express" } },
      auth
    );
    expect(res.status).toBe(200);
    expect((res.json["provider"] as Record<string, unknown>)["is_active"]).toBe(false);

    const list = await get(ctx, `/commerce/stores/${storeId}/threepl/providers`, auth);
    expect((list.json["providers"] as unknown[]).length).toBe(1);
  });

  it("PUT unknown provider → 400", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/threepl/providers/not_a_3pl`,
      { is_active: true },
      auth
    );
    expect(res.status).toBe(400);
  });

  it("DELETE /threepl/providers/shipbob → removes it", async () => {
    const res = await del(ctx, `/commerce/stores/${storeId}/threepl/providers/shipbob`, auth);
    expect(res.status).toBe(200);
    const list = await get(ctx, `/commerce/stores/${storeId}/threepl/providers`, auth);
    expect((list.json["providers"] as unknown[]).length).toBe(0);
  });
});

// ── submitOrderToThreePl with an injected fake connector ────────────────────────

/** Records the context it saw + returns caller-supplied submit/status results. */
class FakeConnector implements FulfillmentProvider {
  submitCalls = 0;
  lastSubmitCtx: FulfillmentContext | null = null;
  constructor(
    private readonly submitResult: SubmitResult | (() => SubmitResult),
    private readonly statusResult: StatusResult = { status: "shipped" }
  ) {}
  async submit(ctx: FulfillmentContext): Promise<SubmitResult> {
    this.submitCalls++;
    this.lastSubmitCtx = ctx;
    return typeof this.submitResult === "function" ? this.submitResult() : this.submitResult;
  }
  async getStatus(): Promise<StatusResult> {
    return this.statusResult;
  }
  async cancel(): Promise<void> {
    /* no-op */
  }
}

describe("submitOrderToThreePl (injected connector)", () => {
  it("creates a fulfillment row with external_id + status + submitted_at", async () => {
    const s = await setup();
    const storeId = s.store.id;
    await upsertThreePlProvider(storeId, {
      provider: "shipbob",
      is_active: true,
      config: { access_token: "tok-1", shipping_method: "Standard" },
    });
    const orderId = await seedOrder(storeId);

    const connector = new FakeConnector({
      externalId: "sb-12345",
      status: "submitted",
    });

    const outcome = await submitOrderToThreePl(storeId, orderId, "shipbob", { connector });
    expect(outcome.alreadySubmitted).toBe(false);
    expect(outcome.fulfillment.external_id).toBe("sb-12345");
    expect(outcome.fulfillment.status).toBe("submitted");
    expect(outcome.fulfillment.submitted_at).not.toBeNull();

    // Connector received the order view (recipient + sku lines).
    expect(connector.lastSubmitCtx?.order?.recipientName).toBe("Ada Lovelace");
    expect(connector.lastSubmitCtx?.order?.lines).toEqual([{ sku: "SKU-1", quantity: 2 }]);
    expect(connector.lastSubmitCtx?.accessToken).toBe("tok-1");

    // Persisted row.
    const rows = await ctx.pool.query(
      `SELECT external_id, status FROM threepl_fulfillments
       WHERE store_id = $1::uuid AND order_id = $2::uuid`,
      [storeId, orderId]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].external_id).toBe("sb-12345");
  });

  it("is idempotent — re-submit returns the existing row, no duplicate, no second call", async () => {
    const s = await setup();
    const storeId = s.store.id;
    await upsertThreePlProvider(storeId, {
      provider: "shipbob",
      is_active: true,
      config: { access_token: "tok-1" },
    });
    const orderId = await seedOrder(storeId);

    const connector = new FakeConnector({ externalId: "sb-1", status: "submitted" });
    await submitOrderToThreePl(storeId, orderId, "shipbob", { connector });

    const second = await submitOrderToThreePl(storeId, orderId, "shipbob", { connector });
    expect(second.alreadySubmitted).toBe(true);
    expect(second.fulfillment.external_id).toBe("sb-1");
    // Connector.submit was NOT called a second time.
    expect(connector.submitCalls).toBe(1);

    const rows = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM threepl_fulfillments
       WHERE store_id = $1::uuid AND order_id = $2::uuid`,
      [storeId, orderId]
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("records last_error + status='error' on connector failure (never throws)", async () => {
    const s = await setup();
    const storeId = s.store.id;
    await upsertThreePlProvider(storeId, {
      provider: "shipbob",
      is_active: true,
      config: { access_token: "tok-1" },
    });
    const orderId = await seedOrder(storeId);

    const connector = new FakeConnector(() => {
      throw new Error("shipbob: status 500: boom");
    });

    const outcome = await submitOrderToThreePl(storeId, orderId, "shipbob", { connector });
    expect(outcome.fulfillment.status).toBe("error");
    expect(outcome.fulfillment.last_error).toContain("boom");
    expect(outcome.fulfillment.external_id).toBeNull();
    expect(outcome.fulfillment.submitted_at).toBeNull();
  });

  it("throws NOT_FOUND when provider not configured", async () => {
    const s = await setup();
    const orderId = await seedOrder(s.store.id);
    await expect(
      submitOrderToThreePl(s.store.id, orderId, "shipbob", {
        connector: new FakeConnector({ externalId: "x", status: "submitted" }),
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ── syncThreePlStatuses ─────────────────────────────────────────────────────────

describe("syncThreePlStatuses (injected connector)", () => {
  it("advances status + tracking from the connector", async () => {
    const s = await setup();
    const storeId = s.store.id;
    await upsertThreePlProvider(storeId, {
      provider: "shipbob",
      is_active: true,
      config: { access_token: "tok-1" },
    });
    const orderId = await seedOrder(storeId);

    // Submit first → "submitted".
    const submitConnector = new FakeConnector({ externalId: "sb-9", status: "submitted" });
    await submitOrderToThreePl(storeId, orderId, "shipbob", { connector: submitConnector });

    // Sync: connector now reports shipped + tracking.
    const statusConnector = new FakeConnector(
      { externalId: "sb-9", status: "submitted" },
      { status: "shipped", trackingNumber: "1Z999", trackingUrl: "https://track/1Z999" }
    );
    const advanced = await syncThreePlStatuses(storeId, { connector: statusConnector });
    expect(advanced).toBe(1);

    const rows = await ctx.pool.query(
      `SELECT status, tracking_number, tracking_url, last_synced_at
       FROM threepl_fulfillments WHERE store_id = $1::uuid AND order_id = $2::uuid`,
      [storeId, orderId]
    );
    expect(rows.rows[0].status).toBe("shipped");
    expect(rows.rows[0].tracking_number).toBe("1Z999");
    expect(rows.rows[0].tracking_url).toBe("https://track/1Z999");
    expect(rows.rows[0].last_synced_at).not.toBeNull();
  });
});

// ── ShipBobClient — mapping + fetch (mocked) ────────────────────────────────────

interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  responseBody: unknown,
  opts: { status?: number } = {}
): { calls: StubCall[] } {
  const status = opts.status ?? 200;
  const calls: StubCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status < 400,
      status,
      text: async () =>
        typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
      json: async () => responseBody,
    } as unknown as Response;
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShipBobClient", () => {
  it("toShipBobOrder maps a CartCrft order → ShipBob request", () => {
    const req = toShipBobOrder({
      referenceId: "ord-1",
      orderNumber: "1001",
      recipientName: "Ada Lovelace",
      address1: "1 Engine St",
      address2: "Suite 7",
      city: "London",
      state: "LDN",
      country: "GB",
      zip: "EC1A",
      email: "ada@example.com",
      shippingMethod: "Standard",
      lines: [{ sku: "SKU-1", quantity: 2 }, { sku: "SKU-2", quantity: 1 }],
    });
    expect(req.reference_id).toBe("ord-1");
    expect(req.order_number).toBe("1001");
    expect(req.recipient.name).toBe("Ada Lovelace");
    expect(req.recipient.address.address1).toBe("1 Engine St");
    expect(req.recipient.address.address2).toBe("Suite 7");
    expect(req.recipient.address.zip_code).toBe("EC1A");
    expect(req.recipient.email).toBe("ada@example.com");
    expect(req.shipping_method).toBe("Standard");
    expect(req.products).toEqual([
      { reference_id: "SKU-1", quantity: 2 },
      { reference_id: "SKU-2", quantity: 1 },
    ]);
  });

  it("normalizeShipBobStatus maps raw ShipBob statuses → the CartCrft enum", () => {
    expect(normalizeShipBobStatus("Processing")).toBe("processing");
    expect(normalizeShipBobStatus("Completed")).toBe("shipped");
    expect(normalizeShipBobStatus("Fulfilled")).toBe("shipped");
    expect(normalizeShipBobStatus("Delivered")).toBe("delivered");
    expect(normalizeShipBobStatus("Cancelled")).toBe("cancelled");
    expect(normalizeShipBobStatus("Exception")).toBe("exception");
    expect(normalizeShipBobStatus("")).toBe("submitted");
    expect(normalizeShipBobStatus("something-weird")).toBe("processing");
  });

  it("extractShipBobStatus prefers the shipment status + tracking", () => {
    const out = extractShipBobStatus({
      id: 5,
      status: "Processing",
      shipments: [
        {
          id: 9,
          status: "Completed",
          tracking: { tracking_number: "TN1", tracking_url: "https://t/TN1" },
        },
      ],
    });
    expect(out.status).toBe("shipped");
    expect(out.trackingNumber).toBe("TN1");
    expect(out.trackingUrl).toBe("https://t/TN1");
  });

  it("createFulfillmentOrder POSTs to /order with Bearer auth", async () => {
    const { calls } = stubFetch({ id: 777, status: "Processing" });
    const client = newShipBobClient("tok-abc");
    const res = await client.createFulfillmentOrder(
      toShipBobOrder({
        referenceId: "ord-1",
        recipientName: "Ada",
        address1: "1 St",
        city: "London",
        state: "LDN",
        country: "GB",
        zip: "EC1A",
        lines: [{ sku: "SKU-1", quantity: 1 }],
      })
    );
    expect(res.id).toBe(777);
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.shipbob.com/1.0/order");
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call.init?.body)).reference_id).toBe("ord-1");
  });

  it("getFulfillmentStatus GETs /order/{id}", async () => {
    const { calls } = stubFetch({ id: 777, status: "Completed" });
    const client = newShipBobClient("tok-abc");
    const res = await client.getFulfillmentStatus("777");
    expect(res.status).toBe("Completed");
    expect(calls[0]!.url).toBe("https://api.shipbob.com/1.0/order/777");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  it("cancelFulfillmentOrder POSTs /order/{id}/cancel", async () => {
    const { calls } = stubFetch("", { status: 204 });
    const client = newShipBobClient("tok-abc");
    await client.cancelFulfillmentOrder("777");
    expect(calls[0]!.url).toBe("https://api.shipbob.com/1.0/order/777/cancel");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  it("throws ShipBobAPIError on a 4xx", async () => {
    stubFetch("forbidden", { status: 403 });
    const client = new ShipBobClient("tok");
    await expect(client.getFulfillmentStatus("1")).rejects.toBeInstanceOf(ShipBobAPIError);
  });
});
