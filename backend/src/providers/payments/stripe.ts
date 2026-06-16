/**
 * providers/payments/stripe.ts — Stripe PaymentIntent client (raw fetch, no SDK).
 *
 * Ported from webcrft-mono/backend/internal/payments/stripe/client.go.
 * Uses application/x-www-form-urlencoded POST as required by the Stripe v1 API.
 */

export interface PaymentIntentRequest {
  /** Amount in smallest currency unit (cents for USD). Integer. */
  amountCents: number;
  /** Lowercase ISO 4217 currency code, e.g. "usd". */
  currency: string;
  /** Checkout ID — stored in metadata.checkout_id. */
  checkoutId: string;
  /** Optional receipt email for the customer. */
  email?: string | undefined;
}

export interface PaymentIntentResponse {
  id: string;
  clientSecret: string;
  status: string;
  currency: string;
  amount: number;
}

export interface RefundRequest {
  /**
   * The provider reference of the captured payment. For Stripe this is a
   * PaymentIntent id (pi_…) or a Charge id (ch_…). PaymentIntent ids are
   * detected by the "pi_" prefix and sent as `payment_intent`; everything
   * else is sent as `charge`.
   */
  providerReference: string;
  /** Amount in smallest currency unit (cents). Integer. */
  amountCents: number;
}

export interface RefundResponse {
  id: string;
  /** Raw Stripe refund status: pending|succeeded|failed|canceled|requires_action. */
  status: string;
}

const STRIPE_BASE_URL = "https://api.stripe.com/v1";

export class StripeClient {
  private readonly secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  async createPaymentIntent(
    req: PaymentIntentRequest
  ): Promise<PaymentIntentResponse> {
    const params = new URLSearchParams();
    params.set("amount", String(Math.round(req.amountCents)));
    params.set("currency", req.currency.toLowerCase());
    params.set("automatic_payment_methods[enabled]", "true");
    params.set("metadata[checkout_id]", req.checkoutId);
    if (req.email) {
      params.set("receipt_email", req.email);
    }

    const res = await fetch(`${STRIPE_BASE_URL}/payment_intents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      const errMsg =
        (data["error"] as Record<string, unknown> | undefined)?.["message"] ??
        `stripe: status ${res.status}`;
      throw new Error(String(errMsg));
    }

    return {
      id: String(data["id"]),
      clientSecret: String(data["client_secret"]),
      status: String(data["status"]),
      currency: String(data["currency"]),
      amount: Number(data["amount"]),
    };
  }

  async createRefund(req: RefundRequest): Promise<RefundResponse> {
    const params = new URLSearchParams();
    if (req.providerReference.startsWith("pi_")) {
      params.set("payment_intent", req.providerReference);
    } else {
      params.set("charge", req.providerReference);
    }
    params.set("amount", String(Math.round(req.amountCents)));

    const res = await fetch(`${STRIPE_BASE_URL}/refunds`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      const errMsg =
        (data["error"] as Record<string, unknown> | undefined)?.["message"] ??
        `stripe: status ${res.status}`;
      throw new Error(String(errMsg));
    }

    return {
      id: String(data["id"]),
      status: String(data["status"]),
    };
  }
}
