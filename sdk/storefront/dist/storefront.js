/* Cartcrft Storefront SDK — https://cartcrft.dev */
"use strict";
var _CartcrftSDK = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/storefront.ts
  var storefront_exports = {};
  __export(storefront_exports, {
    CartcrftAuth: () => CartcrftAuth,
    checkoutLinkUrl: () => checkoutLinkUrl,
    createCheckoutLink: () => createCheckoutLink,
    getCheckoutLink: () => getCheckoutLink
  });
  var DERIVED_BASE = (() => {
    var _a;
    try {
      const s = document.currentScript;
      if (!s || !s.src) return "";
      if ((_a = s.dataset) == null ? void 0 : _a["api"]) return s.dataset["api"].replace(/\/+$/, "");
      return new URL(s.src).origin;
    } catch {
      return "";
    }
  })();
  var CART_KEY = "cc_cart";
  function storageGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed !== null && parsed !== void 0 ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
    }
  }
  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
    }
  }
  function emitEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
    } catch {
    }
  }
  function postJSON(path, body, authHdr) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHdr },
      body: JSON.stringify(body != null ? body : {})
    }).then((res) => {
      return res.json().then((data) => {
        var _a, _b;
        if (!res.ok) {
          const err = new Error(
            (_b = (_a = data["error"]) != null ? _a : data["message"]) != null ? _b : `HTTP ${res.status}`
          );
          err.status = res.status;
          err.detail = data;
          throw err;
        }
        return data;
      });
    });
  }
  function makeCartStore() {
    const store = {
      items: storageGet(CART_KEY, []),
      showCart: false,
      checkingOut: false,
      get count() {
        return this.items.reduce((s, i) => s + i.quantity, 0);
      },
      get total() {
        return this.items.reduce((s, i) => s + i.price * i.quantity, 0);
      },
      /**
       * Add a product to the cart. Uses the first variant; increments
       * quantity if that variant is already in the cart.
       * product shape: { title, variants: [{ id, price }] }
       */
      add(product) {
        var _a;
        const variant = (_a = product.variants) == null ? void 0 : _a[0];
        if (!variant) return;
        const existing = this.items.find((i) => i.variant_id === variant.id);
        if (existing) {
          existing.quantity++;
        } else {
          this.items.push({
            variant_id: variant.id,
            name: product.title,
            price: variant.price,
            quantity: 1
          });
        }
        storageSet(CART_KEY, this.items);
        emitEvent("cartcrft:cart-updated", { items: this.items, count: this.count, total: this.total });
      },
      /**
       * Add a specific variant directly (for when you already know the variant).
       */
      addVariant(variantId, name, price, quantity = 1) {
        const existing = this.items.find((i) => i.variant_id === variantId);
        if (existing) {
          existing.quantity += quantity;
        } else {
          this.items.push({ variant_id: variantId, name, price, quantity });
        }
        storageSet(CART_KEY, this.items);
        emitEvent("cartcrft:cart-updated", { items: this.items, count: this.count, total: this.total });
      },
      remove(variantId) {
        this.items = this.items.filter((i) => i.variant_id !== variantId);
        storageSet(CART_KEY, this.items);
        emitEvent("cartcrft:cart-updated", { items: this.items, count: this.count, total: this.total });
      },
      updateQty(variantId, qty) {
        if (qty <= 0) {
          this.remove(variantId);
          return;
        }
        const item = this.items.find((i) => i.variant_id === variantId);
        if (item) item.quantity = qty;
        storageSet(CART_KEY, this.items);
        emitEvent("cartcrft:cart-updated", { items: this.items, count: this.count, total: this.total });
      },
      clear() {
        this.items = [];
        storageRemove(CART_KEY);
        emitEvent("cartcrft:cart-updated", { items: [], count: 0, total: 0 });
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
      checkoutNative(opts) {
        if (!opts.storeId || !opts.publicKey) {
          return Promise.reject(new Error("checkoutNative requires {storeId, publicKey}."));
        }
        if (!this.items.length) return Promise.reject(new Error("Cart is empty."));
        if (this.checkingOut) return Promise.resolve(null);
        this.checkingOut = true;
        const self = this;
        const base = "/commerce/stores/" + opts.storeId;
        const authHdr = { "Authorization": "Bearer " + opts.publicKey };
        let cartId = "";
        let checkoutId = "";
        return postJSON(base + "/carts", {}, authHdr).then((cart) => {
          cartId = cart["id"];
          return self.items.reduce((chain, item) => {
            return chain.then(
              () => postJSON(base + "/carts/" + cartId + "/lines", {
                variant_id: item.variant_id,
                quantity: item.quantity
              }, authHdr).then(() => void 0)
            );
          }, Promise.resolve(void 0));
        }).then(() => {
          const body = { cart_id: cartId };
          if (opts.email) body["email"] = opts.email;
          if (opts.customerId) body["customer_id"] = opts.customerId;
          if (opts.shippingAddress) body["shipping_address"] = opts.shippingAddress;
          if (opts.shippingRateId) body["shipping_rate"] = { id: opts.shippingRateId };
          if (opts.discountCode) body["discount_code"] = opts.discountCode;
          return postJSON(base + "/checkouts", body, authHdr);
        }).then((checkout) => {
          checkoutId = checkout["id"];
          return postJSON(base + "/checkouts/" + checkoutId + "/payment-session", {}, authHdr);
        }).then((session) => {
          if (session["authorization_url"]) {
            self.clear();
            window.location.href = session["authorization_url"];
            return session;
          }
          if (session["invoice_url"]) {
            self.clear();
            window.location.href = session["invoice_url"];
            return session;
          }
          if (session["provider"] === "razorpay" && session["order_id"]) {
            const Razorpay = window["Razorpay"];
            if (typeof Razorpay === "function") {
              return new Promise((resolve, reject) => {
                var _a;
                const rzpOpts = {
                  ...(_a = opts.razorpayOptions) != null ? _a : {},
                  order_id: session["order_id"],
                  handler: (response) => {
                    self.clear();
                    emitEvent("cartcrft:checkout-complete", response);
                    resolve({ provider: "razorpay", ...response });
                  }
                };
                try {
                  const rzp = new Razorpay(rzpOpts);
                  rzp.on("payment.failed", (...args) => {
                    self.checkingOut = false;
                    reject(new Error("Razorpay payment failed: " + JSON.stringify(args[0])));
                  });
                  rzp.open();
                } catch (e) {
                  self.checkingOut = false;
                  reject(e);
                }
              });
            }
            self.checkingOut = false;
            return { ...session, checkout_id: checkoutId };
          }
          session["checkout_id"] = checkoutId;
          self.checkingOut = false;
          emitEvent("cartcrft:checkout-complete", session);
          return session;
        }).catch((err) => {
          self.checkingOut = false;
          emitEvent("cartcrft:checkout-error", { error: err });
          throw err;
        });
      }
    };
    return store;
  }
  if (typeof document !== "undefined") {
    document.addEventListener("alpine:init", () => {
      const Alpine = window["Alpine"];
      if (Alpine && typeof Alpine.store === "function") {
        Alpine.store("cart", makeCartStore());
      }
    });
  }
  window["CartcrftCart"] = makeCartStore();
  var DEFAULT_TIMEOUT_MS = 15e3;
  function withTimeout(url, init) {
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const fetchInit = { ...init != null ? init : {} };
    if (controller) fetchInit.signal = controller.signal;
    const timer = setTimeout(() => {
      if (controller) controller.abort();
    }, DEFAULT_TIMEOUT_MS);
    return fetch(url, fetchInit).then(
      (res) => {
        clearTimeout(timer);
        return res;
      },
      (err) => {
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error("CartcrftAuth: request timed out");
        }
        throw err;
      }
    );
  }
  var CartcrftAuth = class {
    constructor(storeId, options) {
      this._listeners = [];
      // Single in-flight refresh shared by any callers that race on token
      // expiry. Without this, N parallel callers each hit /auth/token with
      // the same session_token; the first rotates and revokes it, every one
      // after the winner is treated as reuse and the family is killed.
      this._refreshInFlight = null;
      var _a;
      if (!storeId) throw new Error("CartcrftAuth: storeId is required");
      this.storeId = storeId;
      this.baseUrl = (_a = options == null ? void 0 : options["baseUrl"]) != null ? _a : DERIVED_BASE;
      if (!this.baseUrl) {
        throw new Error(
          "CartcrftAuth: baseUrl is required when the SDK is not loaded via <script src>. Pass {baseUrl: 'https://api.your-domain.com'} as the second argument."
        );
      }
    }
    // ── Internal helpers ─────────────────────────────────────────────────────
    _url(path) {
      return this.baseUrl + path;
    }
    _sessionKey() {
      return "cc_customer_session_" + this.storeId;
    }
    _tokenKey() {
      return "cc_customer_token_" + this.storeId;
    }
    _store(sessionToken, accessToken) {
      try {
        if (sessionToken) localStorage.setItem(this._sessionKey(), sessionToken);
        if (accessToken) localStorage.setItem(this._tokenKey(), accessToken);
      } catch {
      }
      this._notify(
        sessionToken && accessToken ? { sessionToken, accessToken } : null
      );
    }
    _clear() {
      try {
        localStorage.removeItem(this._sessionKey());
        localStorage.removeItem(this._tokenKey());
      } catch {
      }
      this._notify(null);
    }
    _notify(session) {
      for (const listener of this._listeners) {
        try {
          listener(session);
        } catch {
        }
      }
    }
    _post(path, body) {
      return withTimeout(this._url(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body != null ? body : {})
      }).then(
        (res) => res.json().then((data) => {
          var _a;
          if (!res.ok) {
            const err = new Error(
              (_a = data["error"]) != null ? _a : `Request failed: ${res.status}`
            );
            err.status = res.status;
            err.detail = data;
            return Promise.reject(err);
          }
          return data;
        })
      );
    }
    _get(path, token) {
      return withTimeout(this._url(path), {
        headers: { Authorization: "Bearer " + token }
      }).then(
        (res) => res.json().then((data) => {
          var _a;
          if (!res.ok) {
            const err = new Error(
              (_a = data["error"]) != null ? _a : `Request failed: ${res.status}`
            );
            err.status = res.status;
            return Promise.reject(err);
          }
          return data;
        })
      );
    }
    _put(path, body, token) {
      return withTimeout(this._url(path), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(body != null ? body : {})
      }).then(
        (res) => res.json().then((data) => {
          var _a;
          if (!res.ok) {
            const err = new Error(
              (_a = data["error"]) != null ? _a : `Request failed: ${res.status}`
            );
            err.status = res.status;
            return Promise.reject(err);
          }
          return data;
        })
      );
    }
    _delete(path, token) {
      return withTimeout(this._url(path), {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token }
      }).then(
        (res) => res.json().then((data) => {
          var _a;
          if (!res.ok) {
            const err = new Error(
              (_a = data["error"]) != null ? _a : `Request failed: ${res.status}`
            );
            err.status = res.status;
            return Promise.reject(err);
          }
          return data;
        })
      );
    }
    // ── Token management ─────────────────────────────────────────────────────
    getSessionToken() {
      try {
        return localStorage.getItem(this._sessionKey());
      } catch {
        return null;
      }
    }
    getAccessToken() {
      try {
        return localStorage.getItem(this._tokenKey());
      } catch {
        return null;
      }
    }
    refreshToken() {
      if (this._refreshInFlight) return this._refreshInFlight;
      const session = this.getSessionToken();
      if (!session) return Promise.resolve(null);
      const inflight = this._post(
        "/commerce/stores/" + this.storeId + "/auth/token",
        { session_token: session }
      ).then((data) => {
        var _a;
        this._store(
          (_a = data["session_token"]) != null ? _a : session,
          data["access_token"]
        );
        return data;
      }).catch(() => {
        this._clear();
        return null;
      }).then((result) => {
        this._refreshInFlight = null;
        return result;
      });
      this._refreshInFlight = inflight;
      return inflight;
    }
    isTokenValid() {
      var _a;
      const token = this.getAccessToken();
      if (!token) return false;
      try {
        const parts = token.split(".");
        if (parts.length !== 3) return false;
        const b64 = ((_a = parts[1]) != null ? _a : "").replace(/-/g, "+").replace(/_/g, "/");
        const payload = JSON.parse(atob(b64));
        return !!payload.exp && payload.exp * 1e3 > Date.now();
      } catch {
        return false;
      }
    }
    getValidToken() {
      if (this.isTokenValid()) return Promise.resolve(this.getAccessToken());
      return this.refreshToken().then((data) => {
        var _a;
        if (!data) return null;
        return (_a = data["access_token"]) != null ? _a : this.getAccessToken();
      });
    }
    // ── Auth flows ───────────────────────────────────────────────────────────
    login(email, password) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/login", {
        email,
        password
      }).then((data) => {
        this._store(
          data["session_token"],
          data["access_token"]
        );
        emitEvent("cartcrft:auth-login", { storeId: this.storeId });
        return data;
      });
    }
    register(email, password, profile) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/register", {
        email,
        password,
        ...profile != null ? profile : {}
      }).then((data) => {
        if (data["session_token"]) {
          this._store(
            data["session_token"],
            data["access_token"]
          );
        }
        emitEvent("cartcrft:auth-register", { storeId: this.storeId });
        return data;
      });
    }
    logout() {
      const session = this.getSessionToken();
      this._clear();
      emitEvent("cartcrft:auth-logout", { storeId: this.storeId });
      if (!session) return Promise.resolve({ ok: true });
      return this._post("/commerce/stores/" + this.storeId + "/auth/logout", {
        session_token: session
      }).then(() => ({ ok: true })).catch(() => ({ ok: true }));
    }
    getUser() {
      return this.getValidToken().then((token) => {
        if (!token) return Promise.reject(new Error("Not authenticated"));
        return this._get("/commerce/stores/" + this.storeId + "/auth/me", token);
      });
    }
    // ── Password reset ──────────────────────────────────────────────────────
    requestPasswordReset(email) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/password-reset/request", { email });
    }
    completePasswordReset(token, newPassword) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/password-reset/complete", {
        token,
        new_password: newPassword
      });
    }
    // ── Email verification ──────────────────────────────────────────────────
    verifyEmail(token) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/verify-email", { token });
    }
    resendVerification(email) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/verify-email/resend", { email });
    }
    // ── Magic link ──────────────────────────────────────────────────────────
    requestMagicLink(email) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/magic-link", { email });
    }
    verifyMagicLink(token) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/magic-link/verify", { token }).then((data) => {
        this._store(
          data["session_token"],
          data["access_token"]
        );
        return data;
      });
    }
    // ── Invitation ──────────────────────────────────────────────────────────
    acceptInvite(token, password, name) {
      return this._post("/commerce/stores/" + this.storeId + "/auth/invite/accept", {
        token,
        password,
        name: name != null ? name : ""
      }).then((data) => {
        this._store(
          data["session_token"],
          data["access_token"]
        );
        return data;
      });
    }
    // ── Authenticated user actions ──────────────────────────────────────────
    updateProfile(fields) {
      return this.getValidToken().then((token) => {
        if (!token) return Promise.reject(new Error("Not authenticated"));
        return this._put("/commerce/stores/" + this.storeId + "/auth/me", fields, token);
      });
    }
    changePassword(currentPassword, newPassword) {
      return this.getValidToken().then((token) => {
        if (!token) return Promise.reject(new Error("Not authenticated"));
        return this._put("/commerce/stores/" + this.storeId + "/auth/me/password", {
          current_password: currentPassword,
          new_password: newPassword
        }, token);
      });
    }
    getSessions() {
      return this.getValidToken().then((token) => {
        if (!token) return Promise.reject(new Error("Not authenticated"));
        return this._get("/commerce/stores/" + this.storeId + "/auth/sessions", token);
      });
    }
    revokeSession(sessionId) {
      return this.getValidToken().then((token) => {
        if (!token) return Promise.reject(new Error("Not authenticated"));
        return this._delete("/commerce/stores/" + this.storeId + "/auth/sessions/" + sessionId, token);
      });
    }
    // ── Auth state listener ─────────────────────────────────────────────────
    onAuthChange(callback) {
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
    init() {
      return this.refreshToken().then((tokenData) => {
        if (!tokenData) return null;
        return this.getUser().catch(() => null);
      }).catch(() => null);
    }
    // ── Pool info ────────────────────────────────────────────────────────────
    /**
     * Get public pool info (name, logo, enabled auth methods). No auth required.
     */
    getPoolInfo() {
      return withTimeout(this._url("/commerce/stores/" + this.storeId + "/auth/info")).then(
        (res) => res.json().then((data) => {
          var _a;
          if (!res.ok) {
            const err = new Error(
              (_a = data["error"]) != null ? _a : `Request failed: ${res.status}`
            );
            err.status = res.status;
            err.detail = data;
            return Promise.reject(err);
          }
          return data;
        })
      );
    }
  };
  window["CartcrftAuth"] = CartcrftAuth;
  function resolveBase(explicit) {
    const base = (explicit != null ? explicit : DERIVED_BASE).replace(/\/+$/, "");
    if (!base) {
      throw new Error(
        "checkout-links: baseUrl is required when the SDK is not loaded via <script src>. Pass { baseUrl: 'https://api.your-domain.com' }."
      );
    }
    return base;
  }
  function createCheckoutLink(input) {
    if (!input.storeId || !input.merchantKey) {
      return Promise.reject(new Error("createCheckoutLink requires { storeId, merchantKey }."));
    }
    if (!input.lineItems || input.lineItems.length === 0) {
      return Promise.reject(new Error("createCheckoutLink requires at least one line item."));
    }
    const base = resolveBase(input.baseUrl);
    const body = {
      line_items: input.lineItems.map((li) => ({ variant_id: li.variant_id, quantity: li.quantity }))
    };
    if (input.customerEmail) body["customer_email"] = input.customerEmail;
    if (input.successUrl) body["success_url"] = input.successUrl;
    if (input.cancelUrl) body["cancel_url"] = input.cancelUrl;
    if (input.expiresAt) body["expires_at"] = input.expiresAt;
    return postJSON(
      base + "/commerce/stores/" + input.storeId + "/checkout-links",
      body,
      { Authorization: "Bearer " + input.merchantKey }
    );
  }
  function getCheckoutLink(token, opts) {
    if (!token) return Promise.reject(new Error("getCheckoutLink requires a token."));
    const base = resolveBase(opts == null ? void 0 : opts.baseUrl);
    return fetch(base + "/storefront/checkout-links/" + encodeURIComponent(token)).then(
      (res) => res.json().then((data) => {
        var _a, _b;
        if (!res.ok) {
          const err = new Error(
            (_b = (_a = data["error"]) == null ? void 0 : _a.message) != null ? _b : `HTTP ${res.status}`
          );
          err.status = res.status;
          err.detail = data;
          throw err;
        }
        return data;
      })
    );
  }
  function checkoutLinkUrl(token, opts) {
    var _a;
    const base = ((_a = opts == null ? void 0 : opts.base) != null ? _a : "").replace(/\/+$/, "");
    const q = (opts == null ? void 0 : opts.embed) ? "?embed=1" : "";
    return base + "/pay/" + encodeURIComponent(token) + q;
  }
  window["CartcrftCheckoutLinks"] = { createCheckoutLink, getCheckoutLink, checkoutLinkUrl };
  return __toCommonJS(storefront_exports);
})();
