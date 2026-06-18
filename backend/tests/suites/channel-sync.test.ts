/**
 * channel-sync.test.ts — Wave 9 outbound channel sync.
 *
 * Coverage:
 *  - Channel CRUD over the REST routes (enable/configure/list/items).
 *  - runChannelSync with an INJECTED fake connector: pushes the store's products,
 *    records channel_sync_items synced + external_id, marks errors on connector
 *    failure, and is idempotent (re-run updates, never duplicates).
 *  - GoogleShoppingClient maps a product → Content API resource correctly + sets
 *    Bearer auth + posts to the right URL (global fetch mocked — never hits Google).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  put,
  post,
  mintJwt,
  insertStore,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";
import { runChannelSync } from "../../src/modules/channels/service.js";
import type {
  ChannelConnector,
  SyncContext,
  ProductSyncOutcome,
} from "../../src/modules/channels/connector.js";
import {
  GoogleShoppingClient,
  GoogleShoppingAPIError,
  newGoogleShoppingClient,
  toContentProduct,
} from "../../src/providers/channels/google-shopping.js";

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

async function seedProduct(storeId: string, opts: { price?: string } = {}) {
  const product = await insertProduct(ctx.pool, { storeId });
  // The feed/channel query only includes active products.
  await ctx.pool.query(
    `UPDATE products SET status = 'active' WHERE id = $1::uuid`,
    [product.id]
  );
  await insertVariant(ctx.pool, { productId: product.id, price: opts.price ?? "19.99" });
  return product;
}

// ── Channel CRUD ────────────────────────────────────────────────────────────────

describe("Channel CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /channels → empty list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/channels`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["channels"])).toBe(true);
    expect((res.json["channels"] as unknown[]).length).toBe(0);
  });

  it("PUT /channels/google_shopping → creates + configures", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/channels/google_shopping`,
      { is_active: true, config: { merchant_id: "123456", country: "US" } },
      auth
    );
    expect(res.status).toBe(200);
    const channel = res.json["channel"] as Record<string, unknown>;
    expect(channel["channel"]).toBe("google_shopping");
    expect(channel["is_active"]).toBe(true);
    expect((channel["config"] as Record<string, unknown>)["merchant_id"]).toBe("123456");
  });

  it("PUT again → updates (upsert, not duplicate)", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/channels/google_shopping`,
      { is_active: false, config: { merchant_id: "999" } },
      auth
    );
    expect(res.status).toBe(200);
    expect((res.json["channel"] as Record<string, unknown>)["is_active"]).toBe(false);

    const list = await get(ctx, `/commerce/stores/${storeId}/channels`, auth);
    expect((list.json["channels"] as unknown[]).length).toBe(1);
  });

  it("PUT unknown channel → 400", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/channels/not_a_channel`,
      { is_active: true },
      auth
    );
    expect(res.status).toBe(400);
  });

  it("GET /channels/:channel/items → 404 when item-listing a missing channel", async () => {
    const fresh = await setup();
    const res = await get(
      ctx,
      `/commerce/stores/${fresh.store.id}/channels/google_shopping/items`,
      fresh.auth
    );
    expect(res.status).toBe(404);
  });
});

// ── runChannelSync with an injected fake connector ───────────────────────────────

/** Records the context it received + reports caller-supplied outcomes. */
class FakeConnector implements ChannelConnector {
  lastCtx: SyncContext | null = null;
  constructor(
    private readonly outcomesFor: (ctx: SyncContext) => ProductSyncOutcome[],
    private readonly result: { synced: number; errored: number; status: "ok" | "error" | "partial"; error?: string }
  ) {}
  async syncProducts(ctx: SyncContext) {
    this.lastCtx = ctx;
    await ctx.recordOutcomes(this.outcomesFor(ctx));
    return this.result;
  }
  async syncInventory(ctx: SyncContext) {
    return this.syncProducts(ctx);
  }
}

describe("runChannelSync (injected connector)", () => {
  it("pushes products and records synced items with external_id", async () => {
    const s = await setup();
    const storeId = s.store.id;
    const p1 = await seedProduct(storeId);
    const p2 = await seedProduct(storeId);

    await put(
      ctx,
      `/commerce/stores/${storeId}/channels/google_shopping`,
      { is_active: true, config: { merchant_id: "m1" } },
      s.auth
    );

    const connector = new FakeConnector(
      (sctx) => sctx.products.map((p) => ({
        productId: p.productId,
        status: "synced" as const,
        externalId: `ext-${p.productId.slice(0, 8)}`,
      })),
      { synced: 2, errored: 0, status: "ok" }
    );

    const result = await runChannelSync(storeId, "google_shopping", { connector });
    expect(result.status).toBe("ok");
    expect(result.synced).toBe(2);

    // Connector saw both products.
    expect(connector.lastCtx?.products.length).toBe(2);
    const seen = new Set(connector.lastCtx?.products.map((p) => p.productId));
    expect(seen.has(p1.id)).toBe(true);
    expect(seen.has(p2.id)).toBe(true);

    // channel_sync_items recorded as synced with external_id.
    const items = await ctx.pool.query(
      `SELECT product_id::text, status, external_id, synced_at
       FROM channel_sync_items WHERE store_id = $1::uuid ORDER BY product_id`,
      [storeId]
    );
    expect(items.rows.length).toBe(2);
    for (const row of items.rows) {
      expect(row.status).toBe("synced");
      expect(String(row.external_id)).toMatch(/^ext-/);
      expect(row.synced_at).not.toBeNull();
    }

    // last_status updated on the channel_syncs row.
    const sync = await ctx.pool.query(
      `SELECT last_status, last_synced_at FROM channel_syncs WHERE store_id = $1::uuid`,
      [storeId]
    );
    expect(sync.rows[0].last_status).toBe("ok");
    expect(sync.rows[0].last_synced_at).not.toBeNull();
  });

  it("marks items as error on connector failure (and never throws)", async () => {
    const s = await setup();
    const storeId = s.store.id;
    const p1 = await seedProduct(storeId);

    await put(
      ctx,
      `/commerce/stores/${storeId}/channels/google_shopping`,
      { is_active: true, config: { merchant_id: "m1" } },
      s.auth
    );

    const connector = new FakeConnector(
      (sctx) => sctx.products.map((p) => ({
        productId: p.productId,
        status: "error" as const,
        error: "boom",
      })),
      { synced: 0, errored: 1, status: "error", error: "boom" }
    );

    const result = await runChannelSync(storeId, "google_shopping", { connector });
    expect(result.status).toBe("error");

    const items = await ctx.pool.query(
      `SELECT status, error FROM channel_sync_items WHERE store_id = $1::uuid AND product_id = $2::uuid`,
      [storeId, p1.id]
    );
    expect(items.rows[0].status).toBe("error");
    expect(items.rows[0].error).toBe("boom");
  });

  it("is idempotent — re-run updates the same items, no duplicates", async () => {
    const s = await setup();
    const storeId = s.store.id;
    const p1 = await seedProduct(storeId);

    await put(
      ctx,
      `/commerce/stores/${storeId}/channels/google_shopping`,
      { is_active: true, config: { merchant_id: "m1" } },
      s.auth
    );

    // First run: error.
    const errConnector = new FakeConnector(
      (sctx) => sctx.products.map((p) => ({ productId: p.productId, status: "error" as const, error: "first" })),
      { synced: 0, errored: 1, status: "error", error: "first" }
    );
    await runChannelSync(storeId, "google_shopping", { connector: errConnector });

    // Second run: success — should UPDATE the same row.
    const okConnector = new FakeConnector(
      (sctx) => sctx.products.map((p) => ({ productId: p.productId, status: "synced" as const, externalId: "ext-2" })),
      { synced: 1, errored: 0, status: "ok" }
    );
    await runChannelSync(storeId, "google_shopping", { connector: okConnector });

    const items = await ctx.pool.query(
      `SELECT status, external_id, error FROM channel_sync_items
       WHERE store_id = $1::uuid AND product_id = $2::uuid`,
      [storeId, p1.id]
    );
    expect(items.rows.length).toBe(1); // not duplicated
    expect(items.rows[0].status).toBe("synced");
    expect(items.rows[0].external_id).toBe("ext-2");
  });

  it("returns error when the channel is not configured", async () => {
    const s = await setup();
    const result = await runChannelSync(s.store.id, "google_shopping", {
      connector: new FakeConnector(() => [], { synced: 0, errored: 0, status: "ok" }),
    });
    expect(result.status).toBe("error");
  });
});

// ── GoogleShoppingClient — mapping + fetch (mocked) ──────────────────────────────

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
      text: async () => (typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)),
      json: async () => responseBody,
    } as unknown as Response;
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GoogleShoppingClient", () => {
  it("toContentProduct maps a CartCrft product → Content API resource", () => {
    const resource = toContentProduct({
      offerId: "prod-1",
      title: "Blue Shirt",
      description: "A nice shirt",
      link: "https://shop.example/products/blue-shirt",
      imageLink: "https://cdn.example/blue.jpg",
      price: "12.5",
      currency: "usd",
      inStock: true,
      brand: "Acme",
      gtin: "0123456789012",
      mpn: "SKU-1",
    });
    expect(resource.offerId).toBe("prod-1");
    expect(resource.title).toBe("Blue Shirt");
    expect(resource.availability).toBe("in_stock");
    expect(resource.price).toEqual({ value: "12.50", currency: "USD" });
    expect(resource.channel).toBe("online");
    expect(resource.condition).toBe("new");
    expect(resource.brand).toBe("Acme");
    expect(resource.gtin).toBe("0123456789012");
    expect(resource.mpn).toBe("SKU-1");
  });

  it("maps out_of_stock and omits empty optionals", () => {
    const resource = toContentProduct({
      offerId: "prod-2",
      title: "Out of stock",
      link: "https://shop.example/products/oos",
      price: "0",
      currency: "EUR",
      inStock: false,
    });
    expect(resource.availability).toBe("out_of_stock");
    expect(resource.price).toEqual({ value: "0.00", currency: "EUR" });
    expect(resource.brand).toBeUndefined();
    expect(resource.imageLink).toBeUndefined();
  });

  it("insertProduct posts to /{merchantId}/products with Bearer auth", async () => {
    const { calls } = stubFetch({ id: "online:en:US:prod-1", offerId: "prod-1" });
    const client = newGoogleShoppingClient("tok-abc");
    const resource = toContentProduct({
      offerId: "prod-1",
      title: "Blue Shirt",
      link: "https://shop.example/products/blue-shirt",
      price: "12.50",
      currency: "USD",
      inStock: true,
    });
    const res = await client.insertProduct("merch-9", resource);

    expect(res.id).toBe("online:en:US:prod-1");
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://shoppingcontent.googleapis.com/content/v2.1/merch-9/products"
    );
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(call.init?.body)).offerId).toBe("prod-1");
  });

  it("customBatchProducts posts to /products/batch and returns entries", async () => {
    const { calls } = stubFetch({
      entries: [{ batchId: 0, product: { id: "x", offerId: "prod-1" } }],
    });
    const client = newGoogleShoppingClient("tok-abc");
    const entries = await client.customBatchProducts([
      {
        batchId: 0,
        merchantId: "merch-9",
        method: "insert",
        product: toContentProduct({
          offerId: "prod-1",
          title: "T",
          link: "https://x/p",
          price: "1.00",
          currency: "USD",
          inStock: true,
        }),
      },
    ]);
    expect(entries.length).toBe(1);
    expect(calls[0]!.url).toBe(
      "https://shoppingcontent.googleapis.com/content/v2.1/products/batch"
    );
    expect((calls[0]!.init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer tok-abc"
    );
  });

  it("throws GoogleShoppingAPIError on a 4xx", async () => {
    stubFetch("forbidden", { status: 403 });
    const client = new GoogleShoppingClient("tok");
    await expect(client.deleteProduct("m", "p")).rejects.toBeInstanceOf(
      GoogleShoppingAPIError
    );
  });
});
