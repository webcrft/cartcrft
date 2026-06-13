/**
 * jwt-claims — H6.3 JWT iss/aud validation test suite.
 *
 * Tests:
 *  1. Platform JWT (lib/auth/jwt.ts):
 *     - mintJwt produces tokens with iss="cartcrft" and aud="cartcrft"
 *     - verifyJwt accepts a correctly minted token
 *     - verifyJwt rejects a token with wrong issuer
 *     - verifyJwt rejects a token with wrong audience
 *     - verifyJwt rejects a token with missing iss/aud (legacy token without claims)
 *
 *  2. Customer JWT (customer-auth/service.ts):
 *     - issueCustomerJwt produces iss="cartcrft" and store-scoped aud
 *     - verifyCustomerJwt accepts a token with correct store aud
 *     - verifyCustomerJwt rejects a token with wrong store aud
 *     - verifyCustomerJwt rejects a token with wrong issuer
 *
 *  3. customer-auth SMTP-connect endpoint returns 501 NOT_IMPLEMENTED
 *     (honest response, not misleading { ok: true })
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SignJWT, decodeJwt } from "jose";
import { randomUUID } from "node:crypto";
import {
  mintJwt,
  verifyJwt,
  JWT_ISSUER,
  JWT_AUDIENCE,
} from "../../src/lib/auth/jwt.js";
import {
  issueCustomerJwt,
  verifyCustomerJwt,
  customerJwtAudience,
  CUSTOMER_JWT_ISSUER,
} from "../../src/modules/customer-auth/service.js";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { post, mintJwt as helperMintJwt } from "../shared/helpers.js";
import { encodeSecretValue } from "../../src/lib/secrets.js";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { setMailerForTesting } from "../../src/modules/customer-auth/service.js";

// ── Setup ─────────────────────────────────────────────────────────────────────

let ctx: TestCtx;
const TEST_STORE_JWT_SECRET = "test-store-jwt-secret-min32chars!!!";

beforeAll(async () => {
  setMailerForTesting(new ConsoleMailer());
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Platform JWT tests ────────────────────────────────────────────────────────

describe("Platform JWT iss/aud", () => {
  const userId = randomUUID();
  const orgId = randomUUID();

  it("mintJwt includes iss=cartcrft", async () => {
    const token = await mintJwt({ userId, orgId });
    const payload = decodeJwt(token);
    expect(payload.iss).toBe(JWT_ISSUER);
  });

  it("mintJwt includes aud=cartcrft", async () => {
    const token = await mintJwt({ userId, orgId });
    const payload = decodeJwt(token);
    // jose encodes aud as a string or string[] — normalise for assertion
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    expect(aud).toBe(JWT_AUDIENCE);
  });

  it("mintJwt does NOT include jti (no revocation list)", async () => {
    const token = await mintJwt({ userId, orgId });
    const payload = decodeJwt(token);
    expect(payload.jti).toBeUndefined();
  });

  it("verifyJwt accepts a correctly minted token", async () => {
    const token = await mintJwt({ userId, orgId, email: "test@example.com" });
    const claims = await verifyJwt(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(userId);
    expect(claims!.org).toBe(orgId);
  });

  it("verifyJwt rejects a token with wrong issuer", async () => {
    // Mint manually with bad issuer using same secret
    const secret = new TextEncoder().encode(process.env["JWT_SECRET"] ?? "test-secret");
    const token = await new SignJWT({ sub: userId, org: orgId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("evil-issuer")
      .setAudience(JWT_AUDIENCE)
      .setExpirationTime("1h")
      .sign(secret);

    const result = await verifyJwt(token);
    expect(result).toBeNull();
  });

  it("verifyJwt rejects a token with wrong audience", async () => {
    const secret = new TextEncoder().encode(process.env["JWT_SECRET"] ?? "test-secret");
    const token = await new SignJWT({ sub: userId, org: orgId })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(JWT_ISSUER)
      .setAudience("some-other-service")
      .setExpirationTime("1h")
      .sign(secret);

    const result = await verifyJwt(token);
    expect(result).toBeNull();
  });

  it("verifyJwt rejects a legacy token with no iss/aud claims", async () => {
    // Simulate a token minted before H6.3 (no iss/aud)
    const secret = new TextEncoder().encode(process.env["JWT_SECRET"] ?? "test-secret");
    const token = await new SignJWT({ sub: userId, org: orgId })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(secret);

    // Should be rejected because iss/aud are now required
    const result = await verifyJwt(token);
    expect(result).toBeNull();
  });

  it("mintTestJwt (used by all suites) produces verifiable tokens", async () => {
    const token = await helperMintJwt({ userId, orgId });
    const claims = await verifyJwt(token);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(userId);
  });
});

// ── Customer JWT tests ────────────────────────────────────────────────────────

describe("Customer JWT iss/aud (store-scoped)", () => {
  const storeId = randomUUID();
  const otherStoreId = randomUUID();
  const customerId = randomUUID();
  const email = "customer@example.com";

  it("issueCustomerJwt includes iss=cartcrft", async () => {
    const token = await issueCustomerJwt(TEST_STORE_JWT_SECRET, customerId, email, false, storeId, [], 60);
    const payload = decodeJwt(token);
    expect(payload.iss).toBe(CUSTOMER_JWT_ISSUER);
  });

  it("issueCustomerJwt includes store-scoped aud", async () => {
    const token = await issueCustomerJwt(TEST_STORE_JWT_SECRET, customerId, email, false, storeId, [], 60);
    const payload = decodeJwt(token);
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    expect(aud).toBe(customerJwtAudience(storeId));
    expect(aud).toContain(storeId);
  });

  it("issueCustomerJwt does NOT include jti", async () => {
    const token = await issueCustomerJwt(TEST_STORE_JWT_SECRET, customerId, email, false, storeId, [], 60);
    const payload = decodeJwt(token);
    expect(payload.jti).toBeUndefined();
  });

  it("verifyCustomerJwt accepts a token with the correct store audience", async () => {
    const token = await issueCustomerJwt(TEST_STORE_JWT_SECRET, customerId, email, false, storeId, [], 60);
    const claims = await verifyCustomerJwt(token, TEST_STORE_JWT_SECRET, undefined, storeId);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(customerId);
    expect(claims!.store).toBe(storeId);
  });

  it("verifyCustomerJwt rejects a token with wrong store audience", async () => {
    // Token minted for storeId — should be rejected when verified against otherStoreId
    const token = await issueCustomerJwt(TEST_STORE_JWT_SECRET, customerId, email, false, storeId, [], 60);
    const claims = await verifyCustomerJwt(token, TEST_STORE_JWT_SECRET, undefined, otherStoreId);
    expect(claims).toBeNull();
  });

  it("verifyCustomerJwt rejects a token with wrong issuer", async () => {
    const key = new TextEncoder().encode(TEST_STORE_JWT_SECRET);
    const token = await new SignJWT({ sub: customerId, email, store: storeId, is_admin: false })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("malicious-issuer")
      .setAudience(customerJwtAudience(storeId))
      .setExpirationTime("1h")
      .sign(key);

    const claims = await verifyCustomerJwt(token, TEST_STORE_JWT_SECRET, undefined, storeId);
    expect(claims).toBeNull();
  });
});

// ── SMTP-connect endpoint test ────────────────────────────────────────────────

describe("customer-auth SMTP-connect endpoint", () => {
  let storeId: string;

  beforeAll(async () => {
    // Create a minimal store + configure auth for the SMTP-connect test
    const orgId = randomUUID();
    const userId = randomUUID();
    const token = await helperMintJwt({ userId, orgId });
    const auth = { type: "bearer" as const, token };

    const storeRes = await post(ctx, "/commerce/stores", { name: "SMTP Test Store", currency: "USD" }, auth);
    if (storeRes.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(storeRes.body)}`);
    storeId = (storeRes.body as Record<string, unknown>)["id"] as string;

    // Configure auth so the endpoint is reachable
    const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
    const encodedSecret = encodeSecretValue(TEST_STORE_JWT_SECRET, secretsKey) ?? TEST_STORE_JWT_SECRET;
    await ctx.pool.query(
      `UPDATE stores SET auth_enabled = true, auth_jwt_secret = $2 WHERE id = $1::uuid`,
      [storeId, encodedSecret]
    );
  });

  it("POST /auth/email/connect returns 501 NOT_IMPLEMENTED (not a misleading 200 ok)", async () => {
    const orgId = randomUUID();
    const userId = randomUUID();

    // We need a proper admin JWT for this store's org — look up the org
    const { rows } = await ctx.pool.query<{ organization_id: string }>(
      `SELECT organization_id::text FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    const storeOrgId = rows[0]?.organization_id ?? orgId;
    const token = await helperMintJwt({ userId, orgId: storeOrgId });
    const auth = { type: "bearer" as const, token };

    const res = await post(ctx, `/commerce/stores/${storeId}/auth/email/connect`, {}, auth);

    expect(res.status).toBe(501);
    const body = res.body as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("NOT_IMPLEMENTED");
    expect(typeof err["message"]).toBe("string");
  });
});
