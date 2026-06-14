/**
 * lib/x402/index.ts — public surface for the x402 machine-payment module.
 */
export { x402PreHandler, buildX402Config, buildPaymentOptionFromEnv, toAtomicUnits, parsePaymentProof, verifyPaymentProof } from "./middleware.js";
export { x402Plugin } from "./routes.js";
export type { X402PaymentOption, X402PaymentRequired, X402PaymentProof, X402Config, FacilitatorVerifyResponse } from "./types.js";
