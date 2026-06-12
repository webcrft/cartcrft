/**
 * vouchers-wallet.test.ts — Voucher lifecycle and wallet ledger invariants
 *
 * Tests:
 *   VW1.  Voucher percent / fixed_usd / free_months lifecycles
 *   VW2.  Redeem once per org: second redemption throws
 *   VW3.  Expired voucher rejected
 *   VW4.  max_redemptions enforced
 *   VW5.  Wallet top-up minimum R10 (1000 cents) enforced
 *   VW6.  walletCoversOverage path: deducts wallet before card charge
 *   VW7.  Ledger balance_after invariant under sequential deductions
 *   VW8.  Concurrent deductions: wallet balance never goes below zero
 *   VW9.  Voucher not yet valid (valid_from in future) rejected
 *   VW10. Free months voucher: discountUsdCents = invoiceUsdCents × N months
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createBillingCtx,
  makeSimEngine,
  newOrgId,
  type BillingTestCtx,
} from './helpers.js';
import { ManualClock } from '../src/clock.js';
import { validateTopupAmount, MIN_TOPUP_CENTS, walletCoversOverage, calcOverageCost } from '../src/math.js';

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Vouchers and wallet', () => {
  let ctx: BillingTestCtx;
  let clock: ManualClock;

  beforeAll(async () => {
    ctx = await createBillingCtx();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(() => {
    clock = new ManualClock(new Date('2026-04-01T12:00:00Z'));
  });

  // ── VW1. Voucher percent lifecycle ────────────────────────────────────

  describe('VW1 – percent voucher lifecycle', () => {
    it('percent voucher: discountUsdCents = floor(invoiceUsdCents * pct / 100)', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `PCT_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'percent', 20, true)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      const { discountUsdCents, freeMonths } = await engine.applyVoucher(pool, orgId, code, 2900);

      expect(discountUsdCents).toBe(580); // floor(2900 * 20 / 100)
      expect(freeMonths).toBe(0);

      // Redemption row created
      const redemption = await pool.query(
        `SELECT COUNT(*) AS cnt FROM billing_voucher_redemptions
          WHERE organization_id = $1::uuid`,
        [orgId],
      );
      expect(Number(redemption.rows[0]?.cnt)).toBe(1);
    });

    it('percent voucher: discount_applied_usd stored correctly', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `PCT2_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'percent', 15, true)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      const { discountUsdCents } = await engine.applyVoucher(pool, orgId, code, 7900);
      // 15% of 7900 = 1185 cents = $11.85
      expect(discountUsdCents).toBe(1185);

      const redemptionRow = await pool.query<{ discount_applied_usd: string }>(
        `SELECT discount_applied_usd::text FROM billing_voucher_redemptions
          WHERE organization_id = $1::uuid`,
        [orgId],
      );
      expect(Number(redemptionRow.rows[0]?.discount_applied_usd)).toBeCloseTo(1185 / 100, 2);
    });
  });

  // ── VW1b. fixed_usd voucher ───────────────────────────────────────────

  describe('VW1b – fixed_usd voucher', () => {
    it('fixed_usd voucher: discountUsdCents = min(round(value*100), invoiceUsdCents)', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `FIXED_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'fixed_usd', 10.00, true)`, // $10 off
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      const { discountUsdCents } = await engine.applyVoucher(pool, orgId, code, 2900);
      // $10 = 1000 cents; invoice = $29; discount = 1000 (not exceeding invoice)
      expect(discountUsdCents).toBe(1000);
    });

    it('fixed_usd voucher capped at invoice total', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `FIXEDCAP_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'fixed_usd', 500.00, true)`, // $500 off — more than invoice
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      const { discountUsdCents } = await engine.applyVoucher(pool, orgId, code, 2900);
      // Should be capped at invoice total = 2900 cents
      expect(discountUsdCents).toBe(2900);
    });
  });

  // ── VW1c. free_months voucher ─────────────────────────────────────────

  describe('VW10 – free_months voucher', () => {
    it('free_months=2 on $29 plan gives 2×2900 = 5800 cents discount', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `FREEMON_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'free_months', 2, true)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      const { discountUsdCents, freeMonths } = await engine.applyVoucher(pool, orgId, code, 2900);
      expect(freeMonths).toBe(2);
      expect(discountUsdCents).toBe(5800); // 2900 * 2
    });

    it('free_months=1 gives one month free', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `FREEMON1_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'free_months', 1, true)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      const { discountUsdCents, freeMonths } = await engine.applyVoucher(pool, orgId, code, 7900);
      expect(freeMonths).toBe(1);
      expect(discountUsdCents).toBe(7900);
    });
  });

  // ── VW2. Redeem once per org ──────────────────────────────────────────

  describe('VW2 – redeem once per org', () => {
    it('second redemption by same org throws "already redeemed"', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `ONCE_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'percent', 10, true)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      await engine.applyVoucher(pool, orgId, code, 2900);
      await expect(engine.applyVoucher(pool, orgId, code, 2900)).rejects.toThrow('Voucher already redeemed');
    });

    it('different org can redeem the same voucher', async () => {
      const { pool } = ctx;
      const orgId1 = await newOrgId(pool);
      const orgId2 = await newOrgId(pool);
      const code = `TWOORG_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'percent', 10, true)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      await engine.applyVoucher(pool, orgId1, code, 2900);
      // Second org should succeed
      const { discountUsdCents } = await engine.applyVoucher(pool, orgId2, code, 2900);
      expect(discountUsdCents).toBe(290);
    });
  });

  // ── VW3. Expired voucher ──────────────────────────────────────────────

  describe('VW3 – expired voucher is rejected', () => {
    it('voucher with valid_until in the past throws', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `EXPIRED_${randomBytes(6).toString('hex')}`;

      // valid_until = 1 hour BEFORE the clock's current time (2026-04-01T11:00:00Z)
      const expiredAt = new Date(clock.now().getTime() - 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active, valid_until)
         VALUES ($1, 'percent', 20, true, $2)`,
        [code, expiredAt],
      );

      const engine = makeSimEngine(pool, clock);
      await expect(engine.applyVoucher(pool, orgId, code, 2900)).rejects.toThrow('Voucher has expired');
    });

    it('voucher not yet valid (valid_from in future) throws', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `FUTURE_${randomBytes(6).toString('hex')}`;

      // valid_from = 1 day AFTER the clock's current time
      const futureFrom = new Date(clock.now().getTime() + 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active, valid_from)
         VALUES ($1, 'percent', 20, true, $2)`,
        [code, futureFrom],
      );

      const engine = makeSimEngine(pool, clock);
      await expect(engine.applyVoucher(pool, orgId, code, 2900)).rejects.toThrow('Voucher not yet valid');
    });

    it('inactive voucher throws "not found or inactive"', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const code = `INACTIVE_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'percent', 20, false)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      await expect(engine.applyVoucher(pool, orgId, code, 2900)).rejects.toThrow(
        'Voucher not found or inactive',
      );
    });
  });

  // ── VW4. max_redemptions enforced ─────────────────────────────────────

  describe('VW4 – max_redemptions limit is enforced', () => {
    it('voucher with max_redemptions=1 rejects after one redemption', async () => {
      const { pool } = ctx;
      const orgId1 = await newOrgId(pool);
      const orgId2 = await newOrgId(pool);
      const code = `MAXONE_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active, max_redemptions)
         VALUES ($1, 'percent', 10, true, 1)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      await engine.applyVoucher(pool, orgId1, code, 2900); // First org uses it

      // Second org → max reached
      await expect(engine.applyVoucher(pool, orgId2, code, 2900)).rejects.toThrow(
        'Voucher redemption limit reached',
      );
    });

    it('voucher with max_redemptions=3 allows up to 3 distinct org redemptions', async () => {
      const { pool } = ctx;
      const code = `MAX3_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active, max_redemptions)
         VALUES ($1, 'percent', 5, true, 3)`,
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      for (let i = 0; i < 3; i++) {
        const orgId = await newOrgId(pool);
        const result = await engine.applyVoucher(pool, orgId, code, 2900);
        expect(result.discountUsdCents).toBe(145); // 5% of 2900
      }

      // 4th attempt should fail
      const orgId4 = await newOrgId(pool);
      await expect(engine.applyVoucher(pool, orgId4, code, 2900)).rejects.toThrow(
        'Voucher redemption limit reached',
      );
    });

    it('voucher with max_redemptions=null allows unlimited redemptions', async () => {
      const { pool } = ctx;
      const code = `UNLIMITED_${randomBytes(6).toString('hex')}`;

      await pool.query(
        `INSERT INTO billing_vouchers (code, discount_type, discount_value, is_active)
         VALUES ($1, 'percent', 5, true)`, // max_redemptions defaults to null
        [code],
      );

      const engine = makeSimEngine(pool, clock);
      // Redeem 5 times from different orgs — all should succeed
      for (let i = 0; i < 5; i++) {
        const orgId = await newOrgId(pool);
        await expect(engine.applyVoucher(pool, orgId, code, 2900)).resolves.toBeTruthy();
      }
    });
  });

  // ── VW5. Wallet top-up minimum ─────────────────────────────────────────

  describe('VW5 – wallet top-up minimum R10 (1000 cents)', () => {
    it('validateTopupAmount returns false below minimum', () => {
      expect(validateTopupAmount(0)).toBe(false);
      expect(validateTopupAmount(999)).toBe(false);
      expect(validateTopupAmount(-1)).toBe(false);
    });

    it('validateTopupAmount returns true at or above minimum', () => {
      expect(validateTopupAmount(MIN_TOPUP_CENTS)).toBe(true); // exactly 1000
      expect(validateTopupAmount(1001)).toBe(true);
      expect(validateTopupAmount(50000)).toBe(true);
    });

    it('wallet credit with 1000 cents creates ledger entry', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);

      // Credit R10 (minimum valid amount)
      const newBalance = await engine.creditWallet(pool, orgId, MIN_TOPUP_CENTS, 'Top-up R10');
      expect(newBalance).toBe(MIN_TOPUP_CENTS);

      // Ledger entry exists
      const ledger = await pool.query<{ entry_type: string; amount_cents: number; balance_after_cents: number }>(
        `SELECT entry_type, amount_cents, balance_after_cents
           FROM billing_wallet_ledger
          WHERE organization_id = $1::uuid
          ORDER BY created_at`,
        [orgId],
      );
      expect(ledger.rows.length).toBe(1);
      expect(ledger.rows[0]?.entry_type).toBe('credit');
      expect(ledger.rows[0]?.amount_cents).toBe(MIN_TOPUP_CENTS);
      expect(ledger.rows[0]?.balance_after_cents).toBe(MIN_TOPUP_CENTS);
    });
  });

  // ── VW6. walletCoversOverage path ─────────────────────────────────────

  describe('VW6 – walletCoversOverage: wallet deducted when sufficient', () => {
    it('walletCoversOverage returns true when balance >= overage cost', () => {
      // 100 overUnits at R1/1000 = 0.1 cents → ceil → 1 cent
      expect(walletCoversOverage(100, 100, 1)).toBe(true);
      expect(walletCoversOverage(1000, 500, 100)).toBe(true); // cost=50
    });

    it('walletCoversOverage returns false when balance < overage cost', () => {
      expect(walletCoversOverage(0, 100, 100)).toBe(false);
      expect(walletCoversOverage(10, 200, 1000)).toBe(false); // cost=200
    });

    it('wallet debit succeeds when balance is sufficient', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);

      await engine.creditWallet(pool, orgId, 5000, 'Initial credit');
      const { newBalance, ok } = await engine.debitWallet(pool, orgId, 2000, 'Overage charge');

      expect(ok).toBe(true);
      expect(newBalance).toBe(3000);
    });

    it('wallet debit fails when balance is insufficient', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);

      await engine.creditWallet(pool, orgId, 1000, 'Initial credit');
      const { newBalance, ok } = await engine.debitWallet(pool, orgId, 5000, 'Too large');

      expect(ok).toBe(false);
      // newBalance should be 0 (returned by implementation when wallet guard fails)
      expect(newBalance).toBe(0);

      // Wallet still has original balance
      const wallet = await engine.getOrCreateWallet(pool, orgId);
      expect(wallet.balanceCents).toBe(1000);
    });
  });

  // ── VW7. Ledger balance_after invariant ───────────────────────────────

  describe('VW7 – ledger balance_after is monotonic with credits and debits', () => {
    it('each ledger entry has correct balance_after reflecting running total', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);

      // Credit 3000
      await engine.creditWallet(pool, orgId, 3000, 'Credit 1');
      // Credit 2000
      await engine.creditWallet(pool, orgId, 2000, 'Credit 2');
      // Debit 1000
      await engine.debitWallet(pool, orgId, 1000, 'Debit 1');
      // Debit 500
      await engine.debitWallet(pool, orgId, 500, 'Debit 2');

      const ledger = await pool.query<{
        entry_type: string;
        amount_cents: number;
        balance_after_cents: number;
      }>(
        `SELECT entry_type, amount_cents, balance_after_cents
           FROM billing_wallet_ledger
          WHERE organization_id = $1::uuid
          ORDER BY created_at ASC`,
        [orgId],
      );

      expect(ledger.rows.length).toBe(4);
      expect(ledger.rows[0]?.balance_after_cents).toBe(3000); // after credit 3000
      expect(ledger.rows[1]?.balance_after_cents).toBe(5000); // after credit 2000
      expect(ledger.rows[2]?.balance_after_cents).toBe(4000); // after debit 1000
      expect(ledger.rows[3]?.balance_after_cents).toBe(3500); // after debit 500

      // Final wallet balance matches last ledger entry
      const wallet = await engine.getOrCreateWallet(pool, orgId);
      expect(wallet.balanceCents).toBe(3500);
    });

    it('failed debit (insufficient funds) creates no ledger entry', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);

      await engine.creditWallet(pool, orgId, 500, 'Initial');
      const { ok } = await engine.debitWallet(pool, orgId, 1000, 'Insufficient');
      expect(ok).toBe(false);

      const ledger = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM billing_wallet_ledger
          WHERE organization_id = $1::uuid`,
        [orgId],
      );
      // Only the initial credit, not the failed debit
      expect(Number(ledger.rows[0]?.cnt)).toBe(1);
    });
  });

  // ── VW8. Concurrent deductions safety ────────────────────────────────

  describe('VW8 – concurrent wallet debits never produce negative balance', () => {
    it('parallel debits: sum of successful debits never exceeds initial balance', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);

      // Fund wallet with 5000 cents
      await engine.creditWallet(pool, orgId, 5000, 'Funded');

      // Fire 10 concurrent debit attempts of 1000 each (total would be 10000 > 5000)
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          engine.debitWallet(pool, orgId, 1000, 'Concurrent debit'),
        ),
      );

      const successCount = results.filter((r) => r.ok).length;
      const failCount = results.filter((r) => !r.ok).length;

      // At most 5 should succeed (balance = 5000, each debit = 1000)
      expect(successCount).toBeLessThanOrEqual(5);
      // At least some should fail
      expect(failCount).toBeGreaterThanOrEqual(5);

      // Final wallet balance must be >= 0
      const wallet = await engine.getOrCreateWallet(pool, orgId);
      expect(wallet.balanceCents).toBeGreaterThanOrEqual(0);

      // Sum of successful deductions + remaining balance = initial 5000
      const totalDebited = successCount * 1000;
      expect(wallet.balanceCents + totalDebited).toBe(5000);
    });

    it('ledger entries are consistent: all balance_after >= 0', async () => {
      const { pool } = ctx;
      const orgId = await newOrgId(pool);
      const engine = makeSimEngine(pool, clock);

      await engine.creditWallet(pool, orgId, 3000, 'Funded');

      await Promise.all(
        Array.from({ length: 6 }, () =>
          engine.debitWallet(pool, orgId, 1000, 'Concurrent debit'),
        ),
      );

      const ledger = await pool.query<{ balance_after_cents: number; entry_type: string }>(
        `SELECT balance_after_cents, entry_type
           FROM billing_wallet_ledger
          WHERE organization_id = $1::uuid
          ORDER BY created_at ASC`,
        [orgId],
      );

      // Every ledger entry must have non-negative balance_after
      for (const row of ledger.rows) {
        if (row.entry_type === 'debit') {
          expect(row.balance_after_cents).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });
});
