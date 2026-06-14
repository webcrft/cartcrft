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
 *  9. order.created — storefront checkout complete fires order.created (audit H2.1)
 * 10. payment.captured — webhook-confirmed payment fires payment.captured (audit H2.1)
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
import { completeCheckout } from "../../src/modules/checkout/complete.js";
import { signStripe } from "../../src/webhooks/verifiers/stripe.js";

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

// ── 9. Storefront checkout complete fires order.created (H2.1 audit) ────────────

describe("H2.1 audit — storefront checkout complete fires order.created", () => {
  let mockServer: MockServer;

  beforeAll(async () => {
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("completeCheckout fires order.created webhook + delivery-log row", async () => {
    // Set up store with a notification webhook provider subscribed to order.created
    const orgId = randomUUID();
    const store = await insertStore(ctx.pool, { orgId });
    const userId = randomUUID();
    const token = await mintJwt({ userId, orgId });
    const auth = { type: "bearer" as const, token };
    const secret = "checkout-order-created-secret";

    const providerRes = await post(
      ctx,
      `/commerce/stores/${store.id}/notification-providers`,
      { name: "Checkout Dispatch Test", webhook_url: mockServer.url, events: ["order.created"], webhook_secret: secret },
      auth
    );
    expect(providerRes.status).toBe(201);
    const providerId = providerRes.json["id"] as string;

    // Build a product + variant + cart + checkout via SQL (fastest; avoids route auth complexity).
    // track_inventory = false so completeCheckout doesn't need inventory_levels rows.
    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const varRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO product_variants (product_id, title, price, track_inventory)
       VALUES ($1::uuid, 'Default', 49.00, false)
       RETURNING id::text`,
      [product.id]
    );
    const variantId = varRes.rows[0]!.id;

    const cartRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO carts (store_id, status, currency) VALUES ($1::uuid, 'active', 'USD') RETURNING id::text`,
      [store.id]
    );
    const cartId = cartRes.rows[0]!.id;

    await ctx.pool.query(
      `INSERT INTO cart_lines (cart_id, variant_id, quantity, price) VALUES ($1::uuid, $2::uuid, 1, 49.00)`,
      [cartId, variantId]
    );

    const checkoutRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO checkouts (store_id, cart_id, status, currency, subtotal, shipping_total, tax_total, discount_total, total)
       VALUES ($1::uuid, $2::uuid, 'pending', 'USD', 49.00, 0, 0, 0, 49.00)
       RETURNING id::text`,
      [store.id, cartId]
    );
    const checkoutId = checkoutRes.rows[0]!.id;

    const beforeCount = mockServer.requests.length;

    // This is the PRIMARY storefront path — must fire order.created
    const result = await completeCheckout(store.id, checkoutId);
    expect(result.orderId).toBeTruthy();

    await waitForRequests(mockServer, beforeCount + 1);

    const req = mockServer.requests.at(-1);
    expect(req).toBeDefined();
    expect(req!.headers["x-cartcrft-event"]).toBe("order.created");
    expect(req!.headers["x-cartcrft-store-id"]).toBe(store.id);
    const sig = req!.headers["x-cartcrft-signature"];
    expect(sig).toBeDefined();
    const mac = createHmac("sha256", secret);
    mac.update(Buffer.from(req!.body, "utf8"));
    expect(sig).toBe(mac.digest("hex"));

    const payload = JSON.parse(req!.body) as Record<string, unknown>;
    expect(payload["event"]).toBe("order.created");
    expect(payload["order_id"]).toBe(result.orderId);
    expect(payload["order_number"]).toBe(result.orderNumber);

    // Delivery log row must exist
    await new Promise((r) => setTimeout(r, 200));
    const log = await getLatestDeliveryLog(ctx.pool, providerId);
    expect(log).not.toBeNull();
    expect(log!.status_code).toBe(200);
    expect(log!.event).toBe("order.created");
  });
});

// ── 10. Webhook-confirmed payment fires payment.captured (H2.1 audit) ───────────

describe("H2.1 audit — webhook-confirmed payment fires payment.captured", () => {
  let mockServer: MockServer;
  const STRIPE_WEBHOOK_SECRET = "whsec_dispatch_test_secret_for_audit";

  beforeAll(async () => {
    mockServer = await createMockServer();
  });

  afterAll(async () => {
    await mockServer.close();
  });

  it("recordPaymentSuccess via Stripe webhook fires payment.captured + delivery-log row", async () => {
    const orgId = randomUUID();
    const store = await insertStore(ctx.pool, { orgId });
    const userId = randomUUID();
    const token = await mintJwt({ userId, orgId });
    const auth = { type: "bearer" as const, token };
    const secret = "webhook-payment-captured-secret";

    const providerRes = await post(
      ctx,
      `/commerce/stores/${store.id}/notification-providers`,
      { name: "Webhook Payment Test", webhook_url: mockServer.url, events: ["payment.captured"], webhook_secret: secret },
      auth
    );
    expect(providerRes.status).toBe(201);
    const providerId = providerRes.json["id"] as string;

    // Register a Stripe payment provider for this store
    const slug = `stripe-audit-${randomUUID().slice(0, 8)}`;
    await ctx.pool.query(
      `INSERT INTO payment_providers (store_id, slug, name, type, config, is_active)
       VALUES ($1::uuid, $2, 'Stripe Audit', 'stripe', $3::jsonb, true)`,
      [store.id, slug, JSON.stringify({ webhook_secret: STRIPE_WEBHOOK_SECRET })]
    );

    // Build a pending checkout + order (Stripe redirect flow: order already exists).
    // The cart/checkout are needed for FK integrity; inventory is not checked
    // because completeCheckout is not called (the order row pre-exists).
    const cartRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO carts (store_id, status, currency) VALUES ($1::uuid, 'active', 'USD') RETURNING id::text`,
      [store.id]
    );
    const cartId = cartRes.rows[0]!.id;

    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const varRes2 = await ctx.pool.query<{ id: string }>(
      `INSERT INTO product_variants (product_id, title, price, track_inventory)
       VALUES ($1::uuid, 'Default', 75.00, false)
       RETURNING id::text`,
      [product.id]
    );
    const variantId2 = varRes2.rows[0]!.id;

    await ctx.pool.query(
      `INSERT INTO cart_lines (cart_id, variant_id, quantity, price) VALUES ($1::uuid, $2::uuid, 1, 75.00)`,
      [cartId, variantId2]
    );

    const checkoutRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO checkouts (store_id, cart_id, status, currency, subtotal, shipping_total, tax_total, discount_total, total)
       VALUES ($1::uuid, $2::uuid, 'pending', 'USD', 75.00, 0, 0, 0, 75.00)
       RETURNING id::text`,
      [store.id, cartId]
    );
    const checkoutId = checkoutRes.rows[0]!.id;

    const orderRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders (store_id, checkout_id, order_number, currency, status, financial_status, fulfillment_status, subtotal, shipping_total, tax_total, discount_total, total)
       VALUES ($1::uuid, $2::uuid, next_order_number($1::uuid), 'USD', 'open', 'pending', 'unfulfilled', 75.00, 0, 0, 0, 75.00)
       RETURNING id::text`,
      [store.id, checkoutId]
    );
    const orderId = orderRes.rows[0]!.id;

    const beforeCount = mockServer.requests.length;

    // Send a valid Stripe webhook to trigger recordPaymentSuccess
    const eventId = `evt_audit_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const piId = `pi_audit_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const webhookPayload = JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: piId,
          amount: 7500, // cents
          currency: "usd",
          metadata: { checkout_id: checkoutId },
        },
      },
    });

    const sigHeader = signStripe(webhookPayload, STRIPE_WEBHOOK_SECRET);
    const webhookUrl = `${ctx.baseUrl}/webhooks/${store.id}/payment/${slug}`;
    const webhookRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": sigHeader },
      body: webhookPayload,
    });
    expect(webhookRes.status).toBe(200);

    // Wait for the async dispatchStoreEvent to fire
    await waitForRequests(mockServer, beforeCount + 1);

    const req = mockServer.requests.at(-1);
    expect(req).toBeDefined();
    expect(req!.headers["x-cartcrft-event"]).toBe("payment.captured");
    expect(req!.headers["x-cartcrft-store-id"]).toBe(store.id);
    const sig = req!.headers["x-cartcrft-signature"];
    expect(sig).toBeDefined();
    const mac = createHmac("sha256", secret);
    mac.update(Buffer.from(req!.body, "utf8"));
    expect(sig).toBe(mac.digest("hex"));

    const payload = JSON.parse(req!.body) as Record<string, unknown>;
    expect(payload["event"]).toBe("payment.captured");
    expect(payload["order_id"]).toBe(orderId);
    expect(typeof payload["payment_id"]).toBe("string");

    // Delivery log row must exist
    await new Promise((r) => setTimeout(r, 200));
    const log = await getLatestDeliveryLog(ctx.pool, providerId);
    expect(log).not.toBeNull();
    expect(log!.status_code).toBe(200);
    expect(log!.event).toBe("payment.captured");
  });
});
