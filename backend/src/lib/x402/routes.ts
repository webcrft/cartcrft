/**
 * lib/x402/routes.ts — x402 demo route plugin.
 *
 * Registers:
 *   GET /x402/demo — gated demo endpoint (off by default; set X402_ENABLED=true)
 *
 * The demo endpoint returns per-request metadata (request ID, timestamp) to
 * demonstrate that the caller successfully paid for the response.
 *
 * This plugin is intentionally lightweight — it exists to prove the x402
 * middleware works end-to-end. In production, the x402PreHandler can be
 * attached to any Fastify route (e.g. a paid AI inference endpoint, a rate-
 * limited API surface, or a per-request data feed).
 *
 * ENVIRONMENT VARIABLES:
 *   X402_ENABLED=true           — enable the middleware (off by default)
 *   X402_NETWORK=base           — payment network ("base" or "base-sepolia")
 *   X402_ASSET=USDC             — token symbol
 *   X402_ASSET_ADDRESS=0x...    — ERC-20 contract address on the network
 *   X402_AMOUNT=0.001           — amount per request (human-readable)
 *   X402_PAY_TO=0xYourWallet    — your wallet address to receive payments
 *   X402_FACILITATOR_URL=https://x402.org/facilitator  — Coinbase facilitator
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { x402PreHandler, buildX402Config } from "./middleware.js";

export const x402Plugin: FastifyPluginAsyncZod = async (app) => {
  // cfg is intentionally left empty — x402PreHandler reads env vars per-request
  // so that X402_ENABLED / X402_PAY_TO can be toggled at runtime (and in tests).

  /**
   * GET /x402/demo
   *
   * When X402_ENABLED=false (default): returns 200 with a note that x402 is off.
   * When X402_ENABLED=true:
   *   - No X-PAYMENT header → 402 with payment requirements JSON
   *   - Valid X-PAYMENT → 200 with { paid: true, request_id, served_at, note }
   *   - Invalid X-PAYMENT → 402 with error message
   */
  app.get(
    "/x402/demo",
    {
      schema: {
        description:
          "x402 machine-payment demo. Returns 402 with payment requirements when X402_ENABLED=true and no valid X-PAYMENT header is present.",
        tags: ["x402"],
        headers: z.object({
          "x-payment": z.string().optional(),
        }).passthrough(),
        response: {
          200: z.object({
            paid: z.boolean(),
            request_id: z.string(),
            served_at: z.string(),
            note: z.string(),
            x402_enabled: z.boolean(),
            settlement: z.record(z.string(), z.unknown()).optional(),
          }),
          402: z.object({
            x402Version: z.number(),
            accepts: z.array(z.record(z.string(), z.unknown())),
            error: z.string(),
          }),
        },
      },
      preHandler: x402PreHandler(),
    },
    async (request, reply) => {
      const enabled = process.env["X402_ENABLED"] === "true" || process.env["X402_ENABLED"] === "1";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- x402 not typed on FastifyRequest
      const x402Context = (request as any)["x402"] as {
        proof: unknown;
        option: unknown;
        settlement?: Record<string, unknown>;
      } | undefined;

      return reply.status(200).send({
        paid: enabled,
        request_id: request.id,
        served_at: new Date().toISOString(),
        note: enabled
          ? "Payment verified. Welcome to the x402 paid API surface."
          : "x402 is currently disabled (X402_ENABLED not set). Set X402_ENABLED=true to activate the payment gate.",
        x402_enabled: enabled,
        settlement: x402Context?.settlement,
      });
    }
  );

  /**
   * GET /x402/config
   * Returns the current x402 payment requirements (public endpoint — no auth required).
   * Useful for clients to discover payment options before hitting /x402/demo.
   */
  app.get(
    "/x402/config",
    {
      schema: {
        description: "Returns the x402 payment requirements for this server.",
        tags: ["x402"],
        response: {
          200: z.object({
            x402_enabled: z.boolean(),
            accepts: z.array(z.record(z.string(), z.unknown())),
          }),
        },
      },
    },
    async (_request, reply) => {
      const enabled = process.env["X402_ENABLED"] === "true" || process.env["X402_ENABLED"] === "1";
      // Build accepts dynamically from env so config endpoint reflects current state
      const dynamicCfg = buildX402Config();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema needs generic record
      const accepts = (dynamicCfg.accepts ?? []) as unknown as Record<string, unknown>[];
      return reply.status(200).send({
        x402_enabled: enabled,
        accepts,
      });
    }
  );
};
