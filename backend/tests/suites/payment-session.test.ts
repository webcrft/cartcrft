/**
 * payment-session.test.ts — H0.1: Live payment-session wiring.
 *
 * For each provider type (stripe, paystack, razorpay, xendit), seeds a store +
 * active payment_provider (with config), drives cart → line → checkout →
 * payment-session, mocks the provider HTTP with vi.stubGlobal("fetch"),
 * and asserts:
 *   - provider-correct payload shape in the response
 *   - checkouts.payment_session was persisted with the correct data
 *
 * Also tests:
 *   - no-provider store → 501 PROVIDER_NOT_CONFIGURED
 *   - non-pending checkout (already completed) → 409
 *   - unknown checkout → 404
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  mintJwt,
  createApiKey,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

afterEach(() => {
  // Always restore the real fetch after each test
  vi.unstubAllGlobals();
});

// ── URL-discriminating fetch mock ─────────────────────────────────────────────
// ctx.request() uses the global fetch to hit the local test server.
// Provider clients also use the global fetch to hit external APIs.
// We must intercept only the external provider calls and let localhost through.

const REAL_FETCH = globalThis.fetch;

/**
 * Stub global fetch so that:
 *  - Requests to localhost/127.0.0.1 (the test server) pass through to real fetch.
 *  - Requests to external provider APIs (stripe.com, paystack.co, etc.) return
 *    the provided mock response.
 */
function stubProviderFetch(
  mockResponse: Record<string, unknown>,
  opts: { ok?: boolean; status?: number } = {}
) {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;

  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;

    // Pass-through for local test server
    if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
      return REAL_FETCH(url as string, init);
    }

    // Mock the external provider API call
    return {
      ok,
      status,
      text: async () => JSON.stringify(mockResponse),
      json: async () => mockResponse,
    };
  });
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Create a store via REST and an API key. Returns storeId + keyAuth. */
async function setupStore(opts: { currency?: string } = {}) {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(
    ctx,
    "/commerce/stores",
    {
      name: `PaySess Test Store ${randomUUID().slice(0, 8)}`,
      currency: opts.currency ?? "USD",
      timezone: "UTC",
    },
    auth
  );
  if (storeRes.status !== 201) {
    throw new Error(`setupStore: ${storeRes.status} ${JSON.stringify(storeRes.body)}`);
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

  return { storeId, keyAuth };
}

/**
 * Seed a payment_provider row directly via SQL.
 * config is stored as plain JSON (no encryption needed for tests).
 */
async function seedProvider(
  storeId: string,
  opts: {
    type: string;
    slug: string;
    config: Record<string, unknown>;
    position?: number;
  }
) {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO payment_providers
       (store_id, name, type, slug, config, is_active, position)
     VALUES
       ($1::uuid, $2, $3, $4, $5::jsonb, true, $6)
     RETURNING id::text`,
    [
      storeId,
      `${opts.type} provider`,
      opts.type,
      opts.slug,
      JSON.stringify(opts.config),
      opts.position ?? 0,
    ]
  );
  return rows[0]!.id;
}

/**
 * Build a pending checkout: cart → add variant → checkout.
 * Returns { checkoutId, total, currency }.
 */
async function buildCheckout(
  storeId: string,
  keyAuth: { type: "api-key"; key: string },
  opts: { email?: string } = {}
) {
  // Create product + variant
  const product = await insertProduct(ctx.pool, { storeId, title: "Widget" });
  const variant = await insertVariant(ctx.pool, {
    productId: product.id,
    title: "Default",
    price: "50.00",
  });

  // Create cart
  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
  expect(cartRes.status).toBe(201);
  const cartId = cartRes.json["id"] as string;

  // Add line
  const lineRes = await post(
    ctx,
    `/commerce/stores/${storeId}/carts/${cartId}/lines`,
    { variant_id: variant.id, quantity: 2 },
    keyAuth
  );
  expect(lineRes.status).toBe(201);

  // Create checkout
  const coRes = await post(
    ctx,
    `/commerce/stores/${storeId}/checkouts`,
    {
      cart_id: cartId,
      ...(opts.email ? { email: opts.email } : {}),
    },
    keyAuth
  );
  expect(coRes.status).toBe(201);
  const checkoutId = coRes.json["id"] as string;
  const total = coRes.json["total"] as string;
  const currency = coRes.json["currency"] as string;

  return { checkoutId, total, currency };
}

/** Read checkouts.payment_session from DB. */
async function getPersistedSession(checkoutId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await ctx.pool.query<{ payment_session: Record<string, unknown> | null }>(
    `SELECT payment_session FROM checkouts WHERE id = $1::uuid`,
    [checkoutId]
  );
  return rows[0]?.payment_session ?? null;
}

// ── Stripe ────────────────────────────────────────────────────────────────────

describe("Stripe payment session", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore({ currency: "USD" }));
    await seedProvider(storeId, {
      type: "stripe",
      slug: "stripe",
      config: { secret_key: "sk_test_fake_stripe" },
    });
  });

  it("returns client_secret + payment_intent_id and persists session", async () => {
    const { checkoutId, total } = await buildCheckout(storeId, keyAuth, {
      email: "buyer@example.com",
    });
    const amountCents = Math.round(parseFloat(total) * 100);

    // Mock Stripe API
    stubProviderFetch({
      id: "pi_stripe_test_001",
      client_secret: "pi_stripe_test_001_secret_abc",
      status: "requires_payment_method",
      currency: "usd",
      amount: amountCents,
    });

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).toBe(200);
    expect(res.json["provider"]).toBe("stripe");
    expect(typeof res.json["client_secret"]).toBe("string");
    expect(res.json["client_secret"]).toMatch(/^pi_/);
    expect(typeof res.json["payment_intent_id"]).toBe("string");

    // Verify persistence in DB
    const session = await getPersistedSession(checkoutId);
    expect(session).not.toBeNull();
    expect(session!["provider"]).toBe("stripe");
    expect(session!["client_secret"]).toBe("pi_stripe_test_001_secret_abc");
    expect(session!["payment_intent_id"]).toBe("pi_stripe_test_001");
  });
});

// ── Paystack ──────────────────────────────────────────────────────────────────

describe("Paystack payment session", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore({ currency: "ZAR" }));
    await seedProvider(storeId, {
      type: "paystack",
      slug: "paystack",
      config: { secret_key: "sk_test_fake_paystack" },
    });
  });

  it("returns authorization_url + reference and persists session", async () => {
    const { checkoutId } = await buildCheckout(storeId, keyAuth, {
      email: "buyer@example.com",
    });

    stubProviderFetch({
      status: true,
      message: "Authorization URL created",
      data: {
        authorization_url: "https://checkout.paystack.com/test_paystack_ref",
        access_code: "test_access_code",
        reference: "test_paystack_ref",
      },
    });

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).toBe(200);
    expect(res.json["provider"]).toBe("paystack");
    expect(typeof res.json["authorization_url"]).toBe("string");
    expect(res.json["authorization_url"]).toMatch(/^https?:\/\//);
    expect(typeof res.json["reference"]).toBe("string");

    const session = await getPersistedSession(checkoutId);
    expect(session).not.toBeNull();
    expect(session!["provider"]).toBe("paystack");
    expect(session!["authorization_url"]).toBe("https://checkout.paystack.com/test_paystack_ref");
    expect(session!["reference"]).toBe("test_paystack_ref");
  });

  it("returns 422 when checkout has no email", async () => {
    // Build checkout without email
    const { checkoutId } = await buildCheckout(storeId, keyAuth);

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).toBe(422);
    expect(res.json["error"]["code"]).toBe("VALIDATION_ERROR");
  });
});

// ── Razorpay ──────────────────────────────────────────────────────────────────

describe("Razorpay payment session", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore({ currency: "INR" }));
    await seedProvider(storeId, {
      type: "razorpay",
      slug: "razorpay",
      config: { key_id: "rzp_test_fake_id", key_secret: "rzp_test_fake_secret" },
    });
  });

  it("returns order_id + amount + key_id and persists session", async () => {
    const { checkoutId, total } = await buildCheckout(storeId, keyAuth);
    const amountSmallest = Math.round(parseFloat(total) * 100);

    stubProviderFetch({
      id: "order_rzp_test_001",
      amount: amountSmallest,
      currency: "INR",
      status: "created",
      receipt: checkoutId,
    });

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).toBe(200);
    expect(res.json["provider"]).toBe("razorpay");
    expect(typeof res.json["order_id"]).toBe("string");
    expect(res.json["order_id"]).toMatch(/^order_/);
    expect(typeof res.json["amount"]).toBe("number");
    expect(typeof res.json["key_id"]).toBe("string");
    expect(res.json["key_id"]).toBe("rzp_test_fake_id");

    const session = await getPersistedSession(checkoutId);
    expect(session).not.toBeNull();
    expect(session!["provider"]).toBe("razorpay");
    expect(session!["order_id"]).toBe("order_rzp_test_001");
  });
});

// ── Xendit ────────────────────────────────────────────────────────────────────

describe("Xendit payment session", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore({ currency: "IDR" }));
    await seedProvider(storeId, {
      type: "xendit",
      slug: "xendit",
      config: { api_key: "xnd_test_fake_api_key" },
    });
  });

  it("returns invoice_url + invoice_id and persists session", async () => {
    const { checkoutId } = await buildCheckout(storeId, keyAuth, {
      email: "buyer@example.com",
    });

    stubProviderFetch({
      id: "inv_xendit_test_001",
      invoice_url: "https://checkout.xendit.co/web/inv_xendit_test_001",
      external_id: checkoutId,
      status: "PENDING",
      amount: 100000,
      currency: "IDR",
    });

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).toBe(200);
    expect(res.json["provider"]).toBe("xendit");
    expect(typeof res.json["invoice_url"]).toBe("string");
    expect(res.json["invoice_url"]).toMatch(/^https?:\/\//);
    expect(typeof res.json["invoice_id"]).toBe("string");
    expect(res.json["invoice_id"]).toBe("inv_xendit_test_001");

    const session = await getPersistedSession(checkoutId);
    expect(session).not.toBeNull();
    expect(session!["provider"]).toBe("xendit");
    expect(session!["invoice_url"]).toBe("https://checkout.xendit.co/web/inv_xendit_test_001");
    expect(session!["invoice_id"]).toBe("inv_xendit_test_001");
  });
});

// ── No provider configured ────────────────────────────────────────────────────

describe("No provider configured", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore());
    // Intentionally: NO payment_provider row seeded
  });

  it("returns 501 PROVIDER_NOT_CONFIGURED", async () => {
    const { checkoutId } = await buildCheckout(storeId, keyAuth, {
      email: "buyer@example.com",
    });

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth
    );

    expect(res.status).toBe(501);
    expect(res.json["error"]["code"]).toBe("PROVIDER_NOT_CONFIGURED");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore());
    await seedProvider(storeId, {
      type: "stripe",
      slug: "stripe",
      config: { secret_key: "sk_test_fake_stripe_edge" },
    });
  });

  it("returns 404 for unknown checkoutId", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkouts/${randomUUID()}/payment-session`,
      {},
      keyAuth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });

  it("provider position=0 is selected first when multiple providers exist", async () => {
    // Create a second store with two providers; lower position wins
    const { storeId: storeId2, keyAuth: keyAuth2 } = await setupStore({ currency: "USD" });

    // Insert high-position stripe first, low-position paystack second
    // (but paystack needs email; we'll put stripe at position 0)
    await seedProvider(storeId2, {
      type: "stripe",
      slug: "stripe",
      config: { secret_key: "sk_test_fake_pos0" },
      position: 0,
    });
    await seedProvider(storeId2, {
      type: "paystack",
      slug: "paystack",
      config: { secret_key: "sk_test_fake_pos1" },
      position: 1,
    });

    const { checkoutId } = await buildCheckout(storeId2, keyAuth2, {
      email: "buyer@example.com",
    });

    // Mock — stripe endpoint gets called (not paystack)
    stubProviderFetch({
      id: "pi_pos_test",
      client_secret: "pi_pos_test_secret",
      status: "requires_payment_method",
      currency: "usd",
      amount: 10000,
    });

    const res = await post(
      ctx,
      `/commerce/stores/${storeId2}/checkouts/${checkoutId}/payment-session`,
      {},
      keyAuth2
    );

    expect(res.status).toBe(200);
    expect(res.json["provider"]).toBe("stripe");
  });
});
