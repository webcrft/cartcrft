/**
 * paystack.ts — Paystack billing client
 *
 * Raw fetch-based client (no SDK deps). Mirrors the billing handler's
 * paystackRequest/chargeAuthCode pattern from webcrft-mono/backend/internal/handlers/billing.go.
 *
 * Operations:
 *   initializeTransaction  — hosted checkout (card connect, 3DS)
 *   chargeAuthorization    — tokenized renewal charge
 *   verifyTransaction      — verify by reference
 *   refund                 — refund a transaction
 *
 * PAYSTACK_SECRET_KEY is injected at construction time (from backend config or env).
 */

export const PAYSTACK_BASE = 'https://api.paystack.co';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaystackInitRequest {
  email: string;
  /** Amount in smallest currency unit (ZAR cents, NGN kobo, etc.) */
  amount: number;
  currency?: string;
  reference?: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
  channels?: string[];
}

export interface PaystackInitResponse {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface PaystackChargeRequest {
  authorizationCode: string;
  email: string;
  /** Amount in cents */
  amount: number;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface PaystackChargeResult {
  /** 'success' | 'failed' | 'pending' etc. */
  status: string;
  reference: string;
  gatewayResponse: string;
}

export interface PaystackVerifyData {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  gatewayResponse: string;
  metadata: Record<string, unknown>;
  authorization: Record<string, unknown>;
  customer: Record<string, unknown>;
}

export interface PaystackRefundResult {
  id: number;
  status: string;
  transactionReference: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class PaystackClient {
  private readonly secretKey: string;
  private readonly timeoutMs: number;

  constructor(secretKey: string, timeoutMs = 15_000) {
    this.secretKey = secretKey;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Initialize a Paystack transaction (hosted checkout page).
   * Returns { authorizationUrl, accessCode, reference }.
   */
  async initializeTransaction(req: PaystackInitRequest): Promise<PaystackInitResponse> {
    const body: Record<string, unknown> = {
      email: req.email,
      amount: req.amount,
    };
    if (req.currency) body['currency'] = req.currency;
    if (req.reference) body['reference'] = req.reference;
    if (req.callbackUrl) body['callback_url'] = req.callbackUrl;
    if (req.metadata) body['metadata'] = req.metadata;
    if (req.channels) body['channels'] = req.channels;

    const data = await this.request('POST', '/transaction/initialize', body);
    return {
      authorizationUrl: String(data['authorization_url'] ?? ''),
      accessCode: String(data['access_code'] ?? ''),
      reference: String(data['reference'] ?? ''),
    };
  }

  /**
   * Charge a stored authorization code (tokenized renewal).
   * Returns { status, reference, gatewayResponse }.
   * Does NOT throw on charge failure — returns status='failed' instead so callers
   * can handle gracefully without try/catch (mirrors Go chargeAuthCode).
   */
  async chargeAuthorization(req: PaystackChargeRequest): Promise<PaystackChargeResult> {
    const body: Record<string, unknown> = {
      authorization_code: req.authorizationCode,
      email: req.email,
      amount: req.amount,
    };
    if (req.currency) body['currency'] = req.currency;
    if (req.metadata) body['metadata'] = req.metadata;

    let envelope: Record<string, unknown>;
    let data: Record<string, unknown> = {};

    try {
      const raw = await this.rawRequest('POST', '/transaction/charge_authorization', body);
      envelope = JSON.parse(raw) as Record<string, unknown>;
      data = (envelope['data'] as Record<string, unknown>) ?? {};
    } catch {
      return {
        status: 'failed',
        reference: `localfail-${randomStr(16)}`,
        gatewayResponse: 'Paystack request failed',
      };
    }

    const topStatus = Boolean(envelope['status']);
    if (!topStatus) {
      const msg = String(envelope['message'] ?? 'charge_authorization rejected');
      const ref = String(data['reference'] ?? `localfail-${randomStr(16)}`);
      return { status: 'failed', reference: ref, gatewayResponse: msg };
    }

    return {
      status: String(data['status'] ?? 'failed'),
      reference: String(data['reference'] ?? `localfail-${randomStr(16)}`),
      gatewayResponse: String(data['gateway_response'] ?? String(envelope['message'] ?? '')),
    };
  }

  /**
   * Verify a transaction by reference.
   */
  async verifyTransaction(reference: string): Promise<PaystackVerifyData> {
    const data = await this.request('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    /* eslint-disable @typescript-eslint/no-explicit-any -- paystack API response is untyped */
    return {
      status: String(data['status'] ?? ''),
      reference: String(data['reference'] ?? reference),
      amount: Number(data['amount'] ?? 0),
      currency: String(data['currency'] ?? 'ZAR'),
      gatewayResponse: String(data['gateway_response'] ?? ''),
      metadata: (data['metadata'] as Record<string, unknown>) ?? {},
      authorization: (data['authorization'] as Record<string, unknown>) ?? {},
      customer: (data['customer'] as Record<string, unknown>) ?? {},
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  /**
   * Refund a transaction by reference.
   * amount: ZAR cents (partial refund supported; 0 = full refund).
   */
  async refund(transactionReference: string, amount?: number): Promise<PaystackRefundResult> {
    const body: Record<string, unknown> = {
      transaction: transactionReference,
    };
    if (amount && amount > 0) body['amount'] = amount;

    const data = await this.request('POST', '/refund', body);
    return {
      id: Number(data['id'] ?? 0),
      status: String(data['status'] ?? 'pending'),
      transactionReference: String(data['transaction_reference'] ?? transactionReference),
    };
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /** POST/GET with JSON parsing; throws on non-2xx or Paystack status:false. */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const raw = await this.rawRequest(method, path, body);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const envelope = parsed as { status?: boolean; message?: string; data?: unknown };
    if (!envelope.status) {
      throw new Error(`paystack: ${String(envelope.message ?? 'api error')}`);
    }
    return (envelope.data as Record<string, unknown>) ?? {};
  }

  /** Raw fetch — returns response body as string. Throws on HTTP errors. */
  private async rawRequest(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);

    try {
      const fetchOpts: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
        signal: ac.signal,
      };
      if (body !== undefined) {
        fetchOpts.body = JSON.stringify(body);
      }
      const res = await fetch(PAYSTACK_BASE + path, fetchOpts);
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`paystack: http ${res.status}: ${text}`);
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function randomStr(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

/**
 * Extract amount in cents from a Paystack event data object.
 * Paystack returns amounts in their smallest unit which equals cents for ZAR.
 */
export function extractPaystackAmountCents(data: Record<string, unknown>): number {
  const v = data['amount'];
  if (typeof v === 'number') return Math.max(0, Math.floor(v));
  if (typeof v === 'string') return Math.max(0, parseInt(v, 10) || 0);
  return 0;
}
