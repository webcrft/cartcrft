/**
 * checkout-links.test.ts — SDK helpers for shareable checkout links.
 *
 * Imports the REAL exported helpers from storefront.ts. The module assigns a
 * few window.* globals + reads document.currentScript at import time, so we
 * shim the minimal browser surface before importing (mirrors cart.test.ts).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ── Minimal browser shims (must exist before importing the module) ──────────
const _storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => _storage.get(k) ?? null,
    setItem: (k: string, v: string) => { _storage.set(k, v); },
    removeItem: (k: string) => { _storage.delete(k); },
  },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: { dispatchEvent: () => {}, location: { href: "" } },
  configurable: true,
});
Object.defineProperty(globalThis, "document", {
  value: {
    // Provide a <script src> origin so DERIVED_BASE resolves without an explicit baseUrl.
    currentScript: { src: "https://api.example.com/storefront.js", dataset: {} },
    addEventListener: () => {},
  },
  configurable: true,
});
Object.defineProperty(globalThis, "CustomEvent", {
  value: class { constructor(public type: string, public init?: unknown) {} },
  configurable: true,
});

const mod = await import("./storefront.js");
const { createCheckoutLink, getCheckoutLink, checkoutLinkUrl } = mod;

afterEach(() => { vi.unstubAllGlobals(); });

describe("checkoutLinkUrl", () => {
  it("builds a relative /pay/<token> url by default", () => {
    expect(checkoutLinkUrl("cl_abc")).toBe("/pay/cl_abc");
  });
  it("adds ?embed=1 in embed mode", () => {
    expect(checkoutLinkUrl("cl_abc", { embed: true })).toBe("/pay/cl_abc?embed=1");
  });
  it("prefixes an absolute base and trims trailing slashes", () => {
    expect(checkoutLinkUrl("cl_abc", { base: "https://pay.cc/" })).toBe("https://pay.cc/pay/cl_abc");
  });
});

describe("createCheckoutLink", () => {
  beforeEach(() => { _storage.clear(); });

  it("POSTs to the merchant endpoint with the bearer key and returns {id,token,url}", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: "li_1", token: "cl_xyz", url: "/pay/cl_xyz" }),
      };
    });

    const res = await createCheckoutLink({
      storeId: "11111111-1111-1111-1111-111111111111",
      merchantKey: "cc_prv_test",
      lineItems: [{ variant_id: "v1", quantity: 2 }],
      customerEmail: "buyer@example.com",
    });

    expect(res.token).toBe("cl_xyz");
    expect(res.url).toBe("/pay/cl_xyz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://api.example.com/commerce/stores/11111111-1111-1111-1111-111111111111/checkout-links"
    );
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer cc_prv_test");
    const sent = JSON.parse(calls[0]!.init!.body as string);
    expect(sent.line_items).toEqual([{ variant_id: "v1", quantity: 2 }]);
    expect(sent.customer_email).toBe("buyer@example.com");
  });

  it("rejects without storeId/merchantKey or with empty line items", async () => {
    await expect(
      createCheckoutLink({ storeId: "", merchantKey: "", lineItems: [] })
    ).rejects.toThrow();
    await expect(
      createCheckoutLink({ storeId: "s", merchantKey: "k", lineItems: [] })
    ).rejects.toThrow();
  });
});

describe("getCheckoutLink", () => {
  it("GETs the public resolve endpoint (no auth header) and returns the payload", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          token: "cl_xyz",
          status: "open",
          store: { name: "Demo" },
          line_items: [],
          totals: { subtotal: "10.00", tax_total: "0.00", shipping_total: "0.00", total: "10.00", currency: "USD" },
          customer_email: null,
          success_url: null,
          cancel_url: null,
          expires_at: null,
        }),
      };
    });

    const link = await getCheckoutLink("cl_xyz");
    expect(seenUrl).toBe("https://api.example.com/storefront/checkout-links/cl_xyz");
    expect(seenInit).toBeUndefined(); // plain GET, no auth
    expect(link.store.name).toBe("Demo");
    expect(link.totals.total).toBe("10.00");
  });

  it("throws on a 404 with the server error message", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: "NOT_FOUND", message: "checkout link not found" } }),
    }));
    await expect(getCheckoutLink("cl_nope")).rejects.toThrow("checkout link not found");
  });
});
