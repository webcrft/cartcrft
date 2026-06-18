/**
 * customer-addresses — Vitest integration suite (Wave 13.1).
 *
 * Covers the storefront address book mounted on the customer-auth plugin:
 *   GET/POST    /commerce/stores/:storeId/me/addresses
 *   PUT/DELETE  /commerce/stores/:storeId/me/addresses/:addressId
 *   POST        /commerce/stores/:storeId/me/addresses/:addressId/default
 *   GET         /commerce/stores/:storeId/customers/:customerId/addresses (admin)
 *
 * Verifies: create multiple → list only own → update → delete; setDefault flips
 * exactly one default per kind; and the IDOR guard (a customer cannot see or
 * modify another customer's addresses).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, del, mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { setMailerForTesting } from "../../src/modules/customer-auth/service.js";
import { encodeSecretValue } from "../../src/lib/secrets.js";

let ctx: TestCtx;
const mailer = new ConsoleMailer();

const TEST_JWT_SECRET = "test-jwt-secret-256bits-longerthis";

beforeAll(async () => {
  setMailerForTesting(mailer);
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Setup helpers ─────────────────────────────────────────────────────────────

async function adminAuth(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

async function setupStore() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const auth = await adminAuth(userId, orgId);
  const res = await post(ctx, "/commerce/stores", { name: "Addr Test Store", currency: "USD" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  const storeId = (res.json as Record<string, unknown>)["id"] as string;

  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const encodedSecret = encodeSecretValue(TEST_JWT_SECRET, secretsKey) ?? TEST_JWT_SECRET;

  await ctx.pool.query(
    `UPDATE stores
     SET auth_enabled = true,
         auth_jwt_secret = $2,
         auth_email_password_enabled = true,
         auth_require_email_verification = false
     WHERE id = $1::uuid`,
    [storeId, encodedSecret],
  );

  return { storeId, auth };
}

/** Create a verified customer and log in, returning the access token. */
async function makeCustomer(storeId: string): Promise<{ customerId: string; token: string }> {
  const email = `addr-${randomUUID()}@example.com`;
  const { hashPasswordSync } = await import("../../src/modules/customer-auth/service.js");
  const hash = hashPasswordSync("Password123!");
  const ins = await ctx.pool.query<{ id: string }>(
    `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
     VALUES ($1::uuid, $2, $3, 'email', true, true)
     RETURNING id::text`,
    [storeId, email, hash],
  );
  const customerId = ins.rows[0]!.id;

  const loginRes = await post(ctx, `/commerce/stores/${storeId}/auth/login`, {
    email,
    password: "Password123!",
  });
  if (loginRes.status !== 200) throw new Error(`login failed: ${JSON.stringify(loginRes.body)}`);
  const token = (loginRes.json as Record<string, unknown>)["access_token"] as string;
  return { customerId, token };
}

function bearer(token: string) {
  return { type: "bearer" as const, token };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Customer addresses — CRUD + defaults + IDOR", () => {
  let storeId: string;
  let adminAuth_: { type: "bearer"; token: string };
  let custToken: string;
  let custId: string;

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore();
    storeId = setup.storeId;
    adminAuth_ = setup.auth;
    const c = await makeCustomer(storeId);
    custToken = c.token;
    custId = c.customerId;
  });

  const addrIds: string[] = [];

  it("starts with an empty address book", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/me/addresses`, bearer(custToken));
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>)["addresses"]).toEqual([]);
  });

  it("POST creates multiple addresses", async () => {
    const a1 = await post(ctx, `/commerce/stores/${storeId}/me/addresses`, {
      label: "Home",
      name: "Ada Lovelace",
      address1: "1 Analytical Way",
      city: "London",
      province_code: "LDN",
      postal_code: "EC1",
      country_code: "GB",
      is_default_shipping: true,
      is_default_billing: true,
    }, bearer(custToken));
    expect(a1.status).toBe(201);
    const addr1 = (a1.json as Record<string, unknown>)["address"] as Record<string, unknown>;
    expect(addr1["label"]).toBe("Home");
    expect(addr1["address1"]).toBe("1 Analytical Way");
    expect(addr1["is_default_shipping"]).toBe(true);
    addrIds.push(addr1["id"] as string);

    const a2 = await post(ctx, `/commerce/stores/${storeId}/me/addresses`, {
      label: "Work",
      name: "Ada Lovelace",
      address1: "2 Babbage St",
      city: "London",
      country_code: "GB",
    }, bearer(custToken));
    expect(a2.status).toBe(201);
    const addr2 = (a2.json as Record<string, unknown>)["address"] as Record<string, unknown>;
    addrIds.push(addr2["id"] as string);
    expect(addr2["is_default_shipping"]).toBe(false);
  });

  it("GET lists both addresses, default first", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/me/addresses`, bearer(custToken));
    expect(res.status).toBe(200);
    const addresses = (res.json as Record<string, unknown>)["addresses"] as Record<string, unknown>[];
    expect(addresses.length).toBe(2);
    expect(addresses[0]!["label"]).toBe("Home"); // default shipping sorts first
  });

  it("PUT updates an address", async () => {
    const res = await put(ctx, `/commerce/stores/${storeId}/me/addresses/${addrIds[1]}`, {
      city: "Manchester",
      company: "Acme",
    }, bearer(custToken));
    expect(res.status).toBe(200);
    const addr = (res.json as Record<string, unknown>)["address"] as Record<string, unknown>;
    expect(addr["city"]).toBe("Manchester");
    expect(addr["company"]).toBe("Acme");
  });

  it("setDefault flips exactly one default shipping", async () => {
    // Promote address #2 to default shipping; #1 should lose it.
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/me/addresses/${addrIds[1]}/default`,
      { kind: "shipping" },
      bearer(custToken),
    );
    expect(res.status).toBe(200);
    expect(((res.json as Record<string, unknown>)["address"] as Record<string, unknown>)["is_default_shipping"]).toBe(true);

    const list = await get(ctx, `/commerce/stores/${storeId}/me/addresses`, bearer(custToken));
    const addresses = (list.json as Record<string, unknown>)["addresses"] as Record<string, unknown>[];
    const defaults = addresses.filter((a) => a["is_default_shipping"] === true);
    expect(defaults.length).toBe(1);
    expect(defaults[0]!["id"]).toBe(addrIds[1]);

    // Billing default is independent and still on #1.
    const billingDefaults = addresses.filter((a) => a["is_default_billing"] === true);
    expect(billingDefaults.length).toBe(1);
    expect(billingDefaults[0]!["id"]).toBe(addrIds[0]);
  });

  it("DELETE removes an address", async () => {
    const res = await del(ctx, `/commerce/stores/${storeId}/me/addresses/${addrIds[0]}`, bearer(custToken));
    expect(res.status).toBe(200);

    const list = await get(ctx, `/commerce/stores/${storeId}/me/addresses`, bearer(custToken));
    const addresses = (list.json as Record<string, unknown>)["addresses"] as Record<string, unknown>[];
    expect(addresses.length).toBe(1);
    expect(addresses[0]!["id"]).toBe(addrIds[1]);
  });

  it("requires a bearer token", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/me/addresses`);
    expect(res.status).toBe(401);
  });

  it("admin can read a customer's addresses (support)", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/customers/${custId}/addresses`, adminAuth_);
    expect(res.status).toBe(200);
    const addresses = (res.json as Record<string, unknown>)["addresses"] as Record<string, unknown>[];
    expect(addresses.length).toBe(1);
  });

  // ── IDOR: a second customer cannot touch the first customer's addresses ──────

  describe("IDOR isolation", () => {
    let otherToken: string;
    let victimAddrId: string;

    beforeAll(async () => {
      // Victim creates an address.
      const victim = await makeCustomer(storeId);
      const created = await post(ctx, `/commerce/stores/${storeId}/me/addresses`, {
        label: "Secret",
        address1: "99 Private Rd",
        city: "London",
        country_code: "GB",
      }, bearer(victim.token));
      victimAddrId = ((created.json as Record<string, unknown>)["address"] as Record<string, unknown>)["id"] as string;

      // Attacker is a different customer.
      const attacker = await makeCustomer(storeId);
      otherToken = attacker.token;
    });

    it("attacker's list does not contain the victim's address", async () => {
      const res = await get(ctx, `/commerce/stores/${storeId}/me/addresses`, bearer(otherToken));
      expect(res.status).toBe(200);
      const addresses = (res.json as Record<string, unknown>)["addresses"] as Record<string, unknown>[];
      expect(addresses.find((a) => a["id"] === victimAddrId)).toBeUndefined();
    });

    it("attacker cannot UPDATE the victim's address (404)", async () => {
      const res = await put(ctx, `/commerce/stores/${storeId}/me/addresses/${victimAddrId}`, {
        city: "Hacked",
      }, bearer(otherToken));
      expect(res.status).toBe(404);
    });

    it("attacker cannot DELETE the victim's address (404)", async () => {
      const res = await del(ctx, `/commerce/stores/${storeId}/me/addresses/${victimAddrId}`, bearer(otherToken));
      expect(res.status).toBe(404);
    });

    it("attacker cannot set the victim's address as default (404)", async () => {
      const res = await post(
        ctx,
        `/commerce/stores/${storeId}/me/addresses/${victimAddrId}/default`,
        { kind: "shipping" },
        bearer(otherToken),
      );
      expect(res.status).toBe(404);
    });
  });
});
