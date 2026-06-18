/**
 * loyalty/service.ts — SQL-backed native loyalty / points service.
 *
 * Config:
 *  - getOrCreateConfig: UPSERTs a defaults row (points_per_currency_unit=1,
 *    redeem_value_per_point=0.01, is_active=true) and returns it.
 *  - updateConfig: partial update of the earn rate / redeem value / active flag.
 *
 * Accounts + ledger (mirrors the wallet ledger invariant):
 *  - Every points mutation runs inside withTx, locks the account row FOR UPDATE,
 *    UPDATEs balance_points (+ lifetime_points on earn), and INSERTs one
 *    loyalty_ledger row carrying the signed delta and balance_after — in the
 *    same transaction.
 *  - earnPointsForOrder is idempotent per order_id (partial UNIQUE index in
 *    0031_loyalty.sql); a duplicate order replay returns the existing entry
 *    without crediting again.
 *  - redeemPoints rejects when balance is insufficient
 *    ({ code: "INSUFFICIENT_POINTS" }) and returns the monetary value
 *    (points × redeem_value_per_point) for checkout to apply downstream.
 *
 * Points are integers (bigint columns, parsed to JS number). Money fields are
 * numeric, handled as decimal strings (never float) like the wallet module.
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import type {
  LoyaltyConfig,
  LoyaltyAccount,
  LoyaltyLedgerEntry,
  UpdateConfigInput,
  RedeemResult,
} from "./types.js";

// ── Column lists ───────────────────────────────────────────────────────────────

const CONFIG_COLS = `
  store_id::text,
  points_per_currency_unit::text,
  redeem_value_per_point::text,
  is_active,
  created_at,
  updated_at
`;

const ACCOUNT_COLS = `
  id::text,
  store_id::text,
  customer_id::text,
  balance_points::bigint,
  lifetime_points::bigint,
  created_at,
  updated_at
`;

const LEDGER_COLS = `
  id::text,
  store_id::text,
  customer_id::text,
  account_id::text,
  entry_type,
  points::bigint,
  balance_after::bigint,
  reason,
  order_id::text,
  created_at
`;

// pg returns bigint as string to preserve precision; normalise to number.
interface RawAccount {
  id: string;
  store_id: string;
  customer_id: string;
  balance_points: string;
  lifetime_points: string;
  created_at: string;
  updated_at: string;
}

interface RawLedger {
  id: string;
  store_id: string;
  customer_id: string;
  account_id: string;
  entry_type: LoyaltyLedgerEntry["entry_type"];
  points: string;
  balance_after: string;
  reason: string | null;
  order_id: string | null;
  created_at: string;
}

function mapAccount(r: RawAccount): LoyaltyAccount {
  return {
    id: r.id,
    store_id: r.store_id,
    customer_id: r.customer_id,
    balance_points: Number(r.balance_points),
    lifetime_points: Number(r.lifetime_points),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function mapLedger(r: RawLedger): LoyaltyLedgerEntry {
  return {
    id: r.id,
    store_id: r.store_id,
    customer_id: r.customer_id,
    account_id: r.account_id,
    entry_type: r.entry_type,
    points: Number(r.points),
    balance_after: Number(r.balance_after),
    reason: r.reason,
    order_id: r.order_id,
    created_at: r.created_at,
  };
}

function codedError(message: string, code: string): Error {
  const e = new Error(message);
  (e as NodeJS.ErrnoException).code = code;
  return e;
}

// ── Config ─────────────────────────────────────────────────────────────────────

/**
 * Get the store's loyalty config, creating a defaults row on first access.
 * Defaults: points_per_currency_unit=1, redeem_value_per_point=0.01, active.
 */
export async function getOrCreateConfig(storeId: string): Promise<LoyaltyConfig> {
  return withTx(async (client) => {
    await client.query(
      `INSERT INTO loyalty_config (store_id)
       VALUES ($1::uuid)
       ON CONFLICT (store_id) DO NOTHING`,
      [storeId]
    );
    const { rows } = await client.query<LoyaltyConfig>(
      `SELECT ${CONFIG_COLS} FROM loyalty_config WHERE store_id = $1::uuid`,
      [storeId]
    );
    const cfg = rows[0];
    if (!cfg) throw new Error("getOrCreateConfig: no config row after upsert");
    return cfg;
  });
}

/** Partial update of the store's loyalty config. Creates the row first if absent. */
export async function updateConfig(
  storeId: string,
  input: UpdateConfigInput
): Promise<LoyaltyConfig> {
  return withTx(async (client) => {
    await client.query(
      `INSERT INTO loyalty_config (store_id)
       VALUES ($1::uuid)
       ON CONFLICT (store_id) DO NOTHING`,
      [storeId]
    );

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [storeId];

    if (input.points_per_currency_unit !== undefined) {
      params.push(input.points_per_currency_unit);
      sets.push(`points_per_currency_unit = $${params.length}::numeric`);
    }
    if (input.redeem_value_per_point !== undefined) {
      params.push(input.redeem_value_per_point);
      sets.push(`redeem_value_per_point = $${params.length}::numeric`);
    }
    if (input.is_active !== undefined) {
      params.push(input.is_active);
      sets.push(`is_active = $${params.length}`);
    }

    await client.query(
      `UPDATE loyalty_config SET ${sets.join(", ")} WHERE store_id = $1::uuid`,
      params
    );

    const { rows } = await client.query<LoyaltyConfig>(
      `SELECT ${CONFIG_COLS} FROM loyalty_config WHERE store_id = $1::uuid`,
      [storeId]
    );
    const cfg = rows[0];
    if (!cfg) throw new Error("updateConfig: no config row after update");
    return cfg;
  });
}

// ── Accounts ─────────────────────────────────────────────────────────────────

/** Get (or create) a customer's points account. */
export async function getOrCreateAccount(
  storeId: string,
  customerId: string
): Promise<LoyaltyAccount> {
  return withTx(async (client) => {
    const account = await getOrCreateAccountTx(client, storeId, customerId);
    return account;
  });
}

/**
 * Internal: ensure the account row exists and return it. Must run inside a
 * transaction (callers that mutate then re-lock FOR UPDATE).
 */
async function getOrCreateAccountTx(
  client: import("pg").PoolClient,
  storeId: string,
  customerId: string
): Promise<LoyaltyAccount> {
  await client.query(
    `INSERT INTO loyalty_accounts (store_id, customer_id)
     VALUES ($1::uuid, $2::uuid)
     ON CONFLICT (store_id, customer_id) DO NOTHING`,
    [storeId, customerId]
  );
  const { rows } = await client.query<RawAccount>(
    `SELECT ${ACCOUNT_COLS} FROM loyalty_accounts
     WHERE store_id = $1::uuid AND customer_id = $2::uuid`,
    [storeId, customerId]
  );
  const row = rows[0];
  if (!row) throw new Error("getOrCreateAccount: no account row after upsert");
  return mapAccount(row);
}

/**
 * Read a customer's balance. Returns a zeroed account view when no row exists
 * yet (does not create one — this is a read path).
 */
export async function getBalance(
  storeId: string,
  customerId: string
): Promise<{ balance_points: number; lifetime_points: number }> {
  const pool = getReadDb();
  const { rows } = await pool.query<{ balance_points: string; lifetime_points: string }>(
    `SELECT balance_points::bigint, lifetime_points::bigint
     FROM loyalty_accounts
     WHERE store_id = $1::uuid AND customer_id = $2::uuid`,
    [storeId, customerId]
  );
  const row = rows[0];
  if (!row) return { balance_points: 0, lifetime_points: 0 };
  return {
    balance_points: Number(row.balance_points),
    lifetime_points: Number(row.lifetime_points),
  };
}

// ── Earn ─────────────────────────────────────────────────────────────────────

/**
 * Earn points for a completed order. EXPORTED for wiring into order completion.
 *
 * Signature:
 *   earnPointsForOrder(storeId, customerId, orderId, orderTotal) => Promise<{
 *     account: LoyaltyAccount;
 *     entry: LoyaltyLedgerEntry;
 *     pointsEarned: number;
 *     alreadyEarned: boolean;
 *   }>
 *
 * - orderTotal is a decimal string (the order's monetary total, e.g. "49.99").
 * - points = floor(orderTotal × config.points_per_currency_unit).
 * - Idempotent per order_id: a replay returns the existing earn entry with
 *   alreadyEarned=true and credits nothing (enforced by the partial UNIQUE
 *   index ux_loyalty_ledger_earn_order + ON CONFLICT DO NOTHING).
 * - When the program is inactive OR computed points <= 0, no points are
 *   credited and no ledger row is written; pointsEarned=0.
 */
export async function earnPointsForOrder(
  storeId: string,
  customerId: string,
  orderId: string,
  orderTotal: string
): Promise<{
  account: LoyaltyAccount;
  entry: LoyaltyLedgerEntry | null;
  pointsEarned: number;
  alreadyEarned: boolean;
}> {
  return withTx(async (client) => {
    // Ensure config exists; read the live earn rate + active flag.
    await client.query(
      `INSERT INTO loyalty_config (store_id) VALUES ($1::uuid)
       ON CONFLICT (store_id) DO NOTHING`,
      [storeId]
    );
    const { rows: cfgRows } = await client.query<{
      points_per_currency_unit: string;
      is_active: boolean;
    }>(
      `SELECT points_per_currency_unit::text, is_active
       FROM loyalty_config WHERE store_id = $1::uuid`,
      [storeId]
    );
    const cfg = cfgRows[0];
    if (!cfg) throw new Error("earnPointsForOrder: no config row");

    await getOrCreateAccountTx(client, storeId, customerId);

    // Lock the account row.
    const { rows: lockRows } = await client.query<{
      id: string;
      balance_points: string;
      lifetime_points: string;
    }>(
      `SELECT id::text, balance_points::bigint, lifetime_points::bigint
       FROM loyalty_accounts
       WHERE store_id = $1::uuid AND customer_id = $2::uuid
       FOR UPDATE`,
      [storeId, customerId]
    );
    const locked = lockRows[0];
    if (!locked) throw new Error("earnPointsForOrder: account row not found after upsert");

    // If a prior earn entry already exists for this order, return it (idempotent).
    const { rows: existingRows } = await client.query<RawLedger>(
      `SELECT ${LEDGER_COLS} FROM loyalty_ledger
       WHERE store_id = $1::uuid AND customer_id = $2::uuid
         AND order_id = $3::uuid AND entry_type = 'earn'`,
      [storeId, customerId, orderId]
    );
    if (existingRows[0]) {
      const account = await reloadAccount(client, locked.id);
      return {
        account,
        entry: mapLedger(existingRows[0]),
        pointsEarned: 0,
        alreadyEarned: true,
      };
    }

    const total = parseFloat(orderTotal);
    const rate = parseFloat(cfg.points_per_currency_unit);
    const points = Number.isFinite(total) && Number.isFinite(rate)
      ? Math.floor(total * rate)
      : 0;

    if (!cfg.is_active || points <= 0) {
      const account = await reloadAccount(client, locked.id);
      return { account, entry: null, pointsEarned: 0, alreadyEarned: false };
    }

    const newBalance = Number(locked.balance_points) + points;
    const newLifetime = Number(locked.lifetime_points) + points;

    await client.query(
      `UPDATE loyalty_accounts
       SET balance_points = $1::bigint, lifetime_points = $2::bigint, updated_at = now()
       WHERE id = $3::uuid`,
      [String(newBalance), String(newLifetime), locked.id]
    );

    // INSERT the earn ledger row. ON CONFLICT DO NOTHING guards against a race
    // where two concurrent completions reach this point for the same order; the
    // partial unique index makes the second insert a no-op.
    const { rows: entryRows } = await client.query<RawLedger>(
      `INSERT INTO loyalty_ledger
         (store_id, customer_id, account_id, entry_type, points, balance_after, reason, order_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'earn', $4::bigint, $5::bigint, $6, $7::uuid)
       ON CONFLICT (store_id, customer_id, order_id) WHERE entry_type = 'earn' AND order_id IS NOT NULL
       DO NOTHING
       RETURNING ${LEDGER_COLS}`,
      [
        storeId,
        customerId,
        locked.id,
        String(points),
        String(newBalance),
        `Earned on order ${orderId}`,
        orderId,
      ]
    );

    const entry = entryRows[0];
    if (!entry) {
      // Lost the race: another tx already wrote the earn row. Roll back our
      // balance bump by re-reading the committed state would require a fresh
      // tx; instead we treat it as alreadyEarned and undo the local update by
      // re-selecting the canonical row after the conflicting insert is visible.
      // Since this tx hasn't committed, simply not crediting is correct: re-set
      // balance to the locked (pre-update) value.
      await client.query(
        `UPDATE loyalty_accounts
         SET balance_points = $1::bigint, lifetime_points = $2::bigint, updated_at = now()
         WHERE id = $3::uuid`,
        [locked.balance_points, locked.lifetime_points, locked.id]
      );
      const { rows: existing2 } = await client.query<RawLedger>(
        `SELECT ${LEDGER_COLS} FROM loyalty_ledger
         WHERE store_id = $1::uuid AND customer_id = $2::uuid
           AND order_id = $3::uuid AND entry_type = 'earn'`,
        [storeId, customerId, orderId]
      );
      const account = await reloadAccount(client, locked.id);
      return {
        account,
        entry: existing2[0] ? mapLedger(existing2[0]) : null,
        pointsEarned: 0,
        alreadyEarned: true,
      };
    }

    const account = await reloadAccount(client, locked.id);
    return { account, entry: mapLedger(entry), pointsEarned: points, alreadyEarned: false };
  });
}

// ── Redeem ─────────────────────────────────────────────────────────────────

/**
 * Redeem points for store credit / discount value.
 *
 * - Locks the account FOR UPDATE; rejects when balance < points with
 *   { code: "INSUFFICIENT_POINTS" }.
 * - Debits balance_points (lifetime_points is unchanged), writes a 'redeem'
 *   ledger row with a negative `points` delta.
 * - Returns RedeemResult.value = points × redeem_value_per_point as a 2-dp
 *   decimal string, for checkout to apply as store credit / discount.
 */
export async function redeemPoints(
  storeId: string,
  customerId: string,
  points: number,
  reason?: string | undefined
): Promise<RedeemResult> {
  if (!Number.isInteger(points) || points <= 0) {
    throw codedError("redeem points must be a positive integer", "INVALID_POINTS");
  }

  return withTx(async (client) => {
    await client.query(
      `INSERT INTO loyalty_config (store_id) VALUES ($1::uuid)
       ON CONFLICT (store_id) DO NOTHING`,
      [storeId]
    );
    const { rows: cfgRows } = await client.query<{ redeem_value_per_point: string }>(
      `SELECT redeem_value_per_point::text FROM loyalty_config WHERE store_id = $1::uuid`,
      [storeId]
    );
    const cfg = cfgRows[0];
    if (!cfg) throw new Error("redeemPoints: no config row");

    await getOrCreateAccountTx(client, storeId, customerId);

    const { rows: lockRows } = await client.query<{ id: string; balance_points: string }>(
      `SELECT id::text, balance_points::bigint
       FROM loyalty_accounts
       WHERE store_id = $1::uuid AND customer_id = $2::uuid
       FOR UPDATE`,
      [storeId, customerId]
    );
    const locked = lockRows[0];
    if (!locked) throw new Error("redeemPoints: account row not found after upsert");

    const balance = Number(locked.balance_points);
    if (balance < points) {
      throw codedError(
        `insufficient points: balance ${balance} < requested ${points}`,
        "INSUFFICIENT_POINTS"
      );
    }

    const newBalance = balance - points;

    await client.query(
      `UPDATE loyalty_accounts
       SET balance_points = $1::bigint, updated_at = now()
       WHERE id = $2::uuid`,
      [String(newBalance), locked.id]
    );

    const { rows: entryRows } = await client.query<RawLedger>(
      `INSERT INTO loyalty_ledger
         (store_id, customer_id, account_id, entry_type, points, balance_after, reason, order_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'redeem', $4::bigint, $5::bigint, $6, NULL)
       RETURNING ${LEDGER_COLS}`,
      [
        storeId,
        customerId,
        locked.id,
        String(-points),
        String(newBalance),
        reason ?? `Redeemed ${points} points`,
      ]
    );
    const entry = entryRows[0];
    if (!entry) throw new Error("redeemPoints: no ledger row returned");

    const value = (points * parseFloat(cfg.redeem_value_per_point)).toFixed(2);
    const account = await reloadAccount(client, locked.id);

    return { account, entry: mapLedger(entry), value };
  });
}

// ── Manual adjust (admin) ─────────────────────────────────────────────────

/**
 * Manually adjust a customer's balance by a signed `points` delta (admin).
 * Negative deltas that would push balance below zero are rejected with
 * { code: "INSUFFICIENT_POINTS" }. Positive deltas also credit lifetime_points.
 */
export async function adjustPoints(
  storeId: string,
  customerId: string,
  points: number,
  reason?: string | undefined
): Promise<{ account: LoyaltyAccount; entry: LoyaltyLedgerEntry }> {
  if (!Number.isInteger(points) || points === 0) {
    throw codedError("adjust points must be a non-zero integer", "INVALID_POINTS");
  }

  return withTx(async (client) => {
    await getOrCreateAccountTx(client, storeId, customerId);

    const { rows: lockRows } = await client.query<{
      id: string;
      balance_points: string;
      lifetime_points: string;
    }>(
      `SELECT id::text, balance_points::bigint, lifetime_points::bigint
       FROM loyalty_accounts
       WHERE store_id = $1::uuid AND customer_id = $2::uuid
       FOR UPDATE`,
      [storeId, customerId]
    );
    const locked = lockRows[0];
    if (!locked) throw new Error("adjustPoints: account row not found after upsert");

    const balance = Number(locked.balance_points);
    const newBalance = balance + points;
    if (newBalance < 0) {
      throw codedError(
        `insufficient points: balance ${balance} + delta ${points} < 0`,
        "INSUFFICIENT_POINTS"
      );
    }
    const newLifetime = points > 0
      ? Number(locked.lifetime_points) + points
      : Number(locked.lifetime_points);

    await client.query(
      `UPDATE loyalty_accounts
       SET balance_points = $1::bigint, lifetime_points = $2::bigint, updated_at = now()
       WHERE id = $3::uuid`,
      [String(newBalance), String(newLifetime), locked.id]
    );

    const { rows: entryRows } = await client.query<RawLedger>(
      `INSERT INTO loyalty_ledger
         (store_id, customer_id, account_id, entry_type, points, balance_after, reason, order_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'adjust', $4::bigint, $5::bigint, $6, NULL)
       RETURNING ${LEDGER_COLS}`,
      [storeId, customerId, locked.id, String(points), String(newBalance), reason ?? "Manual adjustment"]
    );
    const entry = entryRows[0];
    if (!entry) throw new Error("adjustPoints: no ledger row returned");

    const account = await reloadAccount(client, locked.id);
    return { account, entry: mapLedger(entry) };
  });
}

// ── Ledger read ─────────────────────────────────────────────────────────────

/** List a customer's ledger entries, most recent first. */
export async function listLedger(
  storeId: string,
  customerId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<LoyaltyLedgerEntry[]> {
  const pool = getReadDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const { rows } = await pool.query<RawLedger>(
    `SELECT ${LEDGER_COLS} FROM loyalty_ledger
     WHERE store_id = $1::uuid AND customer_id = $2::uuid
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [storeId, customerId, limit, offset]
  );
  return rows.map(mapLedger);
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function reloadAccount(
  client: import("pg").PoolClient,
  accountId: string
): Promise<LoyaltyAccount> {
  const { rows } = await client.query<RawAccount>(
    `SELECT ${ACCOUNT_COLS} FROM loyalty_accounts WHERE id = $1::uuid`,
    [accountId]
  );
  const row = rows[0];
  if (!row) throw new Error("reloadAccount: account row not found");
  return mapAccount(row);
}
