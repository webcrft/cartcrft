/**
 * onboarding.test.ts — agent-surface onboarding (B7).
 *
 * Covers:
 *  - connect descriptor (2-click): Google OAuth/instructions + ACP instructions
 *  - create a connection, list it, status transitions
 *  - generate + submit a feed to each surface (surface HTTP mocked → success)
 *  - feed content correctness (Google Content API custombatch shape, ACP feed url)
 *  - credential-gating (no creds → 409 CREDENTIALS_REQUIRED)
 *  - org isolation (org A cannot touch org B's connections)
 *  - disconnect
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { setSurfaceFetchForTesting } from "../../src/agent/onboarding/service.js";
import {
  get,
  post,
  del,
  mintJwt,
  insertStore,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";

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

/** Seed an active product + variant so the feed has at least one item. */
async function seedCatalog(storeId: string) {
  const product = await insertProduct(ctx.pool, { storeId, title: "Widget" });
  await ctx.pool.query(
    `UPDATE products SET status = 'active', description = 'A fine widget', vendor = 'Acme'
     WHERE id = $1::uuid`,
    [product.id]
  );
  const variant = await insertVariant(ctx.pool, {
    productId: product.id,
    title: "Default",
    price: "29.99",
  });
  // Disable inventory tracking so availability = in_stock without inventory rows.
  await ctx.pool.query(
    `UPDATE product_variants SET track_inventory = false WHERE id = $1::uuid`,
    [variant.id]
  );
  return { product, variant };
}

/** Build a mocked fetch that records the request and returns `body`. */
function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
  ) as unknown as typeof fetch;
  return { fn, calls };
}

// ── Connect descriptor (2-click) ────────────────────────────────────────────

describe("connect descriptor", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("lists available surfaces with empty connections", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/agent-surfaces`, auth);
    expect(res.status).toBe(200);
    expect(res.json["surfaces"]).toEqual(["google_merchant", "chatgpt_acp"]);
    expect(res.json["connections"]).toEqual([]);
  });

  it("Google connect returns required-to-go-live disclosure", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces/google_merchant/connect`,
      auth
    );
    expect(res.status).toBe(200);
    const connect = res.json["connect"] as Record<string, unknown>;
    expect(connect["surface"]).toBe("google_merchant");
    expect(Array.isArray(connect["required_to_go_live"])).toBe(true);
    expect((connect["required_to_go_live"] as string[]).join(" ")).toMatch(
      /Merchant Center/i
    );
  });

  it("ACP connect returns instructions + no OAuth URL", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces/chatgpt_acp/connect`,
      auth
    );
    expect(res.status).toBe(200);
    const connect = res.json["connect"] as Record<string, unknown>;
    expect(connect["authorize_url"]).toBeNull();
    expect((connect["instructions"] as string[]).join(" ")).toMatch(/acp/i);
    expect((connect["required_to_go_live"] as string[]).join(" ")).toMatch(
      /OpenAI/i
    );
  });
});

// ── CRUD + status transitions ───────────────────────────────────────────────

describe("connection CRUD + status transitions", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("create without credentials → pending", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces`,
      { surface: "chatgpt_acp", external_account_id: "merchant-123" },
      auth
    );
    expect(res.status).toBe(201);
    const conn = res.json["connection"] as Record<string, unknown>;
    expect(conn["status"]).toBe("pending");
    expect(conn["has_credentials"]).toBe(false);
    expect(conn["external_account_id"]).toBe("merchant-123");
  });

  it("upsert with credentials → connected + credentials hidden", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces`,
      {
        surface: "chatgpt_acp",
        external_account_id: "merchant-123",
        credentials: "secret-token",
      },
      auth
    );
    expect(res.status).toBe(201);
    const conn = res.json["connection"] as Record<string, unknown>;
    expect(conn["status"]).toBe("connected");
    expect(conn["has_credentials"]).toBe(true);
    // raw credential blob must never be returned
    expect(conn["credentials_enc"]).toBeUndefined();
  });

  it("list reflects the single upserted connection (unique per surface)", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/agent-surfaces`, auth);
    const conns = res.json["connections"] as Array<Record<string, unknown>>;
    const acp = conns.filter((c) => c["surface"] === "chatgpt_acp");
    expect(acp.length).toBe(1);
  });

  it("disconnect removes the connection", async () => {
    const list = await get(ctx, `/commerce/stores/${storeId}/agent-surfaces`, auth);
    const conn = (list.json["connections"] as Array<Record<string, unknown>>)[0];
    const id = conn["id"] as string;
    const res = await del(ctx, `/commerce/stores/${storeId}/agent-surfaces/${id}`, auth);
    expect(res.status).toBe(200);
    const after = await get(ctx, `/commerce/stores/${storeId}/agent-surfaces`, auth);
    expect((after.json["connections"] as unknown[]).length).toBe(0);
  });

  it("disconnect unknown id → 404", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces/${randomUUID()}`,
      auth
    );
    expect(res.status).toBe(404);
  });
});

// ── Feed submission (surface HTTP mocked) ───────────────────────────────────

describe("feed submission — Google Merchant", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
    await seedCatalog(storeId);
  });

  it("credential-gated: submit without credentials → 409", async () => {
    // create pending (no creds)
    const created = await post(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces`,
      { surface: "google_merchant", external_account_id: "12345" },
      auth
    );
    const id = (created.json["connection"] as Record<string, unknown>)["id"] as string;
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces/${id}/submit-feed`,
      {},
      auth
    );
    expect(res.status).toBe(409);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe(
      "CREDENTIALS_REQUIRED"
    );
  });

  it("with credentials + mocked Content API → success, correct request shape", async () => {
    // upsert credentials → connected
    const created = await post(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces`,
      {
        surface: "google_merchant",
        external_account_id: "12345",
        credentials: "ya29.fake-oauth-token",
      },
      auth
    );
    const id = (created.json["connection"] as Record<string, unknown>)["id"] as string;

    const { fn, calls } = mockFetch(200, { kind: "content#productsCustomBatchResponse", entries: [{ batchId: 1 }] });
    setSurfaceFetchForTesting(fn);
    try {
      const res = await post(
        ctx,
        `/commerce/stores/${storeId}/agent-surfaces/${id}/submit-feed`,
        {},
        auth
      );
      expect(res.status).toBe(200);
      const result = res.json["result"] as Record<string, unknown>;
      expect(result["ok"]).toBe(true);
      expect(result["surface"]).toBe("google_merchant");
      expect(result["item_count"]).toBe(1);
    } finally {
      setSurfaceFetchForTesting(null);
    }

    // Assert the real Content API request shape was used.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toMatch(/shoppingcontent\.googleapis\.com.*products\/batch/);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer ya29.fake-oauth-token");
    const sent = JSON.parse(calls[0].init.body as string) as {
      entries: Array<{ method: string; merchantId: string; product: Record<string, unknown> }>;
    };
    expect(sent.entries.length).toBe(1);
    expect(sent.entries[0].method).toBe("insert");
    expect(sent.entries[0].merchantId).toBe("12345");
    expect(sent.entries[0].product["offerId"]).toBeTruthy();
    expect(sent.entries[0].product["price"]).toEqual({ value: "29.99", currency: "USD" });
    expect(sent.entries[0].product["availability"]).toBe("in stock");
  });

  it("status persisted as connected with last_sync_at after success", async () => {
    const list = await get(ctx, `/commerce/stores/${storeId}/agent-surfaces`, auth);
    const conn = (list.json["connections"] as Array<Record<string, unknown>>).find(
      (c) => c["surface"] === "google_merchant"
    )!;
    expect(conn["status"]).toBe("connected");
    expect(conn["last_sync_at"]).not.toBeNull();
    const cfg = conn["config"] as Record<string, unknown>;
    expect(cfg["last_feed_item_count"]).toBe(1);
  });

  it("surface HTTP failure → status error", async () => {
    const list = await get(ctx, `/commerce/stores/${storeId}/agent-surfaces`, auth);
    const id = (list.json["connections"] as Array<Record<string, unknown>>).find(
      (c) => c["surface"] === "google_merchant"
    )!["id"] as string;

    const { fn } = mockFetch(403, { error: { message: "forbidden" } });
    setSurfaceFetchForTesting(fn);
    try {
      const res = await post(
        ctx,
        `/commerce/stores/${storeId}/agent-surfaces/${id}/submit-feed`,
        {},
        auth
      );
      expect(res.status).toBe(200);
      expect((res.json["result"] as Record<string, unknown>)["ok"]).toBe(false);
    } finally {
      setSurfaceFetchForTesting(null);
    }
    const after = await get(ctx, `/commerce/stores/${storeId}/agent-surfaces`, auth);
    const conn = (after.json["connections"] as Array<Record<string, unknown>>).find(
      (c) => c["surface"] === "google_merchant"
    )!;
    expect(conn["status"]).toBe("error");
  });
});

describe("feed submission — ChatGPT ACP", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
    await seedCatalog(storeId);
  });

  it("registers the live ACP feed URL with mocked OpenAI API", async () => {
    const created = await post(
      ctx,
      `/commerce/stores/${storeId}/agent-surfaces`,
      {
        surface: "chatgpt_acp",
        external_account_id: "openai-merchant-9",
        credentials: "sk-fake",
      },
      auth
    );
    const id = (created.json["connection"] as Record<string, unknown>)["id"] as string;

    const { fn, calls } = mockFetch(200, { id: "feed_reg_abc" });
    setSurfaceFetchForTesting(fn);
    try {
      const res = await post(
        ctx,
        `/commerce/stores/${storeId}/agent-surfaces/${id}/submit-feed`,
        {},
        auth
      );
      expect(res.status).toBe(200);
      const result = res.json["result"] as Record<string, unknown>;
      expect(result["ok"]).toBe(true);
      expect(result["submission_id"]).toBe("feed_reg_abc");
    } finally {
      setSurfaceFetchForTesting(null);
    }

    expect(calls.length).toBe(1);
    expect(calls[0].url).toMatch(/api\.openai\.com.*commerce\/feeds/);
    const sent = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(sent["merchant_id"]).toBe("openai-merchant-9");
    expect(String(sent["feed_url"])).toMatch(
      new RegExp(`/acp/${storeId}/feed$`)
    );
    expect(sent["protocol"]).toBe("acp");
  });
});

// ── Org isolation ───────────────────────────────────────────────────────────

describe("org isolation", () => {
  it("org B cannot read, submit, or delete org A's connection", async () => {
    const a = await setup();
    const b = await setup();

    // org A creates a connection
    const created = await post(
      ctx,
      `/commerce/stores/${a.store.id}/agent-surfaces`,
      { surface: "chatgpt_acp", external_account_id: "a-merchant", credentials: "a-secret" },
      a.auth
    );
    const id = (created.json["connection"] as Record<string, unknown>)["id"] as string;

    // org B's token against org A's store path → forbidden/not-found (auth layer)
    const listB = await get(
      ctx,
      `/commerce/stores/${a.store.id}/agent-surfaces`,
      b.auth
    );
    expect([401, 403, 404]).toContain(listB.status);

    // org B cannot delete A's connection via A's store path
    const delB = await del(
      ctx,
      `/commerce/stores/${a.store.id}/agent-surfaces/${id}`,
      b.auth
    );
    expect([401, 403, 404]).toContain(delB.status);

    // org A still sees its connection intact
    const listA = await get(
      ctx,
      `/commerce/stores/${a.store.id}/agent-surfaces`,
      a.auth
    );
    expect((listA.json["connections"] as unknown[]).length).toBe(1);
  });
});
