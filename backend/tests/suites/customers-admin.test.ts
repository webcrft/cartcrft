/**
 * customers-admin.test.ts — H6.4: Admin customer management CRUD suite.
 *
 * Covers the /commerce/stores/:storeId/customers endpoints:
 *   - List customers (GET /customers)
 *   - Create customer (POST /customers)
 *   - Get customer (GET /customers/:id)
 *   - Update customer (PUT /customers/:id)
 *   - Delete customer (DELETE /customers/:id)
 *   - Block customer (POST /customers/:id/block)
 *   - Unblock customer (POST /customers/:id/unblock)
 *   - Add address (POST /customers/:id/addresses)
 *   - Delete address (DELETE /customers/:id/addresses/:addrId)
 *   - Get tags (GET /customers/:id/tags)
 *   - Set tags (PUT /customers/:id/tags)
 *   - Audit log (GET /stores/:storeId/audit-log)
 *   - Invite customer (POST /customers/invite) — storefront auth required
 *
 * Org isolation: org B cannot read/mutate org A's customers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, del, mintJwt, createApiKey } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { setMailerForTesting } from "../../src/modules/customer-auth/service.js";

let ctx: TestCtx;

const mailer = new ConsoleMailer();

beforeAll(async () => {
  setMailerForTesting(mailer);
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function makeAdminAuth(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

async function setupStoreWithKey(orgId: string, userId: string) {
  const auth = await makeAdminAuth(userId, orgId);

  const storeRes = await post(
    ctx,
    "/commerce/stores",
    { name: `CustAdmin Test ${randomUUID().slice(0, 8)}`, currency: "USD" },
    auth
  );
  if (storeRes.status !== 201) {
    throw new Error(`setupStore failed: ${JSON.stringify(storeRes.body)}`);
  }
  const storeId = storeRes.json["id"] as string;

  // Configure storefront auth so invite endpoint works
  await ctx.pool.query(
    `UPDATE stores SET auth_enabled = true, auth_jwt_secret = 'test-jwt-secret-cust-admin' WHERE id = $1::uuid`,
    [storeId]
  );

  const apiKey = await createApiKey(ctx, {
    orgId,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const keyAuth = { type: "api-key" as const, key: apiKey };

  return { storeId, auth, keyAuth };
}

// ── CRUD suite ────────────────────────────────────────────────────────────────

describe("Customers admin — CRUD", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let storeId: string;
  let auth: { type: "bearer"; token: string };
  let customerId: string;

  beforeAll(async () => {
    ({ storeId, auth } = await setupStoreWithKey(orgId, userId));
  });

  it("POST /customers → 201 creates customer", async () => {
    const email = `admin-crud-${Date.now()}@example.com`;
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers`,
      { email, first_name: "Admin", last_name: "Test" },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    customerId = res.json["id"] as string;
  });

  it("GET /customers → 200 lists customer", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/customers`, auth);
    expect(res.status).toBe(200);
    const customers = res.json["customers"] as unknown[];
    expect(Array.isArray(customers)).toBe(true);
    expect(customers.length).toBeGreaterThan(0);
  });

  it("GET /customers?q=email → filters results", async () => {
    // Create a uniquely named customer to filter on
    const uniqueEmail = `filter-test-unique-${Date.now()}@example.com`;
    await post(
      ctx,
      `/commerce/stores/${storeId}/customers`,
      { email: uniqueEmail },
      auth
    );
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/customers?q=${encodeURIComponent("filter-test-unique")}`,
      auth
    );
    expect(res.status).toBe(200);
    const customers = res.json["customers"] as Array<{ email: string }>;
    expect(customers.every(c => c.email.includes("filter-test-unique"))).toBe(true);
  });

  it("GET /customers/:id → 200 with customer detail", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}`,
      auth
    );
    expect(res.status).toBe(200);
    const customer = res.json["customer"] as Record<string, unknown>;
    expect(customer["id"]).toBe(customerId);
    expect(typeof customer["email"]).toBe("string");
    expect(Array.isArray(customer["addresses"])).toBe(true);
  });

  it("GET /customers/:id → 404 for non-existent id", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${randomUUID()}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });

  it("PUT /customers/:id → 200 updates customer", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}`,
      { first_name: "Updated", display_name: "Updated Test", phone: "+15551234567" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    // Verify DB
    const check = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}`,
      auth
    );
    expect((check.json["customer"] as Record<string, unknown>)["first_name"]).toBe("Updated");
    expect((check.json["customer"] as Record<string, unknown>)["phone"]).toBe("+15551234567");
  });

  it("PUT /customers/:id → 404 for non-existent id", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/customers/${randomUUID()}`,
      { first_name: "Ghost" },
      auth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });
});

// ── Block / Unblock suite ─────────────────────────────────────────────────────

describe("Customers admin — block / unblock", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let storeId: string;
  let auth: { type: "bearer"; token: string };
  let customerId: string;

  beforeAll(async () => {
    ({ storeId, auth } = await setupStoreWithKey(orgId, userId));
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers`,
      { email: `block-test-${Date.now()}@example.com` },
      auth
    );
    expect(res.status).toBe(201);
    customerId = res.json["id"] as string;
  });

  it("POST /customers/:id/block → 200, customer is_blocked=true", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/block`,
      { reason: "Policy violation" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    const check = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}`,
      auth
    );
    const customer = check.json["customer"] as Record<string, unknown>;
    expect(customer["is_blocked"]).toBe(true);
    expect(customer["blocked_reason"]).toBe("Policy violation");
  });

  it("POST /customers/:id/unblock → 200, customer is_blocked=false", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/unblock`,
      {},
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    const check = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}`,
      auth
    );
    const customer = check.json["customer"] as Record<string, unknown>;
    expect(customer["is_blocked"]).toBe(false);
  });

  it("POST /customers/:id/block → 404 for non-existent id", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/${randomUUID()}/block`,
      {},
      auth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });

  it("POST /customers/:id/unblock → 404 for non-existent id", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/${randomUUID()}/unblock`,
      {},
      auth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });
});

// ── Addresses suite ───────────────────────────────────────────────────────────

describe("Customers admin — addresses", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let storeId: string;
  let keyAuth: { type: "api-key"; key: string };
  let customerId: string;
  let addressId: string;

  beforeAll(async () => {
    const setup = await setupStoreWithKey(orgId, userId);
    storeId = setup.storeId;
    keyAuth = setup.keyAuth;

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers`,
      { email: `addr-test-${Date.now()}@example.com` },
      setup.auth
    );
    expect(res.status).toBe(201);
    customerId = res.json["id"] as string;
  });

  it("POST /customers/:id/addresses → 201 creates address", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/addresses`,
      {
        first_name: "John",
        last_name: "Doe",
        address1: "123 Main St",
        city: "Cape Town",
        zip: "8001",
        country_code: "ZA",
        is_default: true,
      },
      keyAuth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    addressId = res.json["id"] as string;
  });

  it("GET /customers/:id includes address in list", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}`,
      keyAuth
    );
    expect(res.status).toBe(200);
    const customer = res.json["customer"] as Record<string, unknown>;
    const addresses = customer["addresses"] as Array<{ id: string }>;
    expect(addresses.some(a => a.id === addressId)).toBe(true);
  });

  it("DELETE /customers/:id/addresses/:addressId → 200", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/addresses/${addressId}`,
      keyAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /customers/:id/addresses/:addressId → 404 after deletion", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/addresses/${addressId}`,
      keyAuth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });

  it("POST /customers/:id/addresses → 404 for non-existent customer", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/${randomUUID()}/addresses`,
      { address1: "Nowhere" },
      keyAuth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });
});

// ── Tags suite ────────────────────────────────────────────────────────────────

describe("Customers admin — tags", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let storeId: string;
  let auth: { type: "bearer"; token: string };
  let customerId: string;

  beforeAll(async () => {
    ({ storeId, auth } = await setupStoreWithKey(orgId, userId));
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers`,
      { email: `tags-test-${Date.now()}@example.com` },
      auth
    );
    expect(res.status).toBe(201);
    customerId = res.json["id"] as string;
  });

  it("GET /customers/:id/tags → 200 with empty array initially", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/tags`,
      auth
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["tags"])).toBe(true);
  });

  it("PUT /customers/:id/tags → 200 sets tags", async () => {
    const tags = ["vip", "wholesale", "early-adopter"];
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/tags`,
      { tags },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("GET /customers/:id/tags → reflects updated tags", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/tags`,
      auth
    );
    expect(res.status).toBe(200);
    const tags = res.json["tags"] as string[];
    expect(tags).toContain("vip");
    expect(tags).toContain("wholesale");
    expect(tags).toContain("early-adopter");
  });

  it("PUT /customers/:id/tags → 200 clears tags with empty array", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}/tags`,
      { tags: [] },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("PUT /customers/:id/tags → 404 for non-existent customer", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/customers/${randomUUID()}/tags`,
      { tags: ["nope"] },
      auth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });
});

// ── Invite suite ──────────────────────────────────────────────────────────────

describe("Customers admin — invite", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let storeId: string;
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    mailer.clear();
    ({ storeId, auth } = await setupStoreWithKey(orgId, userId));
  });

  it("POST /customers/invite → 200 sends invite", async () => {
    const inviteEmail = `invite-admin-${Date.now()}@example.com`;
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/invite`,
      { email: inviteEmail },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("POST /customers/invite → 401 without auth", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/invite`,
      { email: "anon@example.com" }
    );
    expect(res.status).toBe(401);
  });
});

// ── Delete customer suite ─────────────────────────────────────────────────────

describe("Customers admin — delete", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let storeId: string;
  let auth: { type: "bearer"; token: string };
  let customerId: string;

  beforeAll(async () => {
    ({ storeId, auth } = await setupStoreWithKey(orgId, userId));
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers`,
      { email: `delete-test-${Date.now()}@example.com` },
      auth
    );
    expect(res.status).toBe(201);
    customerId = res.json["id"] as string;
  });

  it("DELETE /customers/:id → 200 deletes customer", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("GET /customers/:id → 404 after deletion", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/customers/${customerId}`,
      auth
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /customers/:id → 404 for non-existent id", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/customers/${randomUUID()}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(res.json["error"]["code"]).toBe("NOT_FOUND");
  });
});

// ── Audit log suite ───────────────────────────────────────────────────────────

describe("Customers admin — audit log", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let storeId: string;
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    ({ storeId, auth } = await setupStoreWithKey(orgId, userId));
    // Create and block a customer to generate audit log entries
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers`,
      { email: `audit-test-${Date.now()}@example.com` },
      auth
    );
    expect(res.status).toBe(201);
    const cid = res.json["id"] as string;
    // Block to generate audit entry
    await post(
      ctx,
      `/commerce/stores/${storeId}/customers/${cid}/block`,
      { reason: "Audit test" },
      auth
    );
  });

  it("GET /audit-log → 200 with entries array", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/audit-log`, auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["entries"])).toBe(true);
  });

  it("GET /audit-log → 401 without auth", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/audit-log`);
    expect(res.status).toBe(401);
  });

  it("GET /audit-log?limit=5 → respects limit", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/audit-log?limit=5`,
      auth
    );
    expect(res.status).toBe(200);
    const entries = res.json["entries"] as unknown[];
    expect(entries.length).toBeLessThanOrEqual(5);
  });
});

// ── Org isolation suite ───────────────────────────────────────────────────────
//
// Cross-tenant access is denied.  The exact status code depends on where
// the check occurs:
//   - 403: JWT org doesn't match the store's org (detected by storeAuthAdmin)
//   - 404: store not found in the requesting org's context
// Both deny access; we accept either (same posture as tenant-isolation.test.ts).

function assertDenied(status: number, label: string) {
  const allowed = [401, 403, 404];
  if (!allowed.includes(status)) {
    throw new Error(
      `${label}: expected 401, 403, or 404 (access denied) but got ${status}`
    );
  }
}

describe("Customers admin — org isolation", () => {
  // Org A
  const userIdA = randomUUID();
  const orgIdA = randomUUID();
  let storeIdA: string;
  let authA: { type: "bearer"; token: string };
  let customerIdA: string;

  // Org B
  const userIdB = randomUUID();
  const orgIdB = randomUUID();
  let authB: { type: "bearer"; token: string };

  beforeAll(async () => {
    // Set up org A's store + customer
    ({ storeId: storeIdA, auth: authA } = await setupStoreWithKey(orgIdA, userIdA));
    const res = await post(
      ctx,
      `/commerce/stores/${storeIdA}/customers`,
      { email: `iso-a-${Date.now()}@example.com` },
      authA
    );
    expect(res.status).toBe(201);
    customerIdA = res.json["id"] as string;

    // Org B: just a JWT, no store in org A
    authB = await makeAdminAuth(userIdB, orgIdB);
  });

  it("org B cannot GET org A's customers list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeIdA}/customers`, authB);
    assertDenied(res.status, "B list A customers");
  });

  it("org B cannot GET org A's specific customer", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeIdA}/customers/${customerIdA}`,
      authB
    );
    assertDenied(res.status, "B get A customer");
  });

  it("org B cannot create a customer in org A's store", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeIdA}/customers`,
      { email: `evil-${Date.now()}@example.com` },
      authB
    );
    assertDenied(res.status, "B create in A");
  });

  it("org B cannot update org A's customer", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeIdA}/customers/${customerIdA}`,
      { first_name: "Hacked" },
      authB
    );
    assertDenied(res.status, "B update A customer");
  });

  it("org B cannot delete org A's customer", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeIdA}/customers/${customerIdA}`,
      authB
    );
    assertDenied(res.status, "B delete A customer");
  });

  it("org B cannot block org A's customer", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeIdA}/customers/${customerIdA}/block`,
      {},
      authB
    );
    assertDenied(res.status, "B block A customer");
  });

  it("org B cannot read org A's audit-log", async () => {
    const res = await get(ctx, `/commerce/stores/${storeIdA}/audit-log`, authB);
    assertDenied(res.status, "B read A audit-log");
  });
});
