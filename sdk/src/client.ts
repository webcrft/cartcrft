/**
 * Cartcrft SDK — thin fetch-based typed client.
 *
 * Usage:
 *   // Storefront (public key, read-only)
 *   const sdk = new Cartcrft({ baseUrl: "https://api.cartcrft.dev", apiKey: "cc_pub_..." });
 *
 *   // Server-side (private key, read-write)
 *   const sdk = new Cartcrft({ baseUrl: "https://api.cartcrft.dev", apiKey: "cc_prv_..." });
 *
 *   // JWT auth (staff/admin)
 *   const sdk = new Cartcrft({ baseUrl: "https://api.cartcrft.dev", token: "eyJ..." });
 */

// ── Shared types ──────────────────────────────────────────────────────────────

export interface CartcrftOptions {
  /** Full base URL of the API, e.g. "http://localhost:3000" or "https://api.cartcrft.dev" */
  baseUrl: string;
  /** cc_pub_* (storefront) or cc_prv_* (server) API key */
  apiKey?: string;
  /** Staff JWT bearer token */
  token?: string;
  /** Additional default headers */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null> | undefined;
  headers?: Record<string, string> | undefined;
  /** Idempotency-Key header for mutating requests */
  idempotencyKey?: string | undefined;
}

export interface CartcrftError {
  code: string;
  message: string;
  details?: unknown;
}

export class CartcrftApiError extends Error {
  readonly status: number;
  readonly error: CartcrftError;

  constructor(status: number, error: CartcrftError) {
    super(`[${error.code}] ${error.message}`);
    this.name = "CartcrftApiError";
    this.status = status;
    this.error = error;
  }
}

// ── Pagination ─────────────────────────────────────────────────────────────────

export interface PageParams {
  limit?: number;
  offset?: number;
  /** Sort direction */
  sort?: "asc" | "desc";
}

// ── Resource helpers ────────────────────────────────────────────────────────────

/**
 * Typed request helper — wraps the generic `request()` escape hatch with
 * stricter in/out typing inferred from the OpenAPI schema.
 */
export type ApiResponse<T> = Promise<T>;

// ── Main client class ─────────────────────────────────────────────────────────

export class Cartcrft {
  private readonly baseUrl: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: CartcrftOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.defaultHeaders = {
      "content-type": "application/json",
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    if (options.apiKey) {
      this.defaultHeaders["authorization"] = `Bearer ${options.apiKey}`;
    } else if (options.token) {
      this.defaultHeaders["authorization"] = `Bearer ${options.token}`;
    }
  }

  // ── Generic typed escape hatch ───────────────────────────────────────────────

  /**
   * Make an arbitrary API request. Useful for paths not yet covered by the
   * named helpers, or for passing body/query params not modelled by helpers.
   *
   * @example
   * const result = await sdk.request("/commerce/stores", { method: "GET" });
   */
  async request<TResponse = unknown>(
    path: string,
    opts: RequestOptions = {}
  ): ApiResponse<TResponse> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v));
        }
      }
    }

    const headers: Record<string, string> = {
      ...this.defaultHeaders,
      ...(opts.headers ?? {}),
    };

    if (opts.idempotencyKey) {
      headers["idempotency-key"] = opts.idempotencyKey;
    }

    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
    };

    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url.toString(), init);

    if (!res.ok) {
      let errBody: { error?: CartcrftError } = {};
      try {
        errBody = (await res.json()) as typeof errBody;
      } catch {
        // Not JSON
      }
      throw new CartcrftApiError(
        res.status,
        errBody.error ?? {
          code: "HTTP_ERROR",
          message: `HTTP ${res.status} ${res.statusText}`,
        }
      );
    }

    // 204 No Content
    if (res.status === 204) {
      return undefined as unknown as TResponse;
    }

    return res.json() as Promise<TResponse>;
  }

  // ── Namespaced resource helpers ───────────────────────────────────────────────

  /** Store management */
  get stores() { return new StoresResource(this); }

  /** API key management */
  get apiKeys() { return new ApiKeysResource(this); }

  /** Catalog — products, variants, collections */
  get catalog() { return new CatalogResource(this); }

  /** Shopping carts */
  get carts() { return new CartsResource(this); }

  /** Checkout sessions */
  get checkout() { return new CheckoutResource(this); }

  /** Orders */
  get orders() { return new OrdersResource(this); }

  /** Payments */
  get payments() { return new PaymentsResource(this); }

  /** Customers */
  get customers() { return new CustomersResource(this); }

  /** Customer storefront auth */
  get customerAuth() { return new CustomerAuthResource(this); }

  /** Inventory */
  get inventory() { return new InventoryResource(this); }

  /** Shipping */
  get shipping() { return new ShippingResource(this); }

  /** Tax */
  get tax() { return new TaxResource(this); }

  /** Discounts */
  get discounts() { return new DiscountsResource(this); }

  /** Store credits (wallet) */
  get wallet() { return new WalletResource(this); }

  /** Gift cards */
  get giftCards() { return new GiftCardsResource(this); }

  /** B2B */
  get b2b() { return new B2bResource(this); }

  /** Subscriptions */
  get subscriptions() { return new SubscriptionsResource(this); }

  /** Returns / RMA */
  get returns() { return new ReturnsResource(this); }

  /** Digital products */
  get digital() { return new DigitalResource(this); }

  /** Wishlists + abandoned carts */
  get engagement() { return new EngagementResource(this); }

  /** Shopping feeds */
  get feeds() { return new FeedsResource(this); }

  /** Integrations + pixels */
  get integrations() { return new IntegrationsResource(this); }

  /** Notification providers */
  get notifications() { return new NotificationsResource(this); }

  /** Analytics */
  get analytics() { return new AnalyticsResource(this); }

  /** Semantic + full-text search */
  get search() { return new SearchResource(this); }

  /** Agent registry + mandates */
  get agents() { return new AgentsResource(this); }

  /** ACP adapter */
  get acp() { return new AcpResource(this); }
}

// ── Base class for resource namespaces ────────────────────────────────────────

/**
 * Build a RequestOptions object, omitting query if it's undefined.
 * This satisfies exactOptionalPropertyTypes.
 */
function withQuery<Q extends Record<string, string | number | boolean | undefined | null>>(
  base: Omit<RequestOptions, "query">,
  query: Q | undefined
): RequestOptions {
  if (query !== undefined) {
    return { ...base, query };
  }
  return base;
}

class BaseResource {
  protected readonly client: Cartcrft;
  constructor(client: Cartcrft) { this.client = client; }

  protected req<T>(path: string, opts?: RequestOptions): ApiResponse<T> {
    return this.client.request<T>(path, opts);
  }

  protected reqQ<T, Q extends Record<string, string | number | boolean | undefined | null>>(
    path: string,
    query: Q | undefined,
    base: Omit<RequestOptions, "query"> = {}
  ): ApiResponse<T> {
    return this.client.request<T>(path, withQuery(base, query));
  }
}

// ── Stores ─────────────────────────────────────────────────────────────────────

export interface Store {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  currency: string;
  timezone?: string | null;
  country_code?: string | null;
  email?: string | null;
  phone?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface CreateStoreBody {
  name: string;
  slug?: string;
  currency?: string;
  timezone?: string;
  country_code?: string;
  email?: string;
  phone?: string;
  weight_unit?: "g" | "kg" | "lb" | "oz";
  enable_currency_conversion?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateStoreBody extends Partial<CreateStoreBody> {
  is_active?: boolean;
}

class StoresResource extends BaseResource {
  list() { return this.req<{ stores: Store[] }>("/commerce/stores"); }
  get(storeId: string) { return this.req<{ store: Store }>(`/commerce/stores/${storeId}`); }
  create(body: CreateStoreBody) {
    return this.req<{ store: Store }>("/commerce/stores", { method: "POST", body });
  }
  update(storeId: string, body: UpdateStoreBody) {
    return this.req<{ store: Store }>(`/commerce/stores/${storeId}`, { method: "PUT", body });
  }
  delete(storeId: string) {
    return this.req<void>(`/commerce/stores/${storeId}`, { method: "DELETE" });
  }
}

// ── API Keys ───────────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  key_type: "public" | "private";
  key_masked: string;
  scopes: string[];
  store_id?: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface CreateApiKeyBody {
  name: string;
  key_type: "public" | "private";
  scopes?: string[];
  store_id?: string;
}

class ApiKeysResource extends BaseResource {
  list(query?: { store_id?: string }) {
    return this.reqQ<{ keys: ApiKey[] }, { store_id?: string }>("/api-keys", query);
  }
  create(body: CreateApiKeyBody) {
    return this.req<{ key: string; api_key: ApiKey }>("/api-keys", { method: "POST", body });
  }
  revoke(keyId: string) {
    return this.req<void>(`/api-keys/${keyId}`, { method: "DELETE" });
  }
}

// ── Catalog ────────────────────────────────────────────────────────────────────

export interface Product {
  id: string;
  store_id: string;
  title: string;
  slug: string;
  description?: string | null;
  product_type: string;
  status: string;
  price_min?: string | null;
  price_max?: string | null;
  variants_count?: number;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface Variant {
  id: string;
  product_id: string;
  title: string;
  sku?: string | null;
  price: string;
  compare_at_price?: string | null;
  inventory_quantity?: number;
  track_inventory: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface Collection {
  id: string;
  store_id: string;
  title: string;
  slug: string;
  collection_type: "manual" | "smart";
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface ListProductsQuery extends PageParams {
  status?: string;
  product_type?: string;
  collection_id?: string;
  q?: string;
}

export interface CreateProductBody {
  title: string;
  slug?: string;
  description?: string;
  product_type?: string;
  status?: string;
  vendor?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateVariantBody {
  title: string;
  sku?: string;
  price: string;
  compare_at_price?: string;
  cost?: string;
  track_inventory?: boolean;
  inventory_quantity?: number;
  weight_g?: number;
  metadata?: Record<string, unknown>;
}

class CatalogResource extends BaseResource {
  // Products
  listProducts(storeId: string, query?: ListProductsQuery) {
    return this.req<{ products: Product[]; total: number }>(`/commerce/stores/${storeId}/products`, { query: query as Record<string, string | number | boolean | undefined | null> });
  }
  /** Get product — returns the product object directly (not wrapped) */
  getProduct(storeId: string, productId: string) {
    return this.req<Product>(`/commerce/stores/${storeId}/products/${productId}`);
  }
  createProduct(storeId: string, body: CreateProductBody) {
    return this.req<{ product: Product }>(`/commerce/stores/${storeId}/products`, { method: "POST", body });
  }
  updateProduct(storeId: string, productId: string, body: Partial<CreateProductBody>) {
    return this.req<{ product: Product }>(`/commerce/stores/${storeId}/products/${productId}`, { method: "PUT", body });
  }
  deleteProduct(storeId: string, productId: string) {
    return this.req<void>(`/commerce/stores/${storeId}/products/${productId}`, { method: "DELETE" });
  }

  // Variants
  listVariants(storeId: string, productId: string) {
    return this.req<{ variants: Variant[] }>(`/commerce/stores/${storeId}/products/${productId}/variants`);
  }
  createVariant(storeId: string, productId: string, body: CreateVariantBody) {
    return this.req<{ variant: Variant }>(`/commerce/stores/${storeId}/products/${productId}/variants`, { method: "POST", body });
  }
  updateVariant(storeId: string, productId: string, variantId: string, body: Partial<CreateVariantBody>) {
    return this.req<{ variant: Variant }>(`/commerce/stores/${storeId}/products/${productId}/variants/${variantId}`, { method: "PUT", body });
  }
  deleteVariant(storeId: string, productId: string, variantId: string) {
    return this.req<void>(`/commerce/stores/${storeId}/products/${productId}/variants/${variantId}`, { method: "DELETE" });
  }

  // Collections
  listCollections(storeId: string) {
    return this.req<{ collections: Collection[] }>(`/commerce/stores/${storeId}/collections`);
  }
  getCollection(storeId: string, collectionId: string) {
    return this.req<{ collection: Collection }>(`/commerce/stores/${storeId}/collections/${collectionId}`);
  }
  createCollection(storeId: string, body: { title: string; slug?: string; collection_type?: "manual" | "smart"; description?: string }) {
    return this.req<{ collection: Collection }>(`/commerce/stores/${storeId}/collections`, { method: "POST", body });
  }
  getCollectionProducts(storeId: string, collectionId: string) {
    return this.req<{ products: Product[] }>(`/commerce/stores/${storeId}/collections/${collectionId}/products`);
  }

  // Price lists
  listPriceLists(storeId: string) {
    return this.req<{ price_lists: unknown[] }>(`/commerce/stores/${storeId}/price-lists`);
  }
}

// ── Carts ─────────────────────────────────────────────────────────────────────

export interface Cart {
  id: string;
  store_id: string;
  status: string;
  currency: string;
  lines: CartLine[];
  subtotal?: string | null;
  total?: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface CartLine {
  id: string;
  cart_id: string;
  variant_id: string;
  quantity: number;
  unit_price: string;
  line_total: string;
  [key: string]: unknown;
}

export interface CreateCartBody {
  currency?: string;
  customer_id?: string;
  metadata?: Record<string, unknown>;
}

export interface AddCartLineBody {
  variant_id: string;
  quantity: number;
  metadata?: Record<string, unknown>;
}

class CartsResource extends BaseResource {
  /** Create cart — returns { id: string } */
  create(storeId: string, body?: CreateCartBody) {
    return this.req<{ id: string }>(`/commerce/stores/${storeId}/carts`, { method: "POST", body: body ?? {} });
  }
  /** Get full cart object */
  get(storeId: string, cartId: string) {
    return this.req<Cart>(`/commerce/stores/${storeId}/carts/${cartId}`);
  }
  /** Add line — returns { id: string } */
  addLine(storeId: string, cartId: string, body: AddCartLineBody) {
    return this.req<{ id: string }>(`/commerce/stores/${storeId}/carts/${cartId}/lines`, { method: "POST", body });
  }
  updateLine(storeId: string, cartId: string, lineId: string, body: { quantity: number }) {
    return this.req<{ ok: boolean }>(`/commerce/stores/${storeId}/carts/${cartId}/lines/${lineId}`, { method: "PATCH", body });
  }
  removeLine(storeId: string, cartId: string, lineId: string) {
    return this.req<{ ok: boolean }>(`/commerce/stores/${storeId}/carts/${cartId}/lines/${lineId}`, { method: "DELETE" });
  }
}

// ── Checkout ──────────────────────────────────────────────────────────────────

export interface Address {
  name?: string;
  phone?: string;
  email?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province_code?: string;
  zip?: string;
  country_code?: string;
  [key: string]: unknown;
}

export interface CheckoutSession {
  id: string;
  store_id: string;
  cart_id: string;
  status: string;
  email?: string | null;
  shipping_address?: Address | null;
  billing_address?: Address | null;
  discount_code?: string | null;
  subtotal?: string | null;
  tax_total?: string | null;
  shipping_total?: string | null;
  discount_total?: string | null;
  total?: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface CreateCheckoutBody {
  cart_id: string;
  customer_id?: string;
  email?: string;
  shipping_address?: Address;
  billing_address?: Address;
  shipping_rate?: { id?: string; [key: string]: unknown };
  discount_code?: string;
}

export interface UpdateCheckoutBody {
  email?: string;
  shipping_address?: Address;
  billing_address?: Address;
  shipping_rate?: { id?: string; [key: string]: unknown };
  discount_code?: string;
}

export interface CompleteCheckoutBody {
  test_mode?: boolean;
  payment_reference?: string;
}

export interface Order {
  id: string;
  store_id: string;
  order_number: string;
  status: string;
  financial_status: string;
  fulfillment_status: string;
  email?: string | null;
  total: string;
  currency: string;
  test: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

class CheckoutResource extends BaseResource {
  /** Create checkout — returns the checkout totals + id directly */
  create(storeId: string, body: CreateCheckoutBody) {
    return this.req<CheckoutSession>(`/commerce/stores/${storeId}/checkouts`, { method: "POST", body });
  }
  /** Get full checkout object */
  get(storeId: string, checkoutId: string) {
    return this.req<CheckoutSession>(`/commerce/stores/${storeId}/checkouts/${checkoutId}`);
  }
  /** Update checkout (email, address, discount) — returns updated totals */
  update(storeId: string, checkoutId: string, body: UpdateCheckoutBody) {
    return this.req<CheckoutSession>(`/commerce/stores/${storeId}/checkouts/${checkoutId}`, { method: "PUT", body });
  }
  /** Complete checkout — returns { order_id, order_number } */
  complete(storeId: string, checkoutId: string, body?: CompleteCheckoutBody) {
    return this.req<{ order_id: string; order_number: string }>(`/commerce/stores/${storeId}/checkouts/${checkoutId}/complete`, { method: "POST", body: body ?? {} });
  }
  initiatePayment(storeId: string, checkoutId: string, body: { provider: string; [key: string]: unknown }) {
    return this.req<unknown>(`/commerce/stores/${storeId}/checkouts/${checkoutId}/payment-session`, { method: "POST", body });
  }
}

// ── Orders ─────────────────────────────────────────────────────────────────────

export interface ListOrdersQuery extends PageParams {
  status?: string;
  financial_status?: string;
  fulfillment_status?: string;
  customer_id?: string;
  test?: boolean;
}

class OrdersResource extends BaseResource {
  list(storeId: string, query?: ListOrdersQuery) {
    return this.req<{ orders: Order[]; total: number }>(`/commerce/stores/${storeId}/orders`, { query: query as Record<string, string | number | boolean | undefined | null> });
  }
  get(storeId: string, orderId: string) {
    return this.req<{ order: Order }>(`/commerce/stores/${storeId}/orders/${orderId}`);
  }
  cancel(storeId: string, orderId: string, body?: { reason?: string }) {
    return this.req<{ order: Order }>(`/commerce/stores/${storeId}/orders/${orderId}/cancel`, { method: "POST", body: body ?? {} });
  }
  addNote(storeId: string, orderId: string, body: { note: string }) {
    return this.req<unknown>(`/commerce/stores/${storeId}/orders/${orderId}/notes`, { method: "POST", body });
  }
  listEvents(storeId: string, orderId: string) {
    return this.req<{ events: unknown[] }>(`/commerce/stores/${storeId}/orders/${orderId}/events`);
  }
}

// ── Payments ──────────────────────────────────────────────────────────────────

export interface Payment {
  id: string;
  order_id: string;
  provider: string;
  status: string;
  amount: string;
  currency: string;
  created_at: string;
  [key: string]: unknown;
}

class PaymentsResource extends BaseResource {
  list(storeId: string, orderId: string) {
    return this.req<{ payments: Payment[] }>(`/commerce/stores/${storeId}/orders/${orderId}/payments`);
  }
  capture(storeId: string, orderId: string, paymentId: string, body?: { amount?: string }) {
    return this.req<{ payment: Payment }>(`/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/capture`, { method: "POST", body: body ?? {} });
  }
  refund(storeId: string, orderId: string, paymentId: string, body: { amount: string; reason?: string }) {
    return this.req<unknown>(`/commerce/stores/${storeId}/orders/${orderId}/payments/${paymentId}/refund`, { method: "POST", body });
  }
}

// ── Customers ─────────────────────────────────────────────────────────────────

export interface Customer {
  id: string;
  store_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface ListCustomersQuery extends PageParams {
  q?: string;
  email?: string;
}

class CustomersResource extends BaseResource {
  list(storeId: string, query?: ListCustomersQuery) {
    return this.req<{ customers: Customer[]; total: number }>(`/commerce/stores/${storeId}/customers`, { query: query as Record<string, string | number | boolean | undefined | null> });
  }
  get(storeId: string, customerId: string) {
    return this.req<{ customer: Customer }>(`/commerce/stores/${storeId}/customers/${customerId}`);
  }
  create(storeId: string, body: { email: string; first_name?: string; last_name?: string; phone?: string; [key: string]: unknown }) {
    return this.req<{ customer: Customer }>(`/commerce/stores/${storeId}/customers`, { method: "POST", body });
  }
  update(storeId: string, customerId: string, body: Partial<Customer>) {
    return this.req<{ customer: Customer }>(`/commerce/stores/${storeId}/customers/${customerId}`, { method: "PUT", body });
  }
  delete(storeId: string, customerId: string) {
    return this.req<void>(`/commerce/stores/${storeId}/customers/${customerId}`, { method: "DELETE" });
  }
  listAddresses(storeId: string, customerId: string) {
    return this.req<{ addresses: Address[] }>(`/commerce/stores/${storeId}/customers/${customerId}/addresses`);
  }
}

// ── Customer Auth ─────────────────────────────────────────────────────────────

export interface CustomerAuthInfo {
  enabled: boolean;
  providers: string[];
  [key: string]: unknown;
}

export interface CustomerSession {
  access_token: string;
  refresh_token: string;
  customer: Customer;
}

class CustomerAuthResource extends BaseResource {
  getConfig(storeId: string) {
    return this.req<{ auth: CustomerAuthInfo }>(`/commerce/stores/${storeId}/auth/config`);
  }
  getInfo(storeId: string) {
    return this.req<CustomerAuthInfo>(`/commerce/stores/${storeId}/auth/info`);
  }
  register(storeId: string, body: { email: string; password: string; first_name?: string; last_name?: string }) {
    return this.req<{ customer: Customer }>(`/commerce/stores/${storeId}/auth/register`, { method: "POST", body });
  }
  login(storeId: string, body: { email: string; password: string }) {
    return this.req<CustomerSession>(`/commerce/stores/${storeId}/auth/login`, { method: "POST", body });
  }
  logout(storeId: string, body?: { refresh_token?: string }) {
    return this.req<void>(`/commerce/stores/${storeId}/auth/logout`, { method: "POST", body: body ?? {} });
  }
  refresh(storeId: string, body: { refresh_token: string }) {
    return this.req<CustomerSession>(`/commerce/stores/${storeId}/auth/token/refresh`, { method: "POST", body });
  }
  me(storeId: string) {
    return this.req<{ customer: Customer }>(`/commerce/stores/${storeId}/auth/me`);
  }
  requestPasswordReset(storeId: string, body: { email: string }) {
    return this.req<void>(`/commerce/stores/${storeId}/auth/password/reset`, { method: "POST", body });
  }
  requestMagicLink(storeId: string, body: { email: string }) {
    return this.req<void>(`/commerce/stores/${storeId}/auth/magic-link`, { method: "POST", body });
  }
}

// ── Inventory ─────────────────────────────────────────────────────────────────

export interface Warehouse {
  id: string;
  store_id: string;
  name: string;
  is_default: boolean;
  created_at: string;
  [key: string]: unknown;
}

export interface InventoryLevel {
  variant_id: string;
  warehouse_id: string;
  on_hand: number;
  committed: number;
  available: number;
  [key: string]: unknown;
}

class InventoryResource extends BaseResource {
  listWarehouses(storeId: string) {
    return this.req<{ warehouses: Warehouse[] }>(`/commerce/stores/${storeId}/warehouses`);
  }
  createWarehouse(storeId: string, body: { name: string; is_default?: boolean; address?: Address }) {
    return this.req<{ warehouse: Warehouse }>(`/commerce/stores/${storeId}/warehouses`, { method: "POST", body });
  }
  listLevels(storeId: string, query?: { warehouse_id?: string; variant_id?: string }) {
    return this.reqQ<{ levels: InventoryLevel[] }, { warehouse_id?: string; variant_id?: string }>(`/commerce/stores/${storeId}/inventory/levels`, query);
  }
  setLevel(storeId: string, body: { variant_id: string; warehouse_id: string; on_hand: number }) {
    return this.req<{ level: InventoryLevel }>(`/commerce/stores/${storeId}/inventory/levels`, { method: "POST", body });
  }
  adjustLevel(storeId: string, body: { variant_id: string; warehouse_id: string; delta: number; reason?: string }) {
    return this.req<{ level: InventoryLevel }>(`/commerce/stores/${storeId}/inventory/adjust`, { method: "POST", body });
  }
}

// ── Shipping ──────────────────────────────────────────────────────────────────

export interface ShippingZone {
  id: string;
  store_id: string;
  name: string;
  created_at: string;
  [key: string]: unknown;
}

class ShippingResource extends BaseResource {
  listZones(storeId: string) {
    return this.req<{ zones: ShippingZone[] }>(`/commerce/stores/${storeId}/shipping/zones`);
  }
  createZone(storeId: string, body: { name: string; regions?: unknown[] }) {
    return this.req<{ zone: ShippingZone }>(`/commerce/stores/${storeId}/shipping/zones`, { method: "POST", body });
  }
  listAvailable(storeId: string, query: { cart_id: string; destination_country?: string }) {
    return this.req<{ rates: unknown[] }>(`/commerce/stores/${storeId}/shipping-rates/available`, { query });
  }
  listShipments(storeId: string, query?: { order_id?: string }) {
    return this.reqQ<{ shipments: unknown[] }, { order_id?: string }>(`/commerce/stores/${storeId}/shipments`, query);
  }
}

// ── Tax ───────────────────────────────────────────────────────────────────────

class TaxResource extends BaseResource {
  listCategories(storeId: string) {
    return this.req<{ categories: unknown[] }>(`/commerce/stores/${storeId}/tax/categories`);
  }
  listZones(storeId: string) {
    return this.req<{ zones: unknown[] }>(`/commerce/stores/${storeId}/tax/zones`);
  }
}

// ── Discounts ─────────────────────────────────────────────────────────────────

export interface Discount {
  id: string;
  store_id: string;
  code: string;
  discount_type: string;
  value: string;
  is_active: boolean;
  created_at: string;
  [key: string]: unknown;
}

class DiscountsResource extends BaseResource {
  list(storeId: string) {
    return this.req<{ discounts: Discount[] }>(`/commerce/stores/${storeId}/discounts`);
  }
  get(storeId: string, discountId: string) {
    return this.req<{ discount: Discount }>(`/commerce/stores/${storeId}/discounts/${discountId}`);
  }
  /**
   * Validate a discount code — returns { discount_id, code, type, value, computed_amount? }
   * or throws 404 if the code doesn't exist / isn't applicable.
   */
  validate(storeId: string, query: { code: string; customer_id?: string; order_total?: string }) {
    return this.req<{ discount_id: string; code: string; type: string; value: string; computed_amount?: string }>(`/commerce/stores/${storeId}/discounts/validate`, { query });
  }
  create(storeId: string, body: { code: string; discount_type: string; value: string; [key: string]: unknown }) {
    return this.req<{ discount: Discount }>(`/commerce/stores/${storeId}/discounts`, { method: "POST", body });
  }
}

// ── Wallet ────────────────────────────────────────────────────────────────────

class WalletResource extends BaseResource {
  getBalance(storeId: string, customerId: string) {
    return this.req<{ balance: string; currency: string }>(`/commerce/stores/${storeId}/customers/${customerId}/credits`);
  }
  issue(storeId: string, customerId: string, body: { amount: string; reason?: string }) {
    return this.req<unknown>(`/commerce/stores/${storeId}/customers/${customerId}/credits/issue`, { method: "POST", body });
  }
  adjust(storeId: string, customerId: string, body: { delta: string; reason?: string }) {
    return this.req<unknown>(`/commerce/stores/${storeId}/customers/${customerId}/credits/adjust`, { method: "POST", body });
  }
  listTransactions(storeId: string, customerId: string) {
    return this.req<{ transactions: unknown[] }>(`/commerce/stores/${storeId}/customers/${customerId}/credits/transactions`);
  }
}

// ── Gift Cards ────────────────────────────────────────────────────────────────

export interface GiftCard {
  id: string;
  store_id: string;
  code: string;
  initial_value: string;
  balance: string;
  currency: string;
  is_active: boolean;
  created_at: string;
  [key: string]: unknown;
}

class GiftCardsResource extends BaseResource {
  list(storeId: string) {
    return this.req<{ gift_cards: GiftCard[] }>(`/commerce/stores/${storeId}/gift-cards`);
  }
  get(storeId: string, giftCardId: string) {
    return this.req<{ gift_card: GiftCard }>(`/commerce/stores/${storeId}/gift-cards/${giftCardId}`);
  }
  create(storeId: string, body: { initial_value: string; currency?: string; customer_id?: string }) {
    return this.req<{ gift_card: GiftCard }>(`/commerce/stores/${storeId}/gift-cards`, { method: "POST", body });
  }
  lookup(storeId: string, code: string) {
    return this.req<{ gift_card: GiftCard }>(`/commerce/stores/${storeId}/gift-cards/lookup`, { query: { code } });
  }
}

// ── B2B ───────────────────────────────────────────────────────────────────────

class B2bResource extends BaseResource {
  listCompanies(storeId: string) {
    return this.req<{ companies: unknown[] }>(`/commerce/stores/${storeId}/companies`);
  }
  createCompany(storeId: string, body: { name: string; [key: string]: unknown }) {
    return this.req<{ company: unknown }>(`/commerce/stores/${storeId}/companies`, { method: "POST", body });
  }
  listQuotes(storeId: string) {
    return this.req<{ quotes: unknown[] }>(`/commerce/stores/${storeId}/quotes`);
  }
  createQuote(storeId: string, body: { company_id: string; [key: string]: unknown }) {
    return this.req<{ quote: unknown }>(`/commerce/stores/${storeId}/quotes`, { method: "POST", body });
  }
}

// ── Subscriptions ──────────────────────────────────────────────────────────────

class SubscriptionsResource extends BaseResource {
  listPlans(storeId: string) {
    return this.req<{ plans: unknown[] }>(`/commerce/stores/${storeId}/subscription-plans`);
  }
  createPlan(storeId: string, body: { name: string; interval: string; interval_count: number; price: string; [key: string]: unknown }) {
    return this.req<{ plan: unknown }>(`/commerce/stores/${storeId}/subscription-plans`, { method: "POST", body });
  }
  list(storeId: string) {
    return this.req<{ subscriptions: unknown[] }>(`/commerce/stores/${storeId}/subscriptions`);
  }
  create(storeId: string, body: { customer_id: string; plan_id: string; [key: string]: unknown }) {
    return this.req<{ subscription: unknown }>(`/commerce/stores/${storeId}/subscriptions`, { method: "POST", body });
  }
}

// ── Returns ───────────────────────────────────────────────────────────────────

class ReturnsResource extends BaseResource {
  list(storeId: string) {
    return this.req<{ returns: unknown[] }>(`/commerce/stores/${storeId}/returns`);
  }
  create(storeId: string, body: { order_id: string; lines: unknown[]; [key: string]: unknown }) {
    return this.req<{ return: unknown }>(`/commerce/stores/${storeId}/returns`, { method: "POST", body });
  }
  get(storeId: string, returnId: string) {
    return this.req<{ return: unknown }>(`/commerce/stores/${storeId}/returns/${returnId}`);
  }
  approve(storeId: string, returnId: string) {
    return this.req<unknown>(`/commerce/stores/${storeId}/returns/${returnId}/approve`, { method: "POST", body: {} });
  }
  receive(storeId: string, returnId: string, body?: unknown) {
    return this.req<unknown>(`/commerce/stores/${storeId}/returns/${returnId}/receive`, { method: "POST", body: body ?? {} });
  }
}

// ── Digital ───────────────────────────────────────────────────────────────────

class DigitalResource extends BaseResource {
  listFiles(storeId: string, productId: string) {
    return this.req<{ files: unknown[] }>(`/commerce/stores/${storeId}/products/${productId}/digital-files`);
  }
  createFile(storeId: string, productId: string, body: { name: string; url: string; size_bytes?: number }) {
    return this.req<{ file: unknown }>(`/commerce/stores/${storeId}/products/${productId}/digital-files`, { method: "POST", body });
  }
  createDownloadLink(storeId: string, fileId: string, body?: { max_downloads?: number; expires_in_hours?: number }) {
    return this.req<{ url: string; token: string }>(`/commerce/stores/${storeId}/digital-files/${fileId}/download-link`, { method: "POST", body: body ?? {} });
  }
}

// ── Engagement ────────────────────────────────────────────────────────────────

class EngagementResource extends BaseResource {
  listWishlists(storeId: string) {
    return this.req<{ wishlists: unknown[] }>(`/commerce/stores/${storeId}/wishlists`);
  }
  createWishlist(storeId: string, body: { customer_id: string; name?: string }) {
    return this.req<{ wishlist: unknown }>(`/commerce/stores/${storeId}/wishlists`, { method: "POST", body });
  }
  listAbandonedCarts(storeId: string) {
    return this.req<{ carts: unknown[] }>(`/commerce/stores/${storeId}/abandoned-carts`);
  }
}

// ── Feeds ─────────────────────────────────────────────────────────────────────

class FeedsResource extends BaseResource {
  googleShopping(storeId: string) {
    return this.req<string>(`/commerce/stores/${storeId}/feeds/google-shopping`);
  }
  facebookCatalog(storeId: string) {
    return this.req<string>(`/commerce/stores/${storeId}/feeds/facebook-catalog`);
  }
  listMerchantFeeds(storeId: string) {
    return this.req<{ feeds: unknown[] }>(`/commerce/stores/${storeId}/merchant-feeds`);
  }
}

// ── Integrations ──────────────────────────────────────────────────────────────

class IntegrationsResource extends BaseResource {
  listDefinitions() {
    return this.req<{ definitions: unknown[] }>("/integrations/definitions");
  }
  list(storeId: string) {
    return this.req<{ integrations: unknown[] }>(`/commerce/stores/${storeId}/integrations`);
  }
  create(storeId: string, body: { integration_definition_id: string; credentials?: unknown }) {
    return this.req<{ integration: unknown }>(`/commerce/stores/${storeId}/integrations`, { method: "POST", body });
  }
  listPixels(storeId: string) {
    return this.req<{ pixels: unknown[] }>(`/commerce/stores/${storeId}/tracking-pixels`);
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────

class NotificationsResource extends BaseResource {
  listProviders(storeId: string) {
    return this.req<{ providers: unknown[] }>(`/commerce/stores/${storeId}/notification-providers`);
  }
  createProvider(storeId: string, body: { type: string; name: string; config: unknown }) {
    return this.req<{ provider: unknown }>(`/commerce/stores/${storeId}/notification-providers`, { method: "POST", body });
  }
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  orders_count: number;
  revenue: string;
  average_order_value: string;
  [key: string]: unknown;
}

class AnalyticsResource extends BaseResource {
  overview(storeId: string, query?: { start_date?: string; end_date?: string }) {
    return this.reqQ<AnalyticsOverview, { start_date?: string; end_date?: string }>(`/analytics/${storeId}/overview`, query);
  }
  products(storeId: string, query?: { start_date?: string; end_date?: string }) {
    return this.reqQ<unknown, { start_date?: string; end_date?: string }>(`/analytics/${storeId}/products`, query);
  }
  funnel(storeId: string) {
    return this.req<unknown>(`/analytics/${storeId}/funnel`);
  }
  revenue(storeId: string, query?: { start_date?: string; end_date?: string }) {
    return this.reqQ<unknown, { start_date?: string; end_date?: string }>(`/analytics/${storeId}/revenue`, query);
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResultItem {
  id: string;
  title: string;
  description?: string | null;
  price_min?: string | null;
  [key: string]: unknown;
}

export interface SearchResult {
  results: SearchResultItem[];
  query: string;
  total: number;
}

export interface SearchQuery {
  /** Natural language query string */
  query: string;
  limit?: number;
  filters?: {
    price_min?: number;
    price_max?: number;
    collection_id?: string;
    in_stock?: boolean;
  };
}

class SearchResource extends BaseResource {
  search(storeId: string, body: SearchQuery) {
    return this.req<SearchResult>(`/commerce/stores/${storeId}/search`, { method: "POST", body });
  }
}

// ── Agents ────────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  store_id: string;
  name: string;
  type: string;
  public_key: string;
  created_at: string;
  [key: string]: unknown;
}

export interface Mandate {
  id: string;
  agent_id: string;
  intent: string;
  created_at: string;
  [key: string]: unknown;
}

class AgentsResource extends BaseResource {
  list(storeId: string) {
    return this.req<{ agents: Agent[] }>(`/commerce/stores/${storeId}/agents`);
  }
  create(storeId: string, body: { name: string; type: string; scopes?: string[]; spend_limit?: string }) {
    return this.req<{ agent: Agent; private_key: string }>(`/commerce/stores/${storeId}/agents`, { method: "POST", body });
  }
  get(storeId: string, agentId: string) {
    return this.req<{ agent: Agent }>(`/commerce/stores/${storeId}/agents/${agentId}`);
  }
  listMandates(storeId: string, agentId: string) {
    return this.req<{ mandates: Mandate[] }>(`/commerce/stores/${storeId}/agents/${agentId}/mandates`);
  }
  createMandate(storeId: string, agentId: string, body: { intent: string; payload?: unknown; [key: string]: unknown }) {
    return this.req<{ mandate: Mandate }>(`/commerce/stores/${storeId}/agents/${agentId}/mandates`, { method: "POST", body });
  }
}

// ── ACP ───────────────────────────────────────────────────────────────────────

export interface AcpCheckoutSession {
  id: string;
  status: string;
  total?: { amount: string; currency: string };
  [key: string]: unknown;
}

class AcpResource extends BaseResource {
  getFeed(storeId: string, query?: { cursor?: string; limit?: number }) {
    return this.req<{ items: unknown[]; next_cursor?: string }>(`/acp/${storeId}/feed`, { query: query as Record<string, string | number | boolean | undefined | null> });
  }
  createSession(storeId: string, body: { cart: unknown; [key: string]: unknown }) {
    return this.req<AcpCheckoutSession>(`/acp/${storeId}/checkout_sessions`, { method: "POST", body });
  }
  getSession(storeId: string, sessionId: string) {
    return this.req<AcpCheckoutSession>(`/acp/${storeId}/checkout_sessions/${sessionId}`);
  }
  updateSession(storeId: string, sessionId: string, body: unknown) {
    return this.req<AcpCheckoutSession>(`/acp/${storeId}/checkout_sessions/${sessionId}/update`, { method: "POST", body });
  }
  completeSession(storeId: string, sessionId: string, body?: unknown) {
    return this.req<{ order: Order }>(`/acp/${storeId}/checkout_sessions/${sessionId}/complete`, { method: "POST", body: body ?? {} });
  }
}
