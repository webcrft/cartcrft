/**
 * superadmin — Hardened super-admin portal backend (P1).
 *
 * Covers:
 *  - login: good/bad password, lockout after N failures, MFA (TOTP) path
 *  - audience isolation: org JWT rejected by requireSuperAdmin; super JWT
 *    rejected by org middleware
 *  - IP allowlist enforcement (SUPERADMIN_IP_ALLOWLIST)
 *  - cross-org browse returns multi-org data (BYPASSRLS owner role)
 *  - system analytics aggregates correct (2 orgs/stores/orders → totals match)
 *  - every action writes an audit row
 *  - audit log append-only (UPDATE/DELETE blocked at DB)
 *  - takedown works + audited
 *
 * Note: the super-admin surface has a per-IP rate limit (30/min). Tests run
 * from 127.0.0.1, so we reset it between phases via _resetSuperAdminRateLimit().
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, mintJwt } from "../shared/helpers.js";
import {
  hashSuperAdminPassword,
  verifyTotp,
  mintSuperAdminJwt,
  _resetSuperAdminRateLimit,
} from "../../src/lib/superadmin-auth.js";
import { encodeSecretValue } from "../../src/lib/secrets.js";

let ctx: TestCtx;

const PASSWORD = "correct-horse-battery-staple";

// Two orgs, each with a store + an order, plus a customer.
const org1 = randomUUID();
const org2 = randomUUID();
let store1 = "";
let store2 = "";
let superAdminId = "";

beforeAll(async () => {
  ctx = await createCtx();

  // Seed a super-admin directly (mirrors the create-super-admin script).
  const hash = hashSuperAdminPassword(PASSWORD);
  const sa = await ctx.pool.query<{ id: string }>(
    `INSERT INTO super_admins (email, password_hash) VALUES ($1, $2) RETURNING id::text`,
    ["ops@webcrft.systems", hash]
  );
  superAdminId = sa.rows[0]!.id;

  // Seed 2 orgs, each with one store, one customer, one paid order.
  const s1 = await ctx.pool.query<{ id: string }>(
    `INSERT INTO stores (organization_id, name, slug, currency) VALUES ($1::uuid, 'Org1 Store', 'org1-store', 'USD') RETURNING id::text`,
    [org1]
  );
  store1 = s1.rows[0]!.id;
  const s2 = await ctx.pool.query<{ id: string }>(
    `INSERT INTO stores (organization_id, name, slug, currency) VALUES ($1::uuid, 'Org2 Store', 'org2-store', 'USD') RETURNING id::text`,
    [org2]
  );
  store2 = s2.rows[0]!.id;

  await ctx.pool.query(
    `INSERT INTO customers (store_id, email) VALUES ($1::uuid, 'c1@example.com'), ($2::uuid, 'c2@example.com')`,
    [store1, store2]
  );

  // Orders: store1 total 100.00, store2 total 250.00 → GMV 350.00
  await ctx.pool.query(
    `INSERT INTO orders (store_id, order_number, currency, subtotal, total)
     VALUES ($1::uuid, 'O-1', 'USD', 100, 100), ($2::uuid, 'O-2', 'USD', 250, 250)`,
    [store1, store2]
  );
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

beforeEach(() => {
  _resetSuperAdminRateLimit();
});

async function login(extra: Record<string, unknown> = {}): Promise<{ status: number; token?: string; json: Record<string, unknown> }> {
  const res = await post(ctx, "/superadmin/auth/login", {
    email: "ops@webcrft.systems",
    password: PASSWORD,
    ...extra,
  });
  return { status: res.status, token: (res.json as Record<string, unknown>)["token"] as string | undefined, json: res.json };
}

function bearer(token: string) {
  return { type: "bearer" as const, token };
}

// ── Login ─────────────────────────────────────────────────────────────────────

describe("login", () => {
  it("succeeds with correct password and returns a token", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(typeof res.token).toBe("string");
    expect(res.json["super_admin"]).toBeTruthy();
  });

  it("rejects a bad password with 401 INVALID_CREDENTIALS", async () => {
    const res = await post(ctx, "/superadmin/auth/login", { email: "ops@webcrft.systems", password: "wrong" });
    expect(res.status).toBe(401);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("INVALID_CREDENTIALS");
  });

  it("locks the account after repeated failures", async () => {
    // Seed a dedicated admin so we don't lock the shared one.
    const hash = hashSuperAdminPassword(PASSWORD);
    await ctx.pool.query(
      `INSERT INTO super_admins (email, password_hash) VALUES ($1, $2)`,
      ["lockme@webcrft.systems", hash]
    );
    let lastCode = "";
    for (let i = 0; i < 5; i++) {
      const r = await post(ctx, "/superadmin/auth/login", { email: "lockme@webcrft.systems", password: "nope" });
      lastCode = (r.json["error"] as Record<string, unknown>)["code"] as string;
    }
    expect(lastCode).toBe("LOCKED");
    // Even the correct password is now refused while locked.
    const good = await post(ctx, "/superadmin/auth/login", { email: "lockme@webcrft.systems", password: PASSWORD });
    expect(good.status).toBe(423);
    expect((good.json["error"] as Record<string, unknown>)["code"]).toBe("LOCKED");
  });
});

// ── MFA (TOTP) ──────────────────────────────────────────────────────────────

describe("MFA / TOTP", () => {
  const base32Secret = "JBSWY3DPEHPK3PXP"; // RFC test vector secret

  it("verifyTotp accepts a freshly generated code and rejects a wrong one", () => {
    // Generate the current code using the same algorithm the lib expects.
    // We compute via verifyTotp's acceptance: brute a code is not exposed,
    // so assert known-bad is rejected and a valid path exists via login below.
    expect(verifyTotp(base32Secret, "000000")).toBe(false);
  });

  it("requires a valid TOTP when the admin has a secret set", async () => {
    // Enable MFA on a new admin. Store the secret in plaintext passthrough
    // (AUTH_SECRETS_KEY unset in test → decodeSecretValue returns as-is).
    const hash = hashSuperAdminPassword(PASSWORD);
    // Store the TOTP secret encrypted exactly as the create-super-admin script does
    // (AES via lib/secrets using AUTH_SECRETS_KEY; plaintext passthrough if unset).
    const enc = encodeSecretValue(base32Secret, process.env["AUTH_SECRETS_KEY"] ?? "");
    await ctx.pool.query(
      `INSERT INTO super_admins (email, password_hash, totp_secret_enc) VALUES ($1, $2, $3)`,
      ["mfa@webcrft.systems", hash, enc]
    );

    // Without a code → MFA_REQUIRED
    const noCode = await post(ctx, "/superadmin/auth/login", { email: "mfa@webcrft.systems", password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect((noCode.json["error"] as Record<string, unknown>)["code"]).toBe("MFA_REQUIRED");

    // Wrong code → MFA_INVALID
    const badCode = await post(ctx, "/superadmin/auth/login", { email: "mfa@webcrft.systems", password: PASSWORD, totp: "123456" });
    expect(badCode.status).toBe(401);
    expect((badCode.json["error"] as Record<string, unknown>)["code"]).toBe("MFA_INVALID");

    // Correct code: derive it the same way the verifier does.
    const code = currentTotp(base32Secret);
    expect(verifyTotp(base32Secret, code)).toBe(true);
    const good = await post(ctx, "/superadmin/auth/login", { email: "mfa@webcrft.systems", password: PASSWORD, totp: code });
    expect(good.status).toBe(200);
  });
});

// Local TOTP generator (mirrors RFC6238 / the lib) for producing a valid code.
import { createHmac } from "node:crypto";
function b32decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}
function currentTotp(secretBase32: string): string {
  const secret = b32decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const codeNum =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (codeNum % 1_000_000).toString().padStart(6, "0");
}

// ── Audience isolation ──────────────────────────────────────────────────────

describe("audience isolation", () => {
  it("rejects an org JWT on a super-admin route", async () => {
    const orgToken = await mintJwt({ userId: randomUUID(), orgId: org1 });
    const res = await get(ctx, "/superadmin/me", bearer(orgToken));
    expect(res.status).toBe(401);
  });

  it("rejects a super-admin JWT on an org route", async () => {
    const superToken = await mintSuperAdminJwt({ superAdminId, sessionId: randomUUID(), email: "ops@webcrft.systems" });
    // /commerce/stores is a JWT-only org route. A super JWT (aud=cartcrft-superadmin,
    // no org claim) must NOT be accepted.
    const res = await get(ctx, "/commerce/stores", bearer(superToken));
    expect(res.status).toBe(401);
  });

  it("rejects an API key on the super-admin surface", async () => {
    const res = await get(ctx, "/superadmin/me", { type: "api-key", key: "cc_prv_fake" });
    expect(res.status).toBe(401);
  });
});

// ── IP allowlist ─────────────────────────────────────────────────────────────

describe("IP allowlist", () => {
  it("blocks requests from a non-allowlisted IP; forged XFF does NOT bypass the check (P0-2)", async () => {
    process.env["SUPERADMIN_IP_ALLOWLIST"] = "10.0.0.0/8";
    try {
      // Login itself is IP-gated.
      const blocked = await post(ctx, "/superadmin/auth/login", { email: "ops@webcrft.systems", password: PASSWORD });
      expect(blocked.status).toBe(403);
      expect((blocked.json["error"] as Record<string, unknown>)["code"]).toBe("IP_BLOCKED");

      // P0-2: getClientIp now returns request.ip (loopback 127.0.0.1), not the
      // forged X-Forwarded-For value.  Even though "10.1.2.3" is within the
      // allowlist CIDR, the server must NOT trust the XFF header unless
      // TRUST_PROXY is configured.  The request must still be blocked (403).
      _resetSuperAdminRateLimit();
      const spoofAttempt = await ctx.request({
        method: "POST",
        path: "/superadmin/auth/login",
        body: { email: "ops@webcrft.systems", password: PASSWORD },
        headers: { "x-forwarded-for": "10.1.2.3" },
      });
      expect(spoofAttempt.status).toBe(403);
      expect((spoofAttempt.json["error"] as Record<string, unknown>)["code"]).toBe("IP_BLOCKED");
    } finally {
      delete process.env["SUPERADMIN_IP_ALLOWLIST"];
    }
  });
});

// ── Cross-tenant browse + analytics ─────────────────────────────────────────

describe("cross-tenant access + analytics", () => {
  let token = "";

  beforeEach(async () => {
    _resetSuperAdminRateLimit();
    const res = await login();
    token = res.token!;
  });

  it("lists stores across multiple orgs", async () => {
    const res = await get(ctx, "/superadmin/stores", bearer(token));
    expect(res.status).toBe(200);
    const items = (res.json["items"] as Array<Record<string, unknown>>);
    const orgIds = new Set(items.map((i) => i["organizationId"]));
    expect(orgIds.has(org1)).toBe(true);
    expect(orgIds.has(org2)).toBe(true);
  });

  it("lists orgs with aggregate counts", async () => {
    const res = await get(ctx, "/superadmin/orgs", bearer(token));
    expect(res.status).toBe(200);
    const items = res.json["items"] as Array<Record<string, unknown>>;
    const o1 = items.find((i) => i["organizationId"] === org1)!;
    expect(o1).toBeTruthy();
    expect(o1["storeCount"]).toBe(1);
    expect(o1["orderCount"]).toBe(1);
    expect(o1["gmv"]).toBe("100.00");
  });

  it("returns org detail with stores + billing slot", async () => {
    const res = await get(ctx, `/superadmin/orgs/${org2}`, bearer(token));
    expect(res.status).toBe(200);
    expect((res.json["stores"] as unknown[]).length).toBe(1);
    expect(res.json["customerCount"]).toBe(1);
    expect(res.json["gmv"]).toBe("250.00");
    expect("billing" in res.json).toBe(true);
  });

  it("searches customers by email across stores", async () => {
    const res = await get(ctx, "/superadmin/customers?search=c2@example.com", bearer(token));
    expect(res.status).toBe(200);
    const items = res.json["items"] as Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    expect(items[0]!["email"]).toBe("c2@example.com");
    expect(items[0]!["organizationId"]).toBe(org2);
  });

  it("computes platform analytics overview totals", async () => {
    const res = await get(ctx, "/superadmin/analytics/overview", bearer(token));
    expect(res.status).toBe(200);
    expect(res.json["totalOrgs"]).toBe(2);
    expect(res.json["totalStores"]).toBe(2);
    expect(res.json["totalCustomers"]).toBe(2);
    expect(res.json["totalOrders"]).toBe(2);
    expect(res.json["gmv"]).toBe("350.00");
  });

  it("returns a timeseries", async () => {
    const res = await get(ctx, "/superadmin/analytics/timeseries?days=7&interval=day", bearer(token));
    expect(res.status).toBe(200);
    const points = res.json["points"] as Array<Record<string, unknown>>;
    expect(Array.isArray(points)).toBe(true);
    const totalOrders = points.reduce((acc, p) => acc + (p["orders"] as number), 0);
    expect(totalOrders).toBe(2);
  });

  it("reports system health", async () => {
    const res = await get(ctx, "/superadmin/analytics/health", bearer(token));
    expect(res.status).toBe(200);
    expect(res.json["db"]).toBe("ok");
    expect(typeof res.json["migrationVersion"]).toBe("string");
  });
});

// ── Audit logging ───────────────────────────────────────────────────────────

describe("audit logging", () => {
  it("writes an audit row for a cross-tenant read", async () => {
    _resetSuperAdminRateLimit();
    const token = (await login()).token!;
    await get(ctx, "/superadmin/orgs", bearer(token));

    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM super_admin_audit_log WHERE action = 'orgs.list'`
    );
    expect(Number(rows[0]!.count)).toBeGreaterThan(0);
  });

  it("login success is audited", async () => {
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM super_admin_audit_log WHERE action = 'login.success'`
    );
    expect(Number(rows[0]!.count)).toBeGreaterThan(0);
  });

  it("audit log is append-only (UPDATE and DELETE blocked)", async () => {
    await expect(
      ctx.pool.query(`UPDATE super_admin_audit_log SET action = 'tampered'`)
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.pool.query(`DELETE FROM super_admin_audit_log`)
    ).rejects.toThrow(/append-only/);
  });

  it("exposes the operator audit trail via GET /superadmin/audit-log", async () => {
    _resetSuperAdminRateLimit();
    const token = (await login()).token!;
    const res = await get(ctx, "/superadmin/audit-log?mine=true", bearer(token));
    expect(res.status).toBe(200);
    expect((res.json["items"] as unknown[]).length).toBeGreaterThan(0);
  });
});

// ── Tenant management ───────────────────────────────────────────────────────

describe("tenant management", () => {
  it("takes down a store and audits it", async () => {
    _resetSuperAdminRateLimit();
    const token = (await login()).token!;
    const res = await post(ctx, `/superadmin/stores/${store1}/takedown`, { reason: "fraud" }, bearer(token));
    expect(res.status).toBe(200);

    const store = await ctx.pool.query<{ is_active: boolean; taken_down_reason: string }>(
      `SELECT is_active, taken_down_reason FROM stores WHERE id = $1::uuid`,
      [store1]
    );
    expect(store.rows[0]!.is_active).toBe(false);
    expect(store.rows[0]!.taken_down_reason).toBe("fraud");

    const audit = await ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM super_admin_audit_log WHERE action = 'store.takedown' AND target_id = $1`,
      [store1]
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThan(0);

    // Restore returns it to active.
    const restore = await post(ctx, `/superadmin/stores/${store1}/restore`, {}, bearer(token));
    expect(restore.status).toBe(200);
    const after = await ctx.pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM stores WHERE id = $1::uuid`,
      [store1]
    );
    expect(after.rows[0]!.is_active).toBe(true);
  });
});

// ── Session lifecycle ───────────────────────────────────────────────────────

describe("session lifecycle", () => {
  it("logout revokes the session so the token no longer works", async () => {
    _resetSuperAdminRateLimit();
    const token = (await login()).token!;
    const me1 = await get(ctx, "/superadmin/me", bearer(token));
    expect(me1.status).toBe(200);

    const out = await post(ctx, "/superadmin/auth/logout", {}, bearer(token));
    expect(out.status).toBe(200);

    const me2 = await get(ctx, "/superadmin/me", bearer(token));
    expect(me2.status).toBe(401);
  });
});
