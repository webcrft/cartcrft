/**
 * generate-openapi.ts — Boot the Fastify app (no listen) and write the
 * OpenAPI 3.1 spec to docs/openapi.json.
 *
 * Usage:
 *   pnpm --filter backend generate-openapi
 *   # or directly:
 *   tsx src/scripts/generate-openapi.ts
 *
 * The spec is date-versioned (info.version = "2026-06-12") and includes
 * all routes registered by the production buildApp() factory.
 *
 * CARTCRFT_OPENAPI=1 is set automatically so swagger is registered.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { config as dotenvConfig } from "dotenv";

// ── Load .env from repo root ──────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
dotenvConfig({ path: path.join(repoRoot, ".env"), override: false });

// Enable OpenAPI plugin before importing buildApp
process.env["CARTCRFT_OPENAPI"] = "1";
// Disable DB requirement — we never listen, only read the spec
process.env["APP_ENV"] = process.env["APP_ENV"] ?? "development";

// ── Build app + extract spec ──────────────────────────────────────────────────
const { buildApp } = await import("../http/app.js");

const app = await buildApp({ openapi: true });

// fastify-swagger: call app.swagger() after ready
await app.ready();

// @fastify/swagger adds app.swagger() which returns the OpenAPI document
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- swagger() is untyped in FastifyInstance without the augmented type
const doc = (app as unknown as { swagger(): unknown }).swagger();

// ── Write to docs/openapi.json ────────────────────────────────────────────────
const docsDir = path.resolve(repoRoot, "docs");
fs.mkdirSync(docsDir, { recursive: true });
const outPath = path.join(docsDir, "openapi.json");
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf-8");

const pathCount = Object.keys((doc as Record<string, unknown>)["paths"] as Record<string, unknown>).length;
console.log(`✓ OpenAPI 3.1 spec written to ${outPath}`);
console.log(`  ${pathCount} paths`);

await app.close();
