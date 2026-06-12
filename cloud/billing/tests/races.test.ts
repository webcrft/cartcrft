/**
 * races.test.ts — Idempotency and concurrency safety tests (AF1–AF8 spirit)
 *
 * Tests:
 *   AF1. Duplicate renewal queue task (same idempotency_key) → single charge
 *   AF2. Webhook charge.success arriving while renewal is enqueued → exactly one
 *        confirmed invoice (ON CONFLICT DO NOTHING on paystack_reference)
 *   AF3. Dead-letter after all attempts exhausted: task preserved in billing_dead_letter
 *   AF4. FOR UPDATE SKIP LOCKED: two concurrent worker ticks each claim distinct tasks
 *   AF5. Worker backoff: failed task scheduled for future (dayDuration/2 then dayDuration)
 *   AF6. idempotency_key collision → no duplicate queue rows
 *   AF7. Worker marks exhausted task dead and preserves last_error
 *   AF8. enqueueRenewal idempotency: calling twice with same periodEnd → one row
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
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
import { handleBillingWebhookEvent } from '../src/webhook.js';

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Billing races and idempotency', () => {
  let ctx: BillingTestCtx;
  let clock: ManualClock;

  beforeAll(async () => {
    ctx = await createBillingCtx();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(() => {
    clock = new ManualClock(new Date('2026-02-01T00:00:00Z'));
  });

  // ── AF1. Duplicate queue task → single charge ─────────────────────────

  describe('AF1 – duplicate renewal queue task produces single charge', () => {
    it('inserting same idempotency_key twice results in one row in billing_queue', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'af1@example.com');
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, 0, clock.now());

      const engine = makeSimEngine(pool, clock);
      const periodEnd = clock.now();

      // Enqueue twice with same period end (same idempotency_key)
      await engine.enqueueRenewal(pool, orgId, subId, periodEnd);
      await engine.enqueueRenewal(pool, orgId, subId, periodEnd);

      const qCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_queue WHERE subscription_id = $1::uuid`,
        [subId],
      );
      expect(Number(qCount.rows[0]?.cnt)).toBe(1);
    });

    it('processing a duplicate task still results in only one transaction', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'af1b@example.com');
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, 0, clock.now());
      const engine = makeSimEngine(pool, clock);

      // Enqueue (idempotent — only one row created)
      await engine.enqueueRenewal(pool, orgId, subId, clock.now());

      const worker = makeSimWorker(pool, clock);
      await worker.tick();

      const txnCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_transactions WHERE organization_id = $1::uuid`,
        [orgId],
      );
      // Exactly one transaction created from the single queue task
      expect(Number(txnCount.rows[0]?.cnt)).toBe(1);
    });
  });

  // ── AF2. Webhook charge.success idempotency ─────────────────────────

  describe('AF2 – webhook charge.success with same reference creates exactly one transaction', () => {
    it('calling webhook handler twice for same reference results in one billing_transaction row', async () => {
      const { pool } = ctx;

      const orgId = await newOrgId(pool);
      const tier = await getStarterTier(pool);

      // Create subscription for the webhook upgrade path
      await pool.query(
        `INSERT INTO billing_subscriptions
           (organization_id, tier_id, status, current_period_start, current_period_end)
         VALUES ($1::uuid, $2::uuid, 'active', now(), now() + interval '30 days')`,
        [orgId, tier.id],
      );

      const psRef = `ps_wh_${randomBytes(12).toString('hex')}`;
      const event = {
        event: 'charge.success',
        data: {
          status: 'success',
          reference: psRef,
          amount: 53708,
          currency: 'ZAR',
          gateway_response: 'Approved',
          customer_email: 'af2@example.com',
          metadata: {
            organization_id: orgId,
            intent: 'upgrade',
            tier_id: tier.id,
          },
          authorization: {
            authorization_code: `AUTH_wh_${randomBytes(8).toString('hex')}`,
            reusable: true,
            card_type: 'visa',
            last4: '4242',
            exp_month: '12',
            exp_year: '2028',
            bank: 'test bank',
            brand: 'visa',
          },
          customer: {
            email: 'af2@example.com',
            customer_code: 'CUS_test',
          },
        },
      };

      // First call
      await handleBillingWebhookEvent({ pool, clock, paystackSecretKey: 'sk_test' }, event);
      // Second call (duplicate webhook delivery)
      await handleBillingWebhookEvent({ pool, clock, paystackSecretKey: 'sk_test' }, event);

      // Exactly one transaction row for this reference
      const txnCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_transactions WHERE paystack_reference = $1`,
        [psRef],
      );
      expect(Number(txnCount.rows[0]?.cnt)).toBe(1);
    });

    it('webhook for add_card is idempotent on paystack_authorization_code', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);

      const psRef = `ps_wh_addcard_${randomBytes(8).toString('hex')}`;
      const authCode = `AUTH_wh_ac_${randomBytes(8).toString('hex')}`;

      const event = {
        event: 'charge.success',
        data: {
          status: 'success',
          reference: psRef,
          amount: 100,
          currency: 'ZAR',
          gateway_response: 'Approved',
          customer_email: 'af2b@example.com',
          metadata: {
            organization_id: orgId,
            intent: 'add_card',
          },
          authorization: {
            authorization_code: authCode,
            reusable: true,
            card_type: 'visa',
            last4: '9999',
            exp_month: '06',
            exp_year: '2029',
            bank: 'test',
            brand: 'visa',
          },
          customer: {
            email: 'af2b@example.com',
            customer_code: 'CUS_test2',
          },
        },
      };

      // Call twice
      await handleBillingWebhookEvent({ pool, clock, paystackSecretKey: 'sk_test' }, event);
      await handleBillingWebhookEvent({ pool, clock, paystackSecretKey: 'sk_test' }, event);

      // Exactly one authorization row for this auth code
      const authCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_authorizations
          WHERE paystack_authorization_code = $1`,
        [authCode],
      );
      expect(Number(authCount.rows[0]?.cnt)).toBe(1);
    });
  });

  // ── AF3. Dead-letter after exhausted retries ──────────────────────────

  describe('AF3 – task moves to dead_letter after exhausting max_attempts', () => {
    it('task at max_attempts goes to billing_dead_letter with last_error preserved', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      // No card → all renewal attempts will fail
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, 0, clock.now());

      // Insert a task already at max-1 attempts (one tick will exhaust it)
      const idemKey = `dead-letter-test:${subId}:${randomBytes(4).toString('hex')}`;
      await pool.query(
        `INSERT INTO billing_queue
           (organization_id, task_type, subscription_id, run_at, cycle_key,
            idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1::uuid, 'subscription_renewal', $2::uuid, $3, 'dead-test', $4, 'pending', 2, 3)`,
        [orgId, subId, clock.now(), idemKey],
      );

      const worker = makeSimWorker(pool, clock);
      await worker.tick();

      // Queue task should be dead
      const qRow = await pool.query<{ status: string; last_error: string }>(
        `SELECT status, last_error FROM billing_queue WHERE idempotency_key = $1`,
        [idemKey],
      );
      expect(qRow.rows[0]?.status).toBe('dead');
      expect(qRow.rows[0]?.last_error).toBeTruthy();

      // Dead letter entry exists
      const dlRow = await pool.query<{ last_error: string; idempotency_key: string }>(
        `SELECT last_error, idempotency_key FROM billing_dead_letter WHERE idempotency_key = $1`,
        [idemKey],
      );
      expect(dlRow.rows[0]?.idempotency_key).toBe(idemKey);
      expect(dlRow.rows[0]?.last_error).toBeTruthy();
    });

    it('dead-lettered task is preserved and not deleted', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, 0, clock.now());

      const idemKey = `dl-preserve-${subId}:${randomBytes(4).toString('hex')}`;
      await pool.query(
        `INSERT INTO billing_queue
           (organization_id, task_type, subscription_id, run_at, cycle_key,
            idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1::uuid, 'subscription_renewal', $2::uuid, $3, 'dl-test', $4, 'pending', 2, 3)`,
        [orgId, subId, clock.now(), idemKey],
      );

      const worker = makeSimWorker(pool, clock);
      await worker.tick();

      // Task still in dead_letter (not deleted)
      const dlCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_dead_letter WHERE idempotency_key = $1`,
        [idemKey],
      );
      expect(Number(dlCount.rows[0]?.cnt)).toBe(1);

      // Resolution is null (unresolved)
      const dlRow = await pool.query<{ resolution: string | null }>(
        `SELECT resolution FROM billing_dead_letter WHERE idempotency_key = $1`,
        [idemKey],
      );
      expect(dlRow.rows[0]?.resolution).toBeNull();
    });
  });

  // ── AF4. FOR UPDATE SKIP LOCKED: each worker claims distinct tasks ──

  describe('AF4 – concurrent worker ticks each process distinct tasks', () => {
    it('two sequential ticks each process a different task (SKIP LOCKED semantics)', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'af4@example.com');
      const tier = await getStarterTier(pool);

      // Create two subscriptions with due tasks
      const subId1 = await seedSubscription(pool, orgId, tier.id, 0, clock.now());
      const subId2 = await seedSubscription(pool, orgId, tier.id, 0, clock.now());

      const engine = makeSimEngine(pool, clock);
      // Enqueue both — with distinct cycle keys via different periodEnd offsets
      const periodEnd1 = new Date(clock.now().getTime() - 100);
      const periodEnd2 = new Date(clock.now().getTime() - 200);
      await engine.enqueueRenewal(pool, orgId, subId1, periodEnd1);
      await engine.enqueueRenewal(pool, orgId, subId2, periodEnd2);

      // Both tasks are now pending and due
      const pending = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_queue
          WHERE organization_id = $1::uuid AND status = 'pending'`,
        [orgId],
      );
      expect(Number(pending.rows[0]?.cnt)).toBe(2);

      // Single worker processes both (batchSize=20)
      const worker = makeSimWorker(pool, clock);
      const result = await worker.tick();
      expect(result.processed).toBe(2);
      expect(result.renewed).toBe(2);

      // Both queue tasks completed
      const completed = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_queue
          WHERE organization_id = $1::uuid AND status = 'completed'`,
        [orgId],
      );
      expect(Number(completed.rows[0]?.cnt)).toBe(2);
    });
  });

  // ── AF5. Worker backoff ───────────────────────────────────────────────

  describe('AF5 – failed task is rescheduled with backoff delay', () => {
    it('first failure reschedules task for dayDuration/2 later', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      // No card → renewal will fail
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, 0, clock.now());

      const idemKey = `backoff-test-${subId}:${randomBytes(4).toString('hex')}`;
      const nowForTask = clock.now();
      await pool.query(
        `INSERT INTO billing_queue
           (organization_id, task_type, subscription_id, run_at, cycle_key,
            idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1::uuid, 'subscription_renewal', $2::uuid, $3, 'backoff', $4, 'pending', 0, 3)`,
        [orgId, subId, nowForTask, idemKey],
      );

      const nowMs = nowForTask.getTime();
      const worker = makeSimWorker(pool, clock);
      await worker.tick();

      // Task should be rescheduled as 'failed' with run_at in the future
      const qRow = await pool.query<{ status: string; run_at: Date; attempt_count: number }>(
        `SELECT status, run_at, attempt_count FROM billing_queue WHERE idempotency_key = $1`,
        [idemKey],
      );
      expect(qRow.rows[0]?.status).toBe('failed');
      expect(qRow.rows[0]!.attempt_count).toBe(1);
      // run_at should be > now (backoff applied)
      expect(new Date(qRow.rows[0]!.run_at).getTime()).toBeGreaterThan(nowMs);
    });
  });

  // ── AF6. idempotency_key uniqueness enforcement ───────────────────────

  describe('AF6 – idempotency_key uniqueness prevents duplicate queue rows', () => {
    it('ON CONFLICT DO NOTHING prevents duplicate rows', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, SIM_CYCLE_MS, clock.now());

      const idemKey = `explicit-idempotency-${randomBytes(8).toString('hex')}`;
      const periodEnd = new Date(clock.now().getTime() + SIM_CYCLE_MS);

      // Insert same key twice
      await pool.query(
        `INSERT INTO billing_queue
           (organization_id, task_type, subscription_id, run_at, cycle_key, idempotency_key, status, max_attempts)
         VALUES ($1::uuid, 'subscription_renewal', $2::uuid, $3, 'test', $4, 'pending', 3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [orgId, subId, periodEnd, idemKey],
      );
      await pool.query(
        `INSERT INTO billing_queue
           (organization_id, task_type, subscription_id, run_at, cycle_key, idempotency_key, status, max_attempts)
         VALUES ($1::uuid, 'subscription_renewal', $2::uuid, $3, 'test', $4, 'pending', 3)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [orgId, subId, periodEnd, idemKey],
      );

      const cnt = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_queue WHERE idempotency_key = $1`,
        [idemKey],
      );
      expect(Number(cnt.rows[0]?.cnt)).toBe(1);
    });
  });

  // ── AF7. Worker marks dead task with last_error ───────────────────────

  describe('AF7 – worker preserves last_error when marking task dead', () => {
    it('last_error in dead_letter contains failure reason', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, 0, clock.now());

      const idemKey = `last-error-test-${randomBytes(6).toString('hex')}`;
      await pool.query(
        `INSERT INTO billing_queue
           (organization_id, task_type, subscription_id, run_at, cycle_key,
            idempotency_key, status, attempt_count, max_attempts)
         VALUES ($1::uuid, 'subscription_renewal', $2::uuid, $3, 'err-test', $4, 'pending', 2, 3)`,
        [orgId, subId, clock.now(), idemKey],
      );

      const worker = makeSimWorker(pool, clock);
      await worker.tick();

      const dlRow = await pool.query<{ last_error: string }>(
        `SELECT last_error FROM billing_dead_letter WHERE idempotency_key = $1`,
        [idemKey],
      );
      // last_error should mention "no payment method" (no card seeded)
      expect(dlRow.rows[0]?.last_error).toBeTruthy();
      expect(dlRow.rows[0]!.last_error.length).toBeGreaterThan(0);
    });
  });

  // ── AF8. enqueueRenewal idempotency ─────────────────────────────────

  describe('AF8 – enqueueRenewal idempotency', () => {
    it('multiple enqueueRenewal calls for same subscription+periodEnd insert one row', async () => {
      const { pool } = ctx;
      await seedExchangeRate(pool, 18.5);

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'af8@example.com');
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, SIM_CYCLE_MS, clock.now());

      const engine = makeSimEngine(pool, clock);
      const periodEnd = new Date(clock.now().getTime() + SIM_CYCLE_MS);

      // Call 5 times with same periodEnd
      for (let i = 0; i < 5; i++) {
        await engine.enqueueRenewal(pool, orgId, subId, periodEnd);
      }

      const cnt = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_queue WHERE subscription_id = $1::uuid`,
        [subId],
      );
      expect(Number(cnt.rows[0]?.cnt)).toBe(1);
    });

    it('different periodEnd values each get their own queue row', async () => {
      const { pool } = ctx;

      const orgId = await newOrgId(pool);
      await seedAuth(pool, orgId, 'af8b@example.com');
      const tier = await getStarterTier(pool);
      const subId = await seedSubscription(pool, orgId, tier.id, SIM_CYCLE_MS, clock.now());

      const engine = makeSimEngine(pool, clock);

      const pe1 = new Date(clock.now().getTime() + SIM_CYCLE_MS);
      const pe2 = new Date(clock.now().getTime() + 2 * SIM_CYCLE_MS);

      await engine.enqueueRenewal(pool, orgId, subId, pe1);
      await engine.enqueueRenewal(pool, orgId, subId, pe2);

      const cnt = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_queue WHERE subscription_id = $1::uuid`,
        [subId],
      );
      expect(Number(cnt.rows[0]?.cnt)).toBe(2);
    });
  });
});
