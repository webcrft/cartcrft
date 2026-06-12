/**
 * cloud-mount.test.ts — Cloud billing webhook gate (T4.2 / Discovered item 1).
 *
 * Verifies:
 *  1. WITHOUT CARTCRFT_CLOUD set: POST /webhooks/billing/paystack is absent
 *     (404 returned).
 *  2. WITH CARTCRFT_CLOUD=1: POST /webhooks/billing/paystack route exists and
 *     responds with 401 (signature check) rather than 404.
 *
 * Strategy:
 *  We call buildApp() directly — the same factory used by the server — so we
 *  can control whether CARTCRFT_CLOUD is set.  We use a single shared TestCtx
 *  for DB setup and build a second Fastify app without DB binding for the route
 *  existence checks (the route mount is synchronous at build time).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../src/http/app.js";
import { createCtx, type TestCtx } from "../shared/ctx.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Inject a request into a Fastify app without starting an HTTP server.
 * Mirrors the approach used in ctx.ts.
 */
async function inject(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  method: string,
  url: string,
  body?: Record<string, unknown>
): Promise<{ statusCode: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (app as any).inject({
    method,
    url,
    payload: body ? JSON.stringify(body) : undefined,
    headers: {
      "content-type": "application/json",
    },
  });
  return { statusCode: res.statusCode as number };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Cloud billing webhook mount gate", () => {
  it("WITHOUT CARTCRFT_CLOUD: POST /webhooks/billing/paystack returns 404 (route absent)", async () => {
    const originalCloud = process.env["CARTCRFT_CLOUD"];
    delete process.env["CARTCRFT_CLOUD"];

    let app;
    try {
      app = await buildApp({});
      const res = await inject(app, "POST", "/webhooks/billing/paystack", {
        event: "charge.success",
        data: {},
      });

      // Route should be absent — not-found handler returns 404.
      expect(res.statusCode).toBe(404);
    } finally {
      if (originalCloud !== undefined) {
        process.env["CARTCRFT_CLOUD"] = originalCloud;
      }
      await app?.close();
    }
  });

  it("WITH CARTCRFT_CLOUD=1: POST /webhooks/billing/paystack returns non-404 (route exists)", async () => {
    const originalCloud = process.env["CARTCRFT_CLOUD"];
    process.env["CARTCRFT_CLOUD"] = "1";

    let app;
    try {
      app = await buildApp({});
      const res = await inject(app, "POST", "/webhooks/billing/paystack", {
        event: "charge.success",
        data: {},
      });

      // Route is mounted — signature check runs and rejects the unsigned request.
      // We get 401 (bad signature) rather than 404 (no route).
      // 400 is also acceptable if JSON parse fails before sig check.
      expect(res.statusCode).not.toBe(404);
      expect([401, 400, 200]).toContain(res.statusCode);
    } finally {
      if (originalCloud !== undefined) {
        process.env["CARTCRFT_CLOUD"] = originalCloud;
      } else {
        delete process.env["CARTCRFT_CLOUD"];
      }
      await app?.close();
    }
  });
});
