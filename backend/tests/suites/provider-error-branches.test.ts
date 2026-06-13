/**
 * provider-error-branches.test.ts — H6.4: Payment provider client non-2xx branch tests.
 *
 * The payment-session suite tests happy-path only.  This suite mocks the
 * provider HTTP layer to return non-2xx / error bodies and asserts that
 * the client (StripeClient, PaystackClient, RazorpayClient, XenditClient)
 * surfaces an error — not a silent success.
 *
 * Two levels are tested:
 *  1. Unit: call the client class directly with stubbed global fetch (no DB).
 *  2. Integration: drive cart→checkout→payment-session against a live test
 *     server; confirm the route returns 5xx (or surfaces the error) rather
 *     than a silent 200 with bad data.
 *
 * Mocking strategy: the same URL-discriminating fetch stub as payment-session.test.ts.
 * Provider API calls go to external domains (stripe.com, paystack.co, etc.) and
 * are intercepted; local 127.0.0.1 traffic passes through to the real test server.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  post,
  mintJwt,
  createApiKey,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { StripeClient } from "../../src/providers/payments/stripe.js";
import { PaystackClient } from "../../src/providers/payments/paystack.js";
import { RazorpayClient } from "../../src/providers/payments/razorpay.js";
import { XenditClient } from "../../src/providers/payments/xendit.js";

// ── Unit-level tests (no DB) ──────────────────────────────────────────────────

const REAL_FETCH = globalThis.fetch;

/**
 * Stub global fetch for all requests (unit tests — no local server involved).
 * Restores automatically via afterEach.
 */
function stubAllFetch(
  responseBody: Record<string, unknown>,
  opts: { ok?: boolean; status?: number } = {}
) {
  const ok = opts.ok ?? false;
  const status = opts.status ?? 400;
  vi.stubGlobal(
    "fetch",
    async (_url: unknown, _init?: unknown) =>
      ({
        ok,
        status,
        text: async () => JSON.stringify(responseBody),
        json: async () => responseBody,
      } as unknown as Response)
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── StripeClient — non-ok branch ──────────────────────────────────────────────

describe("StripeClient — non-2xx error branches", () => {
  it("throws an error when Stripe returns 400 with error envelope", async () => {
    stubAllFetch(
      {
        error: {
          type: "card_error",
          code: "card_declined",
          message: "Your card was declined.",
        },
      },
      { ok: false, status: 400 }
    );

    const client = new StripeClient("sk_test_fake");
    await expect(
      client.createPaymentIntent({
        amountCents: 5000,
        currency: "usd",
        checkoutId: randomUUID(),
      })
    ).rejects.toThrow();
  });

  it("throws when Stripe returns 401 Unauthorized", async () => {
    stubAllFetch(
      { error: { type: "invalid_request_error", message: "No such API key" } },
      { ok: false, status: 401 }
    );

    const client = new StripeClient("sk_test_invalid");
    await expect(
      client.createPaymentIntent({
        amountCents: 1000,
        currency: "usd",
        checkoutId: randomUUID(),
      })
    ).rejects.toThrow();
  });

  it("throws when Stripe returns 500 with error body", async () => {
    stubAllFetch(
      { error: { message: "An error occurred with our servers." } },
      { ok: false, status: 500 }
    );

    const client = new StripeClient("sk_test_fake");
    await expect(
      client.createPaymentIntent({
        amountCents: 2000,
        currency: "usd",
        checkoutId: randomUUID(),
      })
    ).rejects.toThrow();
  });

  it("error message from Stripe error envelope is surfaced", async () => {
    const errorMessage = "Your card was declined.";
    stubAllFetch(
      { error: { type: "card_error", code: "card_declined", message: errorMessage } },
      { ok: false, status: 402 }
    );

    const client = new StripeClient("sk_test_fake");
    await expect(
      client.createPaymentIntent({
        amountCents: 5000,
        currency: "usd",
        checkoutId: randomUUID(),
      })
    ).rejects.toThrow(errorMessage);
  });
});

// ── PaystackClient — non-ok branch ───────────────────────────────────────────

describe("PaystackClient — non-2xx error branches", () => {
  it("throws when Paystack returns 401 unauthorized", async () => {
    stubAllFetch(
      { status: false, message: "Invalid key. Please use your valid/test secret key." },
      { ok: false, status: 401 }
    );

    const client = new PaystackClient("sk_test_invalid");
    await expect(
      client.initializeTransaction({
        email: "buyer@example.com",
        amountKobo: 5000,
      })
    ).rejects.toThrow();
  });

  it("throws when Paystack returns 400 with error body", async () => {
    stubAllFetch(
      { status: false, message: "Email is invalid" },
      { ok: false, status: 400 }
    );

    const client = new PaystackClient("sk_test_fake");
    await expect(
      client.initializeTransaction({
        email: "not-an-email",
        amountKobo: 5000,
      })
    ).rejects.toThrow();
  });

  it("throws when Paystack returns 200 OK but status=false in body", async () => {
    // Paystack wraps errors in an envelope with status=false even on HTTP 200
    stubAllFetch(
      { status: false, message: "Duplicate transaction reference" },
      { ok: true, status: 200 }
    );

    const client = new PaystackClient("sk_test_fake");
    await expect(
      client.initializeTransaction({
        email: "buyer@example.com",
        amountKobo: 5000,
        reference: "dup-ref",
      })
    ).rejects.toThrow("Duplicate transaction reference");
  });

  it("throws when Paystack returns 500 server error", async () => {
    stubAllFetch(
      { status: false, message: "Internal server error" },
      { ok: false, status: 500 }
    );

    const client = new PaystackClient("sk_test_fake");
    await expect(
      client.initializeTransaction({
        email: "buyer@example.com",
        amountKobo: 5000,
      })
    ).rejects.toThrow();
  });
});

// ── RazorpayClient — non-ok branch ───────────────────────────────────────────

describe("RazorpayClient — non-2xx error branches", () => {
  it("throws when Razorpay returns 401 bad credentials", async () => {
    stubAllFetch(
      {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "The api key provided is invalid",
          field: null,
          step: null,
          reason: null,
          metadata: {},
          source: "NA",
        },
      },
      { ok: false, status: 401 }
    );

    const client = new RazorpayClient("rzp_test_invalid_id", "invalid_secret");
    await expect(
      client.createOrder({
        amountSmallest: 50000,
        currency: "INR",
        checkoutId: randomUUID(),
      })
    ).rejects.toThrow();
  });

  it("throws when Razorpay returns 400 validation error", async () => {
    stubAllFetch(
      {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "amount: The amount must be at least 100",
          source: "business",
        },
      },
      { ok: false, status: 400 }
    );

    const client = new RazorpayClient("rzp_test_fake_id", "rzp_test_fake_secret");
    await expect(
      client.createOrder({
        amountSmallest: 1, // below minimum
        currency: "INR",
        checkoutId: randomUUID(),
      })
    ).rejects.toThrow();
  });

  it("throws when Razorpay returns 500 server error", async () => {
    stubAllFetch(
      { error: { code: "SERVER_ERROR", description: "Something went wrong." } },
      { ok: false, status: 500 }
    );

    const client = new RazorpayClient("rzp_test_fake_id", "rzp_test_fake_secret");
    await expect(
      client.createOrder({
        amountSmallest: 50000,
        currency: "INR",
        checkoutId: randomUUID(),
      })
    ).rejects.toThrow();
  });
});

// ── XenditClient — non-ok branch ─────────────────────────────────────────────

describe("XenditClient — non-2xx error branches", () => {
  it("throws when Xendit returns 401 unauthorized", async () => {
    stubAllFetch(
      { errorCode: "REQUEST_FORBIDDEN_ERROR", message: "API key not found" },
      { ok: false, status: 401 }
    );

    const client = new XenditClient("xnd_test_invalid");
    await expect(
      client.createInvoice({
        externalId: randomUUID(),
        amount: 100000,
        currency: "IDR",
      })
    ).rejects.toThrow();
  });

  it("throws when Xendit returns 400 validation error", async () => {
    stubAllFetch(
      { errorCode: "VALIDATION_ERROR", message: "amount must be positive" },
      { ok: false, status: 400 }
    );

    const client = new XenditClient("xnd_test_fake");
    await expect(
      client.createInvoice({
        externalId: randomUUID(),
        amount: -100,
        currency: "IDR",
      })
    ).rejects.toThrow();
  });

  it("throws when Xendit returns 500 server error", async () => {
    stubAllFetch(
      { errorCode: "SERVER_ERROR", message: "Internal error" },
      { ok: false, status: 500 }
    );

    const client = new XenditClient("xnd_test_fake");
    await expect(
      client.createInvoice({
        externalId: randomUUID(),
        amount: 100000,
        currency: "IDR",
      })
    ).rejects.toThrow();
  });
});

// ── Integration: provider error surfaces through the payment-session route ────
//
// Drive cart→checkout→payment-session with a mocked provider returning non-2xx.
// The route must NOT return a silent 200 — it must bubble the provider error
// as a 5xx or structured error response.

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

/**
 * Stub global fetch: pass through 127.0.0.1 (test server),
 * intercept external provider calls with the given mock.
 */
function stubProviderFetch(
  responseBody: Record<string, unknown>,
  opts: { ok?: boolean; status?: number } = {}
) {
  const ok = opts.ok ?? false;
  const status = opts.status ?? 400;
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
          ? url.toString()
          : (url as Request).url;

      if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
        return REAL_FETCH(url as string, init);
      }

      return {
        ok,
        status,
        text: async () => JSON.stringify(responseBody),
        json: async () => responseBody,
      };
    }
  );
}

async function setupStoreWithProvider(type: string, config: Record<string, unknown>) {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(
    ctx,
    "/commerce/stores",
    { name: `ProvErr ${type} ${randomUUID().slice(0, 6)}`, currency: "USD" },
    auth
  );
  if (storeRes.status !== 201) {
    throw new Error(`setupStore: ${JSON.stringify(storeRes.body)}`);
  }
  const storeId = storeRes.json["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const keyAuth = { type: "api-key" as const, key: apiKey };

  // Seed provider
  await ctx.pool.query(
    `INSERT INTO payment_providers (store_id, name, type, slug, config, is_active, position)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, true, 0)`,
    [storeId, `${type} test`, type, type, JSON.stringify(config)]
  );

  return { storeId, keyAuth };
}

async function buildCheckout(
  storeId: string,
  keyAuth: { type: "api-key"; key: string },
  email?: string
) {
  const product = await insertProduct(ctx.pool, { storeId, title: "Test Widget" });
  const variant = await insertVariant(ctx.pool, {
    productId: product.id,
    title: "Default",
    price: "50.00",
  });

  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
  expect(cartRes.status).toBe(201);
  const cartId = cartRes.json["id"] as string;

  await post(
    ctx,
    `/commerce/stores/${storeId}/carts/${cartId}/lines`,
    { variant_id: variant.id, quantity: 1 },
    keyAuth
  );

  const coRes = await post(
    ctx,
    `/commerce/stores/${storeId}/checkouts`,
    { cart_id: cartId, ...(email ? { email } : {}) },
    keyAuth
  );
  expect(coRes.status).toBe(201);
  return coRes.json["id"] as string;
}

describe("Integration — provider error surfaces through payment-session route", () => {
  it("Stripe 400 from provider → route returns error (not silent 200)", async () => {
    const { storeId, keyAuth } = await setupStoreWithProvider("stripe", {
      secret_key: "sk_test_fake_err",
    });
    const checkoutId = await buildCheckout(storeId, keyAuth, "buyer@example.com");

    stubProviderFetch(
      { error: { type: "card_error", message: "Your card was declined." } },
      { ok: false, status: 400 }
    );

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    // The route must not silently return 200 with an empty session
    expect(res.status).not.toBe(200);
    // Should be a 4xx or 5xx
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("Paystack 401 from provider → route returns error", async () => {
    const { storeId, keyAuth } = await setupStoreWithProvider("paystack", {
      secret_key: "sk_test_invalid",
    });
    const checkoutId = await buildCheckout(storeId, keyAuth, "buyer@example.com");

    stubProviderFetch(
      { status: false, message: "Invalid API key" },
      { ok: false, status: 401 }
    );

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("Razorpay 401 from provider → route returns error", async () => {
    const { storeId, keyAuth } = await setupStoreWithProvider("razorpay", {
      key_id: "rzp_test_bad",
      key_secret: "bad_secret",
    });
    const checkoutId = await buildCheckout(storeId, keyAuth);

    stubProviderFetch(
      { error: { code: "BAD_REQUEST_ERROR", description: "Invalid API key" } },
      { ok: false, status: 401 }
    );

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("Xendit 400 from provider → route returns error", async () => {
    const { storeId, keyAuth } = await setupStoreWithProvider("xendit", {
      api_key: "xnd_test_bad",
    });
    const checkoutId = await buildCheckout(storeId, keyAuth, "buyer@example.com");

    stubProviderFetch(
      { errorCode: "VALIDATION_ERROR", message: "External ID already used" },
      { ok: false, status: 400 }
    );

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
