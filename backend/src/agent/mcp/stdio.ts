/**
 * agent/mcp/stdio.ts — stdio entrypoint for the Cartcrft MCP server.
 *
 * Usage (local Claude Desktop / Claude Code):
 *   CARTCRFT_STORE_ID=<uuid> CARTCRFT_API_KEY=<cc_pub_...> DATABASE_URL=<url> \
 *     node dist/agent/mcp/stdio.js
 *
 * Or via pnpm from the backend directory:
 *   CARTCRFT_STORE_ID=... CARTCRFT_API_KEY=... DATABASE_URL=... pnpm mcp:stdio
 *
 * The stdio transport reads JSON-RPC messages from stdin and writes to stdout.
 * Logs go to stderr so they don't pollute the MCP message stream.
 *
 * Environment variables:
 *   CARTCRFT_STORE_ID   — required: UUID of the store to expose
 *   CARTCRFT_API_KEY    — required: cc_pub_ or cc_prv_ key (for authentication)
 *   DATABASE_URL        — required: Postgres connection string
 *   APP_ENV             — optional: "production" suppresses debug logs
 */

import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from repo root (4 levels up: dist/agent/mcp/ → dist/ → backend/ → root,
// or during dev: src/agent/mcp/ → src/ → backend/ → root).
// We try multiple candidate paths so it works both from compiled dist/ and tsx-run src/.
for (const candidate of [
  path.resolve(__dirname, "../../../../.env"), // src/agent/mcp → backend/.env
  path.resolve(__dirname, "../../../../../.env"), // dist/agent/mcp → backend/../.env (repo root)
  path.resolve(__dirname, "../../../../../../.env"), // extra level just in case
]) {
  dotenvConfig({ path: candidate, override: false });
}

// ── Validate required env vars ─────────────────────────────────────────────────

const storeId = process.env["CARTCRFT_STORE_ID"];
const apiKey = process.env["CARTCRFT_API_KEY"];
const databaseUrl = process.env["DATABASE_URL"];

if (!storeId) {
  process.stderr.write("[cartcrft-mcp] ERROR: CARTCRFT_STORE_ID is required\n");
  process.exit(1);
}

if (!apiKey) {
  process.stderr.write("[cartcrft-mcp] ERROR: CARTCRFT_API_KEY is required\n");
  process.exit(1);
}

if (!databaseUrl) {
  process.stderr.write("[cartcrft-mcp] ERROR: DATABASE_URL is required\n");
  process.exit(1);
}

// ── Import services after env is confirmed set ─────────────────────────────────
// config.ts reads DATABASE_URL at import time (zod-parsed), so env vars must
// be populated before we import any module that touches config.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { lookupApiKey, hasScope } from "../../modules/apikeys/service.js";
import { getPool } from "../../db/pool.js";
import { buildMcpServer } from "./server.js";

// ── Validate the API key and store ────────────────────────────────────────────

const cached = await lookupApiKey(apiKey);
if (!cached) {
  process.stderr.write("[cartcrft-mcp] ERROR: Invalid or expired CARTCRFT_API_KEY\n");
  process.exit(1);
}

if (cached.storeRestriction && cached.storeRestriction !== storeId) {
  process.stderr.write(
    `[cartcrft-mcp] ERROR: API key is not authorized for store ${storeId}\n`
  );
  process.exit(1);
}

if (!hasScope(cached.scopes, "commerce:read")) {
  process.stderr.write(
    "[cartcrft-mcp] ERROR: API key requires commerce:read scope\n"
  );
  process.exit(1);
}

const pool = getPool();
const { rows } = await pool.query<{ exists: boolean }>(
  `SELECT EXISTS(SELECT 1 FROM stores WHERE id = $1::uuid AND is_active = true) AS exists`,
  [storeId]
);
if (!rows[0]?.exists) {
  process.stderr.write(`[cartcrft-mcp] ERROR: Store not found: ${storeId}\n`);
  process.exit(1);
}

// ── Start the stdio server ─────────────────────────────────────────────────────

const server = buildMcpServer(storeId);
const transport = new StdioServerTransport();

process.stderr.write(`[cartcrft-mcp] Starting stdio MCP server for store ${storeId}\n`);

await server.connect(transport);

// Keep the process alive — stdio transport stays connected until stdin closes
process.on("SIGINT", async () => {
  process.stderr.write("[cartcrft-mcp] Shutting down...\n");
  await server.close();
  process.exit(0);
});
