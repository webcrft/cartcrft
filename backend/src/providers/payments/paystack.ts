/**
 * providers/payments/paystack.ts — Paystack transaction client (raw fetch, no SDK).
 *
 * Ported from webcrft-mono/backend/internal/payments/paystack/client.go.
 */

export interface InitTransactionRequest {
  email: string;
  /** Amount in smallest currency unit (kobo for NGN, cents for ZAR/USD). Integer. */
  amountKobo: number;
  /** Optional reference — typically the checkout ID. */
  reference?: string | undefined;
  callbackUrl?: string | undefined;
  currency?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface InitTransactionResponse {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface RefundRequest {
  /** The transaction reference of the captured payment (our provider_reference). */
  transaction: string;
  /** Amount in smallest currency unit (kobo/cents). Integer. */
  amountKobo: number;
  currency?: string | undefined;
}

export interface RefundResponse {
  id: string;
  /** Raw Paystack refund status: pending|processing|processed|failed. */
  status: string;
}

const PAYSTACK_BASE_URL = "https://api.paystack.co";

export class PaystackClient {
  private readonly secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  async initializeTransaction(
    req: InitTransactionRequest
  ): Promise<InitTransactionResponse> {
    const body: Record<string, unknown> = {
      email: req.email,
      amount: Math.round(req.amountKobo),
    };
    if (req.reference) body["reference"] = req.reference;
    if (req.callbackUrl) body["callback_url"] = req.callbackUrl;
    if (req.currency) body["currency"] = req.currency;
    if (req.metadata) body["metadata"] = req.metadata;

    const res = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new Error(
        `paystack: status ${res.status}: ${String(raw["message"] ?? "unknown error")}`
      );
    }

    const envelope = raw as {
      status: boolean;
      message: string;
      data?: {
        authorization_url: string;
        access_code: string;
        reference: string;
      };
    };

    if (!envelope.status || !envelope.data) {
      throw new Error(`paystack: ${envelope.message}`);
    }

    return {
      authorizationUrl: envelope.data.authorization_url,
      accessCode: envelope.data.access_code,
      reference: envelope.data.reference,
    };
  }

  async createRefund(req: RefundRequest): Promise<RefundResponse> {
    const body: Record<string, unknown> = {
      transaction: req.transaction,
      amount: Math.round(req.amountKobo),
    };
    if (req.currency) body["currency"] = req.currency;

    const res = await fetch(`${PAYSTACK_BASE_URL}/refund`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new Error(
        `paystack: status ${res.status}: ${String(raw["message"] ?? "unknown error")}`
      );
    }

    const envelope = raw as {
      status: boolean;
      message: string;
      data?: { id?: string | number; status?: string };
    };

    if (!envelope.status || !envelope.data) {
      throw new Error(`paystack: ${envelope.message}`);
    }

    return {
      id: String(envelope.data.id ?? ""),
      status: String(envelope.data.status ?? "pending"),
    };
  }
}
