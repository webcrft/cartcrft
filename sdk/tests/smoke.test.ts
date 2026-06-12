/**
 * sdk/tests/smoke.test.ts — SDK smoke suite.
 *
 * Boots the backend app in-process (via backend's buildApp + test harness ctx),
 * seeds the demo store, then exercises the @cartcrft/sdk typed client against
 * the real HTTP server.
 *
 * Coverage:
 *  1. List products — returns seeded products (≥12).
 *  2. Get product — returns correct product by ID.
 *  3. Search — semantic/full-text finds the merino hoodie.
 *  4. Validate discount code — WELCOME10 returns correct structure.
 *  5. Cart → Checkout → Complete flow (test mode):
 *     - create cart
 *     - add line item
 *     - create checkout
 *     - complete checkout → gets order_id + order_number
 *  6. CartcrftApiError thrown for 404 and 401.
 *
 * The test imports the backend buildApp and seed directly — both are in the
 * same pnpm workspace so no cross-package friction.  The DATABASE_URL is read
 * from the repo-root .env (same as all other backend test suites).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as dotenvConfig } from "dotenv";
import pg from "pg";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";

// ── Load .env ─────────────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../");
dotenvConfig({ path: path.join(repoRoot, ".env"), override: false });

// ── Import SDK (local TypeScript source) ─────────────────────────────────────
import { Cartcrft, CartcrftApiError } from "../src/index.js";

// ── Shared state ──────────────────────────────────────────────────────────────

let app: FastifyInstance;
let baseUrl: string;
let pool: pg.Pool;
let schemaName: string;
let pubKey: string;
let storeId: string;
let variantIds: string[][];

// ── Schema isolation helpers (mirrors backend/tests/shared/ctx.ts) ─────────────

function withSearchPath(connStr: string, schema: string): string {
  const searchPath = `${schema},public`;
  const optionsValue = encodeURIComponent(`-csearch_path=${searchPath}`);
  const sep = connStr.includes("?") ? "&" : "?";
  return `${connStr}${sep}options=${optionsValue}`;
}

async function runMigrations(pool: pg.Pool, schema: string): Promise<void> {
  const backendRoot = path.resolve(repoRoot, "backend");
  const { default: fs } = await import("node:fs");
  const migrationsDir = path.join(backendRoot, "migrations");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  if (!fs.existsSync(migrationsDir)) return;
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .filter((f) => !applied.has(f));

  for (const filename of files) {
    const raw = fs.readFileSync(path.join(migrationsDir, filename), "utf-8");
    let sql = raw.replace(/\bpublic\./gi, `"${schema}".`);
    sql = sql.replace(
      /\bcreate\s+extension\s+if\s+not\s+exists\s+(\w+)(?!\s+SCHEMA)/gi,
      "CREATE EXTENSION IF NOT EXISTS $1 SCHEMA public"
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [filename]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`[sdk-smoke-migrate] ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL not set");

  // 1. Create isolated test schema
  schemaName = `test_sdk_${randomBytes(4).toString("hex")}`;
  const adminClient = new pg.Client({ connectionString: databaseUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  } finally {
    await adminClient.end();
  }

  // 2. Pool scoped to test schema
  const testConnStr = withSearchPath(databaseUrl, schemaName);
  pool = new pg.Pool({ connectionString: testConnStr, max: 5, idleTimeoutMillis: 10_000 });

  // 3. Inject pool into backend singleton
  const { setPoolForTesting } = await import("../../backend/src/db/pool.js");
  setPoolForTesting(pool);

  // 4. Run migrations
  await runMigrations(pool, schemaName);

  // 5. Seed demo store
  const { seedDemoStore } = await import("../../backend/src/seed/index.js");
  const seed = await seedDemoStore(pool, { print: false });
  storeId = seed.storeId;
  pubKey = seed.pubKey;
  variantIds = seed.variantIds;

  // 6. Boot app
  process.env["APP_ENV"] = "test";
  const { buildApp } = await import("../../backend/src/http/app.js");
  app = await buildApp();
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
}, 180_000);

afterAll(async () => {
  try { await app.close(); } catch { /* ignore */ }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl && schemaName) {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try { await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); } finally { await client.end(); }
  }
  try {
    const { closePool } = await import("../../backend/src/db/pool.js");
    await closePool();
  } catch { /* ignore */ }
}, 30_000);

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("SDK smoke suite", () => {

  it("lists products on the seeded store (≥12 products)", async () => {
    const sdk = new Cartcrft({ baseUrl, apiKey: pubKey });
    const res = await sdk.catalog.listProducts(storeId);
    expect(Array.isArray(res.products)).toBe(true);
    expect(res.products.length).toBeGreaterThanOrEqual(12);
    const titles = res.products.map((p) => p.title);
    expect(titles.some((t) => t.toLowerCase().includes("hoodie"))).toBe(true);
  });

  it("gets a single product by ID", async () => {
    const sdk = new Cartcrft({ baseUrl, apiKey: pubKey });
    const { products } = await sdk.catalog.listProducts(storeId);
    const first = products[0];
    expect(first).toBeDefined();
    // getProduct returns the product directly (not wrapped)
    const product = await sdk.catalog.getProduct(storeId, first!.id);
    expect(product.id).toBe(first!.id);
    expect(product.title).toBe(first!.title);
  });

  it("searches for the merino hoodie via full-text", async () => {
    const sdk = new Cartcrft({ baseUrl, apiKey: pubKey });
    const res = await sdk.search.search(storeId, {
      query: "merino wool hoodie",
    });
    // Response shape: { results: [...], query: string, total: number }
    expect(typeof res.total).toBe("number");
    expect(res.total).toBeGreaterThan(0);
    const found = res.results.some((p) => p.title.toLowerCase().includes("hoodie"));
    expect(found).toBe(true);
  });

  it("validates WELCOME10 discount code", async () => {
    const sdk = new Cartcrft({ baseUrl, apiKey: pubKey });
    // validate() returns { discount_id, code, type, value, computed_amount? }
    const res = await sdk.discounts.validate(storeId, { code: "WELCOME10" });
    expect(res.code).toBe("WELCOME10");
    expect(res.type).toBe("percentage");
    expect(res.discount_id).toBeTruthy();
  });

  it("cart → checkout → complete (test mode)", async () => {
    const sdk = new Cartcrft({ baseUrl, apiKey: pubKey });

    // Use first product's first variant
    const productVariants = variantIds[0];
    expect(productVariants).toBeDefined();
    const variantId = productVariants![0];
    expect(variantId).toBeTruthy();

    // 1. Create cart — returns { id: string }
    const { id: cartId } = await sdk.carts.create(storeId);
    expect(cartId).toBeTruthy();

    // 2. Add line — returns { id: string }
    const lineResult = await sdk.carts.addLine(storeId, cartId, {
      variant_id: variantId!,
      quantity: 1,
    });
    expect(lineResult.id).toBeTruthy();

    // 3. Create checkout — returns checkout object with `id`
    const checkout = await sdk.checkout.create(storeId, {
      cart_id: cartId,
      email: "sdk-smoke@cartcrft-test.example.com",
      shipping_address: {
        name: "SDK Test",
        address1: "1 Test St",
        city: "Cape Town",
        country_code: "ZA",
        zip: "8001",
      },
    });
    expect(checkout.id).toBeTruthy();

    // 4. Complete checkout in test mode — returns { order_id, order_number }
    const result = await sdk.checkout.complete(storeId, checkout.id);
    expect(result.order_id).toBeTruthy();
    expect(result.order_number).toBeTruthy();
  });

  it("throws CartcrftApiError for nonexistent product (404)", async () => {
    const sdk = new Cartcrft({ baseUrl, apiKey: pubKey });
    await expect(
      sdk.catalog.getProduct(storeId, "00000000-0000-0000-0000-000000000000")
    ).rejects.toBeInstanceOf(CartcrftApiError);

    try {
      await sdk.catalog.getProduct(storeId, "00000000-0000-0000-0000-000000000000");
    } catch (e) {
      if (e instanceof CartcrftApiError) {
        expect(e.status).toBe(404);
        expect(e.error.code).toBe("NOT_FOUND");
      }
    }
  });

  it("throws CartcrftApiError for invalid API key (401)", async () => {
    const sdk = new Cartcrft({ baseUrl, apiKey: "cc_pub_invalid_key_here" });
    const err = await sdk.catalog.listProducts(storeId).catch((e) => e);
    expect(err).toBeInstanceOf(CartcrftApiError);
    expect((err as CartcrftApiError).status).toBe(401);
  });

});
