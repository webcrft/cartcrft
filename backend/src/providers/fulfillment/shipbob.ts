/**
 * providers/fulfillment/shipbob.ts — ShipBob fulfillment API client.
 *
 * Base: https://api.shipbob.com/1.0
 * Auth: Authorization: Bearer <accessToken>
 *
 * TOKEN PROVISIONING (BYO — follow-up scope)
 * ──────────────────────────────────────────
 * This client accepts a ShipBob API token supplied by the merchant (stored
 * encrypted in store_integrations / threepl provider config, read decrypted at
 * submit/sync time). It does NOT perform OAuth provisioning or refresh — minting
 * and rotating the token is the merchant's responsibility for this pass and is a
 * documented follow-up (wire a token-refresh step into newShipBobClient once a
 * stored refresh_token + client-credentials path lands).
 *
 * Mapping: a CartCrft order → a ShipBob order resource (recipient {name,address},
 * products [{reference_id|sku, quantity}]). See toShipBobOrder().
 *
 * Provider-client pattern mirrors providers/shipping/bobgo.ts &
 * providers/channels/google-shopping.ts: a class with fetch + typed methods, a
 * dedicated error class, and a `newShipBobClient(accessToken)` factory.
 */

const BASE_URL = "https://api.shipbob.com/1.0";

// ── CartCrft → ShipBob input shape ──────────────────────────────────────────────

/** A shipping recipient address as ShipBob expects it. */
export interface ShipBobAddress {
  address1: string;
  address2?: string;
  city: string;
  state: string;
  country: string;
  zip_code: string;
}

/** A single line of a ShipBob order. */
export interface ShipBobProduct {
  /** Merchant SKU / reference id for the item. */
  reference_id: string;
  quantity: number;
}

/** The recipient block of a ShipBob order. */
export interface ShipBobRecipient {
  name: string;
  address: ShipBobAddress;
  email?: string;
  phone_number?: string;
}

/** A ShipBob create-order request (the subset we populate). */
export interface ShipBobOrderRequest {
  /** Merchant reference id (we use the CartCrft order id). */
  reference_id: string;
  /** Human-facing order number, surfaced in the ShipBob dashboard. */
  order_number?: string;
  recipient: ShipBobRecipient;
  products: ShipBobProduct[];
  /** Shipping method, e.g. "Standard". */
  shipping_method?: string;
}

/** ShipBob shipment status block (subset). */
export interface ShipBobShipment {
  id?: number;
  status?: string;
  tracking?: {
    tracking_number?: string;
    tracking_url?: string;
    carrier?: string;
  };
}

/** A ShipBob order resource (the subset we read on create/get). */
export interface ShipBobOrderResponse {
  id: number;
  reference_id?: string;
  order_number?: string;
  status?: string;
  shipments?: ShipBobShipment[];
}

// ── CartCrft order view → ShipBob request ───────────────────────────────────────

/** The minimal CartCrft order view needed to build a ShipBob order. */
export interface FulfillmentOrderInput {
  /** CartCrft order id → ShipBob reference_id. */
  referenceId: string;
  orderNumber?: string;
  recipientName: string;
  address1: string;
  address2?: string;
  city: string;
  state: string;
  country: string;
  zip: string;
  email?: string;
  phone?: string;
  shippingMethod?: string;
  lines: Array<{ sku: string; quantity: number }>;
}

/**
 * Map a CartCrft order view → a ShipBob create-order request.
 *
 * - recipient.name/address from the order's shipping address.
 * - products: one entry per line, keyed by SKU (reference_id) + quantity.
 * - empty optional strings are omitted (exactOptionalPropertyTypes-friendly).
 */
export function toShipBobOrder(input: FulfillmentOrderInput): ShipBobOrderRequest {
  const address: ShipBobAddress = {
    address1: input.address1,
    city: input.city,
    state: input.state,
    country: input.country,
    zip_code: input.zip,
  };
  if (input.address2) address.address2 = input.address2;

  const recipient: ShipBobRecipient = {
    name: input.recipientName,
    address,
  };
  if (input.email) recipient.email = input.email;
  if (input.phone) recipient.phone_number = input.phone;

  const req: ShipBobOrderRequest = {
    reference_id: input.referenceId,
    recipient,
    products: input.lines.map((l) => ({
      reference_id: l.sku,
      quantity: l.quantity,
    })),
  };
  if (input.orderNumber) req.order_number = input.orderNumber;
  if (input.shippingMethod) req.shipping_method = input.shippingMethod;

  return req;
}

// ── Status normalization ────────────────────────────────────────────────────────

/** CartCrft-internal normalized fulfillment status. */
export type ThreePlStatus =
  | "submitted"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled"
  | "exception";

/**
 * Normalize a raw ShipBob order/shipment status string → a CartCrft status.
 *
 * ShipBob order statuses include: Processing, Exception, OnHold, Fulfilled,
 * Cancelled, PartiallyFulfilled, etc.; shipment statuses include Processing,
 * Completed (shipped), Exception, Cancelled, LabeledCreated, etc. We collapse
 * those into the CartCrft enum, defaulting unknown values to "processing".
 */
export function normalizeShipBobStatus(raw: string | undefined | null): ThreePlStatus {
  const s = (raw ?? "").trim().toLowerCase();
  switch (s) {
    case "":
    case "importreview":
    case "import_review":
      return "submitted";
    case "processing":
    case "onhold":
    case "on_hold":
    case "partiallyfulfilled":
    case "partially_fulfilled":
    case "labelcreated":
    case "labeledcreated":
    case "labeled_created":
      return "processing";
    case "shipped":
    case "completed":
    case "fulfilled":
      return "shipped";
    case "delivered":
      return "delivered";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "exception":
      return "exception";
    default:
      return "processing";
  }
}

/**
 * Extract the best status + tracking info from a ShipBob order response. Prefers
 * the most-advanced shipment status when shipments are present.
 */
export function extractShipBobStatus(res: ShipBobOrderResponse): {
  status: ThreePlStatus;
  trackingNumber?: string;
  trackingUrl?: string;
} {
  const shipment = (res.shipments ?? [])[0];
  const rawStatus = shipment?.status ?? res.status;
  const out: { status: ThreePlStatus; trackingNumber?: string; trackingUrl?: string } = {
    status: normalizeShipBobStatus(rawStatus),
  };
  const tn = shipment?.tracking?.tracking_number;
  const tu = shipment?.tracking?.tracking_url;
  if (tn) out.trackingNumber = tn;
  if (tu) out.trackingUrl = tu;
  return out;
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class ShipBobAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`shipbob: status ${status}: ${message}`);
    this.name = "ShipBobAPIError";
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class ShipBobClient {
  constructor(private readonly accessToken: string) {}

  /**
   * POST /order — create a fulfillment order.
   */
  async createFulfillmentOrder(
    req: ShipBobOrderRequest,
    signal?: AbortSignal
  ): Promise<ShipBobOrderResponse> {
    const data = await this._do("POST", "/order", req, signal);
    return data as ShipBobOrderResponse;
  }

  /**
   * GET /order/{id} — fetch a fulfillment order's current status.
   */
  async getFulfillmentStatus(
    externalId: string,
    signal?: AbortSignal
  ): Promise<ShipBobOrderResponse> {
    const data = await this._do(
      "GET",
      `/order/${encodeURIComponent(externalId)}`,
      undefined,
      signal
    );
    return data as ShipBobOrderResponse;
  }

  /**
   * POST /order/{id}/cancel — request cancellation of a fulfillment order.
   */
  async cancelFulfillmentOrder(
    externalId: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this._do(
      "POST",
      `/order/${encodeURIComponent(externalId)}/cancel`,
      undefined,
      signal
    );
  }

  private async _do(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
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
      throw new ShipBobAPIError(res.status, text);
    }

    // Cancel / 204 → no body.
    if (res.status === 204 || text.trim() === "") {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new ShipBobAPIError(
        res.status,
        `could not parse response: ${text.slice(0, 200)}`
      );
    }
  }
}

/**
 * Convenience factory — mirrors newBobGoClient(apiKey) / newGoogleShoppingClient.
 *
 * BYO access token: the caller supplies a valid ShipBob API token (read decrypted
 * from the provider config / store_integrations). Token refresh is out of scope
 * for this pass (see file header).
 */
export function newShipBobClient(accessToken: string): ShipBobClient {
  return new ShipBobClient(accessToken);
}
