/**
 * providers/payments/razorpay.ts — Razorpay order client (raw fetch, no SDK).
 *
 * Ported from webcrft-mono/backend/internal/payments/razorpay/client.go.
 */

export interface CreateOrderRequest {
  /** Amount in smallest currency unit (paise for INR). Integer. */
  amountSmallest: number;
  currency: string;
  /** Used as receipt and notes.checkout_id. */
  checkoutId: string;
}

export interface CreateOrderResponse {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string;
}

const RAZORPAY_BASE_URL = "https://api.razorpay.com/v1";

export class RazorpayClient {
  private readonly keyId: string;
  private readonly keySecret: string;

  constructor(keyId: string, keySecret: string) {
    this.keyId = keyId;
    this.keySecret = keySecret;
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResponse> {
    const creds = Buffer.from(`${this.keyId}:${this.keySecret}`).toString(
      "base64"
    );

    const body = {
      amount: Math.round(req.amountSmallest),
      currency: req.currency,
      receipt: req.checkoutId,
      notes: { checkout_id: req.checkoutId },
    };

    const res = await fetch(`${RAZORPAY_BASE_URL}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      throw new Error(`razorpay: status ${res.status}: ${JSON.stringify(data)}`);
    }

    return {
      id: String(data["id"]),
      amount: Number(data["amount"]),
      currency: String(data["currency"]),
      status: String(data["status"]),
      receipt: String(data["receipt"]),
    };
  }
}
