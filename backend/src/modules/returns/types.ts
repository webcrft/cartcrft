/**
 * returns/types.ts — TypeScript types for returns/RMA module.
 */

export type ReturnStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "in_transit"
  | "received"
  | "inspected"
  | "resolved"
  | "closed";

export type ReturnType = "refund" | "exchange" | "store_credit" | "repair";
export type ReturnAction = "refund" | "exchange" | "store_credit" | "repair";

export interface ReturnRequest {
  id: string;
  store_id: string;
  order_id: string;
  customer_id: string | null;
  rma_number: string;
  status: ReturnStatus;
  return_type: ReturnType;
  notes: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  order_number?: string;
}

export interface ReturnLine {
  id: string;
  return_id: string;
  order_line_id: string;
  quantity: number;
  reason: string | null;
  condition: string | null;
  action: ReturnAction;
  exchange_variant_id: string | null;
  restock: boolean;
  created_at: Date;
  title?: string;
  sku?: string | null;
}

export interface ReturnWithLines extends ReturnRequest {
  lines: ReturnLine[];
}

export interface ReturnEvent {
  id: string;
  return_id: string;
  type: string;
  data: unknown;
  created_by: string | null;
  created_at: Date;
}

export interface CreateReturnInput {
  return_type?: ReturnType | undefined;
  notes?: string | null | undefined;
  lines?: Array<{
    order_line_id: string;
    quantity?: number | undefined;
    reason?: string | null | undefined;
    condition?: string | null | undefined;
    action?: ReturnAction | undefined;
    exchange_variant_id?: string | null | undefined;
    restock?: boolean | undefined;
  }> | undefined;
}

export interface UpdateReturnInput {
  status?: ReturnStatus | null | undefined;
  notes?: string | null | undefined;
  return_type?: ReturnType | null | undefined;
  credit_amount?: number | null | undefined;
}

export interface AddReturnEventInput {
  type?: string | undefined;
  data?: Record<string, unknown> | undefined;
}
