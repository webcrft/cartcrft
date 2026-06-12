/**
 * providers/shipping/bobgo.ts — BobGo courier aggregation API client.
 *
 * Ported from webcrft-mono/backend/internal/shipping/bobgo/client.go.
 * Auth: Bearer token (API key from BobGo Dashboard → Settings → API Keys).
 * Docs: https://api.bobgo.co.za/docs
 *
 * Field names mirror BobGo's v2 REST API.
 */

const BASE_URL = "https://api.bobgo.co.za/v2";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BobGoAddress {
  company?: string;
  name?: string;
  phone?: string;
  email?: string;
  street_address: string;
  suburb?: string;
  city: string;
  zone?: string;        // province / state code
  postal_code: string;
  country_code: string; // ISO 3166-1 alpha-2, e.g. "ZA"
}

export interface BobGoDimensions {
  length: number; // cm
  width: number;  // cm
  height: number; // cm
}

export interface BobGoParcel {
  description?: string;
  submitted_weight_kg: number;
  parcel_dimensions: BobGoDimensions;
  packaging_type?: string; // "custom" | "bag" | "box"
}

export interface BobGoRateRequest {
  collection_address: BobGoAddress;
  delivery_address: BobGoAddress;
  parcels: BobGoParcel[];
  declared_value?: number;
  insure_contents?: boolean;
}

export interface BobGoRate {
  service_level_code: string;
  service_level_name: string;
  courier_code: string;
  courier_name: string;
  total_charge_incl_vat: number;
  currency: string;
  estimated_delivery_days: number;
  estimated_delivery_date?: string;
}

export interface BobGoShipmentRequest {
  service_level_code: string;
  collection_address: BobGoAddress;
  delivery_address: BobGoAddress;
  parcels: BobGoParcel[];
  customer_reference?: string;
  special_instructions_collection?: string;
  special_instructions_delivery?: string;
  declared_value?: number;
  insure_contents?: boolean;
  collect_on_delivery?: { amount: number; currency: string };
  webhook_url?: string;
}

export interface BobGoShipmentResponse {
  shipment_id: string;
  tracking_reference: string;
  label_url: string;
  waybill_url?: string;
  courier_code: string;
  courier_name: string;
  service_level_name: string;
  collection_date?: string;
  status: string;
}

export class BobGoAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`bobgo: status ${status}: ${message}`);
    this.name = "BobGoAPIError";
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class BobGoClient {
  constructor(private readonly apiKey: string) {}

  /**
   * GET /rates/ — fetch live shipping rates for a collection→delivery route.
   * Mirrors Go client.GetRates().
   */
  async getRates(
    req: BobGoRateRequest,
    signal?: AbortSignal
  ): Promise<BobGoRate[]> {
    const data = await this._do("POST", "/rates/", req, signal);
    const parsed = data as { rates?: BobGoRate[] };
    return parsed.rates ?? [];
  }

  /**
   * POST /shipments/ — book a shipment with BobGo.
   * Mirrors Go client.CreateShipment().
   */
  async createShipment(
    req: BobGoShipmentRequest,
    signal?: AbortSignal
  ): Promise<BobGoShipmentResponse> {
    const data = await this._do("POST", "/shipments/", req, signal);
    return data as BobGoShipmentResponse;
  }

  /**
   * GET /shipments/:id/ — fetch a shipment by BobGo shipment ID.
   * Mirrors Go client.GetShipment().
   */
  async getShipment(
    shipmentId: string,
    signal?: AbortSignal
  ): Promise<BobGoShipmentResponse> {
    const data = await this._do("GET", `/shipments/${shipmentId}/`, undefined, signal);
    return data as BobGoShipmentResponse;
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

    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(bodyStr !== undefined ? { body: bodyStr } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });

    const text = await res.text();
    if (res.status >= 400) {
      throw new BobGoAPIError(res.status, text);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`bobgo: could not parse response: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Convenience factory — mirrors Go `bobgo.New(apiKey)`.
 */
export function newBobGoClient(apiKey: string): BobGoClient {
  return new BobGoClient(apiKey);
}
