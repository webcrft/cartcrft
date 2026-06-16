/**
 * providers/payments/xendit.ts — Xendit invoice client (raw fetch, no SDK).
 *
 * Ported from webcrft-mono/backend/internal/payments/xendit/client.go.
 * Xendit uses HTTP Basic auth with apiKey as username, empty password.
 * Amount is in full currency units (NOT cents).
 */

export interface CreateInvoiceRequest {
  /** External ID — typically the checkout ID. */
  externalId: string;
  /** Amount in full currency units (NOT cents). Xendit uses float. */
  amount: number;
  currency: string;
  payerEmail?: string | undefined;
  description?: string | undefined;
  successUrl?: string | undefined;
  failureUrl?: string | undefined;
}

export interface CreateInvoiceResponse {
  id: string;
  invoiceUrl: string;
  externalId: string;
  status: string;
  amount: number;
  currency: string;
}

export interface RefundRequest {
  /** The Xendit invoice id — our provider_reference (set when the invoice was created). */
  invoiceId: string;
  /** Amount in full currency units (NOT cents). Xendit uses float. */
  amount: number;
  currency?: string | undefined;
}

export interface RefundResponse {
  id: string;
  /** Raw Xendit refund status: SUCCEEDED|PENDING|FAILED. */
  status: string;
}

const XENDIT_BASE_URL = "https://api.xendit.co";

export class XenditClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createInvoice(
    req: CreateInvoiceRequest
  ): Promise<CreateInvoiceResponse> {
    // HTTP Basic auth: apiKey as username, empty password
    const creds = Buffer.from(`${this.apiKey}:`).toString("base64");

    // Map camelCase → snake_case for the API
    const payload: Record<string, unknown> = {
      external_id: req.externalId,
      amount: req.amount,
      currency: req.currency,
    };
    if (req.payerEmail) payload["payer_email"] = req.payerEmail;
    if (req.description) payload["description"] = req.description;
    if (req.successUrl) payload["success_redirect_url"] = req.successUrl;
    if (req.failureUrl) payload["failure_redirect_url"] = req.failureUrl;

    const res = await fetch(`${XENDIT_BASE_URL}/v2/invoices`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new Error(`xendit: status ${res.status}: ${JSON.stringify(data)}`);
    }

    return {
      id: String(data["id"]),
      invoiceUrl: String(data["invoice_url"]),
      externalId: String(data["external_id"]),
      status: String(data["status"]),
      amount: Number(data["amount"]),
      currency: String(data["currency"]),
    };
  }

  async createRefund(req: RefundRequest): Promise<RefundResponse> {
    // HTTP Basic auth: apiKey as username, empty password
    const creds = Buffer.from(`${this.apiKey}:`).toString("base64");

    const payload: Record<string, unknown> = {
      invoice_id: req.invoiceId,
      amount: req.amount,
    };
    if (req.currency) payload["currency"] = req.currency;

    const res = await fetch(`${XENDIT_BASE_URL}/refunds`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new Error(`xendit: status ${res.status}: ${JSON.stringify(data)}`);
    }

    return {
      id: String(data["id"]),
      status: String(data["status"] ?? "PENDING"),
    };
  }
}
