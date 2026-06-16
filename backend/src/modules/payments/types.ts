/**
 * payments/types.ts — TypeScript types for the payments module.
 */

// ── Payment ────────────────────────────────────────────────────────────────────

export interface Payment {
  id: string;
  order_id: string;
  provider_id: string | null;
  amount: string;
  currency: string;
  status: "pending" | "authorized" | "captured" | "failed" | "voided" | "refunded" | "partially_refunded";
  provider_reference: string | null;
  provider_session_id: string | null;
  captured_at: string | null;
  is_test: boolean;
  mode: "live" | "dev";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreatePaymentInput {
  amount: string;
  currency?: string | undefined;
  provider_id?: string | undefined;
  provider_reference?: string | undefined;
  mode?: "live" | "dev" | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface CreatePaymentResult {
  id: string;
  mode: string;
  is_test: boolean;
}

// ── Refund ─────────────────────────────────────────────────────────────────────

export interface Refund {
  id: string;
  payment_id: string;
  order_id: string;
  amount: string;
  reason: string | null;
  notes: string | null;
  status: string;
  provider_reference: string | null;
  restock_inventory: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRefundInput {
  amount: string;
  reason?: string | undefined;
  notes?: string | undefined;
  restock?: boolean | undefined;
  provider_reference?: string | undefined;
  idempotency_key?: string | undefined;
}

export interface CreateRefundResult {
  id: string;
  /**
   * Local refund status after attempting the provider refund.
   *  - "pending":    local bookkeeping refund (no provider to call), or webhook
   *                  reconciliation insert — unchanged legacy behavior.
   *  - "processing": provider accepted the refund but it is still in flight.
   *  - "succeeded":  provider confirmed the refund.
   *  - "failed":     provider rejected the refund (row persisted for audit).
   */
  status?: "pending" | "processing" | "succeeded" | "failed" | undefined;
  /** Provider error message when status === "failed". */
  provider_error?: string | undefined;
}

// ── Payment provider (store-level) ─────────────────────────────────────────────

export interface PaymentProvider {
  id: string;
  store_id: string;
  name: string;
  type: string;
  slug: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  config: Record<string, unknown>;
  is_active: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface UpsertPaymentProviderInput {
  slug: string;
  name?: string | undefined;
  type?: string | undefined;
  config: Record<string, unknown>;
  is_active?: boolean | undefined;
  webhook_secret?: string | undefined;
}

// ── Payment gateway (platform-level) ──────────────────────────────────────────

export interface PaymentGatewayInstance {
  id: string;
  name: string;
  type: "paystack" | "stripe" | "razorpay" | "xendit" | "flutterwave";
  is_active: boolean;
  has_dev_credentials: boolean;
  created_at: string;
  updated_at: string;
}

export interface UpsertGatewayInput {
  name: string;
  type: "paystack" | "stripe" | "razorpay" | "xendit" | "flutterwave";
  secret_key_enc: string;
  public_key_enc?: string | undefined;
  webhook_secret_enc?: string | undefined;
  webhook_secret_secondary_enc?: string | undefined;
  is_active?: boolean | undefined;
}

export interface SetGatewayDevCredentialsInput {
  dev_secret_key_enc: string;
  dev_public_key_enc?: string | undefined;
}
