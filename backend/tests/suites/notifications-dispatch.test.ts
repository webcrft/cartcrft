/**
 * notifications-dispatch.test.ts — End-to-end wiring of dispatchStoreEvent.
 *
 * H2.1: Verifies that lifecycle transitions in orders/payments/shipping services
 * actually reach configured notification providers.
 *
 * Tests:
 *  1. order.created — createOrder delivers signed webhook + delivery-log row
 *  2. order.cancelled — cancelOrder fires order.cancelled webhook
 *  3. payment.captured — capturePayment fires payment.captured webhook
 *  4. payment.refunded — createRefund fires payment.refunded webhook
 *  5. shipment.created — createShipment fires shipment.created webhook
 *  6. shipment.delivered — updateShipment(status=delivered) fires shipment.delivered
 *  7. email provider — dispatchStoreEvent delivers via ConsoleMailer + records message
 *  8. sms/whatsapp provider — createNotificationProvider rejects at create time
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import http from "node:http";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  post,
  mintJwt,
  insertStore,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import {
  setNotificationMailer,
  dispatchStoreEvent,
} from "../../src/modules/notifications/service.js";
import {
  createOrder,
  cancelOrder,
} from "../../src/modules/orders/service.js";
import {
  createPayment,
  capturePayment,
  createRefund,
} from "../../src/modules/payments/service.js";
import {
  createShipment,
  updateShipment,
} from "../../src/modules/shipping/service.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Mock HTTP server ────────────────────────────────────────────────────────────

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

/** Wait for at least `count` requests to land on the mock server (max 3s). */
async function waitForRequests(server: MockServer, count: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (server.requests.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Shared setup helpers ────────────────────────────────────────────────────────

async function setupStore() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

async function registerWebhookProvider(
  storeId: string,
  auth: { type: "bearer"; token: string },
  mockUrl: string,
  events: string[],
  secret = "testsecret"
) {
  const res = await post(
    ctx,
    `/commerce/stores/${storeId}/notification-providers`,
    { name: "Dispatch Test", webhook_url: mockUrl, events, webhook_secret: secret },
    auth
  );
  expect(res.status).toBe(201);
  return res.json["id"] as string;
}

function verifyHmac(body: string, secret: string, sig: string) {
  const mac = createHmac("sha256", secret);
  mac.update(Buffer.from(body, "utf8"));
  expect(sig).toBe(mac.digest("hex"));
}

async function getLatestDeliveryLog(pool: typeof ctx.pool, providerId: string) {
  const { rows } = await pool.query<{
    id: string;
    status_code: number | null;
    attempt_number: number;
    event: string;
  }>(
    `SELECT id, status_code, attempt_number, event
     FROM notification_delivery_log
     WHERE provider_id = $1::uuid
     ORDER BY delivered_at DESC LIMIT 1`,
    [providerId]
  );
  return rows[0] ?? null;
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("H2.1 — order.created hook", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("createOrder fires order.created webhook + delivery-log row", async () => {
    const { store, auth } = await setupStore();
    const secret = "ordercreatedsecret";
    const providerId = await registerWebhookProvider(
      store.id, auth, mockServer.url, ["order.created"], secret
    );

    // Need a product + variant to create an order
    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "25.00" });

    const result = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 2, title: "Widget" }],
    });
    expect(result.id).toBeTruthy();

    await waitForRequests(mockServer, 1);

    const req = mockServer.requests.at(-1);
    expect(req).toBeDefined();
    expect(req!.headers["x-cartcrft-event"]).toBe("order.created");
    expect(req!.headers["x-cartcrft-store-id"]).toBe(store.id);
    const sig = req!.headers["x-cartcrft-signature"];
    expect(sig).toBeDefined();
    verifyHmac(req!.body, secret, sig!);

    const payload = JSON.parse(req!.body) as Record<string, unknown>;
    expect(payload["event"]).toBe("order.created");
    expect(payload["order_id"]).toBe(result.id);
    expect(payload["store_id"]).toBe(store.id);
    expect(typeof payload["timestamp"]).toBe("string");

    // Delivery log row
    await new Promise((r) => setTimeout(r, 200));
    const log = await getLatestDeliveryLog(ctx.pool, providerId);
    expect(log).not.toBeNull();
    expect(log!.status_code).toBe(200);
    expect(log!.attempt_number).toBe(1);
    expect(log!.event).toBe("order.created");
  });
});

describe("H2.1 — order.cancelled hook", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("cancelOrder fires order.cancelled webhook", async () => {
    const { store, auth } = await setupStore();
    const secret = "cancelledSecret";
    await registerWebhookProvider(
      store.id, auth, mockServer.url, ["order.cancelled"], secret
    );

    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "10.00" });

    const { id: orderId } = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 1, title: "Foo" }],
    });

    const cancelled = await cancelOrder(orderId, store.id, "customer request");
    expect(cancelled).toBe(true);

    await waitForRequests(mockServer, 1);

    const req = mockServer.requests.at(-1)!;
    expect(req.headers["x-cartcrft-event"]).toBe("order.cancelled");
    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["order_id"]).toBe(orderId);
    expect(payload["reason"]).toBe("customer request");
  });
});

describe("H2.1 — payment.captured hook", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("capturePayment fires payment.captured webhook + delivery-log row", async () => {
    const { store, auth } = await setupStore();
    const secret = "paymentCapturedSec";
    const providerId = await registerWebhookProvider(
      store.id, auth, mockServer.url, ["payment.captured"], secret
    );

    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "50.00" });
    const { id: orderId } = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 1, title: "Gizmo" }],
    });

    const { id: paymentId } = await createPayment(orderId, store.id, {
      amount: "50.00",
      currency: "USD",
      mode: "dev",
    });

    // Clear any order.created requests from this mock (if it was also subscribed)
    mockServer.requests.length = 0;

    await capturePayment(paymentId, orderId, store.id);

    await waitForRequests(mockServer, 1);

    const req = mockServer.requests.at(-1)!;
    expect(req.headers["x-cartcrft-event"]).toBe("payment.captured");
    const sig = req.headers["x-cartcrft-signature"]!;
    verifyHmac(req.body, secret, sig);

    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["order_id"]).toBe(orderId);
    expect(payload["payment_id"]).toBe(paymentId);

    await new Promise((r) => setTimeout(r, 200));
    const log = await getLatestDeliveryLog(ctx.pool, providerId);
    expect(log).not.toBeNull();
    expect(log!.event).toBe("payment.captured");
    expect(log!.status_code).toBe(200);
  });
});

describe("H2.1 — payment.refunded hook", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("createRefund fires payment.refunded webhook", async () => {
    const { store, auth } = await setupStore();
    const secret = "refundSecret";
    await registerWebhookProvider(
      store.id, auth, mockServer.url, ["payment.refunded"], secret
    );

    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "30.00" });
    const { id: orderId } = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 1, title: "Whatsit" }],
    });
    const { id: paymentId } = await createPayment(orderId, store.id, {
      amount: "30.00",
      currency: "USD",
      mode: "dev",
    });
    await capturePayment(paymentId, orderId, store.id);

    mockServer.requests.length = 0;

    await createRefund(paymentId, orderId, store.id, {
      amount: "10.00",
      reason: "customer_request",
    });

    await waitForRequests(mockServer, 1);

    const req = mockServer.requests.at(-1)!;
    expect(req.headers["x-cartcrft-event"]).toBe("payment.refunded");
    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["order_id"]).toBe(orderId);
    expect(payload["payment_id"]).toBe(paymentId);
    expect(payload["refund_amount"]).toBe("10");
  });
});

describe("H2.1 — shipment.created hook", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("createShipment fires shipment.created webhook", async () => {
    const { store, auth } = await setupStore();
    const secret = "shipmentCreatedSec";
    await registerWebhookProvider(
      store.id, auth, mockServer.url, ["shipment.created"], secret
    );

    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "20.00" });
    const { id: orderId } = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 1, title: "Box" }],
    });

    mockServer.requests.length = 0;

    const shipmentId = await createShipment(store.id, orderId, {
      status: "dispatched",
      tracking_number: "TRK-001",
      carrier: "DHL",
    });
    expect(shipmentId).toBeTruthy();

    await waitForRequests(mockServer, 1);

    const req = mockServer.requests.at(-1)!;
    expect(req.headers["x-cartcrft-event"]).toBe("shipment.created");
    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["order_id"]).toBe(orderId);
    expect(payload["shipment_id"]).toBe(shipmentId);
    expect(payload["carrier"]).toBe("DHL");
  });
});

describe("H2.1 — shipment.delivered hook", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("updateShipment(status=delivered) fires shipment.delivered webhook", async () => {
    const { store, auth } = await setupStore();
    const secret = "shipDeliveredSec";
    await registerWebhookProvider(
      store.id, auth, mockServer.url, ["shipment.delivered"], secret
    );

    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "15.00" });
    const { id: orderId } = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 1, title: "Parcel" }],
    });
    const shipmentId = await createShipment(store.id, orderId, {
      status: "dispatched",
      tracking_number: "TRK-002",
    });

    mockServer.requests.length = 0;

    const updated = await updateShipment(store.id, orderId, shipmentId!, {
      status: "delivered",
      delivered_at: new Date().toISOString(),
    });
    expect(updated).toBe(true);

    await waitForRequests(mockServer, 1);

    const req = mockServer.requests.at(-1)!;
    expect(req.headers["x-cartcrft-event"]).toBe("shipment.delivered");
    const payload = JSON.parse(req.body) as Record<string, unknown>;
    expect(payload["order_id"]).toBe(orderId);
    expect(payload["shipment_id"]).toBe(shipmentId);
    expect(payload["status"]).toBe("delivered");
  });
});

describe("H2.1 — email provider dispatches via ConsoleMailer", () => {
  it("dispatchStoreEvent delivers to email provider via ConsoleMailer", async () => {
    const { store, auth } = await setupStore();

    const consoleMailer = new ConsoleMailer();
    setNotificationMailer(consoleMailer);

    // Create an email-type provider
    const res = await post(
      ctx,
      `/commerce/stores/${store.id}/notification-providers`,
      {
        name: "Email Test",
        type: "email",
        webhook_url: "mailto:test@example.com", // required field; not used for email type
        events: ["order.created"],
        config: {
          to_email: "notify@example.com",
          from_name: "Test Store",
          from_email: "store@example.com",
        },
      },
      auth
    );
    expect(res.status).toBe(201);

    // Dispatch directly
    dispatchStoreEvent(store.id, "order.created", {
      order_id: "test-order-email",
      total: "42.00",
    });

    // Wait for async dispatch
    await new Promise((r) => setTimeout(r, 500));

    // ConsoleMailer should have captured the message
    expect(consoleMailer.sentMessages.length).toBeGreaterThanOrEqual(1);
    const msg = consoleMailer.sentMessages.at(-1)!;
    expect(msg.to).toBe("notify@example.com");
    expect(msg.fromName).toBe("Test Store");
    expect(msg.subject).toContain("order.created");
  });
});

describe("H2.1 — sms/whatsapp provider type rejected at create", () => {
  it("POST /notification-providers with type=sms returns 400", async () => {
    const { store, auth } = await setupStore();
    const res = await post(
      ctx,
      `/commerce/stores/${store.id}/notification-providers`,
      {
        name: "SMS Provider",
        type: "sms",
        webhook_url: "https://example.com/sms",
        events: ["order.created"],
      },
      auth
    );
    expect(res.status).toBe(400);
  });

  it("POST /notification-providers with type=whatsapp returns 400", async () => {
    const { store, auth } = await setupStore();
    const res = await post(
      ctx,
      `/commerce/stores/${store.id}/notification-providers`,
      {
        name: "WhatsApp Provider",
        type: "whatsapp",
        webhook_url: "https://example.com/wa",
        events: ["order.created"],
      },
      auth
    );
    expect(res.status).toBe(400);
  });
});
