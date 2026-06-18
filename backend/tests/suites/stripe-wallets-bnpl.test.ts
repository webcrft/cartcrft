/**
 * stripe-wallets-bnpl.test.ts — Wave 5.2: Wallets + BNPL for Stripe.
 *
 * Pure unit tests (no DB). Mocks global fetch like provider-error-branches.test.ts
 * and inspects the Stripe PaymentIntent request body that StripeClient builds.
 *
 * Asserts:
 *  - DEFAULT (no method config): body keeps `automatic_payment_methods[enabled]=true`
 *    and does NOT pin payment_method_types — so card + wallets (Apple/Google Pay)
 *    are surfaced automatically. Backward-compatible.
 *  - When explicit method types are passed (klarna / afterpay_clearpay / affirm),
 *    the body includes those `payment_method_types[]` and DROPS
 *    automatic_payment_methods (the two are mutually exclusive).
 *  - resolveStripePaymentMethodTypes config resolution: defaults, enable_bnpl,
 *    explicit allowlist, card-always-kept-with-BNPL, invalid entries.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { StripeClient } from "../../src/providers/payments/stripe.js";
import { resolveStripePaymentMethodTypes } from "../../src/modules/payments/service.js";

// ── fetch capture ─────────────────────────────────────────────────────────────

/**
 * Stub global fetch and capture the body of the first request. Returns a
 * getter for the parsed URLSearchParams of the captured form body.
 */
function captureFetch(
  responseBody: Record<string, unknown> = {
    id: "pi_test_123",
    client_secret: "pi_test_123_secret_abc",
    status: "requires_payment_method",
    currency: "usd",
    amount: 5000,
  }
): () => URLSearchParams {
  let captured = "";
  vi.stubGlobal(
    "fetch",
    async (_url: unknown, init?: { body?: string }) => {
      captured = init?.body ?? "";
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(responseBody),
        json: async () => responseBody,
      } as unknown as Response;
    }
  );
  return () => new URLSearchParams(captured);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── StripeClient request body ─────────────────────────────────────────────────

describe("StripeClient.createPaymentIntent — default (wallets via automatic methods)", () => {
  it("keeps automatic_payment_methods and does not pin payment_method_types", async () => {
    const body = captureFetch();
    await new StripeClient("sk_test_fake").createPaymentIntent({
      amountCents: 5000,
      currency: "usd",
      checkoutId: randomUUID(),
    });

    const params = body();
    expect(params.get("automatic_payment_methods[enabled]")).toBe("true");
    expect(params.getAll("payment_method_types[]")).toEqual([]);
  });

  it("treats an empty paymentMethodTypes array as default (automatic)", async () => {
    const body = captureFetch();
    await new StripeClient("sk_test_fake").createPaymentIntent({
      amountCents: 5000,
      currency: "usd",
      checkoutId: randomUUID(),
      paymentMethodTypes: [],
    });

    const params = body();
    expect(params.get("automatic_payment_methods[enabled]")).toBe("true");
    expect(params.getAll("payment_method_types[]")).toEqual([]);
  });
});

describe("StripeClient.createPaymentIntent — explicit method types (BNPL)", () => {
  it("pins payment_method_types[] and drops automatic_payment_methods", async () => {
    const body = captureFetch();
    await new StripeClient("sk_test_fake").createPaymentIntent({
      amountCents: 5000,
      currency: "usd",
      checkoutId: randomUUID(),
      paymentMethodTypes: ["card", "klarna", "afterpay_clearpay", "affirm"],
    });

    const params = body();
    expect(params.get("automatic_payment_methods[enabled]")).toBeNull();
    expect(params.getAll("payment_method_types[]")).toEqual([
      "card",
      "klarna",
      "afterpay_clearpay",
      "affirm",
    ]);
  });

  it("de-duplicates repeated method types", async () => {
    const body = captureFetch();
    await new StripeClient("sk_test_fake").createPaymentIntent({
      amountCents: 5000,
      currency: "usd",
      checkoutId: randomUUID(),
      paymentMethodTypes: ["card", "card", "klarna", "klarna"],
    });

    expect(body().getAll("payment_method_types[]")).toEqual(["card", "klarna"]);
  });
});

// ── Config resolution ─────────────────────────────────────────────────────────

describe("resolveStripePaymentMethodTypes — config resolution", () => {
  it("returns undefined by default (automatic methods, card + wallets)", () => {
    expect(resolveStripePaymentMethodTypes({})).toBeUndefined();
    expect(resolveStripePaymentMethodTypes({ secret_key: "sk" })).toBeUndefined();
    expect(
      resolveStripePaymentMethodTypes({ enable_wallets: true })
    ).toBeUndefined();
  });

  it("enable_bnpl: true → card + all BNPL methods", () => {
    expect(resolveStripePaymentMethodTypes({ enable_bnpl: true })).toEqual([
      "card",
      "klarna",
      "afterpay_clearpay",
      "affirm",
    ]);
  });

  it("explicit payment_methods allowlist is honoured in canonical order", () => {
    expect(
      resolveStripePaymentMethodTypes({
        payment_methods: ["klarna", "card"],
      })
    ).toEqual(["card", "klarna"]);
  });

  it("always keeps card when only BNPL is listed (wallets depend on card)", () => {
    expect(
      resolveStripePaymentMethodTypes({ payment_methods: ["klarna"] })
    ).toEqual(["card", "klarna"]);
  });

  it("card-only allowlist returns just card (no BNPL)", () => {
    expect(
      resolveStripePaymentMethodTypes({ payment_methods: ["card"] })
    ).toEqual(["card"]);
  });

  it("ignores unknown/invalid entries and normalises case", () => {
    expect(
      resolveStripePaymentMethodTypes({
        payment_methods: ["CARD", "ideal", "Klarna", 42, null],
      })
    ).toEqual(["card", "klarna"]);
  });

  it("falls back to automatic methods when allowlist has no valid entries", () => {
    expect(
      resolveStripePaymentMethodTypes({ payment_methods: ["ideal", "bancontact"] })
    ).toBeUndefined();
    expect(
      resolveStripePaymentMethodTypes({ payment_methods: [] })
    ).toBeUndefined();
  });

  it("payment_methods takes precedence over enable_bnpl", () => {
    expect(
      resolveStripePaymentMethodTypes({
        payment_methods: ["card"],
        enable_bnpl: true,
      })
    ).toEqual(["card"]);
  });
});
