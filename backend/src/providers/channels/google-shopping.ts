/**
 * providers/channels/google-shopping.ts — Google Content API for Shopping v2.1
 * client for pushing products to a Merchant Center account.
 *
 * Base: https://shoppingcontent.googleapis.com/content/v2.1
 * Auth: Authorization: Bearer <accessToken>
 *
 * TOKEN PROVISIONING (BYO — follow-up scope)
 * ──────────────────────────────────────────
 * This client accepts a Google OAuth access token supplied by the merchant
 * (stored encrypted in store_integrations, read at sync time). It does NOT
 * perform the service-account / OAuth refresh-token exchange — minting and
 * refreshing the access token is the merchant's responsibility for this pass
 * and is a documented follow-up (wire a token-refresh step into newGoogleShoppingClient
 * once a stored refresh_token + client credentials path lands).
 *
 * Mapping: a CartCrft product/variant → a Content API `product` resource
 * (offerId, title, description, link, imageLink, availability, price{value,
 * currency}, brand, gtin/mpn, condition). See toContentProduct().
 *
 * Provider-client pattern mirrors providers/shipping/bobgo.ts &
 * providers/payments/stripe.ts: a class with fetch + typed methods, a dedicated
 * error class, and a `newGoogleShoppingClient(accessToken)` factory.
 */

const BASE_URL = "https://shoppingcontent.googleapis.com/content/v2.1";

// ── Content API product resource (subset we set) ────────────────────────────────

/** Price as the Content API expects it: a string value + ISO-4217 currency. */
export interface ContentApiPrice {
  value: string;
  currency: string;
}

/**
 * A Content API `products` resource (the fields we populate). The full resource
 * has many more optional attributes; we set the ones that map cleanly from the
 * CartCrft catalog.
 */
export interface ContentApiProduct {
  /** REST resource id (channel-assigned). Present on responses, omitted on insert. */
  id?: string;
  /** Merchant-supplied unique id for the offer (we use the CartCrft product/variant id). */
  offerId: string;
  title: string;
  description?: string;
  link: string;
  imageLink?: string;
  contentLanguage: string;
  targetCountry: string;
  channel: "online" | "local";
  availability: "in_stock" | "out_of_stock" | "preorder";
  condition: "new" | "refurbished" | "used";
  price: ContentApiPrice;
  brand?: string;
  gtin?: string;
  mpn?: string;
}

/** A single entry in a products.custombatch request. */
export interface ContentApiBatchEntry {
  batchId: number;
  merchantId: string;
  method: "insert" | "delete" | "get";
  /** Required for method=insert. */
  product?: ContentApiProduct;
  /** Required for method=delete/get. */
  productId?: string;
}

/** A single entry in a products.custombatch response. */
export interface ContentApiBatchResponseEntry {
  batchId: number;
  product?: ContentApiProduct & { id?: string };
  errors?: { code: number; message: string; errors?: unknown[] };
}

// ── CartCrft → Content API input shape ─────────────────────────────────────────

/**
 * The minimal CartCrft product/variant view needed to build a Content API
 * product resource. Mirrors the columns the feeds module reads (see
 * modules/feeds/service.ts getFeedItems): title/description, slug→link,
 * image, price, in/out-of-stock from inventory, brand, gtin/mpn.
 */
export interface ChannelProductInput {
  /** CartCrft product (or variant) id → Content API offerId. */
  offerId: string;
  title: string;
  description?: string;
  /** Absolute storefront product URL. */
  link: string;
  imageLink?: string;
  /** Numeric string, e.g. "12.99". */
  price: string;
  currency: string;
  /** true → in_stock, false → out_of_stock. */
  inStock: boolean;
  brand?: string;
  gtin?: string;
  mpn?: string;
  /** Defaults to "new". */
  condition?: "new" | "refurbished" | "used";
  /** BCP-47 content language, e.g. "en". Defaults to "en". */
  contentLanguage?: string;
  /** ISO-3166 target country, e.g. "US". Defaults to "US". */
  targetCountry?: string;
}

/**
 * Map a CartCrft product/variant into a Content API `product` resource.
 *
 * - availability: in_stock / out_of_stock from `inStock`.
 * - price: { value: "12.99", currency: "USD" } — value normalised to 2 dp,
 *   currency upper-cased (matches the XML feed's "12.99 USD" formatting).
 * - empty optional strings are omitted (exactOptionalPropertyTypes-friendly).
 */
export function toContentProduct(input: ChannelProductInput): ContentApiProduct {
  const value = Number.parseFloat(input.price);
  const priceStr = Number.isFinite(value) ? value.toFixed(2) : "0.00";

  const product: ContentApiProduct = {
    offerId: input.offerId,
    title: input.title,
    link: input.link,
    contentLanguage: input.contentLanguage ?? "en",
    targetCountry: (input.targetCountry ?? "US").toUpperCase(),
    channel: "online",
    availability: input.inStock ? "in_stock" : "out_of_stock",
    condition: input.condition ?? "new",
    price: { value: priceStr, currency: input.currency.toUpperCase() },
  };

  if (input.description) product.description = input.description;
  if (input.imageLink) product.imageLink = input.imageLink;
  if (input.brand) product.brand = input.brand;
  if (input.gtin) product.gtin = input.gtin;
  if (input.mpn) product.mpn = input.mpn;

  return product;
}

// ── Error ───────────────────────────────────────────────────────────────────────

export class GoogleShoppingAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(`google-shopping: status ${status}: ${message}`);
    this.name = "GoogleShoppingAPIError";
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class GoogleShoppingClient {
  constructor(private readonly accessToken: string) {}

  /**
   * Insert (upsert) a single product.
   * POST /{merchantId}/products
   */
  async insertProduct(
    merchantId: string,
    product: ContentApiProduct,
    signal?: AbortSignal
  ): Promise<ContentApiProduct> {
    const data = await this._do(
      "POST",
      `/${encodeURIComponent(merchantId)}/products`,
      product,
      signal
    );
    return data as ContentApiProduct;
  }

  /**
   * Batch insert/delete products.
   * POST /products/batch
   *
   * Each entry carries its own merchantId + method (insert|delete). The response
   * `entries[]` are matched back to requests by `batchId`.
   */
  async customBatchProducts(
    entries: ContentApiBatchEntry[],
    signal?: AbortSignal
  ): Promise<ContentApiBatchResponseEntry[]> {
    const data = await this._do(
      "POST",
      `/products/batch`,
      { entries },
      signal
    );
    const parsed = data as { entries?: ContentApiBatchResponseEntry[] };
    return parsed.entries ?? [];
  }

  /**
   * Delete a single product by its Content API REST id.
   * DELETE /{merchantId}/products/{productId}
   *
   * Returns 204 with an empty body on success.
   */
  async deleteProduct(
    merchantId: string,
    productId: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this._do(
      "DELETE",
      `/${encodeURIComponent(merchantId)}/products/${encodeURIComponent(productId)}`,
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
      throw new GoogleShoppingAPIError(res.status, text);
    }

    // DELETE / 204 → no body.
    if (res.status === 204 || text.trim() === "") {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new GoogleShoppingAPIError(
        res.status,
        `could not parse response: ${text.slice(0, 200)}`
      );
    }
  }
}

/**
 * Convenience factory — mirrors newBobGoClient(apiKey).
 *
 * BYO access token: the caller supplies a valid Google OAuth access token
 * (read decrypted from store_integrations). Token refresh is out of scope for
 * this pass (see file header).
 */
export function newGoogleShoppingClient(accessToken: string): GoogleShoppingClient {
  return new GoogleShoppingClient(accessToken);
}
