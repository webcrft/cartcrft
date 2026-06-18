/**
 * providers/payments/stripe.ts — Stripe PaymentIntent client (raw fetch, no SDK).
 *
 * Ported from webcrft-mono/backend/internal/payments/stripe/client.go.
 * Uses application/x-www-form-urlencoded POST as required by the Stripe v1 API.
 */

/**
 * Explicit Stripe payment method types we know how to surface. Wallets
 * (Apple Pay / Google Pay) are NOT separate method types — they ride on top of
 * `card` and are shown automatically by Stripe when the buyer is eligible, so
 * they only need `card` to be enabled (or `automatic_payment_methods`).
 */
export type StripePaymentMethodType =
  | "card"
  | "klarna"
  | "afterpay_clearpay"
  | "affirm";

export interface PaymentIntentRequest {
  /** Amount in smallest currency unit (cents for USD). Integer. */
  amountCents: number;
  /** Lowercase ISO 4217 currency code, e.g. "usd". */
  currency: string;
  /** Checkout ID — stored in metadata.checkout_id. */
  checkoutId: string;
  /** Optional receipt email for the customer. */
  email?: string | undefined;
  /**
   * Explicit `payment_method_types[]` to send. When provided (non-empty), the
   * PaymentIntent pins these methods and `automatic_payment_methods` is NOT
   * sent (the two are mutually exclusive in the Stripe API). When omitted or
   * empty, the client falls back to `automatic_payment_methods[enabled]=true`,
   * which lets Stripe surface every eligible method for the store — including
   * card + wallets (Apple Pay / Google Pay). This is the default behaviour.
   */
  paymentMethodTypes?: StripePaymentMethodType[] | undefined;
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

    // De-duplicate while preserving order. `card` is always kept first so the
    // primary card flow (and its wallets) is never dropped when BNPL is added.
    const explicitTypes =
      req.paymentMethodTypes && req.paymentMethodTypes.length > 0
        ? Array.from(new Set(req.paymentMethodTypes))
        : [];

    if (explicitTypes.length > 0) {
      // Pinning explicit method types: `automatic_payment_methods` must NOT be
      // sent alongside `payment_method_types` (Stripe rejects the combination).
      // BNPL methods (klarna/afterpay_clearpay/affirm) have currency/amount/
      // region constraints; if one is unsupported for this session Stripe
      // returns a clear error rather than us silently dropping it.
      for (const t of explicitTypes) {
        params.append("payment_method_types[]", t);
      }
    } else {
      // Default (unchanged): let Stripe surface every eligible method,
      // including card + wallets (Apple Pay / Google Pay).
      params.set("automatic_payment_methods[enabled]", "true");
    }

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
