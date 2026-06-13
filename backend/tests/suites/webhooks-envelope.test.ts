/**
 * webhooks-envelope.test.ts — H3.3: Uniform { error: { code, message } } envelope
 *
 * Verifies that every error path in the webhook router returns the project's
 * standard error envelope shape instead of bare { message }.
 *
 * Error paths covered:
 *  E1. Unknown provider / ref → 404 { error: { code: "WEBHOOK_PROVIDER_NOT_FOUND", message } }
 *  E2. Stripe bad signature → 401 { error: { code: "INVALID_SIGNATURE", message } }
 *  E3. Paystack bad signature → 401 { error: { code: "INVALID_SIGNATURE", message } }
 *  E4. Razorpay bad signature → 401 { error: { code: "INVALID_SIGNATURE", message } }
 *  E5. Xendit bad callback token → 401 { error: { code: "INVALID_SIGNATURE", message } }
 *  E6. Custom webhook bad HMAC → 401 { error: { code: "INVALID_SIGNATURE", message } }
 *  E7. Success responses are NOT wrapped — still { message }
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

import { signStripe } from "../../src/webhooks/verifiers/stripe.js";
import { signPaystack } from "../../src/webhooks/verifiers/paystack.js";
import { signRazorpay } from "../../src/webhooks/verifiers/razorpay.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Shared secrets ─────────────────────────────────────────────────────────────

const STRIPE_SECRET  = "whsec_envelope_test_stripe_secret_123";
const PAYSTACK_SECRET = "sk_test_envelope_paystack_secret_456";
const RAZORPAY_SECRET = "rz_test_envelope_razorpay_secret_789";
const XENDIT_TOKEN    = "xendit_envelope_callback_token_test_abc";
const CUSTOM_SECRET   = "custom_hmac_envelope_test_secret_xyz";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function webhookPost(
  storeId: string,
  providerRef: string,
  body: object | string,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const url = `${ctx.baseUrl}/webhooks/${storeId}/payment/${providerRef}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bodyStr,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: res.status, json };
}

async function setupStore(opts: {
  providerType: string;
  config: Record<string, unknown>;
  webhookSecret?: string;
  slug?: string;
}) {
  const userId = randomUUID();
  const orgId  = randomUUID();
  const token  = await mintJwt({ userId, orgId });
  const auth   = { authorization: `Bearer ${token}` };

  const storeRes = await fetch(`${ctx.baseUrl}/commerce/stores`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ name: `Envelope Test Store ${Date.now()}`, currency: "USD" }),
  });
  const storeJson = await storeRes.json() as Record<string, unknown>;
  const storeId = storeJson["id"] as string;

  const slug = opts.slug ?? opts.providerType;
  await ctx.pool.query(
    `INSERT INTO payment_providers
       (store_id, slug, name, type, config, webhook_secret, is_active)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, true)`,
    [
      storeId,
      slug,
      opts.providerType,
      opts.providerType,
      JSON.stringify(opts.config),
      opts.webhookSecret ?? null,
    ]
  );

  return { storeId, slug };
}

// ── Helper: assert error envelope shape ───────────────────────────────────────

function assertErrorEnvelope(
  json: Record<string, unknown>,
  expectedCode: string
): void {
  expect(json).toHaveProperty("error");
  const err = json["error"] as Record<string, unknown>;
  expect(typeof err["code"]).toBe("string");
  expect(typeof err["message"]).toBe("string");
  expect(err["code"]).toBe(expectedCode);
  // Must NOT have a bare "message" at the top level (that would be the old shape)
  expect(json).not.toHaveProperty("message");
}

// ── E1. Unknown provider / ref → 404 ──────────────────────────────────────────

describe("H3.3 Error envelope — provider not found", () => {
  it("E1. unknown providerRef → 404 with { error: { code: WEBHOOK_PROVIDER_NOT_FOUND } }", async () => {
    const { storeId } = await setupStore({
      providerType: "stripe",
      config: { webhook_secret: STRIPE_SECRET },
      slug: `stripe-envelope-404-${randomUUID().slice(0, 8)}`,
    });

    const result = await webhookPost(storeId, "nonexistent-provider-ref-xyz", { event: "test" });

    expect(result.status).toBe(404);
    assertErrorEnvelope(result.json, "WEBHOOK_PROVIDER_NOT_FOUND");
  });
});

// ── E2. Stripe bad signature → 401 ────────────────────────────────────────────

describe("H3.3 Error envelope — Stripe bad signature", () => {
  let storeId: string;
  let slug: string;

  beforeAll(async () => {
    ({ storeId, slug } = await setupStore({
      providerType: "stripe",
      config: { webhook_secret: STRIPE_SECRET },
      slug: `stripe-envelope-sig-${randomUUID().slice(0, 8)}`,
    }));
  });

  it("E2. bad Stripe signature → 401 with { error: { code: INVALID_SIGNATURE } }", async () => {
    const payload = JSON.stringify({
      id: `evt_envelope_bad_${Date.now()}`,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { amount: 10000, currency: "usd", metadata: {} } },
    });

    const badSig = signStripe(payload, "wrong_secret_for_envelope_test");

    const result = await webhookPost(storeId, slug, payload, {
      "stripe-signature": badSig,
    });

    expect(result.status).toBe(401);
    assertErrorEnvelope(result.json, "INVALID_SIGNATURE");
  });
});

// ── E3. Paystack bad signature → 401 ──────────────────────────────────────────

describe("H3.3 Error envelope — Paystack bad signature", () => {
  let storeId: string;
  let slug: string;

  beforeAll(async () => {
    ({ storeId, slug } = await setupStore({
      providerType: "paystack",
      config: { secret_key: PAYSTACK_SECRET },
      slug: `paystack-envelope-sig-${randomUUID().slice(0, 8)}`,
    }));
  });

  it("E3. bad Paystack signature → 401 with { error: { code: INVALID_SIGNATURE } }", async () => {
    const payload = JSON.stringify({
      event: "charge.success",
      data: { id: 99999, reference: randomUUID(), amount: 10000, currency: "USD" },
    });

    const result = await webhookPost(storeId, slug, payload, {
      "x-paystack-signature": "completely_wrong_paystack_sig",
    });

    expect(result.status).toBe(401);
    assertErrorEnvelope(result.json, "INVALID_SIGNATURE");
  });
});

// ── E4. Razorpay bad signature → 401 ──────────────────────────────────────────

describe("H3.3 Error envelope — Razorpay bad signature", () => {
  let storeId: string;
  let slug: string;

  beforeAll(async () => {
    ({ storeId, slug } = await setupStore({
      providerType: "razorpay",
      config: { webhook_secret: RAZORPAY_SECRET },
      slug: `razorpay-envelope-sig-${randomUUID().slice(0, 8)}`,
    }));
  });

  it("E4. bad Razorpay signature → 401 with { error: { code: INVALID_SIGNATURE } }", async () => {
    const payload = JSON.stringify({
      entity: "event",
      event: "payment.captured",
      contains: ["payment"],
      payload: { payment: { entity: { id: "pay_bad_env", amount: 100, currency: "INR" } } },
    });

    const result = await webhookPost(storeId, slug, payload, {
      "x-razorpay-signature": "bad_razorpay_envelope_sig",
    });

    expect(result.status).toBe(401);
    assertErrorEnvelope(result.json, "INVALID_SIGNATURE");
  });
});

// ── E5. Xendit bad callback token → 401 ───────────────────────────────────────

describe("H3.3 Error envelope — Xendit bad callback token", () => {
  let storeId: string;
  let slug: string;

  beforeAll(async () => {
    ({ storeId, slug } = await setupStore({
      providerType: "xendit",
      config: { webhook_token: XENDIT_TOKEN },
      slug: `xendit-envelope-sig-${randomUUID().slice(0, 8)}`,
    }));
  });

  it("E5. bad Xendit callback token → 401 with { error: { code: INVALID_SIGNATURE } }", async () => {
    const payload = JSON.stringify({
      event: "INVOICE.PAID",
      id: `xendit_env_bad_${Date.now()}`,
      external_id: randomUUID(),
      paid_amount: 100,
      currency: "USD",
    });

    const result = await webhookPost(storeId, slug, payload, {
      "x-callback-token": "wrong_xendit_token_for_envelope_test",
    });

    expect(result.status).toBe(401);
    assertErrorEnvelope(result.json, "INVALID_SIGNATURE");
  });
});

// ── E6. Custom webhook bad HMAC → 401 ─────────────────────────────────────────

describe("H3.3 Error envelope — custom webhook bad HMAC", () => {
  let storeId: string;
  let slug: string;

  beforeAll(async () => {
    ({ storeId, slug } = await setupStore({
      providerType: "webhook",
      config: {},
      webhookSecret: CUSTOM_SECRET,
      slug: `webhook-envelope-sig-${randomUUID().slice(0, 8)}`,
    }));
  });

  it("E6. bad custom HMAC → 401 with { error: { code: INVALID_SIGNATURE } }", async () => {
    const payload = JSON.stringify({ event: "order.paid", order_id: randomUUID() });

    const result = await webhookPost(storeId, slug, payload, {
      "x-webhook-signature": "bad_hmac_for_envelope_test",
    });

    expect(result.status).toBe(401);
    assertErrorEnvelope(result.json, "INVALID_SIGNATURE");
  });
});

// ── E7. Success responses are NOT wrapped ──────────────────────────────────────

describe("H3.3 Error envelope — success responses unchanged", () => {
  let storeId: string;
  let slug: string;

  beforeAll(async () => {
    ({ storeId, slug } = await setupStore({
      providerType: "stripe",
      config: { webhook_secret: STRIPE_SECRET },
      slug: `stripe-envelope-ok-${randomUUID().slice(0, 8)}`,
    }));
  });

  it("E7. valid Stripe event → 200 response still uses { message } (not wrapped in error)", async () => {
    // Insert a minimal checkout + order so the payment can record.
    const cartRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO carts (store_id, status, currency) VALUES ($1::uuid, 'active', 'USD') RETURNING id::text`,
      [storeId]
    );
    const cartId = cartRes.rows[0]!.id;

    const prodRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO products (store_id, title, slug)
       VALUES ($1::uuid, 'Envelope OK Product', 'envelope-ok-prod-' || substr(gen_random_uuid()::text, 1, 8))
       RETURNING id::text`,
      [storeId]
    );
    const productId = prodRes.rows[0]!.id;

    const varRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO product_variants (product_id, title, price, track_inventory)
       VALUES ($1::uuid, 'Default', 50.00, false)
       RETURNING id::text`,
      [productId]
    );
    const variantId = varRes.rows[0]!.id;

    await ctx.pool.query(
      `INSERT INTO cart_lines (cart_id, variant_id, quantity, price) VALUES ($1::uuid, $2::uuid, 1, 50.00)`,
      [cartId, variantId]
    );

    const checkoutId = randomUUID();
    await ctx.pool.query(
      `INSERT INTO checkouts (id, store_id, cart_id, status, currency,
         subtotal, shipping_total, tax_total, discount_total, total)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'pending', 'USD', 50.00, 0, 0, 0, 50.00)`,
      [checkoutId, storeId, cartId]
    );

    const ordRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, checkout_id, order_number, currency, status, financial_status,
          fulfillment_status, subtotal, shipping_total, tax_total, discount_total, total)
       VALUES
         ($1::uuid, $2::uuid, next_order_number($1::uuid), 'USD', 'open', 'pending',
          'unfulfilled', 50.00, 0, 0, 0, 50.00)
       RETURNING id::text`,
      [storeId, checkoutId]
    );
    const _orderId = ordRes.rows[0]!.id;

    const eventId = `evt_envelope_ok_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `pi_envelope_ok_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          amount: 5000,
          currency: "usd",
          metadata: { checkout_id: checkoutId },
        },
      },
    });

    const sigHeader = signStripe(payload, STRIPE_SECRET);
    const result = await webhookPost(storeId, slug, payload, {
      "stripe-signature": sigHeader,
    });

    expect(result.status).toBe(200);
    // Success: has message, NOT wrapped in { error: ... }
    expect(result.json).toHaveProperty("message");
    expect(result.json).not.toHaveProperty("error");
  });
});
