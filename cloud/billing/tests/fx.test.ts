/**
 * fx.test.ts — FX rate immutability and edge cases
 *
 * Tests:
 *   FX1. Rate change between invoices — old invoice snapshot is untouched (immutability)
 *   FX2. New invoice uses new rate after rate changes
 *   FX3. Conversion rounding edge cases (integer cents, ceiling per implementation)
 *   FX4. Stale-rate guard: rates older than 6 hours return null
 *   FX5. Missing rate returns null
 *   FX6. ZAR amount precision stored correctly
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createBillingCtx,
  makeSimEngine,
  seedExchangeRate,
  newOrgId,
  getStarterTier,
  type BillingTestCtx,
} from './helpers.js';
import { ManualClock } from '../src/clock.js';
import { convertUsdCentsToZar, convertUsdToZarCents, getUsdZarRate } from '../src/fx.js';

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('FX immutability and edge cases', () => {
  let ctx: BillingTestCtx;
  let clock: ManualClock;

  beforeAll(async () => {
    ctx = await createBillingCtx();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(() => {
    clock = new ManualClock(new Date('2026-01-15T12:00:00Z'));
  });

  // ── FX1+FX2. Rate change between invoices ─────────────────────────────

  describe('FX1+FX2 – rate change does not mutate existing invoice snapshots', () => {
    it('old invoice retains its fx_rate after rate changes, new invoice uses new rate', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const tier = await getStarterTier(pool);

      // Insert initial rate = 18.00
      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: 18.0 })],
      );

      // Create subscription for linking
      const sub1 = await pool.query<{ id: string }>(
        `INSERT INTO billing_subscriptions
           (organization_id, tier_id, status, current_period_start, current_period_end)
         VALUES ($1::uuid, $2::uuid, 'active', now(), now() + interval '30 days')
         RETURNING id`,
        [orgId, tier.id],
      );
      const subId = sub1.rows[0]!.id;

      const engine = makeSimEngine(pool, clock);
      const rate1 = await getUsdZarRate(pool, clock);
      expect(rate1).not.toBeNull();
      expect(rate1!.zarPerUsd).toBe(18.0);

      const usdCents = 2900;
      const zarCents1 = convertUsdCentsToZar(usdCents, rate1!.zarPerUsd);

      // Create first transaction + invoice at rate 18.00
      const ref1 = `test-fx1-${randomBytes(8).toString('hex')}`;
      const txn1 = await pool.query<{ id: string }>(
        `INSERT INTO billing_transactions
           (organization_id, subscription_id, paystack_reference, amount_cents, currency,
            status, charge_type, usd_amount, fx_rate, zar_amount, fx_fetched_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ZAR', 'success', 'subscription',
                 $5, $6, $7, now())
         RETURNING id`,
        [orgId, subId, ref1, zarCents1, usdCents / 100, rate1!.zarPerUsd, zarCents1 / 100],
      );
      const snap1 = {
        usdAmount: usdCents / 100,
        fxRate: rate1!.zarPerUsd,
        zarAmount: zarCents1 / 100,
        fxFetchedAt: rate1!.fetchedAt,
      };
      const inv1Id = await engine.createInvoice(pool, orgId, subId, txn1.rows[0]!.id, zarCents1, 'Invoice 1', snap1);

      // Now change rate to 22.00
      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: 22.0 })],
      );

      const rate2 = await getUsdZarRate(pool, clock);
      expect(rate2).not.toBeNull();
      expect(rate2!.zarPerUsd).toBe(22.0);

      const zarCents2 = convertUsdCentsToZar(usdCents, rate2!.zarPerUsd);
      const ref2 = `test-fx2-${randomBytes(8).toString('hex')}`;
      const txn2 = await pool.query<{ id: string }>(
        `INSERT INTO billing_transactions
           (organization_id, subscription_id, paystack_reference, amount_cents, currency,
            status, charge_type, usd_amount, fx_rate, zar_amount, fx_fetched_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ZAR', 'success', 'subscription',
                 $5, $6, $7, now())
         RETURNING id`,
        [orgId, subId, ref2, zarCents2, usdCents / 100, rate2!.zarPerUsd, zarCents2 / 100],
      );
      const snap2 = {
        usdAmount: usdCents / 100,
        fxRate: rate2!.zarPerUsd,
        zarAmount: zarCents2 / 100,
        fxFetchedAt: rate2!.fetchedAt,
      };
      const inv2Id = await engine.createInvoice(pool, orgId, subId, txn2.rows[0]!.id, zarCents2, 'Invoice 2', snap2);

      // Assert: inv1 snapshot unchanged (still rate 18.00)
      const inv1Row = await pool.query<{ fx_rate: string; zar_amount: string; usd_amount: string }>(
        `SELECT fx_rate::text, zar_amount::text, usd_amount::text FROM billing_invoices WHERE id = $1::uuid`,
        [inv1Id],
      );
      expect(Number(inv1Row.rows[0]!.fx_rate)).toBeCloseTo(18.0, 2);
      expect(Number(inv1Row.rows[0]!.zar_amount)).toBeCloseTo(zarCents1 / 100, 2);
      expect(Number(inv1Row.rows[0]!.usd_amount)).toBeCloseTo(usdCents / 100, 2);

      // Assert: inv2 snapshot uses new rate 22.00
      const inv2Row = await pool.query<{ fx_rate: string; zar_amount: string }>(
        `SELECT fx_rate::text, zar_amount::text FROM billing_invoices WHERE id = $1::uuid`,
        [inv2Id],
      );
      expect(Number(inv2Row.rows[0]!.fx_rate)).toBeCloseTo(22.0, 2);
      expect(Number(inv2Row.rows[0]!.zar_amount)).toBeCloseTo(zarCents2 / 100, 2);

      // Sanity: two invoices have different rates
      expect(Number(inv1Row.rows[0]!.fx_rate)).not.toBe(Number(inv2Row.rows[0]!.fx_rate));

      // Invoice line items also carry the immutable snapshot
      const item1 = await pool.query<{ fx_rate: string }>(
        `SELECT fx_rate::text FROM billing_invoice_items WHERE invoice_id = $1::uuid`,
        [inv1Id],
      );
      expect(Number(item1.rows[0]?.fx_rate)).toBeCloseTo(18.0, 2);

      const item2 = await pool.query<{ fx_rate: string }>(
        `SELECT fx_rate::text FROM billing_invoice_items WHERE invoice_id = $1::uuid`,
        [inv2Id],
      );
      expect(Number(item2.rows[0]?.fx_rate)).toBeCloseTo(22.0, 2);
    });

    it('refund copies fx snapshot from original transaction (not current rate)', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const tier = await getStarterTier(pool);

      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: 19.0 })],
      );

      const sub = await pool.query<{ id: string }>(
        `INSERT INTO billing_subscriptions
           (organization_id, tier_id, status, current_period_start, current_period_end)
         VALUES ($1::uuid, $2::uuid, 'active', now(), now() + interval '30 days')
         RETURNING id`,
        [orgId, tier.id],
      );
      const subId = sub.rows[0]!.id;

      const zarCents = convertUsdCentsToZar(2900, 19.0);
      const ref = `test-refund-fx-${randomBytes(8).toString('hex')}`;
      const txn = await pool.query<{ id: string }>(
        `INSERT INTO billing_transactions
           (organization_id, subscription_id, paystack_reference, amount_cents, currency,
            status, charge_type, usd_amount, fx_rate, zar_amount, fx_fetched_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ZAR', 'success', 'subscription',
                 $5, 19.0, $6, now())
         RETURNING id`,
        [orgId, subId, ref, zarCents, 2900 / 100, zarCents / 100],
      );
      const txnId = txn.rows[0]!.id;

      // Now rate changes to 25.0
      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: 25.0 })],
      );

      const engine = makeSimEngine(pool, clock);
      const refundId = await engine.recordRefund(pool, orgId, txnId, zarCents, 'test refund');

      // Refund snapshot must match original transaction's snapshot (19.0), not current (25.0)
      const refundRow = await pool.query<{ fx_rate: string }>(
        `SELECT fx_rate::text FROM billing_refunds WHERE id = $1::uuid`,
        [refundId],
      );
      expect(Number(refundRow.rows[0]?.fx_rate)).toBeCloseTo(19.0, 2);
    });
  });

  // ── FX3. Conversion rounding edge cases ──────────────────────────────

  describe('FX3 – conversion rounding (ceiling, not floor)', () => {
    it('convertUsdCentsToZar uses ceiling rounding', () => {
      // 1 USD cent * 18.523 = 18.523 ZAR cents → ceil → 19
      expect(convertUsdCentsToZar(1, 18.523)).toBe(19);
      // 100 USD cents * 18.523 = 1852.3 ZAR cents → ceil → 1853
      expect(convertUsdCentsToZar(100, 18.523)).toBe(1853);
      // 2900 * 18.52 = 53708.0 exactly
      expect(convertUsdCentsToZar(2900, 18.52)).toBe(53708);
      // 1 * 18.0 = 18.0 exactly → 18
      expect(convertUsdCentsToZar(1, 18.0)).toBe(18);
    });

    it('convertUsdCentsToZar returns 0 for zero inputs', () => {
      expect(convertUsdCentsToZar(0, 18.5)).toBe(0);
      expect(convertUsdCentsToZar(100, 0)).toBe(0);
      expect(convertUsdCentsToZar(0, 0)).toBe(0);
    });

    it('convertUsdCentsToZar returns 0 for negative inputs', () => {
      expect(convertUsdCentsToZar(-100, 18.5)).toBe(0);
      expect(convertUsdCentsToZar(100, -1)).toBe(0);
    });

    it('convertUsdToZarCents: dollar amount to ZAR cents with ceiling', () => {
      // $29.00 * 18.52 = 537.08 ZAR → * 100 = 53708 cents
      // NOTE: floating-point: 29.0 * 18.52 * 100 = 53708.00000000001, ceil → 53709
      expect(convertUsdToZarCents(29.0, 18.52)).toBe(53709);
      // $0.01 * 18.523 = 0.18523 ZAR → * 100 = 18.523 cents → ceil → 19
      expect(convertUsdToZarCents(0.01, 18.523)).toBe(Math.ceil(0.01 * 18.523 * 100));
    });

    it('stored ZAR amount matches computed value (integer cents / 100 → decimal)', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const tier = await getStarterTier(pool);

      const rate = 18.523456;
      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: rate })],
      );

      const sub = await pool.query<{ id: string }>(
        `INSERT INTO billing_subscriptions
           (organization_id, tier_id, status, current_period_start, current_period_end)
         VALUES ($1::uuid, $2::uuid, 'active', now(), now() + interval '30 days')
         RETURNING id`,
        [orgId, tier.id],
      );
      const subId = sub.rows[0]!.id;

      const usdCents = 2900;
      const expectedZarCents = convertUsdCentsToZar(usdCents, rate);
      const ref = `rounding-test-${randomBytes(8).toString('hex')}`;
      const txn = await pool.query<{ id: string }>(
        `INSERT INTO billing_transactions
           (organization_id, subscription_id, paystack_reference, amount_cents, currency,
            status, charge_type, usd_amount, fx_rate, zar_amount, fx_fetched_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ZAR', 'success', 'subscription',
                 $5, $6, $7, now())
         RETURNING id`,
        [orgId, subId, ref, expectedZarCents, usdCents / 100, rate, expectedZarCents / 100],
      );

      const engine = makeSimEngine(pool, clock);
      const snap = {
        usdAmount: usdCents / 100,
        fxRate: rate,
        zarAmount: expectedZarCents / 100,
        fxFetchedAt: new Date(),
      };
      const invId = await engine.createInvoice(pool, orgId, subId, txn.rows[0]!.id, expectedZarCents, 'Rounding test', snap);

      const invRow = await pool.query<{ total_cents: number; fx_rate: string; zar_amount: string }>(
        `SELECT total_cents, fx_rate::text, zar_amount::text FROM billing_invoices WHERE id = $1::uuid`,
        [invId],
      );
      // total_cents == expectedZarCents
      expect(invRow.rows[0]!.total_cents).toBe(expectedZarCents);
      // zar_amount decimal = expectedZarCents / 100
      expect(Number(invRow.rows[0]!.zar_amount)).toBeCloseTo(expectedZarCents / 100, 2);
    });
  });

  // ── FX4. Stale rate guard ────────────────────────────────────────────

  describe('FX4 – stale rate guard returns null', () => {
    it('rate older than 6 hours returns null (no fresh rows present)', async () => {
      const { pool } = ctx;

      // Wipe all rates and insert only a stale row 8 hours BEFORE clock.now().
      // Must use clock-relative time: clock.now() = 2026-01-15T12:00:00Z so
      // staleAt = 2026-01-15T04:00:00Z which is well past the 6-hour guard.
      const staleAt = new Date(clock.now().getTime() - 8 * 60 * 60 * 1000);
      await pool.query(`DELETE FROM exchange_rates`);
      await pool.query(
        `INSERT INTO exchange_rates (base, rates, fetched_at)
         VALUES ('USD', $1::jsonb, $2)`,
        [JSON.stringify({ ZAR: 999.0 }), staleAt],
      );

      const rate = await getUsdZarRate(pool, clock);
      expect(rate).toBeNull();
    });

    it('fresh rate returns the rate', async () => {
      const { pool } = ctx;
      // Replace any stale rows with a fresh one
      await pool.query(`DELETE FROM exchange_rates`);
      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: 18.75 })],
      );
      const rate = await getUsdZarRate(pool, clock);
      expect(rate).not.toBeNull();
      expect(rate!.zarPerUsd).toBeCloseTo(18.75, 2);
    });
  });

  // ── FX5. Missing rate returns null ───────────────────────────────────

  describe('FX5 – missing ZAR key in rates jsonb returns null', () => {
    it('rates jsonb without ZAR key returns null', async () => {
      const { pool } = ctx;
      // Wipe all rates then insert one with no ZAR key
      await pool.query(`DELETE FROM exchange_rates`);
      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ NGN: 1500.0 })],
      );
      const rate = await getUsdZarRate(pool, clock);
      expect(rate).toBeNull();
      // Restore a valid rate for subsequent tests
      await pool.query(`DELETE FROM exchange_rates`);
      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: 18.5 })],
      );
    });
  });

  // ── FX6. Transaction fx_rate immutability in DB ─────────────────────

  describe('FX6 – transaction FX snapshot is immutable after recording', () => {
    it('updating exchange_rates does not affect previously stored transaction fx_rate', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const tier = await getStarterTier(pool);

      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: 17.5 })],
      );

      const sub = await pool.query<{ id: string }>(
        `INSERT INTO billing_subscriptions
           (organization_id, tier_id, status, current_period_start, current_period_end)
         VALUES ($1::uuid, $2::uuid, 'active', now(), now() + interval '30 days')
         RETURNING id`,
        [orgId, tier.id],
      );

      const zarCents = convertUsdCentsToZar(2900, 17.5);
      const ref = `immut-test-${randomBytes(8).toString('hex')}`;
      const txn = await pool.query<{ id: string }>(
        `INSERT INTO billing_transactions
           (organization_id, subscription_id, paystack_reference, amount_cents, currency,
            status, charge_type, usd_amount, fx_rate, zar_amount, fx_fetched_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ZAR', 'success', 'subscription',
                 29.00, 17.5, $5, now())
         RETURNING id`,
        [orgId, sub.rows[0]!.id, ref, zarCents, zarCents / 100],
      );
      const txnId = txn.rows[0]!.id;

      // Now update exchange_rates to a different value
      await pool.query(
        `INSERT INTO exchange_rates (base, rates) VALUES ('USD', $1::jsonb)`,
        [JSON.stringify({ ZAR: 30.0 })],
      );

      // Transaction row still has the original fx_rate
      const txnRow = await pool.query<{ fx_rate: string }>(
        `SELECT fx_rate::text FROM billing_transactions WHERE id = $1::uuid`,
        [txnId],
      );
      expect(Number(txnRow.rows[0]!.fx_rate)).toBeCloseTo(17.5, 2);
    });
  });
});
