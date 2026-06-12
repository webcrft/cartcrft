/**
 * Static asset routes.
 *
 * T5.2 — Serves the pre-built storefront.js IIFE bundle at GET /storefront.js
 * so storefronts can load the cart+checkout+auth SDK directly from the API server.
 *
 * The file is read from sdk/storefront/dist/storefront.js relative to the
 * monorepo root.  The path is resolved at startup; the file content is served
 * verbatim with `Content-Type: application/javascript; charset=utf-8`.
 */

import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// backend/src/http/ → backend/ → repo root
const REPO_ROOT = path.resolve(__dirname, "../../..");
const STOREFRONT_JS_PATH = path.join(
  REPO_ROOT,
  "sdk",
  "storefront",
  "dist",
  "storefront.js"
);

/** Read the storefront.js content at startup; cache it in memory. */
function loadStorefrontJs(): Buffer | null {
  try {
    return fs.readFileSync(STOREFRONT_JS_PATH);
  } catch {
    return null;
  }
}

const STOREFRONT_CONTENT: Buffer | null = loadStorefrontJs();

/**
 * Fastify plugin that registers GET /storefront.js.
 *
 * If the dist file is missing (e.g. the SDK has not been built yet),
 * the route responds with 404 so the backend still boots in all envs.
 */
export async function staticPlugin(app: FastifyInstance): Promise<void> {
  app.get("/storefront.js", async (_request, reply) => {
    if (!STOREFRONT_CONTENT) {
      return reply.status(404).send({
        error: {
          code: "NOT_FOUND",
          message:
            "storefront.js not found — run `pnpm --filter @cartcrft/storefront build` first",
        },
      });
    }

    return reply
      .status(200)
      .header("Content-Type", "application/javascript; charset=utf-8")
      .header("Cache-Control", "public, max-age=3600")
      .send(STOREFRONT_CONTENT);
  });
}
