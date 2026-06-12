/**
 * smoke — Cartcrft backend smoke suite.
 *
 * Acceptance criteria (tasks.md T0.3):
 *  1. GET /healthz responds 200 with { status, version, db }.
 *  2. The migration runner is idempotent on the test schema (ctx setup ran
 *     migrations once; calling the runner again applies zero new migrations
 *     and does not error).
 *  3. 404 routes return the Cartcrft error envelope shape
 *     { error: { code: "NOT_FOUND", message: string } }.
 *
 * The suite passes even when backend/migrations/ has zero .sql files
 * (Wave 0 — Wave 1 migrations may not be merged yet).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import { get, isErrorEnvelope, errorCode } from "../shared/helpers.js";
import type { TestCtx } from "../shared/ctx.js";

// ── Suite setup ───────────────────────────────────────────────────────────────

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 60_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── 1. Healthz ─────────────────────────────────────────────────────────────────

describe("GET /healthz", () => {
  it("returns 200 with status, version and db fields", async () => {
    const res = await get(ctx, "/healthz");

    expect(res.status).toBe(200);

    // Response must be a JSON object
    expect(typeof res.body).toBe("object");
    expect(res.body).not.toBeNull();

    const body = res.body as Record<string, unknown>;

    // status is either "ok" or "degraded"
    expect(["ok", "degraded"]).toContain(body["status"]);

    // version is a string
    expect(typeof body["version"]).toBe("string");

    // db is either "ok" or "error"
    expect(["ok", "error"]).toContain(body["db"]);
  });

  it("returns status=ok when the test DB is reachable", async () => {
    // If the DB were unreachable, ctx boot itself would have failed, so we
    // can assert the happy path here.
    const res = await get(ctx, "/healthz");
    const body = res.body as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["db"]).toBe("ok");
  });
});

// ── 2. Migration idempotency ───────────────────────────────────────────────────

describe("Migration runner", () => {
  it("schema_migrations tracking table exists in the test schema after ctx boot", async () => {
    // Even with no .sql files the runner creates the tracking table in the
    // test schema (not in public).
    const res = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations`
    );
    // COUNT(*) succeeds → table exists in the test schema's search_path.
    expect(res.rows[0]?.count).toBeDefined();
  });

  it("running the production migrate.ts runner a second time applies zero migrations without error", async () => {
    // The production runner (migrate.ts) uses getPool() which returns our
    // test pool (search_path = test schema).  The test schema's
    // schema_migrations table already records whatever was applied during
    // ctx boot, so a second run must be a no-op.
    const { runMigrations } = await import("../../src/db/migrate.js");

    let count = -1;
    await expect(
      (async () => {
        count = await runMigrations();
      })()
    ).resolves.toBeUndefined();

    expect(count).toBe(0);
  });
});

// ── 3. Error envelope ──────────────────────────────────────────────────────────

describe("Error envelope", () => {
  it("404 on an unknown route returns the Cartcrft error envelope", async () => {
    const res = await get(ctx, "/this-route-does-not-exist-at-all");

    expect(res.status).toBe(404);

    // Must match the error envelope shape { error: { code, message } }
    expect(isErrorEnvelope(res)).toBe(true);

    // Code must be NOT_FOUND
    expect(errorCode(res)).toBe("NOT_FOUND");
  });

  it("error envelope has a non-empty message string", async () => {
    const res = await get(ctx, "/another-nonexistent-route-abc123");

    expect(res.status).toBe(404);

    const body = res.body as Record<string, unknown>;
    const err = body["error"] as Record<string, unknown>;
    expect(typeof err["message"]).toBe("string");
    expect((err["message"] as string).length).toBeGreaterThan(0);
  });
});
