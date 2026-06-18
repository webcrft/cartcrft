/**
 * shippo.test.ts — Unit tests for the Shippo shipping-aggregator client.
 *
 * Pure unit tests: the global `fetch` is stubbed (no DB, no network).
 * Covers getRates parsing, empty-rates fallback, purchaseLabel, getTransaction,
 * the >=400 error branch (ShippoAPIError), Authorization header shape, and
 * the newShippoClient factory.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ShippoClient,
  ShippoAPIError,
  newShippoClient,
} from "../../src/providers/shipping/shippo.js";

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Stub global fetch with a fixed response, capturing each call's url + init.
 * Restores automatically via afterEach (vi.unstubAllGlobals).
 */
function stubFetch(
  responseBody: unknown,
  opts: { status?: number } = {}
): CapturedCall[] {
  const status = opts.status ?? 200;
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
          ? url.toString()
          : (url as Request).url;
      calls.push({ url: urlStr, init });
      return {
        ok: status < 400,
        status,
        text: async () => JSON.stringify(responseBody),
        json: async () => responseBody,
      } as unknown as Response;
    }
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShippoClient.getRates", () => {
  it("parses and returns the rates array", async () => {
    const calls = stubFetch({
      object_id: "shp_1",
      rates: [
        {
          object_id: "rate_1",
          amount: "5.50",
          currency: "USD",
          provider: "USPS",
          servicelevel: { name: "Priority Mail", token: "usps_priority" },
          estimated_days: 2,
        },
      ],
    });

    const client = new ShippoClient("test_key");
    const rates = await client.getRates({
      address_from: {
        name: "Warehouse",
        street1: "1 Main St",
        city: "San Francisco",
        state: "CA",
        zip: "94105",
        country: "US",
      },
      address_to: {
        name: "Buyer",
        street1: "2 Market St",
        city: "New York",
        state: "NY",
        zip: "10001",
        country: "US",
      },
      parcels: [
        {
          length: 20,
          width: 15,
          height: 10,
          distance_unit: "cm",
          weight: 0.5,
          mass_unit: "kg",
        },
      ],
    });

    expect(rates).toHaveLength(1);
    expect(rates[0]?.object_id).toBe("rate_1");
    expect(rates[0]?.servicelevel.token).toBe("usps_priority");

    // POST to /shipments/ with async: false
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.goshippo.com/shipments/");
    expect(calls[0]?.init?.method).toBe("POST");
    const sentBody = JSON.parse(String(calls[0]?.init?.body));
    expect(sentBody.async).toBe(false);
  });

  it("returns [] when response has no rates", async () => {
    stubFetch({ object_id: "shp_2" });
    const client = new ShippoClient("test_key");
    const rates = await client.getRates({
      address_from: {
        name: "W",
        street1: "1 Main St",
        city: "SF",
        state: "CA",
        zip: "94105",
        country: "US",
      },
      address_to: {
        name: "B",
        street1: "2 Market St",
        city: "NY",
        state: "NY",
        zip: "10001",
        country: "US",
      },
      parcels: [],
    });
    expect(rates).toEqual([]);
  });
});

describe("ShippoClient.purchaseLabel", () => {
  it("POSTs to /transactions/ with the rate id and returns the transaction", async () => {
    const calls = stubFetch({
      object_id: "txn_1",
      status: "SUCCESS",
      tracking_number: "9400100000000000000000",
      tracking_url_provider: "https://tools.usps.com/go/track",
      label_url: "https://shippo-delivery.s3.amazonaws.com/label.pdf",
      rate: "rate_1",
    });

    const client = new ShippoClient("test_key");
    const txn = await client.purchaseLabel("rate_1");

    expect(txn.object_id).toBe("txn_1");
    expect(txn.tracking_number).toBe("9400100000000000000000");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.goshippo.com/transactions/");
    expect(calls[0]?.init?.method).toBe("POST");
    const sentBody = JSON.parse(String(calls[0]?.init?.body));
    expect(sentBody.rate).toBe("rate_1");
    expect(sentBody.label_file_type).toBe("PDF");
    expect(sentBody.async).toBe(false);
  });

  it("honours an explicit label_file_type", async () => {
    const calls = stubFetch({
      object_id: "txn_2",
      status: "SUCCESS",
      tracking_number: "T2",
      tracking_url_provider: "",
      label_url: "",
      rate: "rate_9",
    });

    const client = new ShippoClient("test_key");
    await client.purchaseLabel("rate_9", "PNG");

    const sentBody = JSON.parse(String(calls[0]?.init?.body));
    expect(sentBody.label_file_type).toBe("PNG");
  });
});

describe("ShippoClient.getTransaction", () => {
  it("GETs the transaction by id", async () => {
    const calls = stubFetch({
      object_id: "txn_3",
      status: "SUCCESS",
      tracking_number: "T3",
      tracking_url_provider: "",
      label_url: "https://example.com/l.pdf",
      rate: "rate_3",
    });

    const client = new ShippoClient("test_key");
    const txn = await client.getTransaction("txn_3");

    expect(txn.object_id).toBe("txn_3");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.goshippo.com/transactions/txn_3");
    expect(calls[0]?.init?.method).toBe("GET");
  });
});

describe("ShippoClient error handling", () => {
  it("throws ShippoAPIError with the status on a >=400 response", async () => {
    stubFetch({ detail: "Invalid token." }, { status: 401 });
    const client = new ShippoClient("bad_key");

    await expect(client.getTransaction("txn_x")).rejects.toBeInstanceOf(
      ShippoAPIError
    );
    await expect(client.getTransaction("txn_x")).rejects.toMatchObject({
      status: 401,
      name: "ShippoAPIError",
    });
  });
});

describe("ShippoClient auth header", () => {
  it("sends Authorization: ShippoToken <key>", async () => {
    const calls = stubFetch({
      object_id: "txn_4",
      status: "SUCCESS",
      tracking_number: "",
      tracking_url_provider: "",
      label_url: "",
      rate: "",
    });

    const client = new ShippoClient("my_secret_key");
    await client.getTransaction("txn_4");

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("ShippoToken my_secret_key");
  });
});

describe("newShippoClient", () => {
  it("returns a ShippoClient instance", () => {
    const client = newShippoClient("test_key");
    expect(client).toBeInstanceOf(ShippoClient);
  });
});
