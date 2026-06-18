/**
 * wallet/service.ts — SQL-backed store credits + gift cards service.
 *
 * Store credits:
 *  - UPSERT store_credits row (ON CONFLICT(store_id, customer_id, currency))
 *  - All mutations use SELECT FOR UPDATE inside withTx for row-level locking
 *  - Ledger invariant: UPDATE balance + INSERT transaction in same transaction
 *  - Negative adjust below zero → throws { code: "INSUFFICIENT_CREDIT" }
 *  - txType logic (mirrors Go source):
 *      IssueStoreCredit → always type='issue'
 *      AdjustStoreCredit: delta > 0 → type='issue'; delta < 0 → type='adjust'
 *
 * Gift cards:
 *  - UNIQUE(store_id, code) conflict → throws { code: "DUPLICATE_CODE" }
 *  - initial_value is immutable (never updated)
 *  - balance never goes below 0 (enforced by CHECK + application-level guard)
 *  - SELECT FOR UPDATE on redemptions
 *  - LookupGiftCard: 422 GIFT_CARD_DISABLED / GIFT_CARD_EXPIRED when applicable
 */

import type pg from "pg";
import { getPool, getReadDb, withTx } from "../../db/pool.js";
import { round2 } from "../../lib/money.js";
import type {
  StoreCredit,
  StoreCreditTransaction,
  GiftCard,
  GiftCardTransaction,
  IssueStoreCreditInput,
  AdjustStoreCreditInput,
  CreateGiftCardInput,
} from "./types.js";

// ── Column lists ───────────────────────────────────────────────────────────────

const STORE_CREDIT_COLS = `
  id::text,
  store_id::text,
  customer_id::text,
  balance::text,
  currency,
  expires_at,
  created_at,
  updated_at
`;

const SC_TX_COLS = `
  id::text,
  store_credit_id::text,
  order_id::text,
  amount_delta::text,
  balance_after::text,
  type,
  notes,
  created_by::text,
  created_at
`;

const GIFT_CARD_COLS = `
  id::text,
  store_id::text,
  code,
  initial_value::text,
  balance::text,
  currency,
  issued_to::text,
  issued_by_order_id::text,
  expires_at,
  is_active,
  created_at,
  updated_at
`;

const GC_TX_COLS = `
  id::text,
  gift_card_id::text,
  order_id::text,
  amount_delta::text,
  balance_after::text,
  created_at
`;

// ── Store Credits ──────────────────────────────────────────────────────────────

/**
 * Get a customer's store credit wallet for a given currency.
 * Returns null if no wallet row exists yet.
 */
export async function getCustomerCredits(
  storeId: string,
  customerId: string,
  currency?: string | undefined
): Promise<StoreCredit[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();

  if (currency) {
    const { rows } = await pool.query<StoreCredit>(
      `SELECT ${STORE_CREDIT_COLS}
       FROM store_credits
       WHERE store_id = $1::uuid
         AND customer_id = $2::uuid
         AND currency = $3
       ORDER BY created_at`,
      [storeId, customerId, currency.toUpperCase()]
    );
    return rows;
  }

  const { rows } = await pool.query<StoreCredit>(
    `SELECT ${STORE_CREDIT_COLS}
     FROM store_credits
     WHERE store_id = $1::uuid
       AND customer_id = $2::uuid
     ORDER BY currency`,
    [storeId, customerId]
  );
  return rows;
}

/**
 * Issue store credits to a customer.
 *
 * UPSERTs the store_credits wallet row, locks with FOR UPDATE, then applies
 * the positive delta and records a transaction with type='issue'.
 *
 * Returns the updated StoreCredit and the new transaction.
 */
export async function issueStoreCredit(
  storeId: string,
  input: IssueStoreCreditInput
): Promise<{ credit: StoreCredit; transaction: StoreCreditTransaction }> {
  const currency = input.currency.toUpperCase();
  const amount = parseFloat(input.amount);

  if (amount <= 0) {
    const e = new Error("issue amount must be positive");
    (e as NodeJS.ErrnoException).code = "INVALID_AMOUNT";
    throw e;
  }

  return withTx(async (client) => {
    // UPSERT the wallet row so it exists
    await client.query(
      `INSERT INTO store_credits (store_id, customer_id, currency, balance, expires_at)
       VALUES ($1::uuid, $2::uuid, $3, 0, $4::timestamptz)
       ON CONFLICT (store_id, customer_id, currency) DO UPDATE
         SET updated_at = now()`,
      [storeId, input.customer_id, currency, input.expires_at ?? null]
    );

    // Lock the row
    const { rows: lockRows } = await client.query<{ id: string; balance: string }>(
      `SELECT id::text, balance::text
       FROM store_credits
       WHERE store_id = $1::uuid AND customer_id = $2::uuid AND currency = $3
       FOR UPDATE`,
      [storeId, input.customer_id, currency]
    );
    const locked = lockRows[0];
    if (!locked) throw new Error("issueStoreCredit: wallet row not found after upsert");

    const newBalance = parseFloat(locked.balance) + amount;

    // Update balance
    await client.query(
      `UPDATE store_credits
       SET balance = $1::numeric, updated_at = now()
       WHERE id = $2::uuid`,
      [newBalance.toFixed(2), locked.id]
    );

    // Insert transaction (type = 'issue')
    const { rows: txRows } = await client.query<StoreCreditTransaction>(
      `INSERT INTO store_credit_transactions
         (store_credit_id, order_id, amount_delta, balance_after, type, notes, created_by)
       VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, 'issue', $5, $6::uuid)
       RETURNING ${SC_TX_COLS}`,
      [
        locked.id,
        input.order_id ?? null,
        amount.toFixed(2),
        newBalance.toFixed(2),
        input.notes ?? null,
        input.created_by ?? null,
      ]
    );
    const tx = txRows[0];
    if (!tx) throw new Error("issueStoreCredit: no transaction row returned");

    // Fetch updated credit
    const { rows: creditRows } = await client.query<StoreCredit>(
      `SELECT ${STORE_CREDIT_COLS} FROM store_credits WHERE id = $1::uuid`,
      [locked.id]
    );
    const credit = creditRows[0];
    if (!credit) throw new Error("issueStoreCredit: no credit row returned");

    return { credit, transaction: tx };
  });
}

/**
 * Adjust store credits (positive or negative delta).
 *
 * txType: delta > 0 → 'issue'; delta < 0 → 'adjust' (mirrors Go source).
 * Throws { code: "INSUFFICIENT_CREDIT" } if negative delta would go below 0.
 * Throws { code: "WALLET_NOT_FOUND" } if no wallet row exists for this currency.
 */
export async function adjustStoreCredit(
  storeId: string,
  input: AdjustStoreCreditInput
): Promise<{ credit: StoreCredit; transaction: StoreCreditTransaction }> {
  const currency = input.currency.toUpperCase();
  const delta = parseFloat(input.delta);

  if (delta === 0) {
    const e = new Error("delta must be non-zero");
    (e as NodeJS.ErrnoException).code = "INVALID_AMOUNT";
    throw e;
  }

  // txType mirrors Go: txType := "adjust"; if delta > 0 { txType = "issue" }
  const txType = delta > 0 ? "issue" : "adjust";

  return withTx(async (client) => {
    // Lock the wallet row
    const { rows: lockRows } = await client.query<{ id: string; balance: string }>(
      `SELECT id::text, balance::text
       FROM store_credits
       WHERE store_id = $1::uuid AND customer_id = $2::uuid AND currency = $3
       FOR UPDATE`,
      [storeId, input.customer_id, currency]
    );
    const locked = lockRows[0];
    if (!locked) {
      const e = new Error("no store credit wallet found for this customer and currency");
      (e as NodeJS.ErrnoException).code = "WALLET_NOT_FOUND";
      throw e;
    }

    const currentBalance = parseFloat(locked.balance);
    const newBalance = currentBalance + delta;

    if (newBalance < 0) {
      const e = new Error(
        `insufficient credit: balance ${locked.balance} < |delta| ${Math.abs(delta)}`
      );
      (e as NodeJS.ErrnoException).code = "INSUFFICIENT_CREDIT";
      throw e;
    }

    // Update balance
    await client.query(
      `UPDATE store_credits
       SET balance = $1::numeric, updated_at = now()
       WHERE id = $2::uuid`,
      [newBalance.toFixed(2), locked.id]
    );

    // Insert transaction
    const { rows: txRows } = await client.query<StoreCreditTransaction>(
      `INSERT INTO store_credit_transactions
         (store_credit_id, order_id, amount_delta, balance_after, type, notes, created_by)
       VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5, $6, $7::uuid)
       RETURNING ${SC_TX_COLS}`,
      [
        locked.id,
        input.order_id ?? null,
        delta.toFixed(2),
        newBalance.toFixed(2),
        txType,
        input.notes ?? null,
        input.created_by ?? null,
      ]
    );
    const tx = txRows[0];
    if (!tx) throw new Error("adjustStoreCredit: no transaction row returned");

    // Fetch updated credit
    const { rows: creditRows } = await client.query<StoreCredit>(
      `SELECT ${STORE_CREDIT_COLS} FROM store_credits WHERE id = $1::uuid`,
      [locked.id]
    );
    const credit = creditRows[0];
    if (!credit) throw new Error("adjustStoreCredit: no credit row returned");

    return { credit, transaction: tx };
  });
}

/** List store credit transactions for a customer's wallet (all currencies). */
export async function listStoreCreditTransactions(
  storeId: string,
  customerId: string,
  opts: { limit?: number; offset?: number; currency?: string } = {}
): Promise<StoreCreditTransaction[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const SELECT = `
    SELECT sct.id::text, sct.store_credit_id::text, sct.order_id::text,
           sct.amount_delta::text, sct.balance_after::text,
           sct.type, sct.notes, sct.created_by::text, sct.created_at
    FROM store_credit_transactions sct
    JOIN store_credits sc ON sc.id = sct.store_credit_id
    WHERE sc.store_id = $1::uuid
      AND sc.customer_id = $2::uuid
  `;

  if (opts.currency) {
    const { rows } = await pool.query<StoreCreditTransaction>(
      `${SELECT} AND sc.currency = $3
       ORDER BY sct.created_at DESC
       LIMIT $4 OFFSET $5`,
      [storeId, customerId, opts.currency.toUpperCase(), limit, offset]
    );
    return rows;
  }

  const { rows } = await pool.query<StoreCreditTransaction>(
    `${SELECT}
     ORDER BY sct.created_at DESC
     LIMIT $3 OFFSET $4`,
    [storeId, customerId, limit, offset]
  );
  return rows;
}

// ── Gift Cards ─────────────────────────────────────────────────────────────────

/** List gift cards for a store. */
export async function listGiftCards(
  storeId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<GiftCard[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const { rows } = await pool.query<GiftCard>(
    `SELECT ${GIFT_CARD_COLS}
     FROM gift_cards
     WHERE store_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]
  );
  return rows;
}

/**
 * Create a gift card.
 * initial_value sets both initial_value and balance.
 * Throws { code: "DUPLICATE_CODE" } on unique conflict.
 */
export async function createGiftCard(
  storeId: string,
  input: CreateGiftCardInput
): Promise<string> {
  const pool = getPool();
  const code = input.code.trim().toUpperCase();

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO gift_cards
         (store_id, code, initial_value, balance, currency,
          issued_to, issued_by_order_id, expires_at, is_active)
       VALUES
         ($1::uuid, $2, $3::numeric, $3::numeric, $4,
          $5::uuid, $6::uuid, $7::timestamptz, $8)
       RETURNING id::text`,
      [
        storeId,
        code,
        input.initial_value,
        input.currency.toUpperCase(),
        input.issued_to ?? null,
        input.issued_by_order_id ?? null,
        input.expires_at ?? null,
        input.is_active ?? true,
      ]
    );
    const row = rows[0];
    if (!row) throw new Error("createGiftCard: no row returned");
    return row.id;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      const e = new Error(`gift card code "${input.code}" already exists in this store`);
      (e as NodeJS.ErrnoException).code = "DUPLICATE_CODE";
      throw e;
    }
    throw err;
  }
}

/** Get a gift card by id. Returns null if not found or wrong store. */
export async function getGiftCard(
  storeId: string,
  giftCardId: string
): Promise<GiftCard | null> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<GiftCard>(
    `SELECT ${GIFT_CARD_COLS}
     FROM gift_cards
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [giftCardId, storeId]
  );
  return rows[0] ?? null;
}

/**
 * Lookup a gift card by code (storefront / checkout use).
 *
 * Returns:
 *  - { card } on success
 *  - { error: "GIFT_CARD_DISABLED" } if is_active=false
 *  - { error: "GIFT_CARD_EXPIRED" } if expires_at < now()
 *  - null if not found
 */
export async function lookupGiftCard(
  storeId: string,
  code: string
): Promise<
  | { card: GiftCard }
  | { error: "GIFT_CARD_DISABLED" | "GIFT_CARD_EXPIRED" }
  | null
> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<GiftCard>(
    `SELECT ${GIFT_CARD_COLS}
     FROM gift_cards
     WHERE store_id = $1::uuid AND UPPER(code) = $2`,
    [storeId, code.trim().toUpperCase()]
  );
  const card = rows[0];
  if (!card) return null;

  if (!card.is_active) {
    return { error: "GIFT_CARD_DISABLED" };
  }

  if (card.expires_at !== null && new Date(card.expires_at) < new Date()) {
    return { error: "GIFT_CARD_EXPIRED" };
  }

  return { card };
}

/**
 * Disable (deactivate) a gift card.
 * Returns false if not found or wrong store.
 */
export async function disableGiftCard(
  storeId: string,
  giftCardId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE gift_cards
     SET is_active = false, updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [giftCardId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

/** List transactions for a gift card. */
export async function listGiftCardTransactions(
  storeId: string,
  giftCardId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<GiftCardTransaction[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  // Verify the gift card belongs to the store before returning transactions
  const { rows } = await pool.query<GiftCardTransaction>(
    `SELECT gct.id::text, gct.gift_card_id::text, gct.order_id::text,
            gct.amount_delta::text, gct.balance_after::text, gct.created_at
     FROM gift_card_transactions gct
     JOIN gift_cards gc ON gc.id = gct.gift_card_id
     WHERE gct.gift_card_id = $1::uuid
       AND gc.store_id = $2::uuid
     ORDER BY gct.created_at DESC
     LIMIT $3 OFFSET $4`,
    [giftCardId, storeId, limit, offset]
  );
  return rows;
}

// ── Tender redemption (in-transaction primitives) ────────────────────────────
//
// These helpers DEBIT a wallet inside a CALLER-SUPPLIED transaction (the
// checkout-completion withTx). They take a `pg.PoolClient` (NOT a pool) so the
// debit + ledger write + the caller's order/payment writes all commit or roll
// back together. Each one:
//   1. SELECT ... FOR UPDATE — serialises concurrent redemptions of the same
//      wallet row; a second concurrent completion sees the reduced balance.
//   2. Re-validates the LIVE balance (it may have changed since the customer
//      applied the tender at checkout time).
//   3. Debits min(live_balance, requested) — never more than the balance, never
//      more than requested — and appends the ledger row.
//
// The amount that was actually moved is returned so the caller can reduce the
// remaining amount the payment provider must charge.

/** A gift card that was disabled / expired / had zero balance at redeem time. */
export class TenderError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "TenderError";
  }
}

/**
 * Debit a gift card inside an open transaction.
 *
 * Locks the gift_cards row FOR UPDATE, re-validates active/not-expired, then
 * debits min(balance, requested). Returns the amount actually debited (>= 0)
 * and the post-debit balance. Appends a gift_card_transactions ledger row with
 * a NEGATIVE amount_delta.
 *
 * Throws TenderError when the card cannot be redeemed at all (not found in
 * store, disabled, expired). A zero live balance is NOT an error — it simply
 * debits 0 (the caller treats a 0 debit as "nothing tendered").
 */
export async function redeemGiftCardInTx(
  client: pg.PoolClient,
  storeId: string,
  giftCardId: string,
  requested: number,
  orderId: string | null
): Promise<{ debited: number; balanceAfter: number }> {
  const { rows } = await client.query<{
    balance: string;
    is_active: boolean;
    expires_at: string | null;
    currency: string;
  }>(
    `SELECT balance::text, is_active, expires_at, currency
     FROM gift_cards
     WHERE id = $1::uuid AND store_id = $2::uuid
     FOR UPDATE`,
    [giftCardId, storeId]
  );
  const card = rows[0];
  if (!card) {
    throw new TenderError("gift card not found", "GIFT_CARD_NOT_FOUND");
  }
  if (!card.is_active) {
    throw new TenderError("gift card is disabled", "GIFT_CARD_DISABLED");
  }
  if (card.expires_at !== null && new Date(card.expires_at) < new Date()) {
    throw new TenderError("gift card has expired", "GIFT_CARD_EXPIRED");
  }

  const balance = parseFloat(card.balance);
  const debited = round2(Math.max(0, Math.min(balance, requested)));
  if (debited <= 0) {
    return { debited: 0, balanceAfter: balance };
  }

  const balanceAfter = round2(balance - debited);

  await client.query(
    `UPDATE gift_cards SET balance = $1::numeric, updated_at = now()
     WHERE id = $2::uuid`,
    [balanceAfter.toFixed(2), giftCardId]
  );

  await client.query(
    `INSERT INTO gift_card_transactions
       (gift_card_id, order_id, amount_delta, balance_after)
     VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric)`,
    [giftCardId, orderId, (-debited).toFixed(2), balanceAfter.toFixed(2)]
  );

  return { debited, balanceAfter };
}

/**
 * Debit a store-credit wallet inside an open transaction.
 *
 * Locks the store_credits row FOR UPDATE, then debits min(balance, requested).
 * Returns the amount actually debited (>= 0) and the post-debit balance.
 * Appends a store_credit_transactions ledger row with a NEGATIVE amount_delta
 * and type='redeem'.
 *
 * Throws TenderError("STORE_CREDIT_NOT_FOUND") when the wallet row is absent.
 * A zero balance debits 0 (no error).
 */
export async function redeemStoreCreditInTx(
  client: pg.PoolClient,
  storeCreditId: string,
  storeId: string,
  requested: number,
  orderId: string | null
): Promise<{ debited: number; balanceAfter: number }> {
  const { rows } = await client.query<{ balance: string }>(
    `SELECT balance::text
     FROM store_credits
     WHERE id = $1::uuid AND store_id = $2::uuid
     FOR UPDATE`,
    [storeCreditId, storeId]
  );
  const wallet = rows[0];
  if (!wallet) {
    throw new TenderError("store credit wallet not found", "STORE_CREDIT_NOT_FOUND");
  }

  const balance = parseFloat(wallet.balance);
  const debited = round2(Math.max(0, Math.min(balance, requested)));
  if (debited <= 0) {
    return { debited: 0, balanceAfter: balance };
  }

  const balanceAfter = round2(balance - debited);

  await client.query(
    `UPDATE store_credits SET balance = $1::numeric, updated_at = now()
     WHERE id = $2::uuid`,
    [balanceAfter.toFixed(2), storeCreditId]
  );

  await client.query(
    `INSERT INTO store_credit_transactions
       (store_credit_id, order_id, amount_delta, balance_after, type)
     VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, 'redeem')`,
    [storeCreditId, orderId, (-debited).toFixed(2), balanceAfter.toFixed(2)]
  );

  return { debited, balanceAfter };
}
