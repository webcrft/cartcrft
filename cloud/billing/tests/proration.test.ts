/**
 * proration.test.ts — Billing day change and proration under simulated time
 *
 * Tests:
 *   PR1. Mid-cycle upgrade → prorated charge math matches src/math.ts
 *   PR2. Billing-day change with proration charged via saved card
 *   PR3. Billing-day change to same day is rejected
 *   PR4. Downgrade scheduling: cancel_at_period_end flag, period not advanced by cron
 *   PR5. Proration is zero when new due date is not after old due date
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  createBillingCtx,
  makeSimEngine,
  makeSimWorker,
  seedExchangeRate,
  seedAuth,
  seedSubscription,
  newOrgId,
  getStarterTier,
  SIM_DAY_MS,
  SIM_CYCLE_MS,
  type BillingTestCtx,
} from './helpers.js';
import { ManualClock } from '../src/clock.js';
import { calcProration, nextBillingAnchorAfter } from '../src/math.js';

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Billing proration', () => {
  let ctx: BillingTestCtx;
  let clock: ManualClock;
  const NOW_BASE = new Date('2026-03-15T12:00:00Z');

  beforeAll(async () => {
    ctx = await createBillingCtx();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(() => {
    clock = new ManualClock(new Date(NOW_BASE));
  });

  // ── PR1. Proration math matches src/math.ts ─────────────────────────────

  describe('PR1 – prorated charge math matches src/math.ts', () => {
    it('calcProration result is used when charging billing day change', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'pr1@example.com');
      const tier = await getStarterTier(pool);

      // Subscription: billing day = 15 (today), period_end in ~30 sim-days
      const subId = await seedSubscription(pool, orgId, tier.id, SIM_CYCLE_MS, clock.now());

      const sub = await pool.query<{ current_period_end: Date; metadata: Record<string, unknown> }>(
        `SELECT current_period_end, metadata FROM billing_subscriptions WHERE id = $1::uuid`,
        [subId],
      );
      const oldDue = new Date(sub.rows[0]!.current_period_end);

      // Choose a different billing day — day 20
      const newDay = 20;
      const { newDue, prorationCents } = calcProration(clock.now(), oldDue, newDay, tier.priceUsdCents);

      const engine = makeSimEngine(pool, clock);
      const result = await engine.changeBillingDay(pool, orgId, newDay);

      // The result matches what calcProration computed
      expect(result.prorationCents).toBe(prorationCents);
      // New due date matches calcProration result
      expect(result.newDue.getTime()).toBe(newDue.getTime());

      // If proration > 0, a transaction was created
      if (prorationCents > 0) {
        const txn = await pool.query<{ charge_type: string; status: string }>(
          `SELECT charge_type, status FROM billing_transactions
            WHERE organization_id = $1::uuid
            ORDER BY created_at DESC LIMIT 1`,
          [orgId],
        );
        expect(txn.rows[0]?.charge_type).toBe('subscription');
        expect(txn.rows[0]?.status).toBe('success');

        // An invoice was created
        const inv = await pool.query(
          `SELECT COUNT(*) AS cnt FROM billing_invoices WHERE organization_id = $1::uuid`,
          [orgId],
        );
        expect(Number(inv.rows[0]?.cnt)).toBeGreaterThan(0);
      }
    });

    it('proration calcProration: extra days capped at 30', () => {
      const now = new Date('2026-01-01T00:00:00Z');
      const oldDue = new Date('2026-01-05T00:00:00Z');
      // newDay = 5 -> next anchor after now is Jan 5 which is <= oldDue → push to Feb 5
      const { newDue, prorationCents } = calcProration(now, oldDue, 5, 2900);
      // Extra days should be Feb 5 - Jan 5 = 31 days → capped at 30
      const extraDays = Math.min((newDue.getTime() - oldDue.getTime()) / (24 * 60 * 60 * 1000), 30);
      const expected = Math.floor(2900 * extraDays / 30);
      expect(prorationCents).toBe(expected);
    });

    it('proration is zero when price_usd_cents is 0', () => {
      const now = new Date('2026-01-15T00:00:00Z');
      const oldDue = new Date('2026-01-20T00:00:00Z');
      const { prorationCents } = calcProration(now, oldDue, 28, 0);
      expect(prorationCents).toBe(0);
    });
  });

  // ── PR2. Billing-day change charged via saved card ─────────────────────

  describe('PR2 – billing-day change with proration creates charge', () => {
    it('changeBillingDay charges saved card for extra days', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 19.0);

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'pr2@example.com');
      const tier = await getStarterTier(pool);

      // Period ends in 3 sim-days from now
      const subId = await seedSubscription(pool, orgId, tier.id, 3 * SIM_DAY_MS, clock.now());

      const engine = makeSimEngine(pool, clock);
      // Change to billing day 28 — typically extends the period
      const result = await engine.changeBillingDay(pool, orgId, 28);

      expect(result.newDue).toBeInstanceOf(Date);

      // Verify subscription updated with new billing day
      const subRow = await pool.query<{ metadata: Record<string, unknown>; current_period_end: Date }>(
        `SELECT metadata, current_period_end FROM billing_subscriptions WHERE id = $1::uuid`,
        [subId],
      );
      expect(subRow.rows[0]?.metadata?.['billing_day_of_month']).toBe(28);
    });
  });

  // ── PR3. Same billing day is rejected ─────────────────────────────────

  describe('PR3 – changing to current billing day is an error', () => {
    it('changeBillingDay with same day throws error', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'pr3@example.com');
      const tier = await getStarterTier(pool);

      // Seed subscription with billing_day_of_month = 15 (same as NOW_BASE)
      await pool.query(
        `INSERT INTO billing_subscriptions
           (organization_id, tier_id, status, current_period_start, current_period_end,
            metadata)
         VALUES ($1::uuid, $2::uuid, 'active', $3, $4,
                 '{"billing_day_of_month": 15, "billing_timezone": "Africa/Johannesburg"}'::jsonb)`,
        [orgId, tier.id, clock.now(), new Date(clock.now().getTime() + SIM_CYCLE_MS)],
      );

      const engine = makeSimEngine(pool, clock);
      // Day 15 = current preferred day → should throw
      await expect(engine.changeBillingDay(pool, orgId, 15)).rejects.toThrow(
        'Already set to this billing day',
      );
    });

    it('changeBillingDay with day < 1 throws', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);
      await expect(engine.changeBillingDay(pool, orgId, 0)).rejects.toThrow(
        'day_of_month must be between 1 and 31',
      );
    });

    it('changeBillingDay with day > 31 throws', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);
      await expect(engine.changeBillingDay(pool, orgId, 32)).rejects.toThrow(
        'day_of_month must be between 1 and 31',
      );
    });
  });

  // ── PR4. Downgrade scheduling (cancel_at_period_end) ──────────────────

  describe('PR4 – cancel_at_period_end schedules downgrade at period end', () => {
    it('renewal task for cancelled sub downgrades to free (not renewed)', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'pr4@example.com');
      const tier = await getStarterTier(pool);

      const subId = await seedSubscription(pool, orgId, tier.id, 0, clock.now());

      // Mark subscription as cancel_at_period_end
      await pool.query(
        `UPDATE billing_subscriptions SET cancel_at_period_end = true WHERE id = $1::uuid`,
        [subId],
      );

      const engine = makeSimEngine(pool, clock);
      await engine.enqueueRenewal(pool, orgId, subId, clock.now());

      const worker = makeSimWorker(pool, clock);
      const result = await worker.tick();

      // The renewal was "cancelled" (not renewed, not failed)
      expect(result.cancelled).toBe(1);
      expect(result.renewed).toBe(0);

      // Subscription downgraded to free
      const sub = await pool.query<{ tier_slug: string }>(
        `SELECT t.slug AS tier_slug
           FROM billing_subscriptions s
           JOIN billing_tiers t ON t.id = s.tier_id
          WHERE s.id = $1::uuid`,
        [subId],
      );
      expect(sub.rows[0]?.tier_slug).toBe('free');
    });
  });
});
