/**
 * lib/x402/types.ts — x402 HTTP 402 machine-payment type definitions.
 *
 * The x402 protocol (https://x402.org) layers crypto micro-payments on top
 * of HTTP. When a client hits a gated resource without a valid payment, the
 * server returns 402 with a JSON body describing payment requirements. The
 * client pays on-chain and retries with an X-PAYMENT header carrying the
 * settlement proof. The server verifies the proof via a facilitator service
 * before serving the response.
 *
 * Payment flow:
 *   1.  Client → GET /x402/demo (no X-PAYMENT)
 *       Server ← 402 { x402Version, accepts: [...], error: "Payment required" }
 *   2.  Client reads `accepts[0]` → initiates on-chain EIP-3009 transferWithAuthorization
 *   3.  Client → GET /x402/demo (X-PAYMENT: <base64-encoded settlement proof>)
 *       Server → verifies proof with facilitator → 200 { data }
 *
 * Facilitator:
 *   Coinbase's x402 facilitator (https://x402.org/facilitator) exposes:
 *     POST /verify   — check that a payment proof is valid for a given requirement
 *     POST /settle   — settle the payment on-chain (optional: facilitator can do it)
 *   These calls are credential-gated (see X402_FACILITATOR_URL env var).
 *
 * To go live:
 *   X402_ENABLED=true
 *   X402_NETWORK=base            # "base" or "base-sepolia" for testnet
 *   X402_ASSET=USDC              # USDC on Base (or "ETH")
 *   X402_ASSET_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # Base USDC
 *   X402_AMOUNT=0.001            # human-readable amount (e.g. $0.001 USDC)
 *   X402_PAY_TO=0xYourWalletAddress
 *   X402_FACILITATOR_URL=https://x402.org/facilitator  # Coinbase facilitator
 */

/** A single payment option the client can use to pay. */
export interface X402PaymentOption {
  /** Payment network, e.g. "base", "base-sepolia", "ethereum". */
  network: string;
  /** ERC-20 token symbol, e.g. "USDC". */
  asset: string;
  /** ERC-20 contract address (checksummed). */
  assetAddress: string;
  /** Human-readable amount to pay, e.g. "0.001". */
  amount: string;
  /** Amount in atomic units (e.g. USDC has 6 decimals → "0.001" = "1000"). */
  atomicAmount: string;
  /** Recipient wallet address (checksummed). */
  payTo: string;
  /** EIP-3009 / permit2 scheme for the payment. */
  scheme: "exact" | "upto";
  /**
   * Extra verifier params:
   *   maxTimeoutSeconds: maximum time the client has to submit after the 402
   *   memo:             optional per-request memo string
   */
  extra?: Record<string, unknown> | undefined;
}

/** 402 response body per x402 spec v1. */
export interface X402PaymentRequired {
  x402Version: 1;
  accepts: X402PaymentOption[];
  error: string;
}

/**
 * Settlement proof sent by the client in the X-PAYMENT header.
 * Base64url-encoded JSON of this shape (or a compact Coinbase facilitator token).
 */
export interface X402PaymentProof {
  /** Payment option this proof is for (client copies from accepts[n]). */
  network: string;
  asset: string;
  assetAddress: string;
  amount: string;
  atomicAmount: string;
  payTo: string;
  scheme: string;
  /** EIP-3009 signed transfer authorization. */
  authorization: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
    signature: string;
  };
  /** Facilitator-issued settlement receipt (optional — present if settled). */
  receipt?: string | undefined;
}

/** What the facilitator /verify endpoint returns. */
export interface FacilitatorVerifyResponse {
  isValid: boolean;
  invalidReason?: string | undefined;
  settlement?: {
    txHash?: string | undefined;
    settled?: boolean | undefined;
  } | undefined;
}

/** Middleware config for a single x402-gated route. */
export interface X402Config {
  /** Payment options to advertise. If omitted, built from env vars. */
  accepts?: X402PaymentOption[] | undefined;
  /** Override the facilitator verify URL (default: X402_FACILITATOR_URL env). */
  facilitatorUrl?: string | undefined;
  /** Error message to return in the 402 body. */
  errorMessage?: string | undefined;
}
