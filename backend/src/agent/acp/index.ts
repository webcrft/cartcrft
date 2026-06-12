/**
 * ACP adapter — version registry.
 *
 * Future versions co-exist in sibling directories (v2026_04/, v2026_10/, …).
 * Each version exports a Fastify plugin with relative routes; this index
 * registers each version under the appropriate prefix.
 *
 * Current versions:
 *   v2026_04 — ACP 2026-04 baseline (pinned; see docs/acp.md)
 *
 * URL space:
 *   /acp/:storeId/...              — unversioned (latest pinned version)
 *   /acp/v2026-04/:storeId/...     — explicit version (for negotiation / migration windows)
 *
 * Adding a new version:
 *   1. Create backend/src/agent/acp/vYYYY_MM/ with types/feed/sessions/routes.
 *   2. Import and register the plugin here under /acp/vYYYY-MM.
 *   3. Update docs/acp.md with the new version and divergences.
 *   4. Optionally re-point the unversioned /acp prefix to the new version.
 */

import type { FastifyPluginAsync } from "fastify";
import { acpV2026_04Plugin } from "./v2026_04/routes.js";

export const acpPlugin: FastifyPluginAsync = async (app) => {
  // Latest version at /acp (current: 2026-04)
  await app.register(acpV2026_04Plugin, { prefix: "/acp" });

  // Explicit versioned prefix /acp/v2026-04
  await app.register(acpV2026_04Plugin, { prefix: "/acp/v2026-04" });
};
