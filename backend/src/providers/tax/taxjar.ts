/**
 * providers/tax/taxjar.ts — TaxJar tax-automation API client.
 *
 * Mirrors the provider-client pattern in providers/shipping/bobgo.ts:
 * class + global fetch + typed interfaces + APIError class + factory.
 *
 * Auth: Bearer token (API key from TaxJar Dashboard → Account → API Access).
 * Docs: https://developers.taxjar.com/api/reference/
 *
 * Base: https://api.taxjar.com/v2 (sandbox: https://api.sandbox.taxjar.com/v2).
 */

const BASE_URL = "https://api.taxjar.com/v2";
const SANDBOX_BASE_URL = "https://api.sandbox.taxjar.com/v2";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TaxJarLineItem {
  id?: string | undefined;
  quantity: number;
  unit_price: number;
  product_tax_code?: string | undefined;
}

export interface TaxJarCalcParams {
  to_country: string;
  to_zip?: string | undefined;
  to_state?: string | undefined;
  to_city?: string | undefined;
  amount: number;
  shipping: number;
  line_items?: TaxJarLineItem[] | undefined;
}

export interface TaxJarTax {
  amount_to_collect: number;
  rate: number;
  taxable_amount: number;
  has_nexus: boolean;
  freight_taxable?: boolean | undefined;
  breakdown?: Record<string, unknown> | undefined;
}

export class TaxJarAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`taxjar: status ${status}: ${message}`);
    this.name = "TaxJarAPIError";
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class TaxJarClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    sandbox = false
  ) {
    this.baseUrl = sandbox ? SANDBOX_BASE_URL : BASE_URL;
  }

  /**
   * POST /taxes — compute sales tax for an order.
   * Returns the `tax` object from TaxJar's response envelope.
   */
  async calcTax(
    params: TaxJarCalcParams,
    signal?: AbortSignal
  ): Promise<TaxJarTax> {
    const body: Record<string, unknown> = {
      to_country: params.to_country,
      amount: params.amount,
      shipping: params.shipping,
    };
    if (params.to_zip !== undefined) body["to_zip"] = params.to_zip;
    if (params.to_state !== undefined) body["to_state"] = params.to_state;
    if (params.to_city !== undefined) body["to_city"] = params.to_city;
    if (params.line_items !== undefined) body["line_items"] = params.line_items;

    const data = await this._do("POST", "/taxes", body, signal);
    const parsed = data as { tax?: TaxJarTax };
    if (!parsed.tax) {
      throw new Error("taxjar: response missing tax object");
    }
    return parsed.tax;
  }

  private async _do(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    let bodyStr: string | undefined;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });

    const text = await res.text();
    if (res.status >= 400) {
      throw new TaxJarAPIError(res.status, text);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`taxjar: could not parse response: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Convenience factory — mirrors newBobGoClient(apiKey).
 */
export function newTaxJarClient(apiKey: string, sandbox?: boolean): TaxJarClient {
  return new TaxJarClient(apiKey, sandbox ?? false);
}
