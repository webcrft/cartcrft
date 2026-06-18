/**
 * taxjar.test.ts — Unit tests for the TaxJar tax-automation client and the
 * calcTaxAuto provider/DB-fallback path.
 *
 * Pure unit tests: global fetch is stubbed (no DB, no network). For calcTaxAuto
 * we inject a fake TaxProvider via setTaxProvider() and pass a stub pool whose
 * .query returns { rows: [] } so the DB-fallback path produces an empty result.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  TaxJarClient,
  TaxJarAPIError,
  newTaxJarClient,
} from "../../src/providers/tax/taxjar.js";
import {
  calcTaxAuto,
  setTaxProvider,
  type TaxProvider,
  type TaxResult,
} from "../../src/lib/tax.js";

// ── fetch stub helpers ──────────────────────────────────────────────────────────

interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

/** Stub global fetch capturing the last call; returns the given body/status. */
function stubFetch(
  responseBody: Record<string, unknown>,
  opts: { status?: number } = {}
): { calls: StubCall[] } {
  const status = opts.status ?? 200;
  const calls: StubCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: status < 400,
        status,
        text: async () => JSON.stringify(responseBody),
        json: async () => responseBody,
      } as unknown as Response;
    }
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setTaxProvider(null);
});

const TAX_ENVELOPE = {
  tax: {
    amount_to_collect: 1.5,
    rate: 0.0625,
    taxable_amount: 24,
    has_nexus: true,
    freight_taxable: false,
    breakdown: { state_tax_collectable: 1.5 },
  },
};

// ── TaxJarClient.calcTax ─────────────────────────────────────────────────────────

describe("TaxJarClient.calcTax", () => {
  it("POSTs to /taxes and returns the tax object", async () => {
    const { calls } = stubFetch(TAX_ENVELOPE);
    const client = new TaxJarClient("tj_test_key");

    const tax = await client.calcTax({
      to_country: "US",
      to_zip: "90002",
      to_state: "CA",
      to_city: "Los Angeles",
      amount: 24,
      shipping: 0,
      line_items: [{ id: "1", quantity: 1, unit_price: 24, product_tax_code: "20010" }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.taxjar.com/v2/taxes");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(tax.amount_to_collect).toBe(1.5);
    expect(tax.rate).toBe(0.0625);
    expect(tax.has_nexus).toBe(true);

    const sentBody = JSON.parse(calls[0]!.init!.body as string);
    expect(sentBody.to_country).toBe("US");
    expect(sentBody.to_zip).toBe("90002");
    expect(sentBody.amount).toBe(24);
  });

  it("sends a Bearer auth header", async () => {
    const { calls } = stubFetch(TAX_ENVELOPE);
    const client = new TaxJarClient("tj_secret_abc");
    await client.calcTax({ to_country: "US", amount: 10, shipping: 0 });

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tj_secret_abc");
  });

  it("uses the sandbox base URL when sandbox=true", async () => {
    const { calls } = stubFetch(TAX_ENVELOPE);
    const client = new TaxJarClient("tj_test_key", true);
    await client.calcTax({ to_country: "US", amount: 10, shipping: 0 });

    expect(calls[0]!.url).toBe("https://api.sandbox.taxjar.com/v2/taxes");
  });

  it("throws TaxJarAPIError on >= 400", async () => {
    stubFetch({ error: "Bad Request", detail: "to_country is required" }, { status: 400 });
    const client = new TaxJarClient("tj_test_key");

    await expect(
      client.calcTax({ to_country: "", amount: 10, shipping: 0 })
    ).rejects.toBeInstanceOf(TaxJarAPIError);
  });

  it("throws TaxJarAPIError with status on 401", async () => {
    stubFetch({ error: "Unauthorized" }, { status: 401 });
    const client = new TaxJarClient("tj_invalid");

    await expect(
      client.calcTax({ to_country: "US", amount: 10, shipping: 0 })
    ).rejects.toMatchObject({ name: "TaxJarAPIError", status: 401 });
  });
});

// ── factory ──────────────────────────────────────────────────────────────────────

describe("newTaxJarClient", () => {
  it("returns a working TaxJarClient", async () => {
    stubFetch(TAX_ENVELOPE);
    const client = newTaxJarClient("tj_factory_key");
    expect(client).toBeInstanceOf(TaxJarClient);
    const tax = await client.calcTax({ to_country: "US", amount: 5, shipping: 0 });
    expect(tax.amount_to_collect).toBe(1.5);
  });

  it("passes the sandbox flag through", async () => {
    const { calls } = stubFetch(TAX_ENVELOPE);
    const client = newTaxJarClient("tj_factory_key", true);
    await client.calcTax({ to_country: "US", amount: 5, shipping: 0 });
    expect(calls[0]!.url).toBe("https://api.sandbox.taxjar.com/v2/taxes");
  });
});

// ── calcTaxAuto ──────────────────────────────────────────────────────────────────

/** Stub pool whose query always returns an empty result set. */
const emptyPool = {
  query: async () => ({ rows: [] }),
} as unknown as Parameters<typeof calcTaxAuto>[0];

describe("calcTaxAuto", () => {
  it("uses the injected provider on success", async () => {
    const expected: TaxResult = {
      taxTotal: 7.5,
      taxLines: [{ name: "Sales tax", rate_pct: 6.25, amount: 7.5, is_inclusive: false }],
    };
    const provider: TaxProvider = {
      calc: vi.fn(async () => expected),
    };
    setTaxProvider(provider);

    const result = await calcTaxAuto(emptyPool, "store-1", 120, "US", "CA", {
      zip: "90002",
    });

    expect(result).toEqual(expected);
    expect(provider.calc).toHaveBeenCalledTimes(1);
  });

  it("falls back to the DB path when the provider throws", async () => {
    const provider: TaxProvider = {
      calc: vi.fn(async () => {
        throw new Error("provider boom");
      }),
    };
    setTaxProvider(provider);

    const result = await calcTaxAuto(emptyPool, "store-1", 120, "US", "CA");

    // DB-fallback with empty rows → empty result, never throws
    expect(result).toEqual({ taxTotal: 0, taxLines: [] });
    expect(provider.calc).toHaveBeenCalledTimes(1);
  });

  it("uses the DB path when no provider is configured", async () => {
    setTaxProvider(null);
    const result = await calcTaxAuto(emptyPool, "store-1", 120, "US", "CA");
    expect(result).toEqual({ taxTotal: 0, taxLines: [] });
  });
});
