/**
 * wallet/types.ts — shared types for the wallet module.
 *
 * Covers store credits and gift cards.
 * All DB-facing types use string IDs (uuid text).
 * Money fields are string (numeric) in API payloads; never float.
 */

export type StoreCreditTransactionType =
  | "earn"
  | "redeem"
  | "expire"
  | "adjust"
  | "issue"
  | "return";

export interface StoreCredit {
  id: string;
  store_id: string;
  customer_id: string;
  balance: string;
  currency: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoreCreditTransaction {
  id: string;
  store_credit_id: string;
  order_id: string | null;
  amount_delta: string;
  balance_after: string;
  type: StoreCreditTransactionType;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

export interface GiftCard {
  id: string;
  store_id: string;
  code: string;
  initial_value: string;
  balance: string;
  currency: string;
  issued_to: string | null;
  issued_by_order_id: string | null;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface GiftCardTransaction {
  id: string;
  gift_card_id: string;
  order_id: string | null;
  amount_delta: string;
  balance_after: string;
  created_at: string;
}

export interface IssueStoreCreditInput {
  customer_id: string;
  currency: string;
  amount: string;
  notes?: string | undefined;
  created_by?: string | null | undefined;
  expires_at?: string | null | undefined;
  order_id?: string | null | undefined;
}

export interface AdjustStoreCreditInput {
  customer_id: string;
  currency: string;
  delta: string;
  notes?: string | undefined;
  created_by?: string | null | undefined;
  order_id?: string | null | undefined;
}

export interface CreateGiftCardInput {
  code: string;
  initial_value: string;
  currency: string;
  issued_to?: string | null | undefined;
  issued_by_order_id?: string | null | undefined;
  expires_at?: string | null | undefined;
  is_active?: boolean | undefined;
}
