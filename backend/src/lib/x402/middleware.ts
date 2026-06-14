/**
 * lib/x402/middleware.ts — x402 HTTP 402 machine-payment Fastify preHandler.
 *
 * Usage:
 *   import { x402PreHandler, buildX402Config } from "../lib/x402/middleware.js";
 *
 *   // In a Fastify plugin:
 *   app.get("/x402/demo", {
 *     preHandler: x402PreHandler(buildX402Config()),
 *   }, handler);
 *
 * The middleware:
 *   1. If X402_ENABLED is falsy → pass through (no-op, off by default).
 *   2. If no X-PAYMENT header → return 402 with payment requirements JSON.
 *   3. If X-PAYMENT header present → verify the proof via the facilitator.
 *   4. On valid proof → set `request.x402` with the proof + continue.
 *   5. On invalid proof → return 402 with an error.
 *
 * FACILITATOR CONFIG (to go live):
 *   Set X402_FACILITATOR_URL to the Coinbase x402 facilitator endpoint, e.g.:
 *     X402_FACILITATOR_URL=https://x402.org/facilitator
 *
 *   The facilitator exposes:
 *     POST /verify  body: { payment: <proof>, paymentRequirements: <option> }
 *                   → { isValid, invalidReason }
 *
 *   Without X402_FACILITATOR_URL the middleware performs structural proof
 *   validation only (checks required fields) — safe for dev/demo but DOES NOT
 *   verify on-chain payment. Set the facilitator URL for production.
 *
 * ON-CHAIN WALLET SETUP:
 *   X402_PAY_TO must be your wallet's checksummed Ethereum address.
 *   Use a Coinbase Wallet, MetaMask, or any EVM-compatible custody.
 *   For Base mainnet: fund your wallet with USDC on Base.
 *   For Base Sepolia testnet: use the Coinbase faucet for test USDC.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type {
  X402PaymentOption,
  X402PaymentRequired,
  X402PaymentProof,
  X402Config,
  FacilitatorVerifyResponse,
} from "./types.js";

// Re-export types for consumers
export type { X402PaymentOption, X402PaymentRequired, X402PaymentProof, X402Config };

// ── USDC on Base (mainnet) ─────────────────────────────────────────────────────
// Source: https://developers.circle.com/stablecoins/usdc-on-main-networks
const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Convert a human-readable token amount to atomic units.
 * e.g. toAtomicUnits("0.001", 6) → "1000"
 */
export function toAtomicUnits(amount: string, decimals: number): string {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  // Drop leading zeros but keep at least one digit
  const raw = `${whole}${fracPadded}`.replace(/^0+/, "") || "0";
  return raw;
}

/**
 * Build the X402PaymentOption from environment variables.
 * Throws if required env vars are missing.
 */
export function buildPaymentOptionFromEnv(): X402PaymentOption {
  const network = process.env["X402_NETWORK"] ?? "base";
  const asset = process.env["X402_ASSET"] ?? "USDC";
  const assetAddress = process.env["X402_ASSET_ADDRESS"] ?? USDC_BASE_ADDRESS;
  const amount = process.env["X402_AMOUNT"] ?? "0.001";
  const payTo = process.env["X402_PAY_TO"] ?? "";
  const scheme = (process.env["X402_SCHEME"] ?? "exact") as "exact" | "upto";

  if (!payTo) {
    throw new Error(
      "x402: X402_PAY_TO is required. Set it to your EVM wallet address to receive payments."
    );
  }

  const atomicAmount = toAtomicUnits(amount, USDC_DECIMALS);

  return {
    network,
    asset,
    assetAddress,
    amount,
    atomicAmount,
    payTo,
    scheme,
    extra: {
      maxTimeoutSeconds: 60,
    },
  };
}

/**
 * Build an X402Config from environment variables.
 * Use this to create the config passed to x402PreHandler().
 */
export function buildX402Config(overrides: Partial<X402Config> = {}): X402Config {
  return {
    facilitatorUrl: process.env["X402_FACILITATOR_URL"],
    errorMessage: "Payment required",
    ...overrides,
    // Build accepts from env if not provided
    accepts: overrides.accepts ?? (() => {
      try {
        return [buildPaymentOptionFromEnv()];
      } catch {
        // X402_PAY_TO not set — return placeholder for demo
        return [{
          network: process.env["X402_NETWORK"] ?? "base",
          asset: process.env["X402_ASSET"] ?? "USDC",
          assetAddress: process.env["X402_ASSET_ADDRESS"] ?? USDC_BASE_ADDRESS,
          amount: process.env["X402_AMOUNT"] ?? "0.001",
          atomicAmount: toAtomicUnits(process.env["X402_AMOUNT"] ?? "0.001", USDC_DECIMALS),
          payTo: process.env["X402_PAY_TO"] ?? "0x0000000000000000000000000000000000000000",
          scheme: "exact",
          extra: { maxTimeoutSeconds: 60 },
        }];
      }
    })(),
  };
}

/**
 * Parse and structurally validate an X-PAYMENT header value.
 *
 * The value is base64url-encoded JSON matching X402PaymentProof shape.
 * Returns the decoded proof or null if malformed.
 */
export function parsePaymentProof(header: string): X402PaymentProof | null {
  try {
    const json = Buffer.from(header, "base64url").toString("utf8");
    const obj = JSON.parse(json) as unknown;

    if (typeof obj !== "object" || obj === null) return null;
    const proof = obj as Record<string, unknown>;

    // Required fields
    if (
      typeof proof["network"] !== "string" ||
      typeof proof["assetAddress"] !== "string" ||
      typeof proof["payTo"] !== "string" ||
      typeof proof["atomicAmount"] !== "string" ||
      typeof proof["authorization"] !== "object" ||
      proof["authorization"] === null
    ) {
      return null;
    }

    const auth = proof["authorization"] as Record<string, unknown>;
    if (
      typeof auth["from"] !== "string" ||
      typeof auth["to"] !== "string" ||
      typeof auth["value"] !== "string" ||
      typeof auth["signature"] !== "string"
    ) {
      return null;
    }

    return proof as unknown as X402PaymentProof;
  } catch {
    return null;
  }
}

/**
 * Verify a payment proof against a payment option.
 *
 * If X402_FACILITATOR_URL is set, calls the Coinbase x402 facilitator's
 * /verify endpoint for on-chain verification.
 *
 * Without the facilitator URL, performs structural verification:
 *   - proof.payTo matches the configured payTo address (case-insensitive)
 *   - proof.atomicAmount >= the required atomicAmount
 *   - proof.assetAddress matches (case-insensitive)
 *   - proof.network matches
 *
 * NOTE: Structural-only verification does NOT confirm payment occurred on-chain.
 * Set X402_FACILITATOR_URL for production use.
 */
export async function verifyPaymentProof(
  proof: X402PaymentProof,
  option: X402PaymentOption,
  facilitatorUrl?: string | undefined
): Promise<FacilitatorVerifyResponse> {
  // ── Facilitator verify (on-chain) ──────────────────────────────────────────
  if (facilitatorUrl) {
    const verifyUrl = facilitatorUrl.replace(/\/$/, "") + "/verify";
    try {
      const resp = await fetch(verifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payment: proof,
          paymentRequirements: option,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return {
          isValid: false,
          invalidReason: `Facilitator returned HTTP ${resp.status}: ${body.slice(0, 200)}`,
        };
      }

      const result = (await resp.json()) as FacilitatorVerifyResponse;
      return result;
    } catch (err) {
      return {
        isValid: false,
        invalidReason: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ── Structural verification only (no facilitator) ─────────────────────────
  const issues: string[] = [];

  if (proof.network.toLowerCase() !== option.network.toLowerCase()) {
    issues.push(`network mismatch: got ${proof.network}, expected ${option.network}`);
  }

  if (proof.assetAddress.toLowerCase() !== option.assetAddress.toLowerCase()) {
    issues.push(`assetAddress mismatch: got ${proof.assetAddress}`);
  }

  if (proof.payTo.toLowerCase() !== option.payTo.toLowerCase()) {
    issues.push(`payTo mismatch: got ${proof.payTo}, expected ${option.payTo}`);
  }

  const proofAtomic = BigInt(proof.atomicAmount);
  const requiredAtomic = BigInt(option.atomicAmount);
  if (proofAtomic < requiredAtomic) {
    issues.push(`amount too low: got ${proof.atomicAmount}, need >= ${option.atomicAmount}`);
  }

  if (issues.length > 0) {
    return { isValid: false, invalidReason: issues.join("; ") };
  }

  return { isValid: true };
}

// ── Fastify preHandler factory ─────────────────────────────────────────────────

type X402PreHandler = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<void>;

/**
 * Create a Fastify preHandler that enforces x402 payment for a route.
 *
 * Returns the preHandler function. Register it via:
 *   app.get("/x402/demo", { preHandler: x402PreHandler(config) }, handler);
 *
 * @param cfg  X402Config — uses env vars if omitted
 */
export function x402PreHandler(cfg: X402Config = {}): X402PreHandler {
  // cfg is static overrides — dynamic values (env vars, accepts) are resolved per-request
  // so that tests can toggle X402_ENABLED / X402_PAY_TO between test cases.

  return async function x402Gate(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Gate on X402_ENABLED — off by default
    if (process.env["X402_ENABLED"] !== "true" && process.env["X402_ENABLED"] !== "1") {
      return; // Pass through: feature disabled
    }

    // Resolve per-request: env vars may change between tests / live reconfig
    const facilitatorUrl = cfg.facilitatorUrl ?? process.env["X402_FACILITATOR_URL"];
    const errorMessage = cfg.errorMessage ?? "Payment required";
    const accepts: X402PaymentOption[] = cfg.accepts ?? (() => {
      try {
        return [buildPaymentOptionFromEnv()];
      } catch {
        return [];
      }
    })();

    const paymentHeader = (request.headers as Record<string, string | string[] | undefined>)["x-payment"];
    const paymentValue = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;

    // No X-PAYMENT header → return 402 with payment requirements
    if (!paymentValue) {
      const body: X402PaymentRequired = {
        x402Version: 1,
        accepts,
        error: errorMessage,
      };
      await reply.status(402).header("Content-Type", "application/json").send(body);
      return;
    }

    // Parse the proof
    const proof = parsePaymentProof(paymentValue);
    if (!proof) {
      const body: X402PaymentRequired = {
        x402Version: 1,
        accepts,
        error: "X-PAYMENT header is malformed or not valid base64url JSON",
      };
      await reply.status(402).header("Content-Type", "application/json").send(body);
      return;
    }

    // Find the matching payment option (by network + assetAddress)
    const matchingOption = accepts.find(
      (o) =>
        o.network.toLowerCase() === proof.network?.toLowerCase() &&
        o.assetAddress.toLowerCase() === proof.assetAddress?.toLowerCase()
    ) ?? accepts[0];

    if (!matchingOption) {
      await reply.status(402).send({
        x402Version: 1,
        accepts: [],
        error: "No payment options configured",
      });
      return;
    }

    // Verify the proof
    const verification = await verifyPaymentProof(
      proof,
      matchingOption,
      facilitatorUrl
    );

    if (!verification.isValid) {
      const body: X402PaymentRequired = {
        x402Version: 1,
        accepts,
        error: verification.invalidReason ?? "Payment verification failed",
      };
      await reply.status(402).header("Content-Type", "application/json").send(body);
      return;
    }

    // Proof valid — attach to request for the handler
    (request as FastifyRequest & { x402?: unknown })["x402"] = {
      proof,
      option: matchingOption,
      settlement: verification.settlement,
    };

    // Continue to the route handler
  };
}
