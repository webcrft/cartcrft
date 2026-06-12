/**
 * orders/types.ts — TypeScript types for the orders module.
 *
 * Money amounts are string in API payloads (numeric(15,2) from PG comes back as string).
 * All IDs are uuid text strings.
 */

// ── Order ──────────────────────────────────────────────────────────────────────

export interface Order {
  id: string;
  store_id: string;
  customer_id: string | null;
  company_id: string | null;
  checkout_id: string | null;
  order_number: string;
  status: "open" | "closed" | "cancelled";
  financial_status:
    | "pending"
    | "authorized"
    | "partially_paid"
    | "paid"
    | "partially_refunded"
    | "refunded"
    | "voided";
  fulfillment_status:
    | "unfulfilled"
    | "partial"
    | "fulfilled"
    | "returned"
    | "restocked";
  currency: string;
  subtotal: string;
  shipping_total: string;
  tax_total: string;
  discount_total: string;
  total: string;
  total_refunded: string;
  shipping_address: Record<string, unknown>;
  billing_address: Record<string, unknown>;
  po_number: string | null;
  payment_terms_days: number;
  due_date: string | null;
  source_name: string | null;
  notes: string | null;
  tags: string[];
  cancelled_at: string | null;
  cancel_reason: string | null;
  is_test: boolean;
  mode: "live" | "dev";
  created_at: string;
  updated_at: string;
}

export interface OrderLine {
  id: string;
  order_id: string;
  variant_id: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  quantity_fulfilled: number;
  quantity_returned: number;
  price: string;
  total: string;
  discount_total: string;
  tax_total: string;
  fulfillment_status: string;
  requires_shipping: boolean;
  is_digital: boolean;
  is_gift_card: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface OrderEvent {
  id: string;
  order_id: string;
  type: string;
  data: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

// ── Create order ───────────────────────────────────────────────────────────────

export interface CreateOrderLineInput {
  variant_id?: string | undefined;
  title?: string | undefined;
  sku?: string | undefined;
  quantity?: number | undefined;
}

export interface CreateOrderInput {
  currency?: string | undefined;
  customer_id?: string | undefined;
  shipping_address?: Record<string, unknown> | undefined;
  billing_address?: Record<string, unknown> | undefined;
  po_number?: string | undefined;
  payment_terms_days?: number | undefined;
  source_name?: string | undefined;
  notes?: string | undefined;
  shipping_total?: string | undefined;
  tax_total?: string | undefined;
  discount_total?: string | undefined;
  mode?: "live" | "dev" | undefined;
  lines: CreateOrderLineInput[];
}

export interface CreateOrderResult {
  id: string;
  order_number: string;
  mode: string;
  is_test: boolean;
}

// ── Update order ───────────────────────────────────────────────────────────────

export interface UpdateOrderInput {
  notes?: string | undefined;
  tags?: string[] | undefined;
}
