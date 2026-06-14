/**
 * cloud-billing-api.test.ts
 *
 * Integration tests for the billingApiPlugin cloud read-API endpoints:
 *
 *   GET  /cloud/account
 *   PATCH /cloud/account
 *   GET  /cloud/billing/plan
 *   GET  /cloud/billing/invoices
 *   GET  /cloud/billing/invoices/:id
 *   GET  /cloud/billing/wallet
 *
 * Strategy:
 *   - Spin up a Fastify app with CARTCRFT_CLOUD=1 and the billingApiPlugin
 *     mounted directly (bypassing the full buildApp() bootstrap) so we can
 *     control the pool and seed billing tables inline.
 *   - Use a schema-isolated pg.Pool (mirrors cloud-bootstrap.test.ts pattern).
 *   - Mint platform JWTs via jose to test auth enforcement.
 *   - Verify cross-org access is blocked (JWT org ≠ seeded data org).
 *
 * Requires: DATABASE_URL set in .env (same as other suites).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config as dotenvConfig } from 'dotenv';
import { SignJWT } from 'jose';

// ── Load .env ─────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// backend/tests/suites → backend/tests → backend → repo root
const repoRoot = path.resolve(__dirname, '../../..');
dotenvConfig({ path: path.join(repoRoot, '.env'), override: false });

const databaseUrl = process.env['DATABASE_URL'] as string | undefined;
const jwtSecret = process.env['JWT_SECRET'] ?? 'test-jwt-secret-for-cloud-api-tests-32ch';

// ── JWT helpers ───────────────────────────────────────────────────────────────

async function mintJwt(orgId: string, userId: string): Promise<string> {
  const key = new TextEncoder().encode(jwtSecret);
  return new SignJWT({ sub: userId, org: orgId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('cartcrft')
    .setAudience('cartcrft')
    .setExpirationTime('1h')
    .sign(key);
}

// ── Schema helpers (mirrors cloud-bootstrap.test.ts) ─────────────────────────

function withSearchPath(connStr: string, schema: string): string {
  const searchPath = `${schema},public`;
  const optVal = encodeURIComponent(`-csearch_path=${searchPath}`);
  const sep = connStr.includes('?') ? '&' : '?';
  return `${connStr}${sep}options=${optVal}`;
}

async function createSchema(dbUrl: string): Promise<string> {
  const runId = randomBytes(4).toString('hex');
  const schema = `cloudapi_${runId}`;
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await client.end();
  }
  return schema;
}

async function dropSchema(dbUrl: string, schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

import fs from 'node:fs';

async function applyMigrationFile(
  pool: pg.Pool,
  filePath: string,
  trackingName: string,
  schema: string,
): Promise<void> {
  const rawSql = fs.readFileSync(filePath, 'utf-8');
  let sql = rawSql.replace(/\bpublic\./gi, `"${schema}".`);
  sql = sql.replace(
    /\bcreate\s+extension\s+if\s+not\s+exists\s+(\w+)(?!\s+SCHEMA)/gi,
    'CREATE EXTENSION IF NOT EXISTS $1 SCHEMA public',
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
      [trackingName],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(
      `Migration ${trackingName} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    client.release();
  }
}

async function applyAllMigrations(pool: pg.Pool, schema: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  // Backend migrations (for set_updated_at + any shared infra)
  const backendMigsDir = path.resolve(repoRoot, 'backend/migrations');
  if (fs.existsSync(backendMigsDir)) {
    const files = fs.readdirSync(backendMigsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      await applyMigrationFile(pool, path.join(backendMigsDir, f), f, schema);
    }
  }

  // Cloud billing migrations
  const { billingMigrations } = await import('@cartcrft/cloud-billing');
  for (const filePath of billingMigrations()) {
    const trackingName = `cloud/${path.basename(filePath)}`;
    await applyMigrationFile(pool, filePath, trackingName, schema);
  }
}

// ── Billing seed helper ───────────────────────────────────────────────────────

async function seedBillingOrg(pool: pg.Pool): Promise<{
  orgId: string;
  tierId: string;
  subId: string;
  invoiceId: string;
}> {
  const orgId = randomUUID();

  // Tier
  const suffix = randomBytes(3).toString('hex');
  const tierRes = await pool.query<{ id: string }>(
    `INSERT INTO billing_tiers (name, slug, price_usd_cents, is_active)
     VALUES ($1, $2, 2900, true) RETURNING id`,
    [`Pro-${suffix}`, `pro-${suffix}`],
  );
  const tierId = tierRes.rows[0]!.id;

  // Subscription
  const now = new Date();
  const periodEnd = new Date(now.getTime() + 30 * 24 * 3600_000);
  const subRes = await pool.query<{ id: string }>(
    `INSERT INTO billing_subscriptions
       (organization_id, tier_id, status, current_period_start, current_period_end)
     VALUES ($1::uuid, $2::uuid, 'active', $3, $4)
     RETURNING id`,
    [orgId, tierId, now, periodEnd],
  );
  const subId = subRes.rows[0]!.id;

  // Wallet
  await pool.query(
    `INSERT INTO billing_wallets (organization_id, balance_cents)
     VALUES ($1::uuid, 5000)
     ON CONFLICT (organization_id) DO NOTHING`,
    [orgId],
  );

  // Invoice
  const invRes = await pool.query<{ id: string }>(
    `INSERT INTO billing_invoices
       (organization_id, subscription_id, invoice_number, status,
        subtotal_cents, total_cents, usd_amount, fx_rate, zar_amount)
     VALUES ($1::uuid, $2::uuid, $3, 'paid', 2900, 2900, 29.00, 18.50, 536.50)
     RETURNING id`,
    [orgId, subId, `INV-${suffix}-001`],
  );
  const invoiceId = invRes.rows[0]!.id;

  return { orgId, tierId, subId, invoiceId };
}

// ── Fastify plugin under test ─────────────────────────────────────────────────

async function buildTestApp(
  pool: pg.Pool,
): Promise<{ inject: (opts: unknown) => Promise<{ statusCode: number; json: unknown }> }> {
  const Fastify = (await import('fastify')).default;
  const { billingApiPlugin } = await import('@cartcrft/cloud-billing');

  const app = Fastify({ logger: false });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (app as any).register(billingApiPlugin, {
    prefix: '/cloud',
    pool,
    jwtSecret,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function inject(opts: any) {
    const res = await app.inject(opts as Parameters<typeof app.inject>[0]);
    let json: unknown;
    try { json = JSON.parse(res.body); } catch { json = null; }
    return { statusCode: res.statusCode, json };
  }

  return { inject };
}

// ── Suite setup ───────────────────────────────────────────────────────────────

let schema: string;
let pool: pg.Pool;
let orgId: string;
let tierId: string;
let subId: string;
let invoiceId: string;
let testApp: { inject: (opts: unknown) => Promise<{ statusCode: number; json: unknown }> };

const SKIP = !databaseUrl;

beforeAll(async () => {
  if (SKIP) return;

  schema = await createSchema(databaseUrl!);
  pool = new pg.Pool({
    connectionString: withSearchPath(databaseUrl!, schema),
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });

  await applyAllMigrations(pool, schema);
  const seeded = await seedBillingOrg(pool);
  orgId = seeded.orgId;
  tierId = seeded.tierId;
  subId = seeded.subId;
  invoiceId = seeded.invoiceId;

  testApp = await buildTestApp(pool);
}, 90_000);

afterAll(async () => {
  if (SKIP) return;
  await pool?.end();
  await dropSchema(databaseUrl!, schema);
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

function skipIfNoDb() {
  if (SKIP) {
    console.warn('[cloud-billing-api] DATABASE_URL not set — skipping');
    return true;
  }
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('billingApiPlugin — auth enforcement', () => {
  it('GET /cloud/account returns 401 without auth', async () => {
    if (skipIfNoDb()) return;
    const res = await testApp.inject({ method: 'GET', url: '/cloud/account' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /cloud/billing/plan returns 401 without auth', async () => {
    if (skipIfNoDb()) return;
    const res = await testApp.inject({ method: 'GET', url: '/cloud/billing/plan' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /cloud/billing/invoices returns 401 without auth', async () => {
    if (skipIfNoDb()) return;
    const res = await testApp.inject({ method: 'GET', url: '/cloud/billing/invoices' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /cloud/billing/wallet returns 401 without auth', async () => {
    if (skipIfNoDb()) return;
    const res = await testApp.inject({ method: 'GET', url: '/cloud/billing/wallet' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /cloud/account returns 401 with an invalid/forged token', async () => {
    if (skipIfNoDb()) return;
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/account',
      headers: { authorization: 'Bearer this-is-not-a-valid-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('billingApiPlugin — GET /cloud/account', () => {
  it('returns 200 with subscription + plan + wallet for the JWT org', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(orgId, randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/account',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body['organization_id']).toBe(orgId);
    expect(body['subscription']).toBeTruthy();
    expect((body['subscription'] as Record<string, unknown>)['id']).toBe(subId);
    expect(body['plan']).toBeTruthy();
    expect((body['plan'] as Record<string, unknown>)['id']).toBe(tierId);
    expect(body['wallet']).toBeTruthy();
    expect((body['wallet'] as Record<string, unknown>)['balance_cents']).toBe(5000);
  });

  it('returns org_id for an org with no subscription (new org)', async () => {
    if (skipIfNoDb()) return;
    const newOrgId = randomUUID();
    const token = await mintJwt(newOrgId, randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/account',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body['organization_id']).toBe(newOrgId);
    expect(body['subscription']).toBeNull();
    expect(body['plan']).toBeNull();
    expect((body['wallet'] as Record<string, unknown>)['balance_cents']).toBe(0);
  });
});

describe('billingApiPlugin — PATCH /cloud/account', () => {
  it('updates subscription metadata for the JWT org', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(orgId, randomUUID());
    const res = await testApp.inject({
      method: 'PATCH',
      url: '/cloud/account',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ display_name: 'Test Company', billing_email: 'billing@test.example' }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body['organization_id']).toBe(orgId);
    const updated = body['updated'] as Record<string, unknown>;
    expect(updated['display_name']).toBe('Test Company');
    expect(updated['billing_email']).toBe('billing@test.example');
  });

  it('returns 400 when no updateable fields are provided', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(orgId, randomUUID());
    const res = await testApp.inject({
      method: 'PATCH',
      url: '/cloud/account',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ unknown_field: 'ignored' }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('billingApiPlugin — GET /cloud/billing/plan', () => {
  it('returns subscription + plan details', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(orgId, randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/billing/plan',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body['subscription']).toBeTruthy();
    expect((body['subscription'] as Record<string, unknown>)['id']).toBe(subId);
    expect(body['plan']).toBeTruthy();
    expect((body['plan'] as Record<string, unknown>)['id']).toBe(tierId);
    expect((body['plan'] as Record<string, unknown>)['price_usd_cents']).toBe(2900);
  });

  it('returns 404 for an org with no subscription', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(randomUUID(), randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/billing/plan',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('billingApiPlugin — GET /cloud/billing/invoices', () => {
  it('returns paginated invoice list for the JWT org', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(orgId, randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/billing/invoices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(Array.isArray(body['invoices'])).toBe(true);
    const invoices = body['invoices'] as Array<Record<string, unknown>>;
    expect(invoices.length).toBeGreaterThanOrEqual(1);
    expect(invoices[0]!['id']).toBe(invoiceId);
    expect(body['pagination']).toBeTruthy();
    const pagination = body['pagination'] as Record<string, unknown>;
    expect(pagination['total']).toBeGreaterThanOrEqual(1);
  });

  it('returns an empty list for an org with no invoices', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(randomUUID(), randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/billing/invoices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect((body['invoices'] as unknown[]).length).toBe(0);
    expect((body['pagination'] as Record<string, unknown>)['total']).toBe(0);
  });
});

describe('billingApiPlugin — GET /cloud/billing/invoices/:invoiceId', () => {
  it('returns invoice detail + line items for the JWT org', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(orgId, randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: `/cloud/billing/invoices/${invoiceId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect((body['invoice'] as Record<string, unknown>)['id']).toBe(invoiceId);
    expect(Array.isArray(body['items'])).toBe(true);
  });

  it('returns 404 when a different org tries to access this invoice (cross-org block)', async () => {
    if (skipIfNoDb()) return;
    const differentOrgToken = await mintJwt(randomUUID(), randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: `/cloud/billing/invoices/${invoiceId}`,
      headers: { authorization: `Bearer ${differentOrgToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a non-existent invoice id', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(orgId, randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: `/cloud/billing/invoices/${randomUUID()}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('billingApiPlugin — GET /cloud/billing/wallet', () => {
  it('returns wallet balance for the JWT org', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(orgId, randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/billing/wallet',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect(body['wallet']).toBeTruthy();
    expect((body['wallet'] as Record<string, unknown>)['balance_cents']).toBe(5000);
  });

  it('returns zero balance for an org with no wallet', async () => {
    if (skipIfNoDb()) return;
    const token = await mintJwt(randomUUID(), randomUUID());
    const res = await testApp.inject({
      method: 'GET',
      url: '/cloud/billing/wallet',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json as Record<string, unknown>;
    expect((body['wallet'] as Record<string, unknown>)['balance_cents']).toBe(0);
  });
});
