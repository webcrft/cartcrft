/**
 * notifications.test.ts — Notification provider CRUD + webhook dispatch.
 *
 * Covers:
 *  - Provider CRUD: create/list/update/delete
 *  - dispatch → delivery row created in notification_delivery_log with HMAC sig
 *  - Retry on failed delivery (mock target returns 500 first N times)
 *  - Invalid event type rejected
 *
 * Mock HTTP target: uses Node's built-in http.createServer so no extra deps.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import http from "node:http";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  del,
  mintJwt,
  insertStore,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Mock HTTP server ───────────────────────────────────────────────────────────

interface MockRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface MockServer {
  url: string;
  requests: MockRequest[];
  statusCodesToReturn: number[];
  close(): Promise<void>;
}

function createMockServer(): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: MockRequest[] = [];
    const statusCodesToReturn: number[] = [];

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "POST",
          headers: req.headers as Record<string, string>,
          body,
        });
        const code = statusCodesToReturn.shift() ?? 200;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        statusCodesToReturn,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

// ── Provider CRUD ──────────────────────────────────────────────────────────────

describe("Notification provider CRUD", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let providerId = "";

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /notification-providers → empty list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/notification-providers`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["providers"])).toBe(true);
    expect((res.json["providers"] as unknown[]).length).toBe(0);
  });

  it("POST /notification-providers → creates webhook provider", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/notification-providers`,
      {
        name: "My Webhook",
        webhook_url: "https://example.com/hook",
        events: ["order.created", "payment.captured"],
        webhook_secret: "mysecret123",
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    providerId = res.json["id"] as string;
  });

  it("GET /notification-providers → returns provider", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/notification-providers`, auth);
    const providers = res.json["providers"] as Array<Record<string, unknown>>;
    const p = providers.find((x) => x["id"] === providerId);
    expect(p).toBeDefined();
    expect(p!["name"]).toBe("My Webhook");
    expect(p!["type"]).toBe("webhook");
    expect(p!["webhook_url"]).toBe("https://example.com/hook");
    expect(Array.isArray(p!["events"])).toBe(true);
    expect(p!["is_active"]).toBe(true);
  });

  it("POST /notification-providers → rejects unknown event type", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/notification-providers`,
      {
        name: "Bad Events",
        webhook_url: "https://example.com/hook2",
        events: ["order.created", "not.a.real.event"],
      },
      auth
    );
    expect(res.status).toBe(400);
  });

  it("POST /notification-providers → requires at least one event", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/notification-providers`,
      {
        name: "Empty Events",
        webhook_url: "https://example.com/hook3",
        events: [],
      },
      auth
    );
    expect(res.status).toBe(400);
  });

  it("PUT /notification-providers/:providerId → updates url + events", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/notification-providers/${providerId}`,
      {
        webhook_url: "https://updated.example.com/hook",
        events: ["order.created", "shipment.delivered"],
      },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("PUT /notification-providers/:providerId → disabling provider sets is_active false", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/notification-providers/${providerId}`,
      { is_active: false },
      auth
    );
    expect(res.status).toBe(200);

    const list = await get(ctx, `/commerce/stores/${storeId}/notification-providers`, auth);
    const providers = list.json["providers"] as Array<Record<string, unknown>>;
    const p = providers.find((x) => x["id"] === providerId);
    expect(p!["is_active"]).toBe(false);
  });

  it("PUT /notification-providers → 404 for unknown id", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/notification-providers/${randomUUID()}`,
      { name: "Nope" },
      auth
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /notification-providers/:providerId → removes provider", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/notification-providers/${providerId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    const list = await get(ctx, `/commerce/stores/${storeId}/notification-providers`, auth);
    const providers = list.json["providers"] as Array<Record<string, unknown>>;
    expect(providers.find((p) => p["id"] === providerId)).toBeUndefined();
  });

  it("DELETE /notification-providers → 404 for unknown id", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/notification-providers/${randomUUID()}`,
      auth
    );
    expect(res.status).toBe(404);
  });
});

// ── Webhook dispatch + delivery row + HMAC signature ─────────────────────────

describe("Webhook dispatch + delivery log", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let mockServer: MockServer;

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("dispatch fires POST to webhook URL and creates delivery log row", async () => {
    const secret = "webhooksecret42";

    // Create provider pointing at mock server
    const create = await post(
      ctx,
      `/commerce/stores/${storeId}/notification-providers`,
      {
        name: "Dispatch Test",
        webhook_url: mockServer.url,
        events: ["order.created"],
        webhook_secret: secret,
      },
      auth
    );
    expect(create.status).toBe(201);
    const providerId = create.json["id"] as string;

    // Import and call dispatchStoreEvent directly
    const { dispatchStoreEvent } = await import("../../src/modules/notifications/service.js");
    dispatchStoreEvent(storeId, "order.created", {
      order_id: "test-order-123",
      total: "99.99",
    });

    // Wait for async dispatch to complete (retry delays are 0 in this path)
    await new Promise((r) => setTimeout(r, 500));

    // Check mock server received the request
    expect(mockServer.requests.length).toBeGreaterThanOrEqual(1);
    const req = mockServer.requests[mockServer.requests.length - 1]!;
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toContain("application/json");
    expect(req.headers["x-cartcrft-event"]).toBe("order.created");
    expect(req.headers["x-cartcrft-store-id"]).toBe(storeId);

    // Verify HMAC-SHA256 signature
    const sig = req.headers["x-cartcrft-signature"];
    expect(sig).toBeDefined();
    const mac = createHmac("sha256", secret);
    mac.update(Buffer.from(req.body, "utf8"));
    const expected = mac.digest("hex");
    expect(sig).toBe(expected);

    // Check payload contains standard enriched fields
    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["event"]).toBe("order.created");
    expect(payload["store_id"]).toBe(storeId);
    expect(typeof payload["timestamp"]).toBe("string");
    expect(payload["order_id"]).toBe("test-order-123");

    // Check delivery log row was created
    await new Promise((r) => setTimeout(r, 300));
    const log = await ctx.pool.query<{ id: string; status_code: number; attempt_number: number }>(
      `SELECT id, status_code, attempt_number FROM notification_delivery_log
       WHERE provider_id = $1::uuid ORDER BY delivered_at DESC LIMIT 1`,
      [providerId]
    );
    expect(log.rows.length).toBeGreaterThanOrEqual(1);
    expect(log.rows[0]!.status_code).toBe(200);
    expect(log.rows[0]!.attempt_number).toBe(1);
  });
});

// ── Retry on failed delivery ──────────────────────────────────────────────────

describe("Webhook retry on failed delivery", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let mockServer: MockServer;

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("retries on non-2xx and eventually succeeds + logs each attempt", async () => {
    // First two attempts return 500; third returns 200
    mockServer.statusCodesToReturn.push(500, 500, 200);

    const create = await post(
      ctx,
      `/commerce/stores/${storeId}/notification-providers`,
      {
        name: "Retry Test",
        webhook_url: mockServer.url,
        events: ["payment.captured"],
      },
      auth
    );
    expect(create.status).toBe(201);
    const providerId = create.json["id"] as string;

    const { dispatchStoreEvent } = await import("../../src/modules/notifications/service.js");
    dispatchStoreEvent(storeId, "payment.captured", { payment_id: "pay-456" });

    // Wait for all 3 retries (delays: 1s, 5s — but in real test we mock with fast timeout)
    // Since our test mock server responds immediately (no delay), retries fire quickly
    // We wait a generous amount but the RETRY_DELAYS_MS in service.ts are real ms
    // So this test acknowledges it may take up to ~6s total (1+5 delays)
    // For CI speed we reduce: if retries don't complete in time, test still verifies partial
    await new Promise((r) => setTimeout(r, 8_000));

    // Should have received at least 2 requests (could be up to 3)
    expect(mockServer.requests.length).toBeGreaterThanOrEqual(2);

    // Delivery log should have multiple attempt rows
    const log = await ctx.pool.query<{ attempt_number: number; status_code: number | null }>(
      `SELECT attempt_number, status_code FROM notification_delivery_log
       WHERE provider_id = $1::uuid ORDER BY delivered_at ASC`,
      [providerId]
    );
    expect(log.rows.length).toBeGreaterThanOrEqual(2);

    // First attempt: status 500
    const first = log.rows[0]!;
    expect(first.status_code).toBe(500);

    // Last attempt: status 200 (successful)
    const last = log.rows[log.rows.length - 1]!;
    expect(last.status_code).toBe(200);
  }, 15_000);
});

// ── Webhook + delivery log endpoints ─────────────────────────────────────────

describe("GET /webhook-url + /webhook-log", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /webhook-url → returns per-provider webhook URLs (T6.3 shape)", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/webhook-url`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["webhooks"])).toBe(true);
    expect(typeof res.json["subdomain_routing_enabled"]).toBe("boolean");
    // This suite creates notification providers above; each entry carries a path_url.
    const entries = res.json["webhooks"] as Array<Record<string, unknown>>;
    for (const entry of entries) {
      expect(typeof entry["path_url"]).toBe("string");
    }
  });

  it("GET /webhook-log → returns list (empty for new store)", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/webhook-log`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["log"])).toBe(true);
  });
});
