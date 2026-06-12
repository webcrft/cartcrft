/**
 * b2b/types.ts — TypeScript types for B2B commerce.
 *
 * Covers: companies, company_customers, customer_groups,
 * customer_group_members, quotes, quote_lines, purchase_orders.
 *
 * All optional fields include `| undefined` for exactOptionalPropertyTypes.
 */

// ── Companies ──────────────────────────────────────────────────────────────────

export interface Company {
  id: string;
  store_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tax_id: string | null;
  credit_limit: string | null;
  credit_used: string;
  payment_terms_days: number | null;
  price_list_id: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface CreateCompanyInput {
  name: string;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  tax_id?: string | null | undefined;
  credit_limit?: string | null | undefined;
  payment_terms_days?: number | null | undefined;
  price_list_id?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

export interface UpdateCompanyInput {
  name?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  tax_id?: string | null | undefined;
  credit_limit?: string | null | undefined;
  payment_terms_days?: number | null | undefined;
  price_list_id?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

// ── Company customers ──────────────────────────────────────────────────────────

export interface CompanyCustomer {
  id: string;
  company_id: string;
  customer_id: string;
  role: string;
  created_at: Date;
}

// ── Customer groups ────────────────────────────────────────────────────────────

export interface CustomerGroup {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  price_list_id: string | null;
  created_at: Date;
}

export interface CreateCustomerGroupInput {
  name: string;
  description?: string | null | undefined;
  price_list_id?: string | null | undefined;
}

export interface UpdateCustomerGroupInput {
  name?: string | null | undefined;
  description?: string | null | undefined;
  price_list_id?: string | null | undefined;
}

// ── Quotes ─────────────────────────────────────────────────────────────────────

export type QuoteStatus =
  | "draft"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired"
  | "converted";

export interface Quote {
  id: string;
  store_id: string;
  company_id: string | null;
  customer_id: string | null;
  status: QuoteStatus;
  expires_at: Date | null;
  notes: string | null;
  converted_order_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface QuoteLine {
  id: string;
  quote_id: string;
  variant_id: string | null;
  title: string;
  quantity: number;
  price: string;
  notes: string | null;
  created_at: Date;
}

export interface QuoteWithLines extends Quote {
  lines: QuoteLine[];
}

export interface CreateQuoteInput {
  company_id?: string | null | undefined;
  customer_id?: string | null | undefined;
  expires_at?: string | null | undefined;
  notes?: string | null | undefined;
  lines?: Array<{
    variant_id?: string | null | undefined;
    title?: string | null | undefined;
    quantity?: number | undefined;
    price: number;
    notes?: string | null | undefined;
  }> | undefined;
}

export interface UpdateQuoteInput {
  status?: string | null | undefined;
  expires_at?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface AcceptQuoteResult {
  order_id: string;
  order_number: string;
}

// ── Purchase orders ────────────────────────────────────────────────────────────

export interface PurchaseOrder {
  id: string;
  store_id: string;
  company_id: string | null;
  order_id: string | null;
  po_number: string;
  status: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AttachPurchaseOrderInput {
  po_number: string;
  notes?: string | null | undefined;
}

export interface UpdatePurchaseOrderInput {
  status?: string | null | undefined;
  notes?: string | null | undefined;
}
