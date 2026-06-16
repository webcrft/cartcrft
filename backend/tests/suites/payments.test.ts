/**
 * payments — Payments, refunds, and provider CRUD suite.
 *
 * Tests:
 *  1. Create payment → { id, mode: 'live', is_test: false }
 *  2. Create payment with mode='dev' → is_test=true
 *  3. List payments
 *  4. Capture payment → ok; order financial_status=paid
 *  5. Capture already-captured → 409
 *  6. Create refund (partial) → order total_refunded updated
 *  7. Over-refund → 400
 *  8. Idempotency: same provider_reference on CreatePayment → returns existing id
 *  9. Provider client unit tests (mocked fetch)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  mintJwt,
  isErrorEnvelope,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

/** Create a store via REST, return its id. */
async function createStore(
  orgId: string,
  auth: { type: "bearer"; token: string }
): Promise<string> {
  const res = await post(ctx, "/commerce/stores", { name: "Payments Test Store" }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

/** Insert a minimal order directly via SQL, bypassing REST. */
async function insertOrder(
  storeId: string,
  currency = "USD",
  total = "100.00"
): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders
       (store_id, order_number, currency, status, financial_status, fulfillment_status,
        subtotal, shipping_total, tax_total, discount_total, total)
     VALUES
       ($1::uuid, next_order_number($1::uuid), $2, 'open', 'pending', 'unfulfilled',
        $3::numeric, 0, 0, 0, $3::numeric)
     RETURNING id::text`,
    [storeId, currency, total]
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("insertOrder: no id returned");
  return id;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Payments CRUD", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;
  let orderId: string;
  let paymentId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(orgId, auth);
    orderId = await insertOrder(storeId, "USD", "100.00");
  });

  it("1. Create payment → { id, mode: 'live', is_test: false }", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/payments`,
      { amount: "100.00", currency: "USD" },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    expect(res.json["mode"]).toBe("live");
    expect(res.json["is_test"]).toBe(false);
    paymentId = res.json["id"] as string;
  });

  it("2. Create payment with mode='dev' → is_test=true", async () => {
    const devOrderId = await insertOrder(storeId, "USD", "50.00");
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${devOrderId}/payments`,
      { amount: "50.00", currency: "USD", mode: "dev" },
      auth
    );
    expect(res.status).toBe(201);
    expect(res.json["mode"]).toBe("dev");
    expect(res.json["is_test"]).toBe(true);
  });

  it("3. List payments", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/payments`,
      auth
    );
    expect(res.status).toBe(200);
    const payments = res.json["payments"] as unknown[];
    expect(Array.isArray(payments)).toBe(true);
    expect(payments.length).toBeGreaterThan(0);
  });

  it("4. Capture payment → ok; order financial_status=paid", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/capture`,
      {},
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    // Check order financial_status is now 'paid'
    const { rows } = await ctx.pool.query<{ financial_status: string }>(
      `SELECT financial_status FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(rows[0]?.financial_status).toBe("paid");
  });

  it("5. Capture already-captured payment → 409", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/capture`,
      {},
      auth
    );
    expect(res.status).toBe(409);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("6. Create refund (partial) → order total_refunded updated", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/refund`,
      { amount: "25.00", reason: "customer_request", notes: "Partial refund" },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");

    // Check order total_refunded updated
    const { rows } = await ctx.pool.query<{ total_refunded: string }>(
      `SELECT total_refunded::text FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(parseFloat(rows[0]?.total_refunded ?? "0")).toBeCloseTo(25.0, 1);
  });

  it("7. Over-refund → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/refund`,
      { amount: "999.99", reason: "other" },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("8. Idempotency: same provider_reference → returns existing id", async () => {
    const idempOrderId = await insertOrder(storeId, "USD", "200.00");
    const provRef = `idempotent-ref-${randomUUID()}`;

    const res1 = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${idempOrderId}/payments`,
      {
        amount: "50.00",
        currency: "USD",
        provider_reference: provRef,
      },
      auth
    );
    expect(res1.status).toBe(201);
    const id1 = res1.json["id"] as string;

    // Same provider_reference → idempotent — should return same id
    const res2 = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${idempOrderId}/payments`,
      {
        amount: "50.00",
        currency: "USD",
        provider_reference: provRef,
      },
      auth
    );
    expect([200, 201]).toContain(res2.status);
    expect(res2.json["id"]).toBe(id1);
  });

  it("Amount exceeds order balance → 400", async () => {
    const overOrderId = await insertOrder(storeId, "USD", "10.00");
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${overOrderId}/payments`,
      { amount: "999.00", currency: "USD" },
      auth
    );
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("Partially paid: partial capture sets financial_status=partially_paid", async () => {
    const partialOrderId = await insertOrder(storeId, "USD", "100.00");

    // Create payment for 40 out of 100
    const res1 = await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${partialOrderId}/payments`,
      { amount: "40.00", currency: "USD" },
      auth
    );
    expect(res1.status).toBe(201);
    const partPaymentId = res1.json["id"] as string;

    // Capture the 40
    await post(
      ctx,
      `/commerce/stores/${storeId}/orders/${partialOrderId}/payments/${partPaymentId}/capture`,
      {},
      auth
    );

    // Check financial_status is partially_paid
    const { rows } = await ctx.pool.query<{ financial_status: string }>(
      `SELECT financial_status FROM orders WHERE id = $1::uuid`,
      [partialOrderId]
    );
    expect(rows[0]?.financial_status).toBe("partially_paid");
  });
});

// ── Provider client unit tests (mocked fetch) ─────────────────────────────────

describe("Provider client unit tests", () => {
  it("StripeClient.createPaymentIntent calls correct endpoint", async () => {
    const { StripeClient } = await import(
      "../../src/providers/payments/stripe.js"
    );

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "pi_test123",
        client_secret: "pi_test123_secret_xyz",
        status: "requires_payment_method",
        currency: "usd",
        amount: 9999,
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const client = new StripeClient("sk_test_fake");
    const result = await client.createPaymentIntent({
      amountCents: 9999,
      currency: "usd",
      checkoutId: "checkout-abc",
    });

    expect(result.id).toBe("pi_test123");
    expect(result.clientSecret).toBe("pi_test123_secret_xyz");
    expect(result.amount).toBe(9999);

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toContain("stripe.com/v1/payment_intents");
    expect(callArgs[1].method).toBe("POST");

    vi.unstubAllGlobals();
  });

  it("PaystackClient.initializeTransaction unwraps data envelope", async () => {
    const { PaystackClient } = await import(
      "../../src/providers/payments/paystack.js"
    );

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: true,
        message: "Authorization URL created",
        data: {
          authorization_url: "https://checkout.paystack.com/abc123",
          access_code: "abc123",
          reference: "checkout-xyz",
        },
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const client = new PaystackClient("sk_test_fake");
    const result = await client.initializeTransaction({
      email: "test@example.com",
      amountKobo: 10000,
      reference: "checkout-xyz",
    });

    expect(result.authorizationUrl).toBe(
      "https://checkout.paystack.com/abc123"
    );
    expect(result.reference).toBe("checkout-xyz");

    vi.unstubAllGlobals();
  });

  it("RazorpayClient.createOrder uses Basic auth", async () => {
    const { RazorpayClient } = await import(
      "../../src/providers/payments/razorpay.js"
    );

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "order_razorpay123",
        amount: 50000,
        currency: "INR",
        status: "created",
        receipt: "checkout-abc",
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const client = new RazorpayClient("key_id_test", "key_secret_test");
    const result = await client.createOrder({
      amountSmallest: 50000,
      currency: "INR",
      checkoutId: "checkout-abc",
    });

    expect(result.id).toBe("order_razorpay123");
    expect(result.receipt).toBe("checkout-abc");

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["Authorization"]).toMatch(/^Basic /);

    vi.unstubAllGlobals();
  });

  it("XenditClient.createInvoice maps camelCase to snake_case", async () => {
    const { XenditClient } = await import(
      "../../src/providers/payments/xendit.js"
    );

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "inv_xendit123",
        invoice_url: "https://checkout.xendit.co/web/inv_xendit123",
        external_id: "checkout-abc",
        status: "PENDING",
        amount: 100,
        currency: "IDR",
      }),
    });

    vi.stubGlobal("fetch", mockFetch);

    const client = new XenditClient("xnd_test_fake");
    const result = await client.createInvoice({
      externalId: "checkout-abc",
      amount: 100,
      currency: "IDR",
      payerEmail: "test@example.com",
      description: "Test invoice",
    });

    expect(result.invoiceUrl).toBe(
      "https://checkout.xendit.co/web/inv_xendit123"
    );
    expect(result.externalId).toBe("checkout-abc");

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as Record<string, unknown>;
    expect(body["external_id"]).toBe("checkout-abc");
    expect(body["payer_email"]).toBe("test@example.com");
    expect(body["description"]).toBe("Test invoice");

    vi.unstubAllGlobals();
  });
});

// ── Provider client refund unit tests (mocked fetch) ──────────────────────────

describe("Provider client refund unit tests", () => {
  it("StripeClient.createRefund posts payment_intent + amount to /refunds", async () => {
    const { StripeClient } = await import(
      "../../src/providers/payments/stripe.js"
    );

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "re_test123", status: "succeeded" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new StripeClient("sk_test_fake");
    const result = await client.createRefund({
      providerReference: "pi_abc123",
      amountCents: 2500,
    });

    expect(result.id).toBe("re_test123");
    expect(result.status).toBe("succeeded");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/refunds");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk_test_fake"
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("payment_intent")).toBe("pi_abc123");
    expect(body.get("amount")).toBe("2500");
    expect(body.get("charge")).toBeNull();

    vi.unstubAllGlobals();
  });

  it("StripeClient.createRefund sends a charge id as `charge`", async () => {
    const { StripeClient } = await import(
      "../../src/providers/payments/stripe.js"
    );
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "re_ch", status: "pending" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await new StripeClient("sk_test_fake").createRefund({
      providerReference: "ch_xyz",
      amountCents: 1000,
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("charge")).toBe("ch_xyz");
    expect(body.get("payment_intent")).toBeNull();

    vi.unstubAllGlobals();
  });

  it("StripeClient.createRefund throws on provider error", async () => {
    const { StripeClient } = await import(
      "../../src/providers/payments/stripe.js"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: async () => ({ error: { message: "charge already refunded" } }),
      })
    );

    await expect(
      new StripeClient("sk_test_fake").createRefund({
        providerReference: "pi_abc",
        amountCents: 100,
      })
    ).rejects.toThrow("charge already refunded");

    vi.unstubAllGlobals();
  });

  it("PaystackClient.createRefund posts transaction + amount to /refund", async () => {
    const { PaystackClient } = await import(
      "../../src/providers/payments/paystack.js"
    );
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: true,
        message: "Refund has been queued for processing",
        data: { id: 9988, status: "pending" },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await new PaystackClient("sk_test_fake").createRefund({
      transaction: "txn_ref_001",
      amountKobo: 5000,
      currency: "ZAR",
    });

    expect(result.id).toBe("9988");
    expect(result.status).toBe("pending");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.paystack.co/refund");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer sk_test_fake"
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["transaction"]).toBe("txn_ref_001");
    expect(body["amount"]).toBe(5000);
    expect(body["currency"]).toBe("ZAR");

    vi.unstubAllGlobals();
  });

  it("RazorpayClient.createRefund posts to /payments/{id}/refund with Basic auth", async () => {
    const { RazorpayClient } = await import(
      "../../src/providers/payments/razorpay.js"
    );
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "rfnd_test", status: "processed" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await new RazorpayClient(
      "key_id_test",
      "key_secret_test"
    ).createRefund({ paymentId: "pay_abc123", amountSmallest: 75000 });

    expect(result.id).toBe("rfnd_test");
    expect(result.status).toBe("processed");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.razorpay.com/v1/payments/pay_abc123/refund"
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from("key_id_test:key_secret_test").toString("base64")}`
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["amount"]).toBe(75000);

    vi.unstubAllGlobals();
  });

  it("XenditClient.createRefund posts invoice_id + amount (major units) with Basic auth", async () => {
    const { XenditClient } = await import(
      "../../src/providers/payments/xendit.js"
    );
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "rfd_xendit", status: "PENDING" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await new XenditClient("xnd_test_fake").createRefund({
      invoiceId: "inv_123",
      amount: 100,
      currency: "IDR",
    });

    expect(result.id).toBe("rfd_xendit");
    expect(result.status).toBe("PENDING");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.xendit.co/refunds");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from("xnd_test_fake:").toString("base64")}`
    );
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["invoice_id"]).toBe("inv_123");
    // major units — NOT multiplied by 100
    expect(body["amount"]).toBe(100);

    vi.unstubAllGlobals();
  });
});
