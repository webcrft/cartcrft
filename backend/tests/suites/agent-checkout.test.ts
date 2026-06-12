/**
 * agent-checkout.test.ts — Agent spend/mandate enforcement at checkout (Discovered items 2 & 3).
 *
 * Tests:
 *  1. Agent-attributed checkout complete within limit → order created + audit row
 *  2. Agent exceeding spend window limit → 402 MANDATE_SPEND_LIMIT_EXCEEDED
 *  3. Store flag agents_require_mandate=true + no mandate → 402 MANDATE_REQUIRED
 *  4. Store flag agents_require_mandate=true + valid mandate chain → order created
 *  5. Non-agent checkout (no agentCtx) still works (regression)
 *  6. agents_require_mandate store flag can be set/read via PUT /commerce/stores/:id
 *
 * Regression suites run separately — this file only covers the agent-checkout path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  mintJwt,
  createApiKey,
  insertOrg,
  insertProduct,
} from "../shared/helpers.js";
import { sign as cryptoSign } from "node:crypto";
import { buildSigningMessage, sha256Hex } from "../../src/lib/agent-auth.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeAuth(orgId: string) {
  const token = await mintJwt({ userId: "00000000-0000-0000-0000-000000000099", orgId });
  return { type: "bearer" as const, token };
}

/** Set up a store + API key for a fresh org. */
async function makeStore(orgId: string) {
  const auth = await makeAuth(orgId);
  const storeRes = await post(ctx, "/commerce/stores", {
    name: `Agent Checkout Store ${Date.now()}`,
    currency: "ZAR",
    timezone: "Africa/Johannesburg",
  }, auth);
  expect(storeRes.status).toBe(201);
  const storeId = (storeRes.json as Record<string, unknown>)["id"] as string;

  const apiKey = await createApiKey(ctx, {
    orgId,
    userId: "00000000-0000-0000-0000-000000000099",
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });

  return { storeId, auth, keyAuth: { type: "api-key" as const, key: apiKey } };
}

/** Create an agent for a store. Returns agent + private key. */
async function makeAgent(
  storeId: string,
  auth: ReturnType<typeof makeAuth> extends Promise<infer T> ? T : never,
  opts: { spend_limit?: string; spend_window?: string } = {}
) {
  const res = await post(
    ctx,
    `/commerce/stores/${storeId}/agents`,
    {
      name: `Checkout Agent ${Date.now()}`,
      agent_type: "internal",
      scopes: ["orders:read", "checkout:write"],
      ...opts,
    },
    await auth
  );
  expect(res.status).toBe(201);
  const agent = (res.json as Record<string, unknown>)["agent"] as Record<string, unknown>;
  return {
    agentId: agent["id"] as string,
    privateKeyPem: agent["private_key_pem"] as string,
    publicKey: agent["public_key"] as string,
  };
}

/** Sign a request using the agent private key. Returns agent headers. */
function agentHeaders(
  method: string,
  path: string,
  body: string,
  agentId: string,
  privateKeyPem: string
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = sha256Hex(body);
  const message = buildSigningMessage(method, path, bodyHash, timestamp);
  const sigBuffer = cryptoSign(null, Buffer.from(message, "utf8"), {
    key: privateKeyPem,
    format: "pem",
    type: "pkcs8",
  });
  return {
    "x-cartcrft-agent": agentId,
    "x-cartcrft-signature": sigBuffer.toString("hex"),
    "x-cartcrft-timestamp": timestamp,
  };
}

/** Build a full cart → checkout fixture ready for completion. */
async function buildCheckout(
  storeId: string,
  keyAuth: { type: "api-key"; key: string }
) {
  // Insert product + variant via SQL.
  // track_inventory=false avoids INSUFFICIENT_INVENTORY at complete time
  // (mirrors the pattern used in webhooks.test.ts and mandates.test.ts).
  const product = await insertProduct(ctx.pool, {
    storeId,
    title: `Agent Widget ${Date.now()}`,
  });
  // Insert variant directly with track_inventory=false
  const { rows: varRows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO product_variants (product_id, title, price, track_inventory)
     VALUES ($1::uuid, 'Default', 50.00, false)
     RETURNING id::text`,
    [product.id]
  );
  const variant = { id: varRows[0]!.id, productId: product.id, title: "Default", price: "50.00" };

  // Cart
  const cartRes = await post(ctx, `/commerce/stores/${storeId}/carts`, {}, keyAuth);
  expect(cartRes.status).toBe(201);
  const cartId = (cartRes.json as Record<string, unknown>)["id"] as string;

  // Add item
  await post(ctx, `/commerce/stores/${storeId}/carts/${cartId}/lines`, {
    variant_id: variant.id,
    quantity: 1,
  }, keyAuth);

  // Checkout
  const checkoutRes = await post(ctx, `/commerce/stores/${storeId}/checkouts`, {
    cart_id: cartId,
  }, keyAuth);
  expect(checkoutRes.status).toBe(201);
  const checkoutId = (checkoutRes.json as Record<string, unknown>)["id"] as string;

  return { cartId, checkoutId, variantId: variant.id, total: 50.00 };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Agent checkout enforcement", () => {
  const orgId = "20000000-0000-0000-0000-000000000001";

  beforeAll(async () => {
    await insertOrg(ctx.pool, { name: "Agent Checkout Test Org" });
  });

  // ── 1. Agent-attributed checkout within limit succeeds + audit row ────────

  describe("1. Agent checkout within spend limit succeeds", () => {
    it("completes checkout and stamps order.metadata.agent_id", async () => {
      const { storeId, auth, keyAuth } = await makeStore(orgId);
      const agent = await makeAgent(storeId, Promise.resolve(auth), {
        spend_limit: "1000.00",
        spend_window: "24h",
      });

      const { checkoutId } = await buildCheckout(storeId, keyAuth);

      // Complete checkout with agent attribution headers
      const completePath = `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`;
      const headers = agentHeaders("POST", completePath, "{}", agent.agentId, agent.privateKeyPem);

      const res = await ctx.request({
        method: "POST",
        path: completePath,
        headers: {
          ...headers,
          authorization: `Bearer ${keyAuth.key}`,
        },
        body: {},
      });

      expect(res.status).toBe(200);
      const body = res.json as Record<string, unknown>;
      expect(body["order_id"]).toBeTruthy();

      // Verify agent_id in order metadata
      const orderRow = await ctx.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM orders WHERE id = $1::uuid`,
        [body["order_id"]]
      );
      expect(orderRow.rows[0]?.metadata?.["agent_id"]).toBe(agent.agentId);
    });
  });

  // ── 2. Exceeding spend limit → MANDATE_SPEND_LIMIT_EXCEEDED ──────────────

  describe("2. Exceeding spend window limit → MANDATE_SPEND_LIMIT_EXCEEDED", () => {
    it("returns 402 MANDATE_SPEND_LIMIT_EXCEEDED when cumulative spend exceeds limit", async () => {
      const { storeId, keyAuth } = await makeStore(orgId);
      const auth = await makeAuth(orgId);
      const agent = await makeAgent(storeId, Promise.resolve(auth), {
        spend_limit: "40.00",   // total limit: ZAR 40
        spend_window: "24h",
      });

      // Inject a prior order attributed to this agent (ZAR 30 already spent)
      await ctx.pool.query(
        `INSERT INTO orders (
           store_id, order_number, financial_status, fulfillment_status,
           currency, subtotal, shipping_total, tax_total, discount_total, total, metadata
         ) VALUES (
           $1::uuid, $2, 'paid', 'unfulfilled',
           'ZAR', 30.00, 0, 0, 0, 30.00, $3::jsonb
         )`,
        [storeId, `ORD-AGLIMIT-${Date.now()}`, JSON.stringify({ agent_id: agent.agentId })]
      );

      // Build a checkout for ZAR 50 — 30+50=80 > 40 → should be rejected
      const { checkoutId } = await buildCheckout(storeId, keyAuth);

      const completePath = `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`;
      const headers = agentHeaders("POST", completePath, "{}", agent.agentId, agent.privateKeyPem);

      const res = await ctx.request({
        method: "POST",
        path: completePath,
        headers: {
          ...headers,
          authorization: `Bearer ${keyAuth.key}`,
        },
        body: {},
      });

      expect(res.status).toBe(402);
      const body = res.json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown>;
      expect(err["code"]).toBe("MANDATE_SPEND_LIMIT_EXCEEDED");
    });
  });

  // ── 3. Store flag on + no mandate → MANDATE_REQUIRED ─────────────────────

  describe("3. agents_require_mandate=true + no mandate → MANDATE_REQUIRED", () => {
    it("returns 402 MANDATE_REQUIRED when store requires mandate but none exists", async () => {
      const { storeId, auth, keyAuth } = await makeStore(orgId);
      const agent = await makeAgent(storeId, Promise.resolve(auth));

      // Enable agents_require_mandate on the store
      const updateRes = await put(
        ctx,
        `/commerce/stores/${storeId}`,
        { agents_require_mandate: true },
        auth
      );
      expect(updateRes.status).toBe(200);

      // Build checkout (no mandates created)
      const { checkoutId } = await buildCheckout(storeId, keyAuth);

      const completePath = `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`;
      const headers = agentHeaders("POST", completePath, "{}", agent.agentId, agent.privateKeyPem);

      const res = await ctx.request({
        method: "POST",
        path: completePath,
        headers: {
          ...headers,
          authorization: `Bearer ${keyAuth.key}`,
        },
        body: {},
      });

      expect(res.status).toBe(402);
      const body = res.json as Record<string, unknown>;
      const err = body["error"] as Record<string, unknown>;
      expect(err["code"]).toBe("MANDATE_REQUIRED");
    });
  });

  // ── 4. Store flag on + valid mandate chain → success ─────────────────────

  describe("4. agents_require_mandate=true + valid mandate chain → success", () => {
    it("completes checkout when valid payment mandate chain exists", async () => {
      const { storeId, auth, keyAuth } = await makeStore(orgId);
      const agent = await makeAgent(storeId, Promise.resolve(auth));

      // Enable agents_require_mandate on the store
      await put(
        ctx,
        `/commerce/stores/${storeId}`,
        { agents_require_mandate: true },
        auth
      );

      // Build checkout
      const { checkoutId } = await buildCheckout(storeId, keyAuth);

      // Create mandate chain: intent → cart → payment
      // 1. Intent mandate
      const intentRes = await post(
        ctx,
        `/commerce/stores/${storeId}/agents/${agent.agentId}/mandates`,
        {
          mandate_type: "intent",
          payload: { description: "Buy widget" },
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
        auth
      );
      expect(intentRes.status).toBe(201);
      const intentId = ((intentRes.json as Record<string, unknown>)["mandate"] as Record<string, unknown>)["id"] as string;

      // 2. Cart mandate
      const cartMandateRes = await post(
        ctx,
        `/commerce/stores/${storeId}/agents/${agent.agentId}/mandates`,
        {
          mandate_type: "cart",
          payload: { cart_id: "aaaaaaaa-0000-0000-0000-000000000099", max_total: "500.00" },
          parent_mandate_id: intentId,
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
        auth
      );
      expect(cartMandateRes.status).toBe(201);
      const cartMandateId = ((cartMandateRes.json as Record<string, unknown>)["mandate"] as Record<string, unknown>)["id"] as string;

      // 3. Payment mandate for this specific checkout
      const paymentMandateRes = await post(
        ctx,
        `/commerce/stores/${storeId}/agents/${agent.agentId}/mandates`,
        {
          mandate_type: "payment",
          payload: { checkout_id: checkoutId, amount: "50.00" },
          parent_mandate_id: cartMandateId,
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
        auth
      );
      expect(paymentMandateRes.status).toBe(201);

      // Complete checkout with agent attribution
      const completePath = `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`;
      const headers = agentHeaders("POST", completePath, "{}", agent.agentId, agent.privateKeyPem);

      const res = await ctx.request({
        method: "POST",
        path: completePath,
        headers: {
          ...headers,
          authorization: `Bearer ${keyAuth.key}`,
        },
        body: {},
      });

      // Should succeed
      expect(res.status).toBe(200);
      const body = res.json as Record<string, unknown>;
      expect(body["order_id"]).toBeTruthy();
    });
  });

  // ── 5. Non-agent checkout (regression) ───────────────────────────────────

  describe("5. Non-agent checkout still works (regression)", () => {
    it("completes checkout without agent headers (no agentCtx)", async () => {
      const { storeId, keyAuth } = await makeStore(orgId);

      const { checkoutId } = await buildCheckout(storeId, keyAuth);

      // Complete without any agent headers
      const res = await post(
        ctx,
        `/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`,
        {},
        keyAuth
      );

      expect(res.status).toBe(200);
      const body = res.json as Record<string, unknown>;
      expect(body["order_id"]).toBeTruthy();
    });
  });

  // ── 6. agents_require_mandate flag via API ────────────────────────────────

  describe("6. agents_require_mandate store flag", () => {
    it("defaults to false on new store", async () => {
      const { storeId, auth } = await makeStore(orgId);
      const storeRes = await get(ctx, `/commerce/stores/${storeId}`, auth);
      expect(storeRes.status).toBe(200);
      const store = storeRes.json as Record<string, unknown>;
      expect(store["agents_require_mandate"]).toBe(false);
    });

    it("can be set to true and read back via GET", async () => {
      const { storeId, auth } = await makeStore(orgId);

      const updateRes = await put(
        ctx,
        `/commerce/stores/${storeId}`,
        { agents_require_mandate: true },
        auth
      );
      expect(updateRes.status).toBe(200);

      const storeRes = await get(ctx, `/commerce/stores/${storeId}`, auth);
      expect(storeRes.status).toBe(200);
      const store = storeRes.json as Record<string, unknown>;
      expect(store["agents_require_mandate"]).toBe(true);
    });

    it("can be toggled back to false", async () => {
      const { storeId, auth } = await makeStore(orgId);

      await put(ctx, `/commerce/stores/${storeId}`, { agents_require_mandate: true }, auth);
      await put(ctx, `/commerce/stores/${storeId}`, { agents_require_mandate: false }, auth);

      const storeRes = await get(ctx, `/commerce/stores/${storeId}`, auth);
      const store = storeRes.json as Record<string, unknown>;
      expect(store["agents_require_mandate"]).toBe(false);
    });
  });
});
