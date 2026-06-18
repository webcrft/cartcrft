/**
 * webhook-versioning.test.ts — Outbound webhook payload versioning.
 *
 * Verifies the additive payload-versioning contract introduced on top of
 * dispatchStoreEvent:
 *   1. A default webhook delivery carries `version` = current WEBHOOK_SPEC_VERSION
 *      in the body, the X-Cartcrft-Version header matches, and the HMAC signature
 *      verifies against the delivered body (which now includes `version`).
 *   2. A provider pinned via config.api_version delivers that pinned version
 *      (body + header), still correctly signed.
 *   3. Existing standard fields (event/store_id/timestamp + event payload) remain
 *      unchanged — old consumers are unaffected.
 *
 * Reuses the loopback mock-server + provider-create pattern from
 * notifications-dispatch.test.ts. APP_ENV != production in tests, so the SSRF
 * guard permits the 127.0.0.1 mock target.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHmac } from "node:crypto";
import http from "node:http";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { post, mintJwt, insertStore } from "../shared/helpers.js";
import { dispatchStoreEvent } from "../../src/modules/notifications/service.js";
import { WEBHOOK_SPEC_VERSION } from "../../src/modules/notifications/types.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Mock HTTP server (mirrors notifications-dispatch.test.ts) ────────────────────

interface MockRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface MockServer {
  url: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

function createMockServer(): Promise<MockServer> {
  return new Promise((resolve) => {
    const requests: MockRequest[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk.toString()));
      req.on("end", () => {
        requests.push({
          method: req.method ?? "POST",
          headers: req.headers as Record<string, string>,
          body,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Wait for and return the request whose X-Cartcrft-Store-ID matches `storeId`.
 * Dispatch is fire-and-forget and several tests share one mock server, so
 * matching by store id (rather than `requests.at(-1)`) avoids cross-talk.
 */
async function waitForRequestForStore(
  server: MockServer,
  storeId: string,
  timeoutMs = 3_000
): Promise<MockRequest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = server.requests.find((r) => r.headers["x-cartcrft-store-id"] === storeId);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no webhook request for store ${storeId} within ${timeoutMs}ms`);
}

async function setupStore() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

function verifyHmac(body: string, secret: string, sig: string) {
  const mac = createHmac("sha256", secret);
  mac.update(Buffer.from(body, "utf8"));
  expect(sig).toBe(mac.digest("hex"));
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("webhook versioning — default current spec version", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });
  afterAll(async () => {
    await mockServer.close();
  });

  it("stamps current WEBHOOK_SPEC_VERSION in body + header, signed correctly", async () => {
    const { store, auth } = await setupStore();
    const secret = "versioningDefaultSecret";

    const res = await post(
      ctx,
      `/commerce/stores/${store.id}/notification-providers`,
      { name: "Versioning Default", webhook_url: mockServer.url, events: ["order.created"], webhook_secret: secret },
      auth
    );
    expect(res.status).toBe(201);

    dispatchStoreEvent(store.id, "order.created", { order_id: "ord-version-default", total: "10.00" });

    const req = await waitForRequestForStore(mockServer, store.id);

    // Body carries version = current spec version
    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["version"]).toBe(WEBHOOK_SPEC_VERSION);

    // Existing fields unchanged (backward compatible)
    expect(payload["event"]).toBe("order.created");
    expect(payload["store_id"]).toBe(store.id);
    expect(payload["order_id"]).toBe("ord-version-default");
    expect(typeof payload["timestamp"]).toBe("string");

    // Header matches body version
    expect(req.headers["x-cartcrft-version"]).toBe(WEBHOOK_SPEC_VERSION);

    // HMAC verifies over the exact body INCLUDING the version field
    const sig = req.headers["x-cartcrft-signature"];
    expect(sig).toBeDefined();
    verifyHmac(req.body, secret, sig!);
  });
});

describe("webhook versioning — provider pinned api_version", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });
  afterAll(async () => {
    await mockServer.close();
  });

  it("delivers the pinned (known) version in body + header, signed correctly", async () => {
    const { store, auth } = await setupStore();
    const secret = "versioningPinnedSecret";

    // Pin to the current known version via config.api_version.
    const res = await post(
      ctx,
      `/commerce/stores/${store.id}/notification-providers`,
      {
        name: "Versioning Pinned",
        webhook_url: mockServer.url,
        events: ["order.created"],
        webhook_secret: secret,
        config: { api_version: WEBHOOK_SPEC_VERSION },
      },
      auth
    );
    expect(res.status).toBe(201);

    dispatchStoreEvent(store.id, "order.created", { order_id: "ord-version-pinned" });

    const req = await waitForRequestForStore(mockServer, store.id);

    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["version"]).toBe(WEBHOOK_SPEC_VERSION);
    expect(req.headers["x-cartcrft-version"]).toBe(WEBHOOK_SPEC_VERSION);

    const sig = req.headers["x-cartcrft-signature"]!;
    verifyHmac(req.body, secret, sig);
  });

  it("falls back to current version when api_version is unknown/garbage", async () => {
    const { store, auth } = await setupStore();
    const secret = "versioningBadPinSecret";

    const res = await post(
      ctx,
      `/commerce/stores/${store.id}/notification-providers`,
      {
        name: "Versioning Bad Pin",
        webhook_url: mockServer.url,
        events: ["order.created"],
        webhook_secret: secret,
        config: { api_version: "not-a-real-version" },
      },
      auth
    );
    expect(res.status).toBe(201);

    dispatchStoreEvent(store.id, "order.created", { order_id: "ord-version-badpin" });

    const req = await waitForRequestForStore(mockServer, store.id);

    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["version"]).toBe(WEBHOOK_SPEC_VERSION);
    expect(req.headers["x-cartcrft-version"]).toBe(WEBHOOK_SPEC_VERSION);
    verifyHmac(req.body, secret, req.headers["x-cartcrft-signature"]!);
  });
});
