/**
 * customer-auth — Vitest integration suite for T2.8.
 *
 * Tests: register → verify → login → me, lockout, magic link,
 *        invite flow, mock OAuth, email log, sessions, password change.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, del, mintJwt, insertStore } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { ConsoleMailer } from "../../src/lib/mailer/console.js";
import { setMailerForTesting } from "../../src/modules/customer-auth/service.js";
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

function newIds() {
  return { userId: randomUUID(), orgId: randomUUID() };
}

async function adminAuth(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

const TEST_JWT_SECRET = "test-jwt-secret-256bits-longerthis";

async function setupStore(orgId: string, userId: string) {
  const auth = await adminAuth(userId, orgId);
  // Create store
  const res = await post(ctx, "/commerce/stores", { name: "Auth Test Store", currency: "USD" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  const storeId = (res.json as Record<string, unknown>)["id"] as string;

  // Encode the JWT secret using the same key the server uses
  const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
  const encodedSecret = encodeSecretValue(TEST_JWT_SECRET, secretsKey) ?? TEST_JWT_SECRET;

  // Configure auth directly via SQL
  await ctx.pool.query(
    `UPDATE stores
     SET auth_enabled = true,
         auth_jwt_secret = $2,
         auth_email_password_enabled = true,
         auth_allow_self_registration = true,
         auth_require_email_verification = true,
         auth_magic_link_enabled = true
     WHERE id = $1::uuid`,
    [storeId, encodedSecret]
  );

  return { storeId, auth };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Customer auth — register / verify / login / me", () => {
  const { userId, orgId } = newIds();
  let storeId: string;
  let auth: { type: "bearer"; token: string };
  let sessionToken: string;
  let accessToken: string;

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore(orgId, userId);
    storeId = setup.storeId;
    auth = setup.auth;
  });

  const email = `test-${Date.now()}@example.com`;
  const password = "Password123!";

  it("POST /auth/register → 201, requires_verification = true", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/register`, { email, password });
    expect(res.status).toBe(201);
    expect((res.json as Record<string, unknown>)["requires_verification"]).toBe(true);
  });

  it("verification email was sent", () => {
    const sent = mailer.sentMessages.find(m => m.to === email);
    expect(sent).toBeDefined();
    expect(sent?.subject).toMatch(/verify/i);
  });

  it("POST /auth/verify-email → 200 with correct token", async () => {
    const sent = mailer.sentMessages.find(m => m.to === email);
    expect(sent).toBeDefined();
    // Extract token from the link in the email body
    const match = sent!.bodyText?.match(/token=([a-f0-9]+)/);
    expect(match).toBeTruthy();
    const token = match![1]!;

    const res = await post(ctx, `/commerce/stores/${storeId}/auth/verify-email`, { token });
    expect(res.status).toBe(200);
    expect((res.json as Record<string, unknown>)["ok"]).toBe(true);
  });

  it("POST /auth/login → 200 with tokens", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, { email, password });
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(typeof body["session_token"]).toBe("string");
    expect(typeof body["access_token"]).toBe("string");
    sessionToken = body["session_token"] as string;
    accessToken = body["access_token"] as string;
  });

  it("GET /auth/me → 200 with customer data", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/auth/me`, {
      type: "bearer",
      token: accessToken,
    });
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    const customer = body["customer"] as Record<string, unknown>;
    expect(customer["email"]).toBe(email);
  });

  it("GET /auth/me → 401 without token", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/auth/me`);
    expect(res.status).toBe(401);
  });
});

// ── Lockout after too many failed attempts ────────────────────────────────────

describe("Customer auth — lockout after failed attempts", () => {
  const { userId, orgId } = newIds();
  let storeId: string;

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore(orgId, userId);
    storeId = setup.storeId;
    // The lockout customer is created inside the test body with a unique email;
    // no seed needed here (the previous seed used a Date.now() email that could
    // collide with the test-body insert in the same millisecond → duplicate key).
  });

  it("gets 423 after 10 failed login attempts", async () => {
    const email2 = `lockout-${randomUUID()}@example.com`;
    // Insert a customer first
    const hashResult = await ctx.pool.query<{ id: string }>(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, 'pbkdf2:fakesalt:fakehash', 'email', true, true)
       RETURNING id::text`,
      [storeId, email2]
    );
    expect(hashResult.rows[0]).toBeDefined();

    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, {
        email: email2,
        password: "wrongpassword",
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(423);
  });
});

// ── Magic link ────────────────────────────────────────────────────────────────

describe("Customer auth — magic link", () => {
  const { userId, orgId } = newIds();
  let storeId: string;

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore(orgId, userId);
    storeId = setup.storeId;
  });

  const email = `magic-${Date.now()}@example.com`;

  it("POST /auth/magic-link → 200", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/magic-link`, { email });
    expect(res.status).toBe(200);
  });

  it("magic link email was sent", () => {
    const sent = mailer.sentMessages.find(m => m.to === email);
    expect(sent).toBeDefined();
  });

  it("POST /auth/magic-link/verify → 200 with tokens", async () => {
    const sent = mailer.sentMessages.find(m => m.to === email);
    const match = sent?.bodyText?.match(/token=([a-f0-9]+)/);
    expect(match).toBeTruthy();
    const token = match![1]!;

    const res = await post(ctx, `/commerce/stores/${storeId}/auth/magic-link/verify`, { token });
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(typeof body["access_token"]).toBe("string");
  });
});

// ── Invite flow ───────────────────────────────────────────────────────────────

describe("Customer auth — invite flow", () => {
  const { userId, orgId } = newIds();
  let storeId: string;
  let adminAuth_: { type: "bearer"; token: string };

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore(orgId, userId);
    storeId = setup.storeId;
    adminAuth_ = setup.auth;
  });

  const inviteEmail = `invite-${Date.now()}@example.com`;

  it("POST /customers/invite → 200 (admin)", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/customers/invite`,
      { email: inviteEmail },
      adminAuth_
    );
    expect(res.status).toBe(200);
  });

  it("invite email sent", () => {
    const sent = mailer.sentMessages.find(m => m.to === inviteEmail);
    expect(sent).toBeDefined();
    expect(sent?.subject).toMatch(/invite/i);
  });

  it("POST /auth/invite/accept → 200 with tokens", async () => {
    const sent = mailer.sentMessages.find(m => m.to === inviteEmail);
    const match = sent?.bodyText?.match(/token=([a-f0-9]+)/);
    expect(match).toBeTruthy();
    const token = match![1]!;

    const res = await post(ctx, `/commerce/stores/${storeId}/auth/invite/accept`, {
      token,
      password: "NewPassword123!",
    });
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(typeof body["access_token"]).toBe("string");
  });
});

// ── Mock OAuth ────────────────────────────────────────────────────────────────

describe("Customer auth — mock OAuth", () => {
  const { userId, orgId } = newIds();
  let storeId: string;

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore(orgId, userId);
    storeId = setup.storeId;
  });

  it("POST /auth/mock-oauth with google → 200 + tokens", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/mock-oauth`, {
      provider: "google",
      email: `oauth-${Date.now()}@example.com`,
      name: "OAuth User",
    });
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(typeof body["access_token"]).toBe("string");
    expect(typeof body["session_token"]).toBe("string");

    // Verify /auth/me works with the token
    const meRes = await get(ctx, `/commerce/stores/${storeId}/auth/me`, {
      type: "bearer",
      token: body["access_token"] as string,
    });
    expect(meRes.status).toBe(200);
  });
});

// ── Email log ─────────────────────────────────────────────────────────────────

describe("Customer auth — email log", () => {
  const { userId, orgId } = newIds();
  let storeId: string;
  let adminAuth_: { type: "bearer"; token: string };

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore(orgId, userId);
    storeId = setup.storeId;
    adminAuth_ = setup.auth;

    // Register to trigger email
    await post(ctx, `/commerce/stores/${storeId}/auth/register`, {
      email: `log-test-${Date.now()}@example.com`,
      password: "Password123!",
    });
  });

  it("GET /auth/email/log → shows sent emails (admin)", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/auth/email/log`, adminAuth_);
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    const entries = body["entries"] as unknown[];
    expect(entries.length).toBeGreaterThan(0);
  });

  it("GET /auth/email/log → 401 without auth", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/auth/email/log`);
    expect(res.status).toBe(401);
  });
});

// ── Sessions list + revoke ────────────────────────────────────────────────────

describe("Customer auth — sessions", () => {
  const { userId, orgId } = newIds();
  let storeId: string;
  let accessToken: string;
  let sessionId: string;

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore(orgId, userId);
    storeId = setup.storeId;

    // Create verified customer + login
    const email = `sessions-${Date.now()}@example.com`;
    const pwHash = `pbkdf2:${Buffer.from("testsalt").toString("hex")}:placeholder`;

    // Use the service to create a proper hash
    const { hashPasswordSync } = await import("../../src/modules/customer-auth/service.js");
    const realHash = hashPasswordSync("Password123!");

    await ctx.pool.query(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)`,
      [storeId, email, realHash]
    );

    // Disable email verification for this test
    await ctx.pool.query(
      `UPDATE stores SET auth_require_email_verification = false WHERE id = $1::uuid`,
      [storeId]
    );

    const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, {
      email,
      password: "Password123!",
    });
    expect(res.status).toBe(200);
    accessToken = (res.json as Record<string, unknown>)["access_token"] as string;
  });

  it("GET /auth/sessions → lists active sessions", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/auth/sessions`, {
      type: "bearer", token: accessToken,
    });
    expect(res.status).toBe(200);
    const body = res.json as Record<string, unknown>;
    const sessions = body["sessions"] as unknown[];
    expect(sessions.length).toBeGreaterThan(0);
    sessionId = (sessions[0] as Record<string, unknown>)["id"] as string;
  });

  it("DELETE /auth/sessions/:sessionId → 200", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/auth/sessions/${sessionId}`,
      { type: "bearer", token: accessToken }
    );
    expect(res.status).toBe(200);
  });
});

// ── Password change ───────────────────────────────────────────────────────────

describe("Customer auth — password change", () => {
  const { userId, orgId } = newIds();
  let storeId: string;
  let accessToken: string;
  let email: string;

  beforeAll(async () => {
    mailer.clear();
    const setup = await setupStore(orgId, userId);
    storeId = setup.storeId;
    email = `pwchange-${Date.now()}@example.com`;

    // Disable email verification
    await ctx.pool.query(
      `UPDATE stores SET auth_require_email_verification = false WHERE id = $1::uuid`,
      [storeId]
    );

    const { hashPasswordSync } = await import("../../src/modules/customer-auth/service.js");
    const hash = hashPasswordSync("OldPassword123!");
    await ctx.pool.query(
      `INSERT INTO customers (store_id, email, password_hash, auth_provider, is_active, email_verified)
       VALUES ($1::uuid, $2, $3, 'email', true, true)`,
      [storeId, email, hash]
    );

    const loginRes = await post(ctx, `/commerce/stores/${storeId}/auth/login`, {
      email,
      password: "OldPassword123!",
    });
    expect(loginRes.status).toBe(200);
    accessToken = (loginRes.json as Record<string, unknown>)["access_token"] as string;
  });

  it("PUT /auth/me/password → 200", async () => {
    const res = await put(ctx, `/commerce/stores/${storeId}/auth/me/password`, {
      current_password: "OldPassword123!",
      new_password: "NewPassword456!",
    }, { type: "bearer", token: accessToken });
    expect(res.status).toBe(200);
  });

  it("old access token is now invalid for /auth/me", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/auth/me`, {
      type: "bearer", token: accessToken,
    });
    expect(res.status).toBe(401);
  });

  it("can login with new password", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/auth/login`, {
      email,
      password: "NewPassword456!",
    });
    expect(res.status).toBe(200);
  });
});
