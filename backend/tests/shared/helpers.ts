/**
 * Typed HTTP helpers and fixture builders.
 *
 * Mirrors the spirit of webcrft-mono/backend/tests/shared/helpers.go:
 *  - get / post / put / del — typed wrappers around ctx.request with auth
 *    header injection (JWT Bearer or cc_ API key).
 *  - Fixture builders (org, store, product, variant, customer) that insert
 *    directly via SQL when the REST routes are not yet implemented.
 *
 * Auth:
 *   Auth endpoints (login, customer sessions, API key issuance) don't exist
 *   yet (Wave 2).  The helpers accept pre-minted tokens via `AuthOptions` and
 *   will be wired up properly once T2.1 lands.  Key-creation fixtures are
 *   stubbed with TODO markers.
 *
 * Resilience:
 *   Fixture builders that need tables which may not exist yet (Wave 1
 *   migrations may not be merged) catch "relation does not exist" errors from
 *   Postgres (code 42P01) and call `test.skip()` with a descriptive message so
 *   the whole suite is skipped gracefully rather than failing with a confusing
 *   error.
 */

import { test } from "vitest";
import pg from "pg";
import type { TestCtx, RequestResult } from "./ctx.js";

// ── Auth types ────────────────────────────────────────────────────────────────

/**
 * How to authenticate the request.
 *
 *  - `{ type: "bearer"; token: string }` — adds `Authorization: Bearer <token>`
 *  - `{ type: "api-key"; key: string }` — adds `Authorization: Bearer <cc_...key>`
 *  - `{ type: "none" }` — no Authorization header (public endpoints)
 *
 * TODO T2.1: add a `mintJwt(userId, orgId)` helper that signs a JWT with
 * JWT_SECRET from the test .env (mirrors webcrft MintToken).  Until then,
 * callers pass a pre-minted token string.
 */
export type AuthOptions =
  | { type: "bearer"; token: string }
  | { type: "api-key"; key: string }
  | { type: "none" };

/** No auth — convenience singleton for unauthenticated requests. */
export const NO_AUTH: AuthOptions = { type: "none" };

function authHeaders(auth: AuthOptions): Record<string, string> {
  switch (auth.type) {
    case "bearer":
      return { authorization: `Bearer ${auth.token}` };
    case "api-key":
      return { authorization: `Bearer ${auth.key}` };
    case "none":
      return {};
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * GET request with optional auth.
 */
export async function get(
  ctx: TestCtx,
  path: string,
  auth: AuthOptions = NO_AUTH
): Promise<RequestResult> {
  return ctx.request({
    method: "GET",
    path,
    headers: authHeaders(auth),
  });
}

/**
 * POST request with JSON body and optional auth.
 */
export async function post(
  ctx: TestCtx,
  path: string,
  body: unknown,
  auth: AuthOptions = NO_AUTH
): Promise<RequestResult> {
  return ctx.request({
    method: "POST",
    path,
    body,
    headers: authHeaders(auth),
  });
}

/**
 * PUT request with JSON body and optional auth.
 */
export async function put(
  ctx: TestCtx,
  path: string,
  body: unknown,
  auth: AuthOptions = NO_AUTH
): Promise<RequestResult> {
  return ctx.request({
    method: "PUT",
    path,
    body,
    headers: authHeaders(auth),
  });
}

/**
 * DELETE request with optional auth.
 */
export async function del(
  ctx: TestCtx,
  path: string,
  auth: AuthOptions = NO_AUTH
): Promise<RequestResult> {
  return ctx.request({
    method: "DELETE",
    path,
    headers: authHeaders(auth),
  });
}

// ── Error envelope helpers ────────────────────────────────────────────────────

/**
 * Extract the error code from a Cartcrft error envelope response.
 * Returns undefined if the response is not in envelope shape.
 */
export function errorCode(result: RequestResult): string | undefined {
  if (
    typeof result.body === "object" &&
    result.body !== null &&
    "error" in result.body
  ) {
    const err = (result.body as Record<string, unknown>)["error"];
    if (typeof err === "object" && err !== null && "code" in err) {
      return (err as Record<string, unknown>)["code"] as string;
    }
  }
  return undefined;
}

/**
 * Returns true if the response body is a valid Cartcrft error envelope
 * `{ error: { code: string, message: string } }`.
 */
export function isErrorEnvelope(result: RequestResult): boolean {
  if (typeof result.body !== "object" || result.body === null) return false;
  const b = result.body as Record<string, unknown>;
  if (typeof b["error"] !== "object" || b["error"] === null) return false;
  const e = b["error"] as Record<string, unknown>;
  return typeof e["code"] === "string" && typeof e["message"] === "string";
}

// ── Postgres error helpers ────────────────────────────────────────────────────

/** Postgres error code for "relation does not exist" (missing table). */
const PG_UNDEFINED_TABLE = "42P01";

/**
 * Wraps a fixture-building async function.  If the DB throws 42P01
 * (relation/table does not exist — Wave 1 migrations not landed yet),
 * the currently running test is skipped with a clear message instead of
 * failing with a confusing Postgres error.
 *
 * Usage:
 *   const orgId = await resilientFixture(
 *     () => insertOrg(ctx.pool, { name: 'Test Org' }),
 *     'organizations table missing — Wave 1 migrations not applied'
 *   );
 */
export async function resilientFixture<T>(
  fn: () => Promise<T>,
  skipMessage: string
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === PG_UNDEFINED_TABLE
    ) {
      // Vitest skip — test.skip() throws a special skip sentinel.
      test.skip(skipMessage);
      // Unreachable after skip(), but TypeScript needs a return.
      throw err;
    }
    throw err;
  }
}

// ── Fixture builder types ─────────────────────────────────────────────────────

export interface OrgFixture {
  id: string;
  name: string;
}

export interface StoreFixture {
  id: string;
  orgId: string;
  name: string;
  slug: string;
}

export interface ProductFixture {
  id: string;
  storeId: string;
  title: string;
}

export interface VariantFixture {
  id: string;
  productId: string;
  title: string;
  price: string; // numeric string, e.g. "99.99"
}

export interface CustomerFixture {
  id: string;
  storeId: string;
  email: string;
}

// ── SQL fixture builders ───────────────────────────────────────────────────────
//
// These insert rows directly via SQL, bypassing REST routes that don't exist
// yet.  They are resilient to missing tables (Wave 1 not landed).

/**
 * Insert a minimal organization row.
 *
 * Requires: Wave 1 migration (0001_commerce.sql) — no organizations table
 * exists yet in Wave 0.  If the table is missing the calling test is skipped.
 *
 * TODO T2.1: Once the organizations table lands, remove the TODO comment and
 * align column names with the final schema.  For now the fixture targets the
 * expected column names from the webcrft-mono port plan.
 */
export async function insertOrg(
  pool: pg.Pool,
  opts: { name?: string; slug?: string } = {}
): Promise<OrgFixture> {
  const name = opts.name ?? `Test Org ${Date.now()}`;
  const slug =
    opts.slug ??
    `test-org-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return resilientFixture(async () => {
    // Try inserting with slug (required in most deployments).
    // Fall back to name-only insert if the slug column doesn't exist.
    let res: { rows: { id: string; name: string }[] };
    try {
      res = await pool.query<{ id: string; name: string }>(
        `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id::text, name`,
        [name, slug]
      );
    } catch (err: unknown) {
      // If slug column doesn't exist, try without it
      if (
        err instanceof Error &&
        err.message.includes("slug") &&
        err.message.includes("column")
      ) {
        res = await pool.query<{ id: string; name: string }>(
          `INSERT INTO organizations (name) VALUES ($1) RETURNING id::text, name`,
          [name]
        );
      } else {
        throw err;
      }
    }
    const row = res.rows[0];
    if (!row) throw new Error("insertOrg: no row returned");
    return { id: row.id, name: row.name };
  }, `organizations table missing — Wave 1 migrations (0001_commerce.sql) not applied yet`);
}

/**
 * Insert a minimal store row.
 *
 * TODO T2.1: Align column names with the final stores table schema.
 */
export async function insertStore(
  pool: pg.Pool,
  opts: { orgId: string; name?: string; slug?: string }
): Promise<StoreFixture> {
  const name = opts.name ?? `Test Store ${Date.now()}`;
  const slug =
    opts.slug ??
    `test-store-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return resilientFixture(async () => {
    const res = await pool.query<{
      id: string;
      organization_id: string;
      name: string;
      slug: string;
    }>(
      `INSERT INTO stores (organization_id, name, slug)
       VALUES ($1::uuid, $2, $3)
       RETURNING id::text, organization_id::text, name, slug`,
      [opts.orgId, name, slug]
    );
    const row = res.rows[0];
    if (!row) throw new Error("insertStore: no row returned");
    return {
      id: row.id,
      orgId: row.organization_id,
      name: row.name,
      slug: row.slug,
    };
  }, `stores table missing — Wave 1 migrations (0001_commerce.sql) not applied yet`);
}

/**
 * Insert a minimal product row.
 *
 * TODO T2.2: Extend with optional fields (product_type, status, etc.) as the
 * catalog schema stabilises.
 */
export async function insertProduct(
  pool: pg.Pool,
  opts: { storeId: string; title?: string; slug?: string }
): Promise<ProductFixture> {
  const title = opts.title ?? `Test Product ${Date.now()}`;
  const slug =
    opts.slug ??
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) +
      "-" +
      Math.random().toString(36).slice(2, 7);
  return resilientFixture(async () => {
    const res = await pool.query<{ id: string; store_id: string; title: string }>(
      `INSERT INTO products (store_id, title, slug)
       VALUES ($1::uuid, $2, $3)
       RETURNING id::text, store_id::text, title`,
      [opts.storeId, title, slug]
    );
    const row = res.rows[0];
    if (!row) throw new Error("insertProduct: no row returned");
    return { id: row.id, storeId: row.store_id, title: row.title };
  }, `products table missing — Wave 1 migrations (0001_commerce.sql) not applied yet`);
}

/**
 * Insert a minimal product variant row.
 *
 * TODO T2.2: Align with final variants schema (sku, inventory_policy, etc.).
 */
export async function insertVariant(
  pool: pg.Pool,
  opts: { productId: string; title?: string; price?: string }
): Promise<VariantFixture> {
  const title = opts.title ?? "Default";
  const price = opts.price ?? "0.00";
  return resilientFixture(async () => {
    const res = await pool.query<{
      id: string;
      product_id: string;
      title: string;
      price: string;
    }>(
      `INSERT INTO product_variants (product_id, title, price)
       VALUES ($1::uuid, $2, $3::numeric)
       RETURNING id::text, product_id::text, title, price::text`,
      [opts.productId, title, price]
    );
    const row = res.rows[0];
    if (!row) throw new Error("insertVariant: no row returned");
    return {
      id: row.id,
      productId: row.product_id,
      title: row.title,
      price: row.price,
    };
  }, `product_variants table missing — Wave 1 migrations (0001_commerce.sql) not applied yet`);
}

/**
 * Insert a minimal customer row.
 *
 * TODO T2.8: Extend with password_hash for auth tests once customer auth lands.
 */
export async function insertCustomer(
  pool: pg.Pool,
  opts: { storeId: string; email?: string }
): Promise<CustomerFixture> {
  const email =
    opts.email ?? `test-${Date.now()}@cartcrft-test.example.com`;
  return resilientFixture(async () => {
    const res = await pool.query<{
      id: string;
      store_id: string;
      email: string;
    }>(
      `INSERT INTO customers (store_id, email)
       VALUES ($1::uuid, $2)
       RETURNING id::text, store_id::text, email`,
      [opts.storeId, email]
    );
    const row = res.rows[0];
    if (!row) throw new Error("insertCustomer: no row returned");
    return { id: row.id, storeId: row.store_id, email: row.email };
  }, `customers table missing — Wave 1 migrations (0001_commerce.sql) not applied yet`);
}

// ── Auth fixtures (implemented in T2.1) ──────────────────────────────────────

/**
 * Mint a JWT for a synthetic user/org pair.
 *
 * Signs with JWT_SECRET from the test environment (same .env the server uses).
 * Claim shape: { sub: userId, org: orgId, email?, iat, exp, jti }
 * Documented in docs/parity-endpoints.md.
 */
export async function mintJwt(opts: {
  userId: string;
  orgId: string;
  email?: string;
}): Promise<string> {
  const { mintTestJwt } = await import("../../src/lib/auth/jwt.js");
  return mintTestJwt(opts);
}

/**
 * Create a cc_pub_ or cc_prv_ API key for a store by calling the REST endpoint.
 * Returns the full raw key (shown once on creation).
 *
 * Requires: JWT auth for the org that owns the store.
 */
export async function createApiKey(
  ctx: TestCtx,
  opts: {
    orgId: string;
    userId: string;
    storeId?: string;
    type?: "public" | "private";
    scopes?: string[];
    name?: string;
  }
): Promise<string> {
  const token = await mintJwt({ userId: opts.userId, orgId: opts.orgId });
  const res = await post(
    ctx,
    "/api-keys",
    {
      name: opts.name ?? "Test Key",
      key_type: opts.type ?? "private",
      scopes: opts.scopes ?? ["commerce:read", "commerce:write", "commerce:admin"],
      ...(opts.storeId ? { store_id: opts.storeId } : {}),
    },
    { type: "bearer", token }
  );
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `createApiKey: expected 201 but got ${res.status}: ${JSON.stringify(res.body)}`
    );
  }
  const body = res.body as Record<string, unknown>;
  const key = body["key"];
  if (typeof key !== "string") {
    throw new Error("createApiKey: no key in response");
  }
  return key;
}

/**
 * patch — PATCH request with JSON body and optional auth.
 */
export async function patch(
  ctx: TestCtx,
  path: string,
  body: unknown,
  auth: AuthOptions = NO_AUTH
): Promise<RequestResult> {
  return ctx.request({
    method: "PATCH",
    path,
    body,
    headers: authHeaders(auth),
  });
}
