/**
 * helpers.ts — Shared test utilities for cloud/billing lifecycle suites.
 *
 * Provides:
 *   - createBillingCtx()    — fresh schema + pool + migrations per test suite
 *   - makeSimEngine()        — BillingEngine + ManualClock + SimClock config
 *   - makeSimWorker()        — BillingWorker wired to same pool + clock
 *   - seedExchangeRate()     — insert a fresh USD/ZAR rate row
 *   - seedAuth()             — insert an AUTH_test_ paystack authorization for an org
 *   - seedSubscription()     — upsert an active subscription for an org
 *   - mockPaystackOk()       — global fetch spy returning a successful charge
 *   - mockPaystackDecline()  — global fetch spy returning a declined charge
 *   - restoreFetch()         — restore original global fetch
 */

import { randomBytes } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import pg from 'pg';
import { vi } from 'vitest';

import { BillingEngine } from '../src/engine.js';
import { BillingWorker } from '../src/worker.js';
import { ManualClock } from '../src/clock.js';
import type { BillingSimConfig } from '../src/billingsim.js';

// ── .env ──────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// cloud/billing/tests → cloud/billing → cloud → repo root
const repoRoot = path.resolve(__dirname, '../../..');
dotenvConfig({ path: path.join(repoRoot, '.env'), override: false });

// ── Schema helpers ────────────────────────────────────────────────────────────

function withSearchPath(connStr: string, schema: string): string {
  const searchPath = `${schema},public`;
  const optVal = encodeURIComponent(`-csearch_path=${searchPath}`);
  const sep = connStr.includes('?') ? '&' : '?';
  return `${connStr}${sep}options=${optVal}`;
}

async function runMigrations(pool: pg.Pool, schema: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applyFile = async (filePath: string, name: string) => {
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
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  };

  // Backend migrations needed for set_updated_at + exchange_rates table
  const backendMigsDir = path.resolve(repoRoot, 'backend/migrations');
  for (const f of ['0001_commerce.sql', '0004_platform.sql']) {
    const fp = path.join(backendMigsDir, f);
    if (fs.existsSync(fp)) await applyFile(fp, f);
  }

  // Cloud billing migrations
  const cloudMigsDir = path.resolve(__dirname, '../migrations');
  const cloudFiles = fs.readdirSync(cloudMigsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of cloudFiles) {
    await applyFile(path.join(cloudMigsDir, f), `cloud_${f}`);
  }
}

// ── Test context ──────────────────────────────────────────────────────────────

export interface BillingTestCtx {
  pool: pg.Pool;
  schema: string;
  teardown: () => Promise<void>;
}

export async function createBillingCtx(): Promise<BillingTestCtx> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL not set');

  const runId = randomBytes(4).toString('hex');
  const schema = `billingtest_${runId}`;

  const adminClient = new pg.Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await adminClient.end();
  }

  const testConnStr = withSearchPath(databaseUrl, schema);
  const pool = new pg.Pool({
    connectionString: testConnStr,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });

  await runMigrations(pool, schema);

  const teardown = async () => {
    await pool.end();
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  };

  return { pool, schema, teardown };
}

// ── Sim config ────────────────────────────────────────────────────────────────

/** Sim config: 1 real second = 1 billing day */
export const SIM_CFG: BillingSimConfig = {
  billingSimEnabled: true,
  billingSimDaySeconds: 1,
};

/** Day in ms under SIM_CFG */
export const SIM_DAY_MS = 1_000;
/** Cycle (30 days) in ms under SIM_CFG */
export const SIM_CYCLE_MS = 30 * SIM_DAY_MS;
/** Grace period (7 days) in ms under SIM_CFG */
export const SIM_GRACE_MS = 7 * SIM_DAY_MS;

// ── Engine / worker factories ─────────────────────────────────────────────────

export function makeSimEngine(pool: pg.Pool, clock: ManualClock): BillingEngine {
  return new BillingEngine({
    paystackSecretKey: 'sk_test_placeholder',
    billingSimConfig: SIM_CFG,
    clock,
  });
}

export function makeSimWorker(pool: pg.Pool, clock: ManualClock): BillingWorker {
  return new BillingWorker(pool, {
    paystackSecretKey: 'sk_test_placeholder',
    billingSimConfig: SIM_CFG,
    clock,
    batchSize: 20,
    pollIntervalMs: 50,
  });
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/** Insert a fresh USD/ZAR exchange rate row (fresh = just now). */
export async function seedExchangeRate(pool: pg.Pool, zarPerUsd: number): Promise<void> {
  await pool.query(
    `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
    [JSON.stringify({ ZAR: zarPerUsd })],
  );
}

/**
 * Insert an AUTH_test_ Paystack authorization for the given org.
 * Returns the auth code inserted.
 */
export async function seedAuth(
  pool: pg.Pool,
  orgId: string,
  email = 'test@example.com',
): Promise<string> {
  const authCode = `AUTH_test_${randomBytes(8).toString('hex')}`;
  await pool.query(
    `INSERT INTO billing_authorizations
       (organization_id, paystack_authorization_code, paystack_customer_code, email,
        card_type, last4, exp_month, exp_year, reusable, is_default, is_active)
     VALUES ($1::uuid, $2, 'CUST_test', $3, 'visa', '4242', '12', '2028', true, true, true)
     ON CONFLICT (paystack_authorization_code) DO NOTHING`,
    [orgId, authCode, email],
  );
  return authCode;
}

/**
 * Insert a mock "real card" authorization that will trigger actual Paystack HTTP calls.
 * Used for testing decline paths.
 */
export async function seedRealCardAuth(
  pool: pg.Pool,
  orgId: string,
  authCode: string,
  email = 'test@example.com',
): Promise<void> {
  await pool.query(
    `INSERT INTO billing_authorizations
       (organization_id, paystack_authorization_code, paystack_customer_code, email,
        card_type, last4, exp_month, exp_year, reusable, is_default, is_active)
     VALUES ($1::uuid, $2, 'CUST_real', $3, 'visa', '1234', '12', '2028', true, true, true)
     ON CONFLICT (paystack_authorization_code) DO NOTHING`,
    [orgId, authCode, email],
  );
}

/**
 * Get the first non-free paid tier id + slug.
 */
export async function getStarterTier(
  pool: pg.Pool,
): Promise<{ id: string; slug: string; priceUsdCents: number }> {
  const res = await pool.query<{ id: string; slug: string; price_usd_cents: number }>(
    `SELECT id, slug, price_usd_cents FROM billing_tiers WHERE slug = 'starter' AND is_active = true LIMIT 1`,
  );
  const tier = res.rows[0];
  if (!tier) throw new Error('starter tier not found in billing_tiers');
  return { id: tier.id, slug: tier.slug, priceUsdCents: tier.price_usd_cents };
}

export async function getFreeTier(pool: pg.Pool): Promise<{ id: string; slug: string }> {
  const res = await pool.query<{ id: string; slug: string }>(
    `SELECT id, slug FROM billing_tiers WHERE slug = 'free' AND is_active = true LIMIT 1`,
  );
  const tier = res.rows[0];
  if (!tier) throw new Error('free tier not found in billing_tiers');
  return { id: tier.id, slug: tier.slug };
}

/** Create a subscription for an org at a given tier (bypassing subscribe flow). */
export async function seedSubscription(
  pool: pg.Pool,
  orgId: string,
  tierId: string,
  periodEndOffsetMs: number = SIM_CYCLE_MS,
  now: Date = new Date(),
): Promise<string> {
  const periodEnd = new Date(now.getTime() + periodEndOffsetMs);
  const billingDay = now.getDate();
  const res = await pool.query<{ id: string }>(
    `INSERT INTO billing_subscriptions
       (organization_id, tier_id, status, current_period_start, current_period_end,
        failed_payment_count, outstanding_amount_cents,
        metadata)
     VALUES ($1::uuid, $2::uuid, 'active', $3, $4, 0, 0,
             jsonb_build_object('billing_day_of_month', $5::int, 'billing_timezone', 'Africa/Johannesburg'))
     RETURNING id`,
    [orgId, tierId, now, periodEnd, billingDay],
  );
  return res.rows[0]!.id;
}

/** Generate a random org UUID. */
export async function newOrgId(pool: pg.Pool): Promise<string> {
  const res = await pool.query<{ id: string }>(`SELECT gen_random_uuid() AS id`);
  return res.rows[0]!.id;
}

// ── Paystack HTTP mocking ─────────────────────────────────────────────────────

type FetchSpy = ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;
let _fetchSpy: FetchSpy | null = null;

function makeFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Mock global fetch to simulate a Paystack successful charge. */
export function mockPaystackCharge(
  status: 'success' | 'failed' = 'success',
  reference?: string,
): FetchSpy {
  const ref = reference ?? `ps_ref_${randomBytes(8).toString('hex')}`;
  _fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    makeFetchResponse({
      status: true,
      message: 'Charge attempted',
      data: {
        status,
        reference: ref,
        gateway_response: status === 'success' ? 'Approved' : 'Insufficient funds',
        amount: 53708,
        currency: 'ZAR',
      },
    }),
  );
  return _fetchSpy;
}

/** Mock global fetch for initializeTransaction */
export function mockPaystackInit(reference?: string): FetchSpy {
  const ref = reference ?? `ps_init_${randomBytes(8).toString('hex')}`;
  _fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    makeFetchResponse({
      status: true,
      message: 'Authorization URL created',
      data: {
        authorization_url: `https://checkout.paystack.com/${ref}`,
        access_code: `ac_${ref}`,
        reference: ref,
      },
    }),
  );
  return _fetchSpy;
}

/** Restore global fetch to real implementation. */
export function restoreFetch(): void {
  if (_fetchSpy) {
    _fetchSpy.mockRestore();
    _fetchSpy = null;
  }
}
