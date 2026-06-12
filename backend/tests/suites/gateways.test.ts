/**
 * gateways — Payment providers and gateways test suite.
 *
 * Tests:
 *  1. payment_providers CRUD: create with config, list, delete
 *  2. Config encrypt roundtrip: when AUTH_SECRETS_KEY set, stored config is NOT plaintext
 *  3. Dev mode (no AUTH_SECRETS_KEY): stored config IS plaintext
 *  4. Gateway endpoints: requireJwt + superToken required for list/upsert/set-dev-creds
 *  5. GetPaymentGatewayStatus: any JWT user can call; returns { gateways: {...} }; no secrets leaked
 *  6. SetGatewayDevCredentials: super only; updates dev creds; DB verified
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  del,
  mintJwt,
  isErrorEnvelope,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;
const SUPER_TOKEN = "test-super-token-gateways";

beforeAll(async () => {
  process.env["SUPER_TOKEN"] = SUPER_TOKEN;
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  delete process.env["SUPER_TOKEN"];
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

/** Create a store via REST, return its id. */
async function createStore(
  orgId: string,
  auth: { type: "bearer"; token: string }
): Promise<string> {
  const res = await post(ctx, "/commerce/stores", { name: "Gateway Test Store" }, auth);
  if (res.status !== 201) {
    throw new Error(`createStore: expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.json["id"] as string;
}

// ── Payment Providers CRUD ────────────────────────────────────────────────────

describe("Payment Providers CRUD", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;
  let providerId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(orgId, auth);
  });

  it("1. Create payment provider with config", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/payment-providers`,
      {
        slug: "stripe",
        name: "Stripe",
        type: "stripe",
        config: { secret_key: "sk_test_fake_key_12345" },
        is_active: true,
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    providerId = res.json["id"] as string;
  });

  it("1b. List payment providers", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/payment-providers`,
      auth
    );
    expect(res.status).toBe(200);
    const providers = res.json["providers"] as unknown[];
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
  });

  it("2. Config encrypt roundtrip: encryptSecret/decryptSecret", async () => {
    const { randomBytes } = await import("node:crypto");
    const testKey = randomBytes(32).toString("hex"); // 64-char hex key

    const { encryptSecret, decryptSecret } = await import(
      "../../src/lib/secrets.js"
    );

    const plaintext = "sk_live_real_key_here";
    const ciphertext = encryptSecret(plaintext, testKey);

    // Ciphertext should not contain the plaintext
    expect(ciphertext).not.toContain(plaintext);
    expect(ciphertext).not.toBe(plaintext);

    // Should be base64-encoded
    expect(() => Buffer.from(ciphertext, "base64")).not.toThrow();

    // Round-trip: decrypt should return original
    const decrypted = decryptSecret(ciphertext, testKey);
    expect(decrypted).toBe(plaintext);
  });

  it("3. Dev mode (no AUTH_SECRETS_KEY): encodeSecretValue returns plaintext", async () => {
    const { encodeSecretValue, decodeSecretValue } = await import(
      "../../src/lib/secrets.js"
    );

    const value = "sk_test_passthrough";

    // With empty key → passthrough
    const stored = encodeSecretValue(value, "");
    expect(stored).toBe(value);

    // Decode with empty key → passthrough
    const decoded = decodeSecretValue(value, "");
    expect(decoded).toBe(value);

    // Empty value → null
    const nullResult = encodeSecretValue("", "");
    expect(nullResult).toBeNull();
  });

  it("1c. Delete payment provider", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/payment-providers/${providerId}`,
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("Delete non-existent provider → 404", async () => {
    const fakeId = randomUUID();
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/payment-providers/${fakeId}`,
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("Upsert (create then update) provider is idempotent", async () => {
    // Create provider
    const res1 = await post(
      ctx,
      `/commerce/stores/${storeId}/payment-providers`,
      {
        slug: "paystack",
        name: "Paystack",
        type: "paystack",
        config: { secret_key: "sk_test_initial" },
      },
      auth
    );
    expect(res1.status).toBe(201);
    const id1 = res1.json["id"] as string;

    // Create again with same slug → should update (ON CONFLICT)
    const res2 = await post(
      ctx,
      `/commerce/stores/${storeId}/payment-providers`,
      {
        slug: "paystack",
        name: "Paystack Updated",
        type: "paystack",
        config: { secret_key: "sk_test_updated" },
      },
      auth
    );
    expect(res2.status).toBe(201);
    // The id should be the same (same slug, same store)
    expect(res2.json["id"]).toBe(id1);
  });
});

// ── Gateway endpoints (platform-level, super-admin only) ─────────────────────

describe("Payment Gateways (platform-level)", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let jwtToken: string;
  let gatewayId: string;

  beforeAll(async () => {
    jwtToken = await mintJwt({ userId, orgId });
  });

  it("4. List gateways: 401 without JWT", async () => {
    const res = await ctx.request({
      method: "GET",
      path: "/commerce/payment-gateways",
    });
    expect(res.status).toBe(401);
  });

  it("4b. List gateways: 403 without super-token", async () => {
    const res = await get(ctx, "/commerce/payment-gateways", {
      type: "bearer",
      token: jwtToken,
    });
    expect(res.status).toBe(403);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("4c. List gateways: 200 with JWT + super-token", async () => {
    const res = await ctx.request({
      method: "GET",
      path: "/commerce/payment-gateways",
      headers: {
        authorization: `Bearer ${jwtToken}`,
        "x-super-token": SUPER_TOKEN,
      },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["gateways"])).toBe(true);
  });

  it("4d. Upsert gateway: creates gateway", async () => {
    const gatewayName = `test-stripe-${randomUUID().slice(0, 8)}`;
    const res = await ctx.request({
      method: "POST",
      path: "/commerce/payment-gateways",
      body: {
        name: gatewayName,
        type: "stripe",
        secret_key_enc: "enc_sk_test_fake",
        public_key_enc: "enc_pk_test_fake",
        is_active: true,
      },
      headers: {
        authorization: `Bearer ${jwtToken}`,
        "x-super-token": SUPER_TOKEN,
      },
    });
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    gatewayId = res.json["id"] as string;
  });

  it("5. GetPaymentGatewayStatus: any JWT user can call; no secrets leaked", async () => {
    const res = await get(ctx, "/commerce/payment-gateway-status", {
      type: "bearer",
      token: jwtToken,
    });
    expect(res.status).toBe(200);
    expect(typeof res.json["gateways"]).toBe("object");

    // Verify no raw keys in response
    const body = JSON.stringify(res.json);
    expect(body).not.toContain("secret_key_enc");
    expect(body).not.toContain("sk_test_");
    expect(body).not.toContain("sk_live_");
  });

  it("6. SetGatewayDevCredentials: super only; updates dev creds; DB verified", async () => {
    if (!gatewayId) {
      throw new Error("No gatewayId available from prior test");
    }

    const res = await ctx.request({
      method: "PUT",
      path: `/commerce/payment-gateways/${gatewayId}/dev-credentials`,
      body: {
        dev_secret_key_enc: "enc_dev_sk_test_fake",
        dev_public_key_enc: "enc_dev_pk_test_fake",
      },
      headers: {
        authorization: `Bearer ${jwtToken}`,
        "x-super-token": SUPER_TOKEN,
      },
    });
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    // Verify DB
    const { rows } = await ctx.pool.query<{
      dev_secret_key_enc: string;
      dev_public_key_enc: string;
    }>(
      `SELECT dev_secret_key_enc, dev_public_key_enc
       FROM payment_gateway_instances WHERE id = $1::uuid`,
      [gatewayId]
    );
    expect(rows[0]?.dev_secret_key_enc).toBe("enc_dev_sk_test_fake");
    expect(rows[0]?.dev_public_key_enc).toBe("enc_dev_pk_test_fake");
  });

  it("6b. SetGatewayDevCredentials: 403 without super-token", async () => {
    const fakeId = randomUUID();
    const res = await ctx.request({
      method: "PUT",
      path: `/commerce/payment-gateways/${fakeId}/dev-credentials`,
      body: { dev_secret_key_enc: "should_not_work" },
      headers: { authorization: `Bearer ${jwtToken}` },
    });
    expect(res.status).toBe(403);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("GetGatewayStatus: returned gateways have correct shape", async () => {
    const res = await get(ctx, "/commerce/payment-gateway-status", {
      type: "bearer",
      token: jwtToken,
    });
    expect(res.status).toBe(200);
    const gateways = res.json["gateways"] as Record<string, unknown>;
    expect(typeof gateways).toBe("object");

    // If stripe gateway was created, verify shape
    if ("stripe" in gateways) {
      const stripe = gateways["stripe"] as Record<string, unknown>;
      expect(typeof stripe["has_live"]).toBe("boolean");
      expect(typeof stripe["has_dev"]).toBe("boolean");
    }
  });

  it("Upsert gateway: 403 without super-token", async () => {
    const res = await post(
      ctx,
      "/commerce/payment-gateways",
      {
        name: "should-fail",
        type: "stripe",
        secret_key_enc: "enc_fake",
      },
      { type: "bearer", token: jwtToken }
    );
    expect(res.status).toBe(403);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── secrets.ts unit tests ─────────────────────────────────────────────────────

describe("secrets.ts encrypt/decrypt", () => {
  it("roundtrip with 64-char hex key", async () => {
    const { encryptSecret, decryptSecret } = await import(
      "../../src/lib/secrets.js"
    );
    const { randomBytes } = await import("node:crypto");
    const key = randomBytes(32).toString("hex");
    const plaintext = "super-secret-value-123";

    const ct = encryptSecret(plaintext, key);
    expect(ct).not.toBe(plaintext);

    const decoded = decryptSecret(ct, key);
    expect(decoded).toBe(plaintext);
  });

  it("roundtrip with base64 key", async () => {
    const { encryptSecret, decryptSecret } = await import(
      "../../src/lib/secrets.js"
    );
    const { randomBytes } = await import("node:crypto");
    const key = randomBytes(32).toString("base64");
    const plaintext = "another-secret";

    const ct = encryptSecret(plaintext, key);
    const decoded = decryptSecret(ct, key);
    expect(decoded).toBe(plaintext);
  });

  it("throws on bad key", async () => {
    const { encryptSecret } = await import("../../src/lib/secrets.js");
    expect(() => encryptSecret("value", "not-a-valid-key")).toThrow();
  });

  it("throws on tampered ciphertext", async () => {
    const { encryptSecret, decryptSecret } = await import(
      "../../src/lib/secrets.js"
    );
    const { randomBytes } = await import("node:crypto");
    const key = randomBytes(32).toString("hex");
    const ct = encryptSecret("test", key);

    // Tamper: replace last 4 chars with garbage
    const tampered = ct.slice(0, -4) + "XXXX";
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("encodeSecretValue returns null for empty input", async () => {
    const { encodeSecretValue } = await import("../../src/lib/secrets.js");
    expect(encodeSecretValue("", "some-ignored")).toBeNull();
  });
});
