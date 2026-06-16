/**
 * payment-refund.test.ts — Live provider refund wiring.
 *
 * createRefund() must actually call the payment provider's refund REST API
 * (not just write a local bookkeeping row). For each provider this suite:
 *   - seeds a store + active payment_provider (with config)
 *   - inserts an order + a CAPTURED payment carrying provider_id +
 *     provider_reference (the provider's charge/transaction id)
 *   - mocks the provider HTTP with a URL-discriminating fetch stub
 *   - POSTs the refund and asserts:
 *       · the correct provider refund endpoint was hit (URL + auth + body)
 *       · the local refund row stores the mapped status + provider refund id
 *
 * Also covers:
 *   - provider failure  → refund row persisted as 'failed', route returns 502,
 *     total_refunded NOT incremented
 *   - 'webhook' provider type → 400 (cannot refund programmatically)
 *   - local payment (no provider/reference) → legacy bookkeeping refund (201)
 *   - idempotency: a refund that already has a provider_reference is not
 *     re-sent to the provider
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

const REAL_FETCH = globalThis.fetch;

/** Captured external provider calls so tests can assert URL/auth/body. */
type CapturedCall = { url: string; init: RequestInit };

/**
 * Stub fetch: pass localhost (the test server) through to the real fetch, and
 * mock external provider API calls with the supplied response. Records every
 * external call into `calls`.
 */
function stubProviderFetch(
  calls: CapturedCall[],
  mockResponse: Record<string, unknown>,
  opts: { ok?: boolean; status?: number } = {}
) {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;

  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;

    if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
      return REAL_FETCH(url as string, init);
    }

    calls.push({ url: urlStr, init: init ?? {} });
    return {
      ok,
      status,
      text: async () => JSON.stringify(mockResponse),
      json: async () => mockResponse,
    };
  });
}

async function authFor() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  return { auth: { type: "bearer" as const, token }, userId, orgId };
}

async function createStore(auth: { type: "bearer"; token: string }): Promise<string> {
  const res = await ctx.request({
    method: "POST",
    path: "/commerce/stores",
    body: { name: `Refund Store ${randomUUID().slice(0, 8)}` },
    headers: { authorization: `Bearer ${auth.token}` },
  });
  if (res.status !== 201) {
    throw new Error(`createStore: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

async function seedProvider(
  storeId: string,
  opts: { type: string; slug: string; config: Record<string, unknown> }
): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO payment_providers (store_id, name, type, slug, config, is_active, position)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, true, 0)
     RETURNING id::text`,
    [storeId, `${opts.type} provider`, opts.type, opts.slug, JSON.stringify(opts.config)]
  );
  return rows[0]!.id;
}

async function insertOrder(storeId: string, total = "100.00"): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO orders
       (store_id, order_number, currency, status, financial_status, fulfillment_status,
        subtotal, shipping_total, tax_total, discount_total, total)
     VALUES ($1::uuid, next_order_number($1::uuid), 'USD', 'open', 'paid', 'unfulfilled',
             $2::numeric, 0, 0, 0, $2::numeric)
     RETURNING id::text`,
    [storeId, total]
  );
  return rows[0]!.id;
}

/** Insert a CAPTURED payment row with provider linkage. */
async function insertCapturedPayment(
  orderId: string,
  opts: {
    amount?: string;
    currency?: string;
    providerId?: string | null;
    providerReference?: string | null;
  } = {}
): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO payments
       (order_id, provider_id, amount, currency, status, provider_reference, captured_at, mode)
     VALUES ($1::uuid, $2, $3::numeric, $4, 'captured', $5, now(), 'live')
     RETURNING id::text`,
    [
      orderId,
      opts.providerId ?? null,
      opts.amount ?? "100.00",
      opts.currency ?? "USD",
      opts.providerReference ?? null,
    ]
  );
  return rows[0]!.id;
}

async function postRefund(
  storeId: string,
  orderId: string,
  paymentId: string,
  body: Record<string, unknown>,
  auth: { type: "bearer"; token: string },
  idempotencyKey?: string
) {
  return ctx.request({
    method: "POST",
    path: `/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/refund`,
    body,
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  });
}

async function getRefund(id: string) {
  const { rows } = await ctx.pool.query<{
    status: string;
    provider_reference: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT status, provider_reference, metadata FROM refunds WHERE id = $1::uuid`,
    [id]
  );
  return rows[0] ?? null;
}

// ── Stripe ────────────────────────────────────────────────────────────────────

describe("Stripe provider refund", () => {
  let storeId: string;
  let providerId: string;
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    ({ auth } = await authFor());
    storeId = await createStore(auth);
    providerId = await seedProvider(storeId, {
      type: "stripe",
      slug: "stripe",
      config: { secret_key: "sk_test_fake_stripe" },
    });
  });

  it("calls Stripe /refunds and persists succeeded + provider refund id", async () => {
    const orderId = await insertOrder(storeId, "100.00");
    const paymentId = await insertCapturedPayment(orderId, {
      providerId,
      providerReference: "pi_charge_001",
    });

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, { id: "re_stripe_001", status: "succeeded" });

    const res = await postRefund(
      storeId,
      orderId,
      paymentId,
      { amount: "25.00", reason: "customer_request" },
      auth
    );

    expect(res.status).toBe(201);
    expect(res.json["status"]).toBe("succeeded");

    // Provider was actually called with the right URL/auth/body.
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/refunds");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk_test_fake_stripe");
    const body = new URLSearchParams(calls[0]!.init.body as string);
    expect(body.get("payment_intent")).toBe("pi_charge_001");
    expect(body.get("amount")).toBe("2500"); // 25.00 → minor units

    const refund = await getRefund(res.json["id"] as string);
    expect(refund!.status).toBe("succeeded");
    expect(refund!.provider_reference).toBe("re_stripe_001");

    const { rows } = await ctx.pool.query<{ total_refunded: string }>(
      `SELECT total_refunded::text FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(parseFloat(rows[0]!.total_refunded)).toBeCloseTo(25, 2);
  });

  it("on provider failure: persists 'failed', returns 502, does not move money", async () => {
    const orderId = await insertOrder(storeId, "100.00");
    const paymentId = await insertCapturedPayment(orderId, {
      providerId,
      providerReference: "pi_charge_002",
    });

    const calls: CapturedCall[] = [];
    stubProviderFetch(
      calls,
      { error: { message: "charge already refunded" } },
      { ok: false, status: 402 }
    );

    const res = await postRefund(
      storeId,
      orderId,
      paymentId,
      { amount: "10.00" },
      auth
    );

    expect(res.status).toBe(502);
    expect(res.json["error"]["code"]).toBe("PROVIDER_REFUND_FAILED");
    const refundId = res.json["refund"]["id"] as string;

    const refund = await getRefund(refundId);
    expect(refund!.status).toBe("failed");
    expect(String(refund!.metadata["provider_error"])).toContain("already refunded");

    // total_refunded must NOT have moved.
    const { rows } = await ctx.pool.query<{ total_refunded: string }>(
      `SELECT total_refunded::text FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(parseFloat(rows[0]!.total_refunded)).toBeCloseTo(0, 2);
  });

  it("idempotent: a refund with an existing provider_reference does not re-call the provider", async () => {
    const orderId = await insertOrder(storeId, "100.00");
    const paymentId = await insertCapturedPayment(orderId, {
      providerId,
      providerReference: "pi_charge_003",
    });

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, { id: "re_stripe_003", status: "succeeded" });

    // Webhook-style insert: caller supplies provider_reference → must NOT call.
    const res = await postRefund(
      storeId,
      orderId,
      paymentId,
      { amount: "5.00", provider_reference: "re_already_known" },
      auth
    );

    expect(res.status).toBe(201);
    expect(calls.length).toBe(0); // provider NOT called
    const refund = await getRefund(res.json["id"] as string);
    expect(refund!.provider_reference).toBe("re_already_known");
  });
});

// ── Paystack ──────────────────────────────────────────────────────────────────

describe("Paystack provider refund", () => {
  it("calls Paystack /refund with transaction + amount", async () => {
    const { auth } = await authFor();
    const storeId = await createStore(auth);
    const providerId = await seedProvider(storeId, {
      type: "paystack",
      slug: "paystack",
      config: { secret_key: "sk_test_fake_paystack" },
    });
    const orderId = await insertOrder(storeId, "100.00");
    const paymentId = await insertCapturedPayment(orderId, {
      providerId,
      providerReference: "txn_ref_ps",
      currency: "ZAR",
    });

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, {
      status: true,
      message: "queued",
      data: { id: 42, status: "pending" },
    });

    const res = await postRefund(
      storeId,
      orderId,
      paymentId,
      { amount: "30.00" },
      auth
    );

    expect(res.status).toBe(201);
    expect(res.json["status"]).toBe("pending");
    expect(calls[0]!.url).toBe("https://api.paystack.co/refund");
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body["transaction"]).toBe("txn_ref_ps");
    expect(body["amount"]).toBe(3000);

    const refund = await getRefund(res.json["id"] as string);
    expect(refund!.provider_reference).toBe("42");
  });
});

// ── Razorpay ──────────────────────────────────────────────────────────────────

describe("Razorpay provider refund", () => {
  it("calls Razorpay /payments/{id}/refund and maps processed → succeeded", async () => {
    const { auth } = await authFor();
    const storeId = await createStore(auth);
    const providerId = await seedProvider(storeId, {
      type: "razorpay",
      slug: "razorpay",
      config: { key_id: "rzp_id", key_secret: "rzp_secret" },
    });
    const orderId = await insertOrder(storeId, "100.00");
    const paymentId = await insertCapturedPayment(orderId, {
      providerId,
      providerReference: "pay_rzp_001",
    });

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, { id: "rfnd_rzp_001", status: "processed" });

    const res = await postRefund(
      storeId,
      orderId,
      paymentId,
      { amount: "40.00" },
      auth
    );

    expect(res.status).toBe(201);
    expect(res.json["status"]).toBe("succeeded");
    expect(calls[0]!.url).toBe(
      "https://api.razorpay.com/v1/payments/pay_rzp_001/refund"
    );
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body["amount"]).toBe(4000);

    const refund = await getRefund(res.json["id"] as string);
    expect(refund!.provider_reference).toBe("rfnd_rzp_001");
  });
});

// ── Xendit ────────────────────────────────────────────────────────────────────

describe("Xendit provider refund", () => {
  it("calls Xendit /refunds with invoice_id + amount in major units", async () => {
    const { auth } = await authFor();
    const storeId = await createStore(auth);
    const providerId = await seedProvider(storeId, {
      type: "xendit",
      slug: "xendit",
      config: { api_key: "xnd_fake" },
    });
    const orderId = await insertOrder(storeId, "100.00");
    const paymentId = await insertCapturedPayment(orderId, {
      providerId,
      providerReference: "inv_xnd_001",
    });

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, { id: "rfd_xnd_001", status: "PENDING" });

    const res = await postRefund(
      storeId,
      orderId,
      paymentId,
      { amount: "60.00" },
      auth
    );

    expect(res.status).toBe(201);
    expect(res.json["status"]).toBe("processing");
    expect(calls[0]!.url).toBe("https://api.xendit.co/refunds");
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body["invoice_id"]).toBe("inv_xnd_001");
    expect(body["amount"]).toBe(60); // major units — NOT 6000
  });
});

// ── Non-refundable + local refunds ────────────────────────────────────────────

describe("Refund provider edge cases", () => {
  it("webhook provider type → 400 (cannot refund programmatically)", async () => {
    const { auth } = await authFor();
    const storeId = await createStore(auth);
    const providerId = await seedProvider(storeId, {
      type: "webhook",
      slug: "webhook",
      config: {},
    });
    const orderId = await insertOrder(storeId, "100.00");
    const paymentId = await insertCapturedPayment(orderId, {
      providerId,
      providerReference: "evt_ref",
    });

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, {});

    const res = await postRefund(storeId, orderId, paymentId, { amount: "5.00" }, auth);

    expect(res.status).toBe(400);
    expect(res.json["error"]["code"]).toBe("VALIDATION_ERROR");
    expect(calls.length).toBe(0);
  });

  it("local payment (no provider, no reference) → 201 bookkeeping refund, no provider call", async () => {
    const { auth } = await authFor();
    const storeId = await createStore(auth);
    const orderId = await insertOrder(storeId, "100.00");
    const paymentId = await insertCapturedPayment(orderId, {
      providerId: null,
      providerReference: null,
    });

    const calls: CapturedCall[] = [];
    stubProviderFetch(calls, {});

    const res = await postRefund(storeId, orderId, paymentId, { amount: "15.00" }, auth);

    expect(res.status).toBe(201);
    expect(calls.length).toBe(0);
    const refund = await getRefund(res.json["id"] as string);
    expect(refund!.status).toBe("pending");

    const { rows } = await ctx.pool.query<{ total_refunded: string }>(
      `SELECT total_refunded::text FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(parseFloat(rows[0]!.total_refunded)).toBeCloseTo(15, 2);
  });
});
