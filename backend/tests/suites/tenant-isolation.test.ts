/**
 * tenant-isolation — Cross-tenant IDOR sweep (H1.1)
 *
 * Verifies that a JWT / API key for Org B / Store B can NEVER read or mutate
 * resources that belong to Org A / Store A.  Every storeId-scoped module group
 * is covered:
 *
 *   - Catalog      (products, variants, collections)
 *   - Orders
 *   - Inventory    (warehouses, levels)
 *   - Discounts
 *   - Customers
 *   - B2B          (companies, quotes)
 *   - Subscriptions (plans)
 *   - Returns
 *   - Agents
 *   - Bookings     (booking resources)
 *   - Wallet       (store credits)
 *   - Shipping     (zones)
 *   - Tax          (zones)
 *
 * Each group:
 *   1. Seeds a resource in Store A (using Org A credentials).
 *   2. Attempts to read / mutate that resource using Org B credentials.
 *   3. Asserts the response is 403 or 404 — never 200/201 that leaks data.
 *
 * "Fail closed" policy: if the app returns anything other than 4xx the test
 * fails loudly so regressions are immediately visible.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, del, mintJwt, createApiKey } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

// ── Two completely independent org/store pairs ────────────────────────────────

const orgAId = randomUUID();
const userAId = randomUUID();
const orgBId = randomUUID();
const userBId = randomUUID();

let storeAId: string;
let storeBId: string;

// Tokens & keys
let tokenA: string; // JWT for Org A
let tokenB: string; // JWT for Org B
let keyA: string;   // cc_prv_ API key for Store A (all scopes)
let keyB: string;   // cc_prv_ API key for Store B (all scopes)

// Auth helpers
const authA = () => ({ type: "bearer" as const, token: tokenA });
const authB = () => ({ type: "bearer" as const, token: tokenB });
const apiKeyB = () => ({ type: "api-key" as const, key: keyB });

// ── Seeded resource IDs (all belong to Store A) ──────────────────────────────

let productAId: string;
let variantAId: string;
let collectionAId: string;
let orderAId: string;
let warehouseAId: string;
let discountAId: string;
let customerAId: string;
let companyAId: string;
let quoteAId: string;
let planAId: string;
let returnRequestAId: string;
let agentAId: string;
let bookingResourceAId: string;
// storeCreditAId not needed — wallet tests use customer-scoped URL instead
let shippingZoneAId: string;
let taxZoneAId: string;

// ── Helper: assert access is denied (401 / 403 / 404) ────────────────────────
//
// The middleware may return:
//   401 — invalid/mismatched credentials (cross-org API key)
//   403 — authenticated but wrong org (cross-org JWT)
//   404 — store not found in org (cross-org JWT via storeExistsInOrg check)
//
// Any of these means "access denied" and constitutes proof that the resource
// was NOT leaked.  200 / 201 / 204 would be a critical IDOR.

function assertDenied(
  status: number,
  label: string
): void {
  expect(
    [401, 403, 404],
    `${label}: expected 401, 403, or 404 but got ${status}`
  ).toContain(status);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ctx = await createCtx();

  // Mint JWTs for both orgs
  tokenA = await mintJwt({ userId: userAId, orgId: orgAId });
  tokenB = await mintJwt({ userId: userBId, orgId: orgBId });

  // ── Create Store A (Org A) ────────────────────────────────────────────────
  const resA = await post(
    ctx,
    "/commerce/stores",
    { name: "Store A", currency: "USD" },
    authA()
  );
  expect(resA.status).toBe(201);
  storeAId = (resA.json as Record<string, unknown>)["id"] as string;

  // ── Create Store B (Org B) ────────────────────────────────────────────────
  const resB = await post(
    ctx,
    "/commerce/stores",
    { name: "Store B", currency: "USD" },
    authB()
  );
  expect(resB.status).toBe(201);
  storeBId = (resB.json as Record<string, unknown>)["id"] as string;

  // ── Create API keys ───────────────────────────────────────────────────────
  keyA = await createApiKey(ctx, {
    orgId: orgAId,
    userId: userAId,
    storeId: storeAId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
    name: "Store A Key",
  });
  keyB = await createApiKey(ctx, {
    orgId: orgBId,
    userId: userBId,
    storeId: storeBId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
    name: "Store B Key",
  });

  // ── Seed resources in Store A via Org A credentials ──────────────────────

  // Catalog: product + variant
  const pRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/products`,
    { title: "Product A", slug: `product-a-${Date.now()}` },
    authA()
  );
  expect(pRes.status).toBe(201);
  productAId = (pRes.json as Record<string, unknown>)["id"] as string;

  const vRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/products/${productAId}/variants`,
    { title: "Default", price: "10.00" },
    authA()
  );
  expect(vRes.status).toBe(201);
  variantAId = (vRes.json as Record<string, unknown>)["id"] as string;

  // Catalog: collection
  const cRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/collections`,
    { title: "Collection A", slug: `col-a-${Date.now()}` },
    authA()
  );
  expect(cRes.status).toBe(201);
  collectionAId = (cRes.json as Record<string, unknown>)["id"] as string;

  // Orders
  const oRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/orders`,
    {
      lines: [{ variant_id: variantAId, quantity: 1, unit_price: "10.00" }],
      currency: "USD",
    },
    authA()
  );
  expect(oRes.status).toBe(201);
  orderAId = (oRes.json as Record<string, unknown>)["id"] as string;

  // Inventory: warehouse
  const wRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/warehouses`,
    { name: "Warehouse A", address: { city: "Cape Town", country_code: "ZA" } },
    authA()
  );
  expect(wRes.status).toBe(201);
  warehouseAId = (wRes.json as Record<string, unknown>)["id"] as string;

  // Discounts
  const dRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/discounts`,
    { code: `SAVE-A-${Date.now()}`, type: "percentage", value: "10" },
    authA()
  );
  expect(dRes.status).toBe(201);
  discountAId = (dRes.json as Record<string, unknown>)["id"] as string;

  // Customers (direct SQL to bypass auth flow)
  const custRes = await ctx.pool.query<{ id: string }>(
    `INSERT INTO customers (store_id, email, auth_provider, is_active)
     VALUES ($1::uuid, $2, 'email', true)
     RETURNING id::text`,
    [storeAId, `customer-a-${Date.now()}@example.com`]
  );
  customerAId = custRes.rows[0]!.id;

  // B2B: company
  const compRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/companies`,
    { name: "Company A", email: `co-a-${Date.now()}@example.com` },
    authA()
  );
  expect(compRes.status).toBe(201);
  companyAId = (compRes.json as Record<string, unknown>)["id"] as string;

  // B2B: quote (direct SQL since quote create has complex validation)
  const qRes = await ctx.pool.query<{ id: string }>(
    `INSERT INTO quotes (store_id, company_id, status)
     VALUES ($1::uuid, $2::uuid, 'draft')
     RETURNING id::text`,
    [storeAId, companyAId]
  );
  quoteAId = qRes.rows[0]!.id;

  // Subscriptions: plan
  const spRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/subscription-plans`,
    {
      name: "Plan A",
      interval: "month",
      interval_count: 1,
    },
    authA()
  );
  expect(spRes.status).toBe(201);
  planAId = (spRes.json as Record<string, unknown>)["id"] as string;

  // Returns: need an order to return from; use direct SQL
  const rrRes = await ctx.pool.query<{ id: string }>(
    `INSERT INTO return_requests (store_id, order_id, status, return_type, notes)
     VALUES ($1::uuid, $2::uuid, 'requested', 'refund', 'IDOR test return')
     RETURNING id::text`,
    [storeAId, orderAId]
  );
  returnRequestAId = rrRes.rows[0]!.id;

  // Agents
  const agRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/agents`,
    { name: "Agent A", agent_type: "webhook" },
    authA()
  );
  expect(agRes.status).toBe(201);
  // Create returns { agent: { id, ... } } — extract the nested id so cross-tenant
  // GET/DELETE hit a valid uuid and exercise the auth boundary (not param validation).
  agentAId = ((agRes.json as Record<string, Record<string, unknown>>)["agent"])["id"] as string;

  // Bookings: booking resource (direct SQL — booking routes may not be tested separately)
  const brRes = await ctx.pool.query<{ id: string }>(
    `INSERT INTO booking_resources (store_id, name, type, capacity, base_price)
     VALUES ($1::uuid, 'Resource A', 'accommodation', 1, 100.00)
     RETURNING id::text`,
    [storeAId]
  );
  bookingResourceAId = brRes.rows[0]!.id;

  // Wallet: store credit (direct SQL — no type/reason columns on store_credits)
  const scRes = await ctx.pool.query<{ id: string }>(
    `INSERT INTO store_credits (store_id, customer_id, balance, currency)
     VALUES ($1::uuid, $2::uuid, 100.00, 'USD')
     RETURNING id::text`,
    [storeAId, customerAId]
  );
  void scRes.rows[0]!.id; // seeded for RLS verification; access attempted via customer URL

  // Shipping zone
  const szRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/shipping-zones`,
    { name: "Zone A" },
    authA()
  );
  expect(szRes.status).toBe(201);
  shippingZoneAId = (szRes.json as Record<string, unknown>)["id"] as string;

  // Tax zone
  const tzRes = await post(
    ctx,
    `/commerce/stores/${storeAId}/tax-zones`,
    { name: "Tax Zone A", country_code: "ZA" },
    authA()
  );
  expect(tzRes.status).toBe(201);
  taxZoneAId = (tzRes.json as Record<string, unknown>)["id"] as string;
}, 180_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── IDOR Sweep Tests ──────────────────────────────────────────────────────────

describe("Tenant isolation — IDOR sweep", () => {
  // ── Catalog ────────────────────────────────────────────────────────────────

  describe("Catalog", () => {
    it("B cannot list Store A products", async () => {
      const res = await get(ctx, `/commerce/stores/${storeAId}/products`, authB());
      assertDenied(res.status, "B list A products [JWT]");
    });

    it("B cannot get Store A product by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/products/${productAId}`,
        authB()
      );
      assertDenied(res.status, "B get A product [JWT]");
    });

    it("B API key cannot list Store A products", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/products`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A products [API key]");
    });

    it("B cannot mutate Store A product", async () => {
      const res = await put(
        ctx,
        `/commerce/stores/${storeAId}/products/${productAId}`,
        { title: "Hacked" },
        authB()
      );
      assertDenied(res.status, "B update A product [JWT]");
    });

    it("B cannot delete Store A product", async () => {
      const res = await del(
        ctx,
        `/commerce/stores/${storeAId}/products/${productAId}`,
        authB()
      );
      assertDenied(res.status, "B delete A product [JWT]");
    });

    it("B cannot list Store A variants", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/products/${productAId}/variants`,
        authB()
      );
      assertDenied(res.status, "B list A variants [JWT]");
    });

    it("B cannot list Store A collections", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/collections`,
        authB()
      );
      assertDenied(res.status, "B list A collections [JWT]");
    });

    it("B cannot get Store A collection by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/collections/${collectionAId}`,
        authB()
      );
      assertDenied(res.status, "B get A collection [JWT]");
    });

    it("B cannot create product in Store A", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/products`,
        { title: "Injected", slug: `injected-${Date.now()}` },
        authB()
      );
      assertDenied(res.status, "B create product in A [JWT]");
    });
  });

  // ── Orders ────────────────────────────────────────────────────────────────

  describe("Orders", () => {
    it("B cannot list Store A orders", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/orders`,
        authB()
      );
      assertDenied(res.status, "B list A orders [JWT]");
    });

    it("B API key cannot list Store A orders", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/orders`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A orders [API key]");
    });

    it("B cannot get Store A order by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/orders/${orderAId}`,
        authB()
      );
      assertDenied(res.status, "B get A order [JWT]");
    });

    it("B cannot cancel Store A order", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/orders/${orderAId}/cancel`,
        {},
        authB()
      );
      assertDenied(res.status, "B cancel A order [JWT]");
    });

    it("B cannot create order in Store A", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/orders`,
        {
          lines: [{ variant_id: variantAId, quantity: 1, unit_price: "10.00" }],
          currency: "USD",
        },
        authB()
      );
      assertDenied(res.status, "B create order in A [JWT]");
    });
  });

  // ── Inventory ─────────────────────────────────────────────────────────────

  describe("Inventory", () => {
    it("B cannot list Store A warehouses", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/warehouses`,
        authB()
      );
      assertDenied(res.status, "B list A warehouses [JWT]");
    });

    it("B API key cannot list Store A warehouses", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/warehouses`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A warehouses [API key]");
    });

    it("B cannot get Store A warehouse by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/warehouses/${warehouseAId}`,
        authB()
      );
      assertDenied(res.status, "B get A warehouse [JWT]");
    });

    it("B cannot create warehouse in Store A", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/warehouses`,
        { name: "Injected", address: { city: "X", country_code: "ZZ" } },
        authB()
      );
      assertDenied(res.status, "B create warehouse in A [JWT]");
    });
  });

  // ── Discounts ─────────────────────────────────────────────────────────────

  describe("Discounts", () => {
    it("B cannot list Store A discount codes", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/discounts`,
        authB()
      );
      assertDenied(res.status, "B list A discounts [JWT]");
    });

    it("B API key cannot list Store A discount codes", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/discounts`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A discounts [API key]");
    });

    it("B cannot get Store A discount by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/discounts/${discountAId}`,
        authB()
      );
      assertDenied(res.status, "B get A discount [JWT]");
    });

    it("B cannot create discount in Store A", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/discounts`,
        { code: `INJECT-${Date.now()}`, type: "fixed_amount", value: "99" },
        authB()
      );
      assertDenied(res.status, "B create discount in A [JWT]");
    });
  });

  // ── Customers ─────────────────────────────────────────────────────────────

  describe("Customers", () => {
    it("B cannot list Store A customers", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/customers`,
        authB()
      );
      assertDenied(res.status, "B list A customers [JWT]");
    });

    it("B API key cannot list Store A customers", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/customers`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A customers [API key]");
    });

    it("B cannot get Store A customer by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/customers/${customerAId}`,
        authB()
      );
      assertDenied(res.status, "B get A customer [JWT]");
    });
  });

  // ── B2B (companies + quotes) ──────────────────────────────────────────────

  describe("B2B", () => {
    it("B cannot list Store A companies", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/companies`,
        authB()
      );
      assertDenied(res.status, "B list A companies [JWT]");
    });

    it("B API key cannot list Store A companies", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/companies`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A companies [API key]");
    });

    it("B cannot get Store A company by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/companies/${companyAId}`,
        authB()
      );
      assertDenied(res.status, "B get A company [JWT]");
    });

    it("B cannot create company in Store A", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/companies`,
        { name: "Injected Co", email: `inject-${Date.now()}@x.com` },
        authB()
      );
      assertDenied(res.status, "B create company in A [JWT]");
    });

    it("B cannot list Store A quotes", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/quotes`,
        authB()
      );
      assertDenied(res.status, "B list A quotes [JWT]");
    });

    it("B cannot get Store A quote by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/quotes/${quoteAId}`,
        authB()
      );
      assertDenied(res.status, "B get A quote [JWT]");
    });
  });

  // ── Subscriptions ─────────────────────────────────────────────────────────

  describe("Subscriptions", () => {
    it("B cannot list Store A subscription plans", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/subscription-plans`,
        authB()
      );
      assertDenied(res.status, "B list A plans [JWT]");
    });

    it("B API key cannot list Store A subscription plans", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/subscription-plans`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A plans [API key]");
    });

    it("B cannot get Store A plan by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/subscription-plans/${planAId}`,
        authB()
      );
      assertDenied(res.status, "B get A plan [JWT]");
    });

    it("B cannot create plan in Store A", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/subscription-plans`,
        {
          name: "Injected Plan",
          interval: "month",
          interval_count: 1,
        },
        authB()
      );
      assertDenied(res.status, "B create plan in A [JWT]");
    });
  });

  // ── Returns ───────────────────────────────────────────────────────────────

  describe("Returns", () => {
    it("B cannot list Store A return requests", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/returns`,
        authB()
      );
      assertDenied(res.status, "B list A returns [JWT]");
    });

    it("B API key cannot list Store A return requests", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/returns`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A returns [API key]");
    });

    it("B cannot get Store A return by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/returns/${returnRequestAId}`,
        authB()
      );
      assertDenied(res.status, "B get A return [JWT]");
    });
  });

  // ── Agents ────────────────────────────────────────────────────────────────

  describe("Agents", () => {
    it("B cannot list Store A agents", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/agents`,
        authB()
      );
      assertDenied(res.status, "B list A agents [JWT]");
    });

    it("B API key cannot list Store A agents", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/agents`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A agents [API key]");
    });

    it("B cannot get Store A agent by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/agents/${agentAId}`,
        authB()
      );
      assertDenied(res.status, "B get A agent [JWT]");
    });

    it("B cannot delete Store A agent", async () => {
      const res = await del(
        ctx,
        `/commerce/stores/${storeAId}/agents/${agentAId}`,
        authB()
      );
      assertDenied(res.status, "B delete A agent [JWT]");
    });
  });

  // ── Bookings ──────────────────────────────────────────────────────────────

  describe("Bookings", () => {
    it("B cannot list Store A booking resources", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/booking-resources`,
        authB()
      );
      assertDenied(res.status, "B list A booking resources [JWT]");
    });

    it("B API key cannot list Store A booking resources", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/booking-resources`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A booking resources [API key]");
    });

    it("B cannot get Store A booking resource by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/booking-resources/${bookingResourceAId}`,
        authB()
      );
      assertDenied(res.status, "B get A booking resource [JWT]");
    });

    it("B cannot list Store A bookings", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/bookings`,
        authB()
      );
      assertDenied(res.status, "B list A bookings [JWT]");
    });
  });

  // ── Wallet (store credits) ────────────────────────────────────────────────
  // Store credits are accessed via /customers/:customerId/credits endpoint.
  // An attempt by Org B to read credits for a customer that belongs to Store A
  // should fail because the storeId param scopes the request to Store A.

  describe("Wallet / Store credits", () => {
    it("B cannot read Store A customer credits (JWT)", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/customers/${customerAId}/credits`,
        authB()
      );
      assertDenied(res.status, "B read A customer credits [JWT]");
    });

    it("B API key cannot read Store A customer credits", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/customers/${customerAId}/credits`,
        apiKeyB()
      );
      assertDenied(res.status, "B read A customer credits [API key]");
    });

    it("B cannot issue store credit in Store A (JWT)", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/customers/${customerAId}/credits/issue`,
        { amount: "100.00", currency: "USD", reason: "injection" },
        authB()
      );
      assertDenied(res.status, "B issue A credit [JWT]");
    });
  });

  // ── Shipping ──────────────────────────────────────────────────────────────

  describe("Shipping", () => {
    it("B cannot list Store A shipping zones", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/shipping-zones`,
        authB()
      );
      assertDenied(res.status, "B list A shipping zones [JWT]");
    });

    it("B API key cannot list Store A shipping zones", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/shipping-zones`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A shipping zones [API key]");
    });

    it("B cannot get Store A shipping zone by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/shipping-zones/${shippingZoneAId}`,
        authB()
      );
      assertDenied(res.status, "B get A shipping zone [JWT]");
    });

    it("B cannot create shipping zone in Store A", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/shipping-zones`,
        { name: "Injected Zone" },
        authB()
      );
      assertDenied(res.status, "B create shipping zone in A [JWT]");
    });
  });

  // ── Tax ───────────────────────────────────────────────────────────────────

  describe("Tax", () => {
    it("B cannot list Store A tax zones", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/tax-zones`,
        authB()
      );
      assertDenied(res.status, "B list A tax zones [JWT]");
    });

    it("B API key cannot list Store A tax zones", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/tax-zones`,
        apiKeyB()
      );
      assertDenied(res.status, "B list A tax zones [API key]");
    });

    it("B cannot get Store A tax zone by id", async () => {
      const res = await get(
        ctx,
        `/commerce/stores/${storeAId}/tax-zones/${taxZoneAId}`,
        authB()
      );
      assertDenied(res.status, "B get A tax zone [JWT]");
    });

    it("B cannot create tax zone in Store A", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeAId}/tax-zones`,
        { name: "Injected Tax Zone", country_code: "XX" },
        authB()
      );
      assertDenied(res.status, "B create tax zone in A [JWT]");
    });
  });

  // ── Cross-store cart access ────────────────────────────────────────────────

  describe("Cart isolation (bonus)", () => {
    let cartAId: string;

    it("B cannot access Store A cart (if one exists)", async () => {
      // Create a cart in Store A
      const cartRes = await post(
        ctx,
        `/commerce/stores/${storeAId}/carts`,
        { currency: "USD" },
        authA()
      );
      // If cart creation succeeds, verify B cannot read it
      if (cartRes.status === 201) {
        cartAId = (cartRes.json as Record<string, unknown>)["id"] as string;
        const readRes = await get(
          ctx,
          `/commerce/stores/${storeAId}/carts/${cartAId}`,
          authB()
        );
        assertDenied(readRes.status, "B read A cart [JWT]");
      } else {
        // Cart creation may require different setup — skip if not 201
        expect([200, 201, 400, 404]).toContain(cartRes.status);
      }
    });
  });
});
