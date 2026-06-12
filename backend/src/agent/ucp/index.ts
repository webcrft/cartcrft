/**
 * UCP adapter — version registry.
 *
 * Future versions co-exist in sibling directories (v2026_01/, v2026_07/, …).
 * Each version exports a Fastify plugin with relative routes; this index
 * registers each version under the appropriate prefix.
 *
 * Current versions:
 *   v2026_01 — UCP 2026-01 NRF baseline (provisional; see docs/ucp.md)
 *
 * URL space:
 *   /ucp/:storeId/...            — unversioned (latest pinned version)
 *   /ucp/v2026-01/:storeId/...   — explicit version (for negotiation / migration windows)
 *
 * Adding a new version:
 *   1. Create backend/src/agent/ucp/vYYYY_MM/ with types/catalog/checkout/routes.
 *   2. Import and register the plugin here under /ucp/vYYYY-MM.
 *   3. Update docs/ucp.md with the new version and divergences.
 *   4. Optionally re-point the unversioned /ucp prefix to the new version.
 */

import type { FastifyPluginAsync } from "fastify";
import { ucpV2026_01Plugin } from "./v2026_01/routes.js";

export const ucpPlugin: FastifyPluginAsync = async (app) => {
  // Latest version at /ucp (current: 2026-01)
  await app.register(ucpV2026_01Plugin, { prefix: "/ucp" });

  // Explicit versioned prefix /ucp/v2026-01
  await app.register(ucpV2026_01Plugin, { prefix: "/ucp/v2026-01" });
};
