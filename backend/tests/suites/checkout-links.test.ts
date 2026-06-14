/**
 * checkout-links.test.ts — Shareable checkout / payment links.
 *
 * Flow under test:
 *   merchant create link → public resolve (totals correct) → public
 *   start-payment returns a provider session (provider HTTP mocked the same way
 *   payment-session.test.ts mocks it) → expired / void / cross-store / completed
 *   rejections.
 *
 * Security assertions:
 *   - the public resolve / start-payment endpoints take a TOKEN ONLY and never
 *     leak store_id or accept a caller store_id.
 *   - a void/expired/completed link cannot be paid.
 *   - the token of store A's link cannot be created or voided by store B's key.
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
  NO_AUTH,
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
  vi.unstubAllGlobals();
});

// ── URL-discriminating fetch mock (mirrors payment-session.test.ts) ───────────

const REAL_FETCH = globalThis.fetch;

function stubProviderFetch(
  mockResponse: Record<string, unknown>,
  opts: { ok?: boolean; status?: number } = {}
) {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
    if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
      return REAL_FETCH(url as string, init);
    }
    return {
      ok,
      status,
      text: async () => JSON.stringify(mockResponse),
      json: async () => mockResponse,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setupStore(opts: { currency?: string } = {}) {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(
    ctx,
    "/commerce/stores",
    { name: `Link Store ${randomUUID().slice(0, 8)}`, currency: opts.currency ?? "USD", timezone: "UTC" },
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
  return { storeId, keyAuth: { type: "api-key" as const, key: apiKey } };
}

async function seedProvider(
  storeId: string,
  opts: { type: string; slug: string; config: Record<string, unknown>; position?: number }
) {
  await ctx.pool.query(
    `INSERT INTO payment_providers (store_id, name, type, slug, config, is_active, position)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, true, $6)`,
    [storeId, `${opts.type} provider`, opts.type, opts.slug, JSON.stringify(opts.config), opts.position ?? 0]
  );
}

async function makeVariant(storeId: string, price: string) {
  const product = await insertProduct(ctx.pool, { storeId, title: "Widget" });
  const variant = await insertVariant(ctx.pool, { productId: product.id, title: "Default", price });
  return variant.id;
}

// ── Create + resolve ────────────────────────────────────────────────────────────

describe("create + public resolve", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore({ currency: "USD" }));
  });

  it("creates a link and returns id + cl_ token + url", async () => {
    const variantId = await makeVariant(storeId, "25.00");
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkout-links`,
      { line_items: [{ variant_id: variantId, quantity: 2 }], customer_email: "buyer@example.com" },
      keyAuth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    expect(res.json["token"]).toMatch(/^cl_/);
    expect(res.json["url"]).toMatch(/\/pay\/cl_/);
  });

  it("public resolve returns store name + items + correct totals, no store_id leak", async () => {
    const variantId = await makeVariant(storeId, "30.00");
    const createRes = await post(
      ctx,
      `/commerce/stores/${storeId}/checkout-links`,
      { line_items: [{ variant_id: variantId, quantity: 3 }] },
      keyAuth
    );
    const token = createRes.json["token"] as string;

    const res = await get(ctx, `/storefront/checkout-links/${token}`, NO_AUTH);
    expect(res.status).toBe(200);
    expect(res.json["status"]).toBe("open");
    expect(res.json["store"]["name"]).toMatch(/Link Store/);
    expect(res.json["line_items"]).toHaveLength(1);
    expect(res.json["line_items"][0]["qty"]).toBe(3);
    expect(res.json["line_items"][0]["unit_price"]).toBe("30.00");
    expect(res.json["line_items"][0]["line_total"]).toBe("90.00");
    expect(res.json["totals"]["subtotal"]).toBe("90.00");
    expect(res.json["totals"]["total"]).toBe("90.00"); // no tax zone configured
    expect(res.json["totals"]["currency"]).toBe("USD");
    // No internal identifiers exposed.
    expect(res.json["store_id"]).toBeUndefined();
    expect(JSON.stringify(res.json)).not.toContain(storeId);
  });

  it("rejects empty line_items (422) and unknown variant (404)", async () => {
    const empty = await post(
      ctx,
      `/commerce/stores/${storeId}/checkout-links`,
      { line_items: [] },
      keyAuth
    );
    expect(empty.status).toBe(400); // zod min(1) → validation error envelope

    const bad = await post(
      ctx,
      `/commerce/stores/${storeId}/checkout-links`,
      { line_items: [{ variant_id: randomUUID(), quantity: 1 }] },
      keyAuth
    );
    expect(bad.status).toBe(404);
    expect(bad.json["error"]["code"]).toBe("NOT_FOUND");
  });

  it("resolve of an unknown token → 404", async () => {
    const res = await get(ctx, `/storefront/checkout-links/cl_does_not_exist`, NO_AUTH);
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });
});

// ── start-payment (Paystack) ─────────────────────────────────────────────────────

describe("public start-payment", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore({ currency: "ZAR" }));
    await seedProvider(storeId, { type: "paystack", slug: "paystack", config: { secret_key: "sk_test_fake" } });
  });

  async function createLink(email?: string) {
    const variantId = await makeVariant(storeId, "100.00");
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkout-links`,
      { line_items: [{ variant_id: variantId, quantity: 1 }], ...(email ? { customer_email: email } : {}) },
      keyAuth
    );
    return res.json["token"] as string;
  }

  it("returns a Paystack authorization_url + checkout_id and stamps the checkout", async () => {
    const token = await createLink("buyer@example.com");

    stubProviderFetch({
      status: true,
      message: "ok",
      data: {
        authorization_url: "https://checkout.paystack.com/abc123",
        access_code: "ac_1",
        reference: "ref_1",
      },
    });

    const res = await post(ctx, `/storefront/checkout-links/${token}/start-payment`, {}, NO_AUTH);
    expect(res.status).toBe(200);
    expect(res.json["provider"]).toBe("paystack");
    expect(res.json["authorization_url"]).toMatch(/^https:\/\//);
    expect(typeof res.json["checkout_id"]).toBe("string");

    // The link should now carry completed_checkout_id (still 'open' pre-webhook).
    const { rows } = await ctx.pool.query<{ completed_checkout_id: string | null; status: string }>(
      `SELECT completed_checkout_id::text, status FROM checkout_links WHERE token = $1`,
      [token]
    );
    expect(rows[0]!.completed_checkout_id).toBe(res.json["checkout_id"]);
    expect(rows[0]!.status).toBe("open");
  });

  it("accepts an email supplied at payment time when the link had none", async () => {
    const token = await createLink(); // no email on the link
    stubProviderFetch({
      status: true,
      data: { authorization_url: "https://checkout.paystack.com/xyz", access_code: "ac", reference: "r" },
    });
    const res = await post(
      ctx,
      `/storefront/checkout-links/${token}/start-payment`,
      { email: "late@example.com" },
      NO_AUTH
    );
    expect(res.status).toBe(200);
    expect(res.json["authorization_url"]).toBeDefined();
  });

  it("422 when Paystack and no email anywhere", async () => {
    const token = await createLink(); // no email
    stubProviderFetch({ status: true, data: {} });
    const res = await post(ctx, `/storefront/checkout-links/${token}/start-payment`, {}, NO_AUTH);
    expect(res.status).toBe(422);
    expect(res.json["error"]["code"]).toBe("VALIDATION_ERROR");
  });
});

// ── No provider configured ────────────────────────────────────────────────────────

describe("start-payment without provider", () => {
  it("returns 501 PROVIDER_NOT_CONFIGURED", async () => {
    const { storeId, keyAuth } = await setupStore();
    const variantId = await makeVariant(storeId, "10.00");
    const createRes = await post(
      ctx,
      `/commerce/stores/${storeId}/checkout-links`,
      { line_items: [{ variant_id: variantId, quantity: 1 }], customer_email: "x@y.com" },
      keyAuth
    );
    const token = createRes.json["token"] as string;
    const res = await post(ctx, `/storefront/checkout-links/${token}/start-payment`, {}, NO_AUTH);
    expect(res.status).toBe(501);
    expect(res.json["error"]["code"]).toBe("PROVIDER_NOT_CONFIGURED");
  });
});

// ── Void / expired / completed rejection ──────────────────────────────────────────

describe("rejections: void / expired / completed", () => {
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };

  beforeAll(async () => {
    ({ storeId, keyAuth } = await setupStore({ currency: "ZAR" }));
    await seedProvider(storeId, { type: "paystack", slug: "paystack", config: { secret_key: "sk" } });
  });

  async function createLink() {
    const variantId = await makeVariant(storeId, "20.00");
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/checkout-links`,
      { line_items: [{ variant_id: variantId, quantity: 1 }], customer_email: "b@e.com" },
      keyAuth
    );
    return { token: res.json["token"] as string, linkId: res.json["id"] as string };
  }

  it("voided link cannot be paid (409 LINK_NOT_OPEN)", async () => {
    const { token, linkId } = await createLink();
    const voidRes = await post(ctx, `/commerce/stores/${storeId}/checkout-links/${linkId}/void`, {}, keyAuth);
    expect(voidRes.status).toBe(200);
    expect(voidRes.json["status"]).toBe("void");

    // resolve still works but reports void
    const resolveRes = await get(ctx, `/storefront/checkout-links/${token}`, NO_AUTH);
    expect(resolveRes.json["status"]).toBe("void");

    const payRes = await post(ctx, `/storefront/checkout-links/${token}/start-payment`, {}, NO_AUTH);
    expect(payRes.status).toBe(409);
    expect(payRes.json["error"]["code"]).toBe("LINK_NOT_OPEN");
  });

  it("expired link cannot be paid; resolve flips it to expired", async () => {
    const { token } = await createLink();
    // Force expiry in the past directly.
    await ctx.pool.query(
      `UPDATE checkout_links SET expires_at = now() - interval '1 hour' WHERE token = $1`,
      [token]
    );
    const resolveRes = await get(ctx, `/storefront/checkout-links/${token}`, NO_AUTH);
    expect(resolveRes.json["status"]).toBe("expired");

    const payRes = await post(ctx, `/storefront/checkout-links/${token}/start-payment`, {}, NO_AUTH);
    expect(payRes.status).toBe(409);
    expect(payRes.json["error"]["code"]).toBe("LINK_NOT_OPEN");
  });

  it("completed link cannot be re-paid", async () => {
    const { token } = await createLink();
    await ctx.pool.query(`UPDATE checkout_links SET status = 'completed' WHERE token = $1`, [token]);
    const payRes = await post(ctx, `/storefront/checkout-links/${token}/start-payment`, {}, NO_AUTH);
    expect(payRes.status).toBe(409);
    expect(payRes.json["error"]["code"]).toBe("LINK_NOT_OPEN");
  });
});

// ── Cross-store isolation ─────────────────────────────────────────────────────────

describe("cross-store isolation", () => {
  it("store B's key cannot void store A's link", async () => {
    const a = await setupStore();
    const b = await setupStore();

    const variantId = await makeVariant(a.storeId, "15.00");
    const createRes = await post(
      ctx,
      `/commerce/stores/${a.storeId}/checkout-links`,
      { line_items: [{ variant_id: variantId, quantity: 1 }] },
      a.keyAuth
    );
    const linkId = createRes.json["id"] as string;

    // B tries to void A's link via B's own store path → key/org mismatch on A's store path.
    const crossVoid = await post(
      ctx,
      `/commerce/stores/${a.storeId}/checkout-links/${linkId}/void`,
      {},
      b.keyAuth
    );
    // B's key does not belong to A's org → 401 from auth middleware.
    expect([401, 403, 404]).toContain(crossVoid.status);

    // And the link is still open.
    const { rows } = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM checkout_links WHERE id = $1::uuid`,
      [linkId]
    );
    expect(rows[0]!.status).toBe("open");
  });

  it("a store cannot create a link with another store's variant", async () => {
    const a = await setupStore();
    const b = await setupStore();
    const aVariant = await makeVariant(a.storeId, "40.00");

    // B references A's variant → not found in B's store.
    const res = await post(
      ctx,
      `/commerce/stores/${b.storeId}/checkout-links`,
      { line_items: [{ variant_id: aVariant, quantity: 1 }] },
      b.keyAuth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });
});
