/**
 * password-hashing — Vitest integration suite for H6.2.
 *
 * Tests:
 *  - New registrations produce argon2id hashes
 *  - Login with argon2id hash works
 *  - Login with legacy PBKDF2 hash succeeds AND upgrades hash to argon2id
 *  - Wrong password rejected for both hash formats
 *  - Hash-format detection utility (isArgon2Hash)
 *  - verifyPasswordSync handles both formats
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { post } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import {
  setMailerForTesting,
  hashPasswordSync,
  verifyPasswordSync,
  isArgon2Hash,
  verifyAndMaybeRehash,
} from "../../src/modules/customer-auth/service.js";
import { encodeSecretValue } from "../../src/lib/secrets.js";

let ctx: TestCtx;

const TEST_JWT_SECRET = "test-jwt-secret-hash-suite-256bits";

beforeAll(async () => {
  setMailerForTesting(new ConsoleMailer());
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePbkdf2Hash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const dk = pbkdf2Sync(password, salt, 100_000, 64, "sha512");
  return `pbkdf2:${salt}:${dk.toString("hex")}`;
}

async function setupStore(): Promise<string> {
  const orgId = randomUUID();
  const userId = randomUUID();

  // Create org + user context, then a store
  const { mintJwt, post: postH } = await import("../shared/helpers.js");
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const res = await postH(ctx, "/commerce/stores", { name: "PwHash Test Store", currency: "USD" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  const storeId = (res.json as Record<string, unknown>)["id"] as string;

  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const encodedSecret = encodeSecretValue(TEST_JWT_SECRET, secretsKey) ?? TEST_JWT_SECRET;

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

// ── Unit tests: hash format detection ─────────────────────────────────────────

describe("password-hashing — hash format detection", () => {
  it("isArgon2Hash: recognises argon2id prefix", () => {
    // Produce a real argon2id hash
    const h = hashPasswordSync("testpassword");
    expect(h).toMatch(/^\$argon2id\$/);
    expect(isArgon2Hash(h)).toBe(true);
  });

  it("isArgon2Hash: rejects pbkdf2 prefix", () => {
    const h = makePbkdf2Hash("testpassword");
    expect(h).toMatch(/^pbkdf2:/);
    expect(isArgon2Hash(h)).toBe(false);
  });

  it("hashPasswordSync always produces argon2id hash", () => {
    const h = hashPasswordSync("somepassword");
    expect(h).toMatch(/^\$argon2id\$/);
  });
});

// ── Unit tests: verify both formats ───────────────────────────────────────────

describe("password-hashing — verifyPasswordSync", () => {
  it("verifies correct password against argon2id hash", () => {
    const h = hashPasswordSync("correcthorse");
    expect(verifyPasswordSync("correcthorse", h)).toBe(true);
  });

  it("rejects wrong password against argon2id hash", () => {
    const h = hashPasswordSync("correcthorse");
    expect(verifyPasswordSync("wrongpassword", h)).toBe(false);
  });

  it("verifies correct password against legacy PBKDF2 hash", () => {
    const h = makePbkdf2Hash("legacypassword");
    expect(verifyPasswordSync("legacypassword", h)).toBe(true);
  });

  it("rejects wrong password against legacy PBKDF2 hash", () => {
    const h = makePbkdf2Hash("legacypassword");
    expect(verifyPasswordSync("wrongpassword", h)).toBe(false);
  });

  it("rejects empty stored hash", () => {
    expect(verifyPasswordSync("anything", "")).toBe(false);
  });

  it("rejects malformed stored hash", () => {
    expect(verifyPasswordSync("anything", "notahash")).toBe(false);
  });
});

// ── Integration: register → hash is argon2id ──────────────────────────────────

describe("password-hashing — register produces argon2id hash", () => {
  let storeId: string;

  beforeAll(async () => {
    storeId = await setupStore();
  });

  const email = `pwhash-reg-${Date.now()}@example.com`;
  const password = "Register123!";

  it("POST /auth/register → 201", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/register`, { email, password });
    expect(res.status).toBe(201);
  });

  it("stored hash is argon2id format", async () => {
    const { rows } = await ctx.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM customers WHERE store_id = $1::uuid AND email = $2`,
      [storeId, email]
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
  });
});

// ── Integration: login with argon2id hash ────────────────────────────────────

describe("password-hashing — login with argon2id hash", () => {
  let storeId: string;

  beforeAll(async () => {
    storeId = await setupStore();
  });

  const email = `pwhash-login-argon-${Date.now()}@example.com`;
  const password = "Argon2Login1!";

  beforeAll(async () => {
    // Only proceed if storeId is set
    if (!storeId) return;
    // Insert customer with argon2id hash directly
    const hash = hashPasswordSync(password);
    await ctx.pool.query(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)`,
      [storeId, email, hash]
    );
  });

  it("login with argon2id hash → 200 with tokens", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, { email, password });
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(typeof body["session_token"]).toBe("string");
    expect(typeof body["access_token"]).toBe("string");
  });

  it("login with wrong password against argon2id hash → 401", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, {
      email,
      password: "wrongpassword!",
    });
    expect(res.status).toBe(401);
  });
});

// ── Integration: legacy PBKDF2 user → login succeeds + hash upgraded ─────────

describe("password-hashing — legacy PBKDF2 rehash-on-login", () => {
  let storeId: string;
  let customerId: string;

  const email = `pwhash-legacy-${Date.now()}@example.com`;
  const password = "LegacyPass123!";

  beforeAll(async () => {
    storeId = await setupStore();

    // Insert a customer with a legacy PBKDF2 hash directly into the DB
    const legacyHash = makePbkdf2Hash(password);
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)
       RETURNING id::text`,
      [storeId, email, legacyHash]
    );
    customerId = rows[0]!.id;

    // Confirm the hash is PBKDF2 before login
    const { rows: before } = await ctx.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM customers WHERE id = $1::uuid`,
      [customerId]
    );
    expect(before[0]!.password_hash).toMatch(/^pbkdf2:/);
  });

  it("login with legacy PBKDF2 hash → 200 with tokens", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, { email, password });
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(typeof body["session_token"]).toBe("string");
    expect(typeof body["access_token"]).toBe("string");
  });

  it("stored hash is upgraded to argon2id after successful login", async () => {
    const { rows } = await ctx.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM customers WHERE id = $1::uuid`,
      [customerId]
    );
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.password_hash).toMatch(/^\$argon2id\$/);
  });

  it("subsequent login with same password still works (argon2id path)", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, { email, password });
    expect(res.status).toBe(200);
  });

  it("wrong password rejected for legacy PBKDF2 user", async () => {
    // Insert a SECOND customer with a PBKDF2 hash for wrong-password test
    const email2 = `pwhash-legacy-wrong-${Date.now()}@example.com`;
    const legacyHash2 = makePbkdf2Hash("RightPassword999!");
    await ctx.pool.query(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)`,
      [storeId, email2, legacyHash2]
    );

    const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, {
      email: email2,
      password: "WrongPassword999!",
    });
    expect(res.status).toBe(401);
  });
});

// ── Unit: verifyAndMaybeRehash ────────────────────────────────────────────────

describe("password-hashing — verifyAndMaybeRehash DB upgrade", () => {
  let storeId: string;
  let customerId: string;

  const password = "RehashTest123!";

  beforeAll(async () => {
    storeId = await setupStore();

    const legacyHash = makePbkdf2Hash(password);
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)
       RETURNING id::text`,
      [storeId, `rehash-test-${Date.now()}@example.com`, legacyHash]
    );
    customerId = rows[0]!.id;
  });

  it("returns true for correct PBKDF2 password and upgrades hash", async () => {
    const { rows: before } = await ctx.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM customers WHERE id = $1::uuid`,
      [customerId]
    );
    const stored = before[0]!.password_hash;
    expect(isArgon2Hash(stored)).toBe(false); // starts as PBKDF2

    const result = await verifyAndMaybeRehash(ctx.pool, customerId, password, stored);
    expect(result).toBe(true);

    const { rows: after } = await ctx.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM customers WHERE id = $1::uuid`,
      [customerId]
    );
    expect(isArgon2Hash(after[0]!.password_hash)).toBe(true);
  });

  it("returns false for wrong PBKDF2 password without upgrading", async () => {
    const { rows: before } = await ctx.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM customers WHERE id = $1::uuid`,
      [customerId]
    );
    // Hash is now argon2id from previous test — reset to PBKDF2 for isolation
    const legacyHash = makePbkdf2Hash("differentpassword");
    await ctx.pool.query(
      `UPDATE customers SET password_hash = $2 WHERE id = $1::uuid`,
      [customerId, legacyHash]
    );

    const result = await verifyAndMaybeRehash(ctx.pool, customerId, "wrongpassword", legacyHash);
    expect(result).toBe(false);

    const { rows: after } = await ctx.pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM customers WHERE id = $1::uuid`,
      [customerId]
    );
    // Hash should still be PBKDF2 (no upgrade on failure)
    expect(isArgon2Hash(after[0]!.password_hash)).toBe(false);
  });
});
