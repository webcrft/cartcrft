/**
 * x402 — HTTP 402 machine-payment middleware tests (C-10b).
 *
 * Tests:
 *  Unit tests (no DB/server needed):
 *   1.  toAtomicUnits: USDC 6 decimals
 *   2.  parsePaymentProof: valid base64url JSON → decoded proof
 *   3.  parsePaymentProof: missing required field → null
 *   4.  parsePaymentProof: bad base64 → null
 *   5.  verifyPaymentProof (structural): matching proof → isValid=true
 *   6.  verifyPaymentProof (structural): wrong payTo → isValid=false
 *   7.  verifyPaymentProof (structural): wrong network → isValid=false
 *   8.  verifyPaymentProof (structural): amount too low → isValid=false
 *   9.  verifyPaymentProof (facilitator): facilitator returns isValid=true → passes
 *  10.  verifyPaymentProof (facilitator): facilitator returns isValid=false → rejected
 *  11.  verifyPaymentProof (facilitator): facilitator unreachable → isValid=false
 *
 *  Integration tests (live Fastify server):
 *  12.  GET /x402/config → 200 with x402_enabled=false, accepts array
 *  13.  GET /x402/demo (X402_ENABLED=false) → 200 (pass-through, note in body)
 *  14.  GET /x402/demo (X402_ENABLED=true, no X-PAYMENT) → 402 with correct JSON
 *  15.  GET /x402/demo (X402_ENABLED=true, malformed X-PAYMENT) → 402 with error
 *  16.  GET /x402/demo (X402_ENABLED=true, valid X-PAYMENT, no facilitator) → 200
 *  17.  GET /x402/demo (X402_ENABLED=true, invalid X-PAYMENT – wrong payTo) → 402
 *  18.  GET /x402/demo (X402_ENABLED=true, valid X-PAYMENT, facilitator mock ok) → 200
 *  19.  GET /x402/demo (X402_ENABLED=true, valid X-PAYMENT, facilitator mock rejects) → 402
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  toAtomicUnits,
  parsePaymentProof,
  verifyPaymentProof,
  buildX402Config,
} from "../../src/lib/x402/middleware.js";
import type { X402PaymentOption, X402PaymentProof } from "../../src/lib/x402/types.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Shared test payment option ─────────────────────────────────────────────────

const TEST_PAY_TO = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth for demo
const TEST_ASSET_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base

const TEST_OPTION: X402PaymentOption = {
  network: "base",
  asset: "USDC",
  assetAddress: TEST_ASSET_ADDRESS,
  amount: "0.001",
  atomicAmount: "1000", // 0.001 USDC * 10^6
  payTo: TEST_PAY_TO,
  scheme: "exact",
  extra: { maxTimeoutSeconds: 60 },
};

function makeValidProof(overrides: Partial<X402PaymentProof> = {}): X402PaymentProof {
  return {
    network: "base",
    asset: "USDC",
    assetAddress: TEST_ASSET_ADDRESS,
    amount: "0.001",
    atomicAmount: "1000",
    payTo: TEST_PAY_TO,
    scheme: "exact",
    authorization: {
      from: "0xabc123000000000000000000000000000000abcd",
      to: TEST_PAY_TO,
      value: "1000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0x" + "00".repeat(32),
      signature: "0x" + "ab".repeat(65),
    },
    ...overrides,
  };
}

function encodeProof(proof: X402PaymentProof): string {
  return Buffer.from(JSON.stringify(proof)).toString("base64url");
}

// ── Unit Tests ─────────────────────────────────────────────────────────────────

describe("x402 unit tests", () => {
  it("1. toAtomicUnits: USDC 6 decimals", () => {
    expect(toAtomicUnits("0.001", 6)).toBe("1000");
    expect(toAtomicUnits("1.000000", 6)).toBe("1000000");
    expect(toAtomicUnits("0.000001", 6)).toBe("1");
    expect(toAtomicUnits("100", 6)).toBe("100000000");
    expect(toAtomicUnits("0.1", 6)).toBe("100000");
    expect(toAtomicUnits("0.0", 6)).toBe("0");
  });

  it("2. parsePaymentProof: valid base64url JSON → decoded proof", () => {
    const proof = makeValidProof();
    const encoded = encodeProof(proof);
    const decoded = parsePaymentProof(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.network).toBe("base");
    expect(decoded!.payTo).toBe(TEST_PAY_TO);
    expect(decoded!.atomicAmount).toBe("1000");
    expect(decoded!.authorization.signature).toMatch(/^0x/);
  });

  it("3. parsePaymentProof: missing required field (authorization) → null", () => {
    const bad = { network: "base", assetAddress: TEST_ASSET_ADDRESS, payTo: TEST_PAY_TO, atomicAmount: "1000" };
    const encoded = Buffer.from(JSON.stringify(bad)).toString("base64url");
    expect(parsePaymentProof(encoded)).toBeNull();
  });

  it("4. parsePaymentProof: bad base64 → null", () => {
    expect(parsePaymentProof("!!! not base64 !!!")).toBeNull();
  });

  it("5. verifyPaymentProof (structural): matching proof → isValid=true", async () => {
    const proof = makeValidProof();
    const result = await verifyPaymentProof(proof, TEST_OPTION);
    expect(result.isValid).toBe(true);
  });

  it("6. verifyPaymentProof (structural): wrong payTo → isValid=false", async () => {
    const proof = makeValidProof({ payTo: "0x0000000000000000000000000000000000000001" });
    const result = await verifyPaymentProof(proof, TEST_OPTION);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/payTo/i);
  });

  it("7. verifyPaymentProof (structural): wrong network → isValid=false", async () => {
    const proof = makeValidProof({ network: "ethereum" });
    const result = await verifyPaymentProof(proof, TEST_OPTION);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/network/i);
  });

  it("8. verifyPaymentProof (structural): amount too low → isValid=false", async () => {
    const proof = makeValidProof({ atomicAmount: "500" }); // < 1000 required
    const result = await verifyPaymentProof(proof, TEST_OPTION);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/amount/i);
  });

  it("9. verifyPaymentProof (facilitator): facilitator returns isValid=true → passes", async () => {
    const REAL_FETCH = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url);
      if (urlStr.includes("facilitator") && urlStr.includes("/verify")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ isValid: true, settlement: { txHash: "0xabc", settled: true } }),
          text: async () => JSON.stringify({ isValid: true }),
        };
      }
      return REAL_FETCH(url as string, init);
    });

    const proof = makeValidProof();
    const result = await verifyPaymentProof(proof, TEST_OPTION, "https://x402.mock.facilitator.test");

    expect(result.isValid).toBe(true);
    expect(result.settlement?.txHash).toBe("0xabc");

    vi.restoreAllMocks();
  });

  it("10. verifyPaymentProof (facilitator): facilitator returns isValid=false → rejected", async () => {
    const REAL_FETCH = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url);
      if (urlStr.includes("facilitator") && urlStr.includes("/verify")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ isValid: false, invalidReason: "signature invalid" }),
          text: async () => JSON.stringify({ isValid: false, invalidReason: "signature invalid" }),
        };
      }
      return REAL_FETCH(url as string, init);
    });

    const proof = makeValidProof();
    const result = await verifyPaymentProof(proof, TEST_OPTION, "https://x402.mock.facilitator.test");

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("signature invalid");

    vi.restoreAllMocks();
  });

  it("11. verifyPaymentProof (facilitator): facilitator unreachable → isValid=false", async () => {
    const REAL_FETCH = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url);
      if (urlStr.includes("facilitator")) {
        throw new Error("ECONNREFUSED");
      }
      return REAL_FETCH(url as string, init);
    });

    const proof = makeValidProof();
    const result = await verifyPaymentProof(proof, TEST_OPTION, "https://x402.unreachable.test");

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toMatch(/unreachable|ECONNREFUSED/i);

    vi.restoreAllMocks();
  });
});

// ── Integration Tests ──────────────────────────────────────────────────────────

describe("x402 integration tests (HTTP)", () => {
  // Save and restore X402_ENABLED env var
  let savedX402Enabled: string | undefined;

  beforeEach(() => {
    savedX402Enabled = process.env["X402_ENABLED"];
  });

  afterEach(() => {
    if (savedX402Enabled === undefined) {
      delete process.env["X402_ENABLED"];
    } else {
      process.env["X402_ENABLED"] = savedX402Enabled;
    }
    vi.restoreAllMocks();
    // restoreAllMocks does NOT undo vi.stubGlobal("fetch", ...) — without this,
    // a leaked fetch stub bleeds into later tests (esp. the integration ones).
    vi.unstubAllGlobals();
  });

  it("12. GET /x402/config → 200 with x402_enabled=false, accepts array", async () => {
    delete process.env["X402_ENABLED"];

    const res = await ctx.request({ method: "GET", path: "/x402/config" });
    expect(res.status).toBe(200);
    expect(res.json["x402_enabled"]).toBe(false);
    expect(Array.isArray(res.json["accepts"])).toBe(true);
  });

  it("13. GET /x402/demo (X402_ENABLED=false) → 200 pass-through with note", async () => {
    delete process.env["X402_ENABLED"];

    const res = await ctx.request({ method: "GET", path: "/x402/demo" });
    expect(res.status).toBe(200);
    expect(res.json["x402_enabled"]).toBe(false);
    expect(res.json["note"]).toMatch(/disabled/i);
  });

  it("14. GET /x402/demo (X402_ENABLED=true, no X-PAYMENT) → 402 with correct JSON", async () => {
    process.env["X402_ENABLED"] = "true";
    process.env["X402_PAY_TO"] = TEST_PAY_TO;
    process.env["X402_AMOUNT"] = "0.001";

    const res = await ctx.request({ method: "GET", path: "/x402/demo" });
    expect(res.status).toBe(402);

    const body = res.json as Record<string, unknown>;
    expect(body["x402Version"]).toBe(1);
    expect(Array.isArray(body["accepts"])).toBe(true);
    const accepts = body["accepts"] as unknown[];
    expect(accepts.length).toBeGreaterThan(0);
    const first = accepts[0] as Record<string, unknown>;
    expect(first["network"]).toBeTruthy();
    expect(first["assetAddress"]).toBeTruthy();
    expect(first["payTo"]).toBe(TEST_PAY_TO);
    expect(first["amount"]).toBe("0.001");
    expect(typeof body["error"]).toBe("string");
  });

  it("15. GET /x402/demo (X402_ENABLED=true, malformed X-PAYMENT) → 402 with error", async () => {
    process.env["X402_ENABLED"] = "true";
    process.env["X402_PAY_TO"] = TEST_PAY_TO;

    const res = await ctx.request({
      method: "GET",
      path: "/x402/demo",
      headers: { "x-payment": "!!!notvalidbase64!!!" },
    });
    expect(res.status).toBe(402);
    expect(String(res.json["error"])).toMatch(/malformed|invalid/i);
  });

  it("16. GET /x402/demo (X402_ENABLED=true, valid X-PAYMENT, no facilitator) → 200", async () => {
    process.env["X402_ENABLED"] = "true";
    process.env["X402_PAY_TO"] = TEST_PAY_TO;
    process.env["X402_AMOUNT"] = "0.001";
    delete process.env["X402_FACILITATOR_URL"];

    const proof = makeValidProof();
    const encoded = encodeProof(proof);

    const res = await ctx.request({
      method: "GET",
      path: "/x402/demo",
      headers: { "x-payment": encoded },
    });
    expect(res.status).toBe(200);
    expect(res.json["paid"]).toBe(true);
    expect(res.json["x402_enabled"]).toBe(true);
  });

  it("17. GET /x402/demo (X402_ENABLED=true, invalid X-PAYMENT – wrong payTo) → 402", async () => {
    process.env["X402_ENABLED"] = "true";
    process.env["X402_PAY_TO"] = TEST_PAY_TO;
    process.env["X402_AMOUNT"] = "0.001";
    delete process.env["X402_FACILITATOR_URL"];

    const proof = makeValidProof({
      payTo: "0x0000000000000000000000000000000000000001", // wrong recipient
    });
    const encoded = encodeProof(proof);

    const res = await ctx.request({
      method: "GET",
      path: "/x402/demo",
      headers: { "x-payment": encoded },
    });
    expect(res.status).toBe(402);
    expect(String(res.json["error"])).toMatch(/payTo|verification/i);
  });

  it("18. GET /x402/demo with facilitator mock → 200 when facilitator says valid", async () => {
    process.env["X402_ENABLED"] = "true";
    process.env["X402_PAY_TO"] = TEST_PAY_TO;
    process.env["X402_AMOUNT"] = "0.001";
    process.env["X402_FACILITATOR_URL"] = "https://x402.mock.facilitator.test";

    const REAL_FETCH = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url);
      if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
        return REAL_FETCH(url as string, init);
      }
      if (urlStr.includes("facilitator")) {
        return {
          ok: true, status: 200,
          json: async () => ({ isValid: true, settlement: { txHash: "0xmockhash", settled: true } }),
          text: async () => JSON.stringify({ isValid: true }),
        };
      }
      throw new Error(`Unexpected fetch to: ${urlStr}`);
    });

    // We need a proof that passes structural checks too (since the middleware verifies
    // even when facilitator is set — it calls facilitator for full on-chain check)
    const proof = makeValidProof();
    const encoded = encodeProof(proof);

    const res = await ctx.request({
      method: "GET",
      path: "/x402/demo",
      headers: { "x-payment": encoded },
    });

    // The facilitator mock says valid → should be 200
    expect(res.status).toBe(200);
    expect(res.json["paid"]).toBe(true);
  });

  it("19. GET /x402/demo with facilitator mock → 402 when facilitator rejects", async () => {
    process.env["X402_ENABLED"] = "true";
    process.env["X402_PAY_TO"] = TEST_PAY_TO;
    process.env["X402_AMOUNT"] = "0.001";
    process.env["X402_FACILITATOR_URL"] = "https://x402.mock.facilitator-reject.test";

    const REAL_FETCH = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url);
      if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
        return REAL_FETCH(url as string, init);
      }
      if (urlStr.includes("facilitator")) {
        return {
          ok: true, status: 200,
          json: async () => ({ isValid: false, invalidReason: "Payment not found on-chain" }),
          text: async () => JSON.stringify({ isValid: false, invalidReason: "Payment not found on-chain" }),
        };
      }
      throw new Error(`Unexpected fetch to: ${urlStr}`);
    });

    const proof = makeValidProof();
    const encoded = encodeProof(proof);

    const res = await ctx.request({
      method: "GET",
      path: "/x402/demo",
      headers: { "x-payment": encoded },
    });

    expect(res.status).toBe(402);
    expect(String(res.json["error"])).toMatch(/not found on-chain|Payment/i);
  });
});
