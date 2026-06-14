/**
 * Cartcrft Storefront SDK
 *
 * Drop in ONE script and you get:
 *   • Alpine.store('cart', …)   — cart, native checkout
 *   • window.CartcrftCart        — same store, callable without Alpine
 *   • window.CartcrftAuth(storeId, opts?) — customer auth client
 *
 * Usage:
 *   <script src="https://your-api.example.com/storefront.js"></script>
 *   <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
 *
 * Cart (Alpine):
 *   $store.cart.add(product) / .remove(variantId) / .updateQty / .clear / .items
 *   $store.cart.checkoutNative({storeId, publicKey, email, customerId?, …})
 *
 * Cart (plain JS):
 *   CartcrftCart.add(product); CartcrftCart.items
 *
 * Customer auth:
 *   const auth = new CartcrftAuth(STORE_ID);   // baseUrl auto-derived
 *   await auth.init();                          // restore + validate
 *   await auth.login(email, password);
 *   const user = await auth.getUser();
 *
 * Init forms for CartcrftAuth (baseUrl resolution, in priority order):
 *   1) Explicit option:
 *        new CartcrftAuth(storeId, { baseUrl: 'https://api.example.com' });
 *   2) Script-tag with data-api override (SDK hosted separately from API):
 *        <script src="https://cdn.example.com/storefront.js" data-api="https://api.example.com"></script>
 *   3) Auto-derived from <script src> origin (SDK and API on same origin):
 *        <script src="https://api.example.com/storefront.js"></script>
 *
 * If none of those resolve a baseUrl, the CartcrftAuth constructor throws —
 * the SDK does not fall back to relative URLs against the page origin.
 */

// ── Resolve API base URL from the <script> tag that loaded this file ──
// Captured synchronously at module-evaluation time so document.currentScript
// is still defined. Returns '' if it cannot resolve.
const DERIVED_BASE: string = ((): string => {
  try {
    const s = document.currentScript as HTMLScriptElement | null;
    if (!s || !s.src) return '';
    if (s.dataset?.['api']) return s.dataset['api'].replace(/\/+$/, '');
    return new URL(s.src).origin;
  } catch {
    return '';
  }
})();

// ═══════════════════════════════════════════════════════════════════════════
// Section 0: Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CartItem {
  variant_id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface CartProduct {
  title: string;
  variants?: Array<{ id: string; price: number }>;
}

export interface CheckoutOpts {
  storeId: string;
  publicKey: string;
  email?: string;
  customerId?: string;
  shippingAddress?: Record<string, unknown>;
  shippingRateId?: string;
  discountCode?: string;
  /** Razorpay widget options passthrough (key, name, description, image, prefill, theme, …) */
  razorpayOptions?: Record<string, unknown>;
}

export interface CheckoutResult {
  order_id?: string;
  order_number?: string;
  provider?: string;
  client_secret?: string;
  authorization_url?: string;
  invoice_url?: string;
  checkout_id?: string;
}

export interface AuthOptions {
  baseUrl?: string;
}

export interface AuthSession {
  sessionToken: string;
  accessToken: string;
}

export type AuthChangeListener = (session: AuthSession | null) => void;

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Cart store
// ═══════════════════════════════════════════════════════════════════════════

const CART_KEY = 'cc_cart';

// ── Safe storage (works when localStorage is blocked, e.g. sandboxed preview)

function storageGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as T | null | undefined;
    return parsed !== null && parsed !== undefined ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function storageSet(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sandboxed */ }
}

function storageRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* sandboxed */ }
}

// ── CustomEvent helpers

function emitEvent(name: string, detail?: unknown): void {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  } catch { /* non-browser env */ }
}

// ── Fetch helper with typed error

interface ApiError extends Error {
  status?: number;
  detail?: unknown;
}

function postJSON(path: string, body: unknown, authHdr: Record<string, string>): Promise<Record<string, unknown>> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHdr },
    body: JSON.stringify(body ?? {}),
  }).then((res) => {
    return res.json().then((data: Record<string, unknown>) => {
      if (!res.ok) {
        const err: ApiError = new Error(
          ((data['error'] as string | undefined) ??
          (data['message'] as string | undefined) ??
          `HTTP ${res.status}`)
        );
        err.status = res.status;
        err.detail = data;
        throw err;
      }
      return data;
    });
  });
}

export interface CartStore {
  items: CartItem[];
  showCart: boolean;
  checkingOut: boolean;
  readonly count: number;
  readonly total: number;
  add(product: CartProduct): void;
  addVariant(variantId: string, name: string, price: number, quantity?: number): void;
  remove(variantId: string): void;
  updateQty(variantId: string, qty: number): void;
  clear(): void;
  checkoutNative(opts: CheckoutOpts): Promise<CheckoutResult | null>;
}

function makeCartStore(): CartStore {
  const store: CartStore = {
    items: storageGet<CartItem[]>(CART_KEY, []),
    showCart: false,
    checkingOut: false,

    get count(): number {
      return this.items.reduce((s, i) => s + i.quantity, 0);
    },

    get total(): number {
      return this.items.reduce((s, i) => s + i.price * i.quantity, 0);
    },

    /**
     * Add a product to the cart. Uses the first variant; increments
     * quantity if that variant is already in the cart.
     * product shape: { title, variants: [{ id, price }] }
     */
    add(product: CartProduct): void {
      const variant = product.variants?.[0];
      if (!variant) return;
      const existing = this.items.find((i) => i.variant_id === variant.id);
      if (existing) {
        existing.quantity++;
      } else {
        this.items.push({
          variant_id: variant.id,
          name: product.title,
          price: variant.price,
          quantity: 1,
        });
      }
      storageSet(CART_KEY, this.items);
      emitEvent('cartcrft:cart-updated', { items: this.items, count: this.count, total: this.total });
    },

    /**
     * Add a specific variant directly (for when you already know the variant).
     */
    addVariant(variantId: string, name: string, price: number, quantity = 1): void {
      const existing = this.items.find((i) => i.variant_id === variantId);
      if (existing) {
        existing.quantity += quantity;
      } else {
        this.items.push({ variant_id: variantId, name, price, quantity });
      }
      storageSet(CART_KEY, this.items);
      emitEvent('cartcrft:cart-updated', { items: this.items, count: this.count, total: this.total });
    },

    remove(variantId: string): void {
      this.items = this.items.filter((i) => i.variant_id !== variantId);
      storageSet(CART_KEY, this.items);
      emitEvent('cartcrft:cart-updated', { items: this.items, count: this.count, total: this.total });
    },

    updateQty(variantId: string, qty: number): void {
      if (qty <= 0) { this.remove(variantId); return; }
      const item = this.items.find((i) => i.variant_id === variantId);
      if (item) item.quantity = qty;
      storageSet(CART_KEY, this.items);
      emitEvent('cartcrft:cart-updated', { items: this.items, count: this.count, total: this.total });
    },

    clear(): void {
      this.items = [];
      storageRemove(CART_KEY);
      emitEvent('cartcrft:cart-updated', { items: [], count: 0, total: 0 });
    },

    /**
     * Native checkout — browser drives the full flow with the public key.
     * Payment gateway secrets stay server-side; the browser only ever sees
     * public session data (Stripe client_secret, Paystack authorization_url, …).
     *
     * opts: { storeId, publicKey, email, customerId?, shippingAddress?,
     *         shippingRateId?, discountCode?, razorpayOptions? }
     *
     * Resolves to one of:
     *   {order_id, order_number}                — payment captured, order created
     *   {provider:'stripe', client_secret}       — caller must confirm with Stripe.js
     *   Redirects the browser for paystack/xendit — the promise never resolves.
     */
    checkoutNative(opts: CheckoutOpts): Promise<CheckoutResult | null> {
      if (!opts.storeId || !opts.publicKey) {
        return Promise.reject(new Error('checkoutNative requires {storeId, publicKey}.'));
      }
      if (!this.items.length) return Promise.reject(new Error('Cart is empty.'));
      if (this.checkingOut) return Promise.resolve(null);
      this.checkingOut = true;

      const self = this;
      const base = '/commerce/stores/' + opts.storeId;
      const authHdr: Record<string, string> = { 'Authorization': 'Bearer ' + opts.publicKey };
      let cartId = '';
      let checkoutId = '';

      // 1. Create cart.
      return postJSON(base + '/carts', {}, authHdr)
        .then((cart) => {
          cartId = cart['id'] as string;
          // 2. Add each line (serial — order matters for inventory deduction).
          return self.items.reduce((chain, item) => {
            return chain.then(() =>
              postJSON(base + '/carts/' + cartId + '/lines', {
                variant_id: item.variant_id,
                quantity: item.quantity,
              }, authHdr).then(() => undefined)
            );
          }, Promise.resolve<void>(undefined));
        })
        .then(() => {
          // 3. Create checkout from cart.
          const body: Record<string, unknown> = { cart_id: cartId };
          if (opts.email) body['email'] = opts.email;
          if (opts.customerId) body['customer_id'] = opts.customerId;
          if (opts.shippingAddress) body['shipping_address'] = opts.shippingAddress;
          if (opts.shippingRateId) body['shipping_rate'] = { id: opts.shippingRateId };
          if (opts.discountCode) body['discount_code'] = opts.discountCode;
          return postJSON(base + '/checkouts', body, authHdr);
        })
        .then((checkout) => {
          checkoutId = checkout['id'] as string;
          // 4. Initiate provider payment session.
          return postJSON(base + '/checkouts/' + checkoutId + '/payment-session', {}, authHdr);
        })
        .then((session) => {
          // ── Per-provider: Stripe confirm, Paystack/Xendit redirect, Razorpay widget ──

          // Paystack redirect
          if (session['authorization_url']) {
            self.clear();
            window.location.href = session['authorization_url'] as string;
            return session as CheckoutResult;
          }

          // Xendit redirect
          if (session['invoice_url']) {
            self.clear();
            window.location.href = session['invoice_url'] as string;
            return session as CheckoutResult;
          }

          // Razorpay widget — open if Razorpay.js loaded, else return session
          if (session['provider'] === 'razorpay' && session['order_id']) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Razorpay global
            const Razorpay = (window as any)['Razorpay'];
            if (typeof Razorpay === 'function') {
              return new Promise<CheckoutResult>((resolve, reject) => {
                const rzpOpts: Record<string, unknown> = {
                  ...(opts.razorpayOptions ?? {}),
                  order_id: session['order_id'],
                  handler: (response: Record<string, unknown>) => {
                    self.clear();
                    emitEvent('cartcrft:checkout-complete', response);
                    resolve({ provider: 'razorpay', ...response } as CheckoutResult);
                  },
                };
                try {
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
                  const rzp: { open(): void; on(ev: string, cb: () => void): void } = new Razorpay(rzpOpts);
                  rzp.on('payment.failed', (...args: unknown[]) => {
                    self.checkingOut = false;
                    reject(new Error('Razorpay payment failed: ' + JSON.stringify(args[0])));
                  });
                  rzp.open();
                } catch (e) {
                  self.checkingOut = false;
                  reject(e);
                }
              });
            }
            // Razorpay.js not loaded — return session for caller to handle
            self.checkingOut = false;
            return { ...session, checkout_id: checkoutId } as CheckoutResult;
          }

          // Stripe — return client_secret for caller to run Stripe.confirmPayment
          // If Stripe.js is loaded and elements are passed via opts we try auto-confirm.
          // If not, we return the session and the caller drives it.
          session['checkout_id'] = checkoutId;
          self.checkingOut = false;
          emitEvent('cartcrft:checkout-complete', session);
          return session as CheckoutResult;
        })
        .catch((err: unknown) => {
          self.checkingOut = false;
          emitEvent('cartcrft:checkout-error', { error: err });
          throw err;
        });
    },
  };

  return store;
}

// ── Alpine.store('cart', …) registration

if (typeof document !== 'undefined') {
  document.addEventListener('alpine:init', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Alpine global
    const Alpine = (window as any)['Alpine'] as
      | { store(name: string, value: unknown): void }
      | undefined;
    if (Alpine && typeof Alpine.store === 'function') {
      Alpine.store('cart', makeCartStore());
    }
  });
}

// ── Plain-JS global (non-Alpine pages or imperative use)

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- global export
(window as any)['CartcrftCart'] = makeCartStore();

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: Customer auth
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT_MS = 15_000;

function withTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const fetchInit: RequestInit = { ...(init ?? {}) };
  if (controller) fetchInit.signal = controller.signal;

  const timer = setTimeout(() => {
    if (controller) controller.abort();
  }, DEFAULT_TIMEOUT_MS);

  return fetch(url, fetchInit).then(
    (res) => { clearTimeout(timer); return res; },
    (err: unknown) => {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('CartcrftAuth: request timed out');
      }
      throw err;
    }
  );
}

export class CartcrftAuth {
  readonly storeId: string;
  readonly baseUrl: string;

  private readonly _listeners: AuthChangeListener[] = [];
  // Single in-flight refresh shared by any callers that race on token
  // expiry. Without this, N parallel callers each hit /auth/token with
  // the same session_token; the first rotates and revokes it, every one
  // after the winner is treated as reuse and the family is killed.
  private _refreshInFlight: Promise<Record<string, unknown> | null> | null = null;

  constructor(storeId: string, options?: AuthOptions) {
    if (!storeId) throw new Error('CartcrftAuth: storeId is required');
    this.storeId = storeId;
    this.baseUrl = options?.['baseUrl'] ?? DERIVED_BASE;
    if (!this.baseUrl) {
      throw new Error(
        "CartcrftAuth: baseUrl is required when the SDK is not loaded via <script src>. " +
        "Pass {baseUrl: 'https://api.your-domain.com'} as the second argument."
      );
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private _url(path: string): string {
    return this.baseUrl + path;
  }

  private _sessionKey(): string {
    return 'cc_customer_session_' + this.storeId;
  }

  private _tokenKey(): string {
    return 'cc_customer_token_' + this.storeId;
  }

  private _store(sessionToken: string | undefined, accessToken: string | undefined): void {
    try {
      if (sessionToken) localStorage.setItem(this._sessionKey(), sessionToken);
      if (accessToken) localStorage.setItem(this._tokenKey(), accessToken);
    } catch { /* sandboxed */ }
    this._notify(
      sessionToken && accessToken
        ? { sessionToken, accessToken }
        : null
    );
  }

  private _clear(): void {
    try {
      localStorage.removeItem(this._sessionKey());
      localStorage.removeItem(this._tokenKey());
    } catch { /* sandboxed */ }
    this._notify(null);
  }

  private _notify(session: AuthSession | null): void {
    for (const listener of this._listeners) {
      try { listener(session); } catch { /* ignore listener errors */ }
    }
  }

  private _post(path: string, body?: unknown): Promise<Record<string, unknown>> {
    return withTimeout(this._url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((res) =>
      res.json().then((data: Record<string, unknown>) => {
        if (!res.ok) {
          const err: ApiError = new Error(
            (data['error'] as string | undefined) ?? `Request failed: ${res.status}`
          );
          err.status = res.status;
          err.detail = data;
          return Promise.reject(err);
        }
        return data;
      })
    );
  }

  private _get(path: string, token: string): Promise<Record<string, unknown>> {
    return withTimeout(this._url(path), {
      headers: { Authorization: 'Bearer ' + token },
    }).then((res) =>
      res.json().then((data: Record<string, unknown>) => {
        if (!res.ok) {
          const err: ApiError = new Error(
            (data['error'] as string | undefined) ?? `Request failed: ${res.status}`
          );
          err.status = res.status;
          return Promise.reject(err);
        }
        return data;
      })
    );
  }

  private _put(path: string, body: unknown, token: string): Promise<Record<string, unknown>> {
    return withTimeout(this._url(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body ?? {}),
    }).then((res) =>
      res.json().then((data: Record<string, unknown>) => {
        if (!res.ok) {
          const err: ApiError = new Error(
            (data['error'] as string | undefined) ?? `Request failed: ${res.status}`
          );
          err.status = res.status;
          return Promise.reject(err);
        }
        return data;
      })
    );
  }

  private _delete(path: string, token: string): Promise<Record<string, unknown>> {
    return withTimeout(this._url(path), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    }).then((res) =>
      res.json().then((data: Record<string, unknown>) => {
        if (!res.ok) {
          const err: ApiError = new Error(
            (data['error'] as string | undefined) ?? `Request failed: ${res.status}`
          );
          err.status = res.status;
          return Promise.reject(err);
        }
        return data;
      })
    );
  }

  // ── Token management ─────────────────────────────────────────────────────

  getSessionToken(): string | null {
    try { return localStorage.getItem(this._sessionKey()); } catch { return null; }
  }

  getAccessToken(): string | null {
    try { return localStorage.getItem(this._tokenKey()); } catch { return null; }
  }

  refreshToken(): Promise<Record<string, unknown> | null> {
    if (this._refreshInFlight) return this._refreshInFlight;
    const session = this.getSessionToken();
    if (!session) return Promise.resolve(null);

    const inflight = this._post(
      '/commerce/stores/' + this.storeId + '/auth/token',
      { session_token: session }
    )
      .then((data) => {
        // The backend rotates the session_token on every successful exchange
        // (reuse-detection family). Persist BOTH so the next refresh doesn't
        // replay a now-revoked token.
        this._store(
          (data['session_token'] as string | undefined) ?? session,
          data['access_token'] as string | undefined
        );
        return data;
      })
      .catch((): null => {
        this._clear();
        return null;
      })
      .then((result) => {
        this._refreshInFlight = null;
        return result;
      });

    this._refreshInFlight = inflight;
    return inflight;
  }

  isTokenValid(): boolean {
    const token = this.getAccessToken();
    if (!token) return false;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const b64 = (parts[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64)) as { exp?: number };
      return !!payload.exp && (payload.exp * 1000) > Date.now();
    } catch {
      return false;
    }
  }

  getValidToken(): Promise<string | null> {
    if (this.isTokenValid()) return Promise.resolve(this.getAccessToken());
    return this.refreshToken().then((data) => {
      if (!data) return null;
      return (data['access_token'] as string | undefined) ?? this.getAccessToken();
    });
  }

  // ── Auth flows ───────────────────────────────────────────────────────────

  login(email: string, password: string): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/login', {
      email, password,
    }).then((data) => {
      this._store(
        data['session_token'] as string | undefined,
        data['access_token'] as string | undefined
      );
      emitEvent('cartcrft:auth-login', { storeId: this.storeId });
      return data;
    });
  }

  register(email: string, password: string, profile?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/register', {
      email, password, ...(profile ?? {}),
    }).then((data) => {
      if (data['session_token']) {
        this._store(
          data['session_token'] as string | undefined,
          data['access_token'] as string | undefined
        );
      }
      emitEvent('cartcrft:auth-register', { storeId: this.storeId });
      return data;
    });
  }

  logout(): Promise<{ ok: boolean }> {
    const session = this.getSessionToken();
    this._clear();
    emitEvent('cartcrft:auth-logout', { storeId: this.storeId });
    if (!session) return Promise.resolve({ ok: true });
    return this._post('/commerce/stores/' + this.storeId + '/auth/logout', {
      session_token: session,
    }).then(() => ({ ok: true })).catch(() => ({ ok: true }));
  }

  getUser(): Promise<Record<string, unknown>> {
    return this.getValidToken().then((token) => {
      if (!token) return Promise.reject(new Error('Not authenticated'));
      return this._get('/commerce/stores/' + this.storeId + '/auth/me', token);
    });
  }

  // ── Password reset ──────────────────────────────────────────────────────

  requestPasswordReset(email: string): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/password-reset/request', { email });
  }

  completePasswordReset(token: string, newPassword: string): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/password-reset/complete', {
      token, new_password: newPassword,
    });
  }

  // ── Email verification ──────────────────────────────────────────────────

  verifyEmail(token: string): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/verify-email', { token });
  }

  resendVerification(email: string): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/verify-email/resend', { email });
  }

  // ── Magic link ──────────────────────────────────────────────────────────

  requestMagicLink(email: string): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/magic-link', { email });
  }

  verifyMagicLink(token: string): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/magic-link/verify', { token })
      .then((data) => {
        this._store(
          data['session_token'] as string | undefined,
          data['access_token'] as string | undefined
        );
        return data;
      });
  }

  // ── Invitation ──────────────────────────────────────────────────────────

  acceptInvite(token: string, password: string, name?: string): Promise<Record<string, unknown>> {
    return this._post('/commerce/stores/' + this.storeId + '/auth/invite/accept', {
      token, password, name: name ?? '',
    }).then((data) => {
      this._store(
        data['session_token'] as string | undefined,
        data['access_token'] as string | undefined
      );
      return data;
    });
  }

  // ── Authenticated user actions ──────────────────────────────────────────

  updateProfile(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.getValidToken().then((token) => {
      if (!token) return Promise.reject(new Error('Not authenticated'));
      return this._put('/commerce/stores/' + this.storeId + '/auth/me', fields, token);
    });
  }

  changePassword(currentPassword: string, newPassword: string): Promise<Record<string, unknown>> {
    return this.getValidToken().then((token) => {
      if (!token) return Promise.reject(new Error('Not authenticated'));
      return this._put('/commerce/stores/' + this.storeId + '/auth/me/password', {
        current_password: currentPassword, new_password: newPassword,
      }, token);
    });
  }

  getSessions(): Promise<Record<string, unknown>> {
    return this.getValidToken().then((token) => {
      if (!token) return Promise.reject(new Error('Not authenticated'));
      return this._get('/commerce/stores/' + this.storeId + '/auth/sessions', token);
    });
  }

  revokeSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.getValidToken().then((token) => {
      if (!token) return Promise.reject(new Error('Not authenticated'));
      return this._delete('/commerce/stores/' + this.storeId + '/auth/sessions/' + sessionId, token);
    });
  }

  // ── Auth state listener ─────────────────────────────────────────────────

  onAuthChange(callback: AuthChangeListener): () => void {
    this._listeners.push(callback);
    return () => {
      const idx = this._listeners.indexOf(callback);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Initialize: restore session from localStorage and validate it.
   * Call this once on page load. Returns the current user if authenticated,
   * null otherwise.
   */
  init(): Promise<Record<string, unknown> | null> {
    return this.refreshToken()
      .then((tokenData) => {
        if (!tokenData) return null;
        return this.getUser().catch(() => null);
      })
      .catch(() => null);
  }

  // ── Pool info ────────────────────────────────────────────────────────────

  /**
   * Get public pool info (name, logo, enabled auth methods). No auth required.
   */
  getPoolInfo(): Promise<Record<string, unknown>> {
    return withTimeout(this._url('/commerce/stores/' + this.storeId + '/auth/info'))
      .then((res) =>
        res.json().then((data: Record<string, unknown>) => {
          if (!res.ok) {
            const err: ApiError = new Error(
              (data['error'] as string | undefined) ?? `Request failed: ${res.status}`
            );
            err.status = res.status;
            err.detail = data;
            return Promise.reject(err);
          }
          return data;
        })
      );
  }
}

// ── Expose CartcrftAuth as a global constructor

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- global export
(window as any)['CartcrftAuth'] = CartcrftAuth;

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Checkout links (shareable / hosted checkout — Stripe-Link-style)
// ═══════════════════════════════════════════════════════════════════════════
//
// A merchant (server-side, cc_prv_ key) creates a checkout link encoding a
// prefilled cart. Anyone with the public token opens the cartcrft-hosted
// /pay/<token> page (or an iframe embed) and pays. Two surfaces:
//
//   createCheckoutLink(input)  — MERCHANT-KEY (cc_prv_). Server-side only:
//                                 never ship a private key to a browser.
//   getCheckoutLink(token)     — PUBLIC. No key. Resolves branding + totals.
//   checkoutLinkUrl(token, …)  — build the hosted /pay/<token> URL.
//
// All three resolve their API base from the <script src> origin (or an explicit
// baseUrl), identical to CartcrftAuth.

export interface CheckoutLinkLineItem {
  variant_id: string;
  quantity: number;
}

export interface CreateCheckoutLinkInput {
  storeId: string;
  /** A server-side cc_prv_ API key with commerce:write. NEVER a cc_pub_ key. */
  merchantKey: string;
  lineItems: CheckoutLinkLineItem[];
  customerEmail?: string;
  successUrl?: string;
  cancelUrl?: string;
  /** ISO 8601 timestamp; the link auto-expires after this. */
  expiresAt?: string;
  baseUrl?: string;
}

export interface CreateCheckoutLinkResult {
  id: string;
  token: string;
  /** `${PUBLIC_CHECKOUT_BASE||''}/pay/<token>` as computed server-side. */
  url: string;
}

export interface CheckoutLinkLineView {
  variant_id: string;
  qty: number;
  unit_price: string;
  line_total: string;
  title: string;
  sku: string;
}

export interface CheckoutLinkTotals {
  subtotal: string;
  tax_total: string;
  shipping_total: string;
  total: string;
  currency: string;
}

export interface ResolvedCheckoutLink {
  token: string;
  status: 'open' | 'completed' | 'expired' | 'void';
  store: { name: string };
  line_items: CheckoutLinkLineView[];
  totals: CheckoutLinkTotals;
  customer_email: string | null;
  success_url: string | null;
  cancel_url: string | null;
  expires_at: string | null;
}

function resolveBase(explicit?: string): string {
  const base = (explicit ?? DERIVED_BASE).replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'checkout-links: baseUrl is required when the SDK is not loaded via <script src>. ' +
      "Pass { baseUrl: 'https://api.your-domain.com' }."
    );
  }
  return base;
}

/**
 * Create a checkout link (MERCHANT key — server-side only).
 *
 * Returns { id, token, url }. Do NOT call this from a public browser page with a
 * private key; mint the link on your server and hand the customer the url.
 */
export function createCheckoutLink(
  input: CreateCheckoutLinkInput
): Promise<CreateCheckoutLinkResult> {
  if (!input.storeId || !input.merchantKey) {
    return Promise.reject(new Error('createCheckoutLink requires { storeId, merchantKey }.'));
  }
  if (!input.lineItems || input.lineItems.length === 0) {
    return Promise.reject(new Error('createCheckoutLink requires at least one line item.'));
  }
  const base = resolveBase(input.baseUrl);
  const body: Record<string, unknown> = {
    line_items: input.lineItems.map((li) => ({ variant_id: li.variant_id, quantity: li.quantity })),
  };
  if (input.customerEmail) body['customer_email'] = input.customerEmail;
  if (input.successUrl) body['success_url'] = input.successUrl;
  if (input.cancelUrl) body['cancel_url'] = input.cancelUrl;
  if (input.expiresAt) body['expires_at'] = input.expiresAt;

  return postJSON(
    base + '/commerce/stores/' + input.storeId + '/checkout-links',
    body,
    { Authorization: 'Bearer ' + input.merchantKey }
  ).then((data) => data as unknown as CreateCheckoutLinkResult);
}

/**
 * Resolve a checkout link by its public token (no key required).
 * Returns branding + line items + computed totals + status.
 */
export function getCheckoutLink(
  token: string,
  opts?: { baseUrl?: string }
): Promise<ResolvedCheckoutLink> {
  if (!token) return Promise.reject(new Error('getCheckoutLink requires a token.'));
  const base = resolveBase(opts?.baseUrl);
  return fetch(base + '/storefront/checkout-links/' + encodeURIComponent(token))
    .then((res) =>
      res.json().then((data: Record<string, unknown>) => {
        if (!res.ok) {
          const err: ApiError = new Error(
            ((data['error'] as { message?: string } | undefined)?.message) ?? `HTTP ${res.status}`
          );
          err.status = res.status;
          err.detail = data;
          throw err;
        }
        return data as unknown as ResolvedCheckoutLink;
      })
    );
}

/**
 * Build the public hosted-checkout URL for a token.
 *
 * checkoutLinkUrl('cl_x')                              → '/pay/cl_x'
 * checkoutLinkUrl('cl_x', { embed: true })             → '/pay/cl_x?embed=1'
 * checkoutLinkUrl('cl_x', { base: 'https://pay.cc' })  → 'https://pay.cc/pay/cl_x'
 */
export function checkoutLinkUrl(
  token: string,
  opts?: { base?: string; embed?: boolean }
): string {
  const base = (opts?.base ?? '').replace(/\/+$/, '');
  const q = opts?.embed ? '?embed=1' : '';
  return base + '/pay/' + encodeURIComponent(token) + q;
}

// ── Expose checkout-link helpers as a global namespace ──────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- global export
(window as any)['CartcrftCheckoutLinks'] = { createCheckoutLink, getCheckoutLink, checkoutLinkUrl };
