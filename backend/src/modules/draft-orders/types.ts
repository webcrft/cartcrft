/**
 * draft-orders/types.ts — TypeScript types for the draft-orders module.
 *
 * Money amounts are decimal strings in API payloads (numeric(15,2) from PG comes
 * back as string). All IDs are uuid text strings.
 */

export type DraftOrderStatus =
  | "draft"
  | "invoice_sent"
  | "converted"
  | "cancelled";

/** A snapshot line as persisted in line_items jsonb + returned to the API. */
export interface DraftOrderLine {
  variant_id: string | null;
  title: string;
  quantity: number;
  /** unit price, decimal string. */
  price: string;
}

export interface DraftOrder {
  id: string;
  store_id: string;
  customer_id: string | null;
  email: string | null;
  currency: string;
  line_items: DraftOrderLine[];
  subtotal: string;
  discount_total: string;
  tax_total: string;
  shipping_total: string;
  total: string;
  note: string | null;
  status: DraftOrderStatus;
  invoice_url: string | null;
  converted_order_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Create / update inputs ───────────────────────────────────────────────────

export interface DraftOrderLineInput {
  variant_id?: string | undefined;
  title?: string | undefined;
  quantity?: number | undefined;
  /** unit price, decimal string. */
  price?: string | undefined;
}

export interface CreateDraftInput {
  customer_id?: string | undefined;
  email?: string | undefined;
  currency?: string | undefined;
  line_items: DraftOrderLineInput[];
  discount_total?: string | undefined;
  tax_total?: string | undefined;
  shipping_total?: string | undefined;
  note?: string | undefined;
}

export interface UpdateDraftInput {
  customer_id?: string | undefined;
  email?: string | undefined;
  currency?: string | undefined;
  line_items?: DraftOrderLineInput[] | undefined;
  discount_total?: string | undefined;
  tax_total?: string | undefined;
  shipping_total?: string | undefined;
  note?: string | undefined;
}

export interface ConvertResult {
  order_id: string;
  order_number: string;
}
