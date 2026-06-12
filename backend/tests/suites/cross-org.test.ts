/**
 * cross-org — Store isolation suite for T2.8.
 *
 * Verifies that:
 *  1. A customer token for store A is rejected on store B
 *  2. Admin JWT for org1 cannot access org2's customers endpoint
 *  3. Same email + different passwords work independently per store
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { setMailerForTesting, hashPasswordSync } from "../../src/modules/customer-auth/service.js";
import { encodeSecretValue } from "../../src/lib/secrets.js";

let ctx: TestCtx;
const mailer = new ConsoleMailer();

beforeAll(async () => {
  setMailerForTesting(mailer);
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createStore(orgId: string, userId: string): Promise<string> {
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  const res = await post(ctx, "/commerce/stores", { name: `Isolation Store ${Date.now()}`, currency: "USD" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  const storeId = (res.json as Record<string, unknown>)["id"] as string;

  // Enable auth
  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const encodedSecret = encodeSecretValue("test-jwt-secret-256bits-longerthis", secretsKey) ?? "test-jwt-secret-256bits-longerthis";
  await ctx.pool.query(
    `UPDATE stores
     SET auth_enabled = true,
         auth_jwt_secret = $2,
         auth_email_password_enabled = true,
         auth_allow_self_registration = true,
         auth_require_email_verification = false
     WHERE id = $1::uuid`,
    [storeId, encodedSecret]
  );
  return storeId;
}

async function loginCustomer(storeId: string, email: string, password: string) {
  const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, { email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
  return (res.json as Record<string, unknown>)["access_token"] as string;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Cross-org isolation", () => {
  const org1Id = randomUUID();
  const org1UserId = randomUUID();
  const org2Id = randomUUID();
  const org2UserId = randomUUID();
  let storeAId: string;
  let storeBId: string;

  beforeAll(async () => {
    storeAId = await createStore(org1Id, org1UserId);
    storeBId = await createStore(org2Id, org2UserId);
  });

  it("store A customer token rejected on store B GET /auth/me", async () => {
    const email = `iso-${Date.now()}@example.com`;
    const hash = hashPasswordSync("Password123!");
    await ctx.pool.query(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)`,
      [storeAId, email, hash]
    );

    const tokenA = await loginCustomer(storeAId, email, "Password123!");

    // Use store A token against store B
    const res = await get(ctx, `/commerce/stores/${storeBId}/auth/me`, {
      type: "bearer",
      token: tokenA,
    });
    expect([401, 404]).toContain(res.status);
  });

  it("admin JWT for org1 cannot GET /customers on org2 store", async () => {
    const token = await mintJwt({ userId: org1UserId, orgId: org1Id });
    const res = await get(ctx, `/commerce/stores/${storeBId}/customers`, {
      type: "bearer",
      token,
    });
    // Should be 404 (store not found in org) or 401
    expect([401, 403, 404]).toContain(res.status);
  });

  it("same email + different passwords work independently per store", async () => {
    const sharedEmail = `shared-${Date.now()}@example.com`;
    const hashA = hashPasswordSync("PasswordForStoreA!");
    const hashB = hashPasswordSync("PasswordForStoreB!");

    await ctx.pool.query(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)`,
      [storeAId, sharedEmail, hashA]
    );
    await ctx.pool.query(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)`,
      [storeBId, sharedEmail, hashB]
    );

    // Login to store A with A password works
    const resA = await post(ctx, `/commerce/stores/${storeAId}/auth/login`, {
      email: sharedEmail,
      password: "PasswordForStoreA!",
    });
    expect(resA.status).toBe(200);

    // Login to store B with B password works
    const resB = await post(ctx, `/commerce/stores/${storeBId}/auth/login`, {
      email: sharedEmail,
      password: "PasswordForStoreB!",
    });
    expect(resB.status).toBe(200);

    // Login to store A with B password fails
    const resFail = await post(ctx, `/commerce/stores/${storeAId}/auth/login`, {
      email: sharedEmail,
      password: "PasswordForStoreB!",
    });
    expect(resFail.status).toBe(401);
  });
});
