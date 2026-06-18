/**
 * providers/shipping/shippo.ts — Shippo multi-carrier shipping aggregation API client.
 *
 * Auth: Shippo token (API key from Shippo Dashboard → Settings → API).
 * Header: `Authorization: ShippoToken <apiKey>`.
 * Docs: https://docs.goshippo.com/shippoapi/public-api/
 *
 * Field names mirror Shippo's public REST API.
 */

const BASE_URL = "https://api.goshippo.com";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ShippoAddress {
  name: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string; // ISO 3166-1 alpha-2, e.g. "US"
  phone?: string | undefined;
  email?: string | undefined;
}

export interface ShippoParcel {
  length: string | number;
  width: string | number;
  height: string | number;
  distance_unit: string; // "cm" | "in" | ...
  weight: string | number;
  mass_unit: string; // "kg" | "lb" | ...
}

export interface ShippoShipmentRequest {
  address_from: ShippoAddress;
  address_to: ShippoAddress;
  parcels: ShippoParcel[];
}

export interface ShippoServiceLevel {
  name: string;
  token: string;
}

export interface ShippoRate {
  object_id: string;
  amount: string;
  currency: string;
  provider: string;
  servicelevel: ShippoServiceLevel;
  estimated_days?: number | undefined;
  duration_terms?: string | undefined;
}

export interface ShippoTransaction {
  object_id: string;
  status: string;
  tracking_number: string;
  tracking_url_provider: string;
  label_url: string;
  rate: string;
  eta?: string | undefined;
}

export class ShippoAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`shippo: status ${status}: ${message}`);
    this.name = "ShippoAPIError";
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class ShippoClient {
  constructor(private readonly apiKey: string) {}

  /**
   * POST /shipments/ — create a shipment synchronously and return its rates.
   */
  async getRates(
    req: ShippoShipmentRequest,
    signal?: AbortSignal
  ): Promise<ShippoRate[]> {
    const data = await this._do(
      "POST",
      "/shipments/",
      { ...req, async: false },
      signal
    );
    const parsed = data as { rates?: ShippoRate[] };
    return parsed.rates ?? [];
  }

  /**
   * POST /transactions/ — purchase a shipping label for a previously fetched rate.
   */
  async purchaseLabel(
    rateObjectId: string,
    labelFileType?: string,
    signal?: AbortSignal
  ): Promise<ShippoTransaction> {
    const data = await this._do(
      "POST",
      "/transactions/",
      {
        rate: rateObjectId,
        label_file_type: labelFileType ?? "PDF",
        async: false,
      },
      signal
    );
    return data as ShippoTransaction;
  }

  /**
   * GET /transactions/:id — fetch a transaction (label) by Shippo object ID.
   */
  async getTransaction(
    transactionId: string,
    signal?: AbortSignal
  ): Promise<ShippoTransaction> {
    const data = await this._do(
      "GET",
      `/transactions/${transactionId}`,
      undefined,
      signal
    );
    return data as ShippoTransaction;
  }

  private async _do(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `ShippoToken ${this.apiKey}`,
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
      throw new ShippoAPIError(res.status, text);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`shippo: could not parse response: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Convenience factory — mirrors `newBobGoClient(apiKey)`.
 */
export function newShippoClient(apiKey: string): ShippoClient {
  return new ShippoClient(apiKey);
}
