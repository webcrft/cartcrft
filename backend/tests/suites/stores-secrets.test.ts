/**
 * stores-secrets — H0.3: auth_jwt_secret encryption round-trip test.
 *
 * Verifies that the auth_jwt_secret written by createStore (stores/service.ts)
 * is encoded with encodeSecretValue so that the customer-auth decode path
 * (decodeSecretValue) can recover it correctly in production.
 *
 * Scenarios:
 *  1. With AUTH_SECRETS_KEY set: store created via API has an AES-GCM encrypted
 *     auth_jwt_secret; a customer register → login round-trip succeeds
 *     (proving JWT signing/verification works with the decoded secret).
 *  2. Without AUTH_SECRETS_KEY: plaintext passthrough still round-trips.
 *
 * Owned by H0.3 — do not touch app.ts/main.ts or other modules.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { setMailerForTesting } from "../../src/modules/customer-auth/service.js";
import {
  encodeSecretValue,
  decodeSecretValue,
} from "../../src/lib/secrets.js";

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

async function adminAuth(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

/**
 * Create a store via the API and return its id.
 * This exercises the createStore code path that should now encode auth_jwt_secret.
 */
async function createStoreViaApi(
  orgId: string,
  userId: string,
  name: string
): Promise<string> {
  const auth = await adminAuth(userId, orgId);
  const res = await post(
    ctx,
    "/commerce/stores",
    { name, currency: "USD" },
    auth
  );
  if (res.status !== 201) {
    throw new Error(
      `createStoreViaApi failed: ${res.status} ${JSON.stringify(res.body)}`
    );
  }
  return (res.json as Record<string, unknown>)["id"] as string;
}

/**
 * Enable customer auth on a store via SQL (setting the fields that control
 * auth behaviour, but NOT overwriting auth_jwt_secret — we want to prove the
 * API-created secret is already correctly encoded).
 */
async function enableAuth(storeId: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE stores
     SET auth_enabled = true,
         auth_email_password_enabled = true,
         auth_allow_self_registration = true,
         auth_require_email_verification = true
     WHERE id = $1::uuid`,
    [storeId]
  );
}

// ── Suite 1: AUTH_SECRETS_KEY set — AES-GCM encrypted round-trip ─────────────

describe("auth_jwt_secret — WITH AUTH_SECRETS_KEY (encrypted path)", () => {
  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const orgId = randomUUID();
  const userId = randomUUID();
  let storeId: string;

  beforeAll(async () => {
    // Guard: this suite only makes sense when AUTH_SECRETS_KEY is present.
    if (!secretsKey) {
      console.warn(
        "[stores-secrets] AUTH_SECRETS_KEY not set — skipping encrypted suite"
      );
      return;
    }
    mailer.clear();
    storeId = await createStoreViaApi(orgId, userId, "Encrypted Secret Store");
  });

  it("AUTH_SECRETS_KEY is set in the test environment", () => {
    expect(secretsKey).not.toBe("");
  });

  it("auth_jwt_secret in DB is not plaintext hex (it is AES-GCM base64)", async () => {
    if (!secretsKey) return;

    const { rows } = await ctx.pool.query<{ auth_jwt_secret: string }>(
      `SELECT auth_jwt_secret FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    const stored = rows[0]?.auth_jwt_secret;
    expect(stored).toBeDefined();
    expect(stored).not.toBe("");

    // A 32-byte random hex string is 64 hex chars.
    // Plaintext would match /^[0-9a-f]{64}$/.
    // After AES-GCM encoding it is base64 and longer (nonce + ct + tag).
    const isPlaintextHex = /^[0-9a-f]{64}$/i.test(stored!);
    expect(isPlaintextHex).toBe(false);
  });

  it("decodeSecretValue(stored, key) recovers a 64-char hex string", async () => {
    if (!secretsKey) return;

    const { rows } = await ctx.pool.query<{ auth_jwt_secret: string }>(
      `SELECT auth_jwt_secret FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    const stored = rows[0]?.auth_jwt_secret!;
    const decoded = decodeSecretValue(stored, secretsKey);
    // Decoded value should be the original 32-byte random hex
    expect(decoded).toMatch(/^[0-9a-f]{64}$/i);
  });

  it("encodeSecretValue → decodeSecretValue round-trips (symmetric)", () => {
    if (!secretsKey) return;

    const original = "deadbeef".repeat(8); // 64-char hex
    const encoded = encodeSecretValue(original, secretsKey);
    expect(encoded).not.toBeNull();
    expect(encoded).not.toBe(original);
    const decoded = decodeSecretValue(encoded!, secretsKey);
    expect(decoded).toBe(original);
  });

  it("customer register → login round-trip succeeds (JWT decode works)", async () => {
    if (!secretsKey) return;

    await enableAuth(storeId);

    const email = `secret-test-${Date.now()}@example.com`;
    const password = "Password123!";

    // Register
    const regRes = await post(
      ctx,
      `/commerce/stores/${storeId}/auth/register`,
      { email, password }
    );
    expect(regRes.status).toBe(201);
    expect(
      (regRes.json as Record<string, unknown>)["requires_verification"]
    ).toBe(true);

    // Extract verification token from email
    const sent = mailer.sentMessages.find((m) => m.to === email);
    expect(sent).toBeDefined();
    const match = sent!.bodyText?.match(/token=([a-f0-9]+)/);
    expect(match).toBeTruthy();
    const verifyToken = match![1]!;

    // Verify email
    const verifyRes = await post(
      ctx,
      `/commerce/stores/${storeId}/auth/verify-email`,
      { token: verifyToken }
    );
    expect(verifyRes.status).toBe(200);

    // Login — this step will fail with a JWT signing error if the stored secret
    // cannot be decoded (i.e., the bug is not fixed).
    const loginRes = await post(
      ctx,
      `/commerce/stores/${storeId}/auth/login`,
      { email, password }
    );
    expect(loginRes.status).toBe(200);
    const loginBody = loginRes.json as Record<string, unknown>;
    expect(typeof loginBody["session_token"]).toBe("string");
    expect(typeof loginBody["access_token"]).toBe("string");

    // Verify /me works — proves JWT verification also succeeds.
    const accessToken = loginBody["access_token"] as string;
    const meRes = await get(
      ctx,
      `/commerce/stores/${storeId}/auth/me`,
      { type: "bearer", token: accessToken }
    );
    expect(meRes.status).toBe(200);
    const meBody = meRes.json as Record<string, unknown>;
    const customer = meBody["customer"] as Record<string, unknown>;
    expect(customer["email"]).toBe(email);
  });
});

// ── Suite 2: no AUTH_SECRETS_KEY — plaintext passthrough ─────────────────────

describe("auth_jwt_secret — WITHOUT AUTH_SECRETS_KEY (plaintext passthrough)", () => {
  it("encodeSecretValue with empty key returns value as-is", () => {
    const plaintext = "myrawsecret";
    const encoded = encodeSecretValue(plaintext, "");
    // Passthrough: not encrypted
    expect(encoded).toBe(plaintext);
  });

  it("decodeSecretValue with empty key returns stored value as-is", () => {
    const stored = "myrawsecret";
    const decoded = decodeSecretValue(stored, "");
    expect(decoded).toBe(stored);
  });

  it("round-trip without key: encode(x, '') === x, decode(x, '') === x", () => {
    const original = "a".repeat(64);
    const encoded = encodeSecretValue(original, "");
    expect(encoded).toBe(original);
    const decoded = decodeSecretValue(encoded!, "");
    expect(decoded).toBe(original);
  });

  it("encodeSecretValue with empty value returns null", () => {
    // Empty value → null (SQL NULL), regardless of key
    expect(encodeSecretValue("", "")).toBeNull();
    const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
    if (secretsKey) {
      expect(encodeSecretValue("", secretsKey)).toBeNull();
    }
  });
});

// ── Suite 3: Symmetry check — values encoded by createStore are decodable ────

describe("auth_jwt_secret — store-create symmetry", () => {
  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const orgId = randomUUID();
  const userId = randomUUID();
  let storedSecret: string;

  beforeAll(async () => {
    const storeId = await createStoreViaApi(
      orgId,
      userId,
      "Symmetry Check Store"
    );
    const { rows } = await ctx.pool.query<{ auth_jwt_secret: string }>(
      `SELECT auth_jwt_secret FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    storedSecret = rows[0]?.auth_jwt_secret ?? "";
  });

  it("stored auth_jwt_secret is non-empty", () => {
    expect(storedSecret).not.toBe("");
  });

  it("decode(stored) yields a 64-char hex string (the original jwtSecret)", () => {
    const decoded = decodeSecretValue(storedSecret, secretsKey);
    // Whether key is set or not, the decoded value should be raw 32-byte hex
    expect(decoded).toMatch(/^[0-9a-f]{64}$/i);
  });
});
