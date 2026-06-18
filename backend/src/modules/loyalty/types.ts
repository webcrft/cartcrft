/**
 * loyalty/types.ts — shared types for the native loyalty / points module.
 *
 * All DB-facing IDs are string (uuid text).
 * Points are integers exposed as JS `number` (bigint columns are cast with
 * ::bigint and parsed; balances stay well within Number.MAX_SAFE_INTEGER for
 * any realistic program). Monetary fields (config rates, redeem value) are
 * strings (numeric) to avoid float drift, matching the wallet module.
 */

export type LoyaltyEntryType = "earn" | "redeem" | "adjust" | "expire";

export interface LoyaltyConfig {
  store_id: string;
  points_per_currency_unit: string;
  redeem_value_per_point: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface LoyaltyAccount {
  id: string;
  store_id: string;
  customer_id: string;
  balance_points: number;
  lifetime_points: number;
  created_at: string;
  updated_at: string;
}

export interface LoyaltyLedgerEntry {
  id: string;
  store_id: string;
  customer_id: string;
  account_id: string;
  entry_type: LoyaltyEntryType;
  points: number;
  balance_after: number;
  reason: string | null;
  order_id: string | null;
  created_at: string;
}

export interface UpdateConfigInput {
  points_per_currency_unit?: string | undefined;
  redeem_value_per_point?: string | undefined;
  is_active?: boolean | undefined;
}

/** Result of redeeming points: how many points were spent and their monetary value. */
export interface RedeemResult {
  account: LoyaltyAccount;
  entry: LoyaltyLedgerEntry;
  /** points × redeem_value_per_point, as a 2-dp decimal string (store credit / discount value). */
  value: string;
  /** the currency-neutral monetary value field above is what checkout applies. */
}
