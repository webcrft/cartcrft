/**
 * cors — H1.2 suite.
 *
 * Verifies CORS + Helmet security-header behaviour:
 *  1. OPTIONS preflight from an allowed origin → 200/204, correct CORS headers.
 *  2. A request from a disallowed origin → CORS headers are NOT reflected back.
 *  3. Helmet security headers are present on a normal response (GET /healthz).
 *  4. Credentials mode: Access-Control-Allow-Credentials: true for allowed origin.
 *  5. /healthz and /storefront.js still respond successfully.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 60_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Issue an OPTIONS preflight from the given origin. */
async function preflight(origin: string, path = "/healthz"): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Authorization, Content-Type",
    },
  });
}

/** Issue a plain GET with an Origin header set. */
async function get(origin: string, path = "/healthz"): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    headers: { Origin: origin },
  });
}

// In the test environment APP_ENV is "test", which is != "production", so the
// dev localhost origins are added. We use one of those as our "allowed" origin.
const ALLOWED_ORIGIN = "http://localhost:5173";
const BLOCKED_ORIGIN = "https://evil.example.com";

// ── 1. Preflight from allowed origin ──────────────────────────────────────────

describe("OPTIONS preflight — allowed origin", () => {
  it("returns a 2xx status", async () => {
    const res = await preflight(ALLOWED_ORIGIN);
    // Fastify @fastify/cors returns 204 for preflight by default.
    expect(res.status === 200 || res.status === 204).toBe(true);
  });

  it("reflects Access-Control-Allow-Origin: <allowed>", async () => {
    const res = await preflight(ALLOWED_ORIGIN);
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao).toBe(ALLOWED_ORIGIN);
  });

  it("includes Access-Control-Allow-Credentials: true", async () => {
    const res = await preflight(ALLOWED_ORIGIN);
    const acac = res.headers.get("access-control-allow-credentials");
    expect(acac).toBe("true");
  });

  it("includes Access-Control-Allow-Methods with GET and POST", async () => {
    const res = await preflight(ALLOWED_ORIGIN);
    const methods = res.headers.get("access-control-allow-methods") ?? "";
    expect(methods).toMatch(/GET/i);
    expect(methods).toMatch(/POST/i);
  });

  it("includes Access-Control-Allow-Headers (contains Authorization)", async () => {
    const res = await preflight(ALLOWED_ORIGIN);
    const headers = res.headers.get("access-control-allow-headers") ?? "";
    // Case-insensitive — the header list may vary in casing.
    expect(headers.toLowerCase()).toContain("authorization");
  });

  it("includes Access-Control-Max-Age", async () => {
    const res = await preflight(ALLOWED_ORIGIN);
    const maxAge = res.headers.get("access-control-max-age");
    // Present and a positive integer string.
    expect(maxAge).toBeTruthy();
    expect(Number(maxAge)).toBeGreaterThan(0);
  });
});

// ── 2. Disallowed origin not reflected ────────────────────────────────────────

describe("CORS — disallowed origin", () => {
  it("preflight from a blocked origin does NOT set Access-Control-Allow-Origin", async () => {
    const res = await preflight(BLOCKED_ORIGIN);
    const acao = res.headers.get("access-control-allow-origin");
    // Must not echo back the blocked origin.
    expect(acao).not.toBe(BLOCKED_ORIGIN);
    // Also must not be wildcard (credentials mode forbids that anyway).
    expect(acao ?? "").not.toBe("*");
  });

  it("a blocked-origin GET does NOT receive Access-Control-Allow-Origin header", async () => {
    const res = await get(BLOCKED_ORIGIN);
    const acao = res.headers.get("access-control-allow-origin");
    expect(acao).not.toBe(BLOCKED_ORIGIN);
  });
});

// ── 3. Helmet security headers on a normal response ───────────────────────────

describe("Helmet security headers — GET /healthz from allowed origin", () => {
  let res: Response;

  beforeAll(async () => {
    res = await get(ALLOWED_ORIGIN, "/healthz");
  });

  it("returns 200", () => {
    expect(res.status).toBe(200);
  });

  it("sets X-Content-Type-Options: nosniff", () => {
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("sets X-Frame-Options (deny or sameorigin)", () => {
    const xfo = (res.headers.get("x-frame-options") ?? "").toLowerCase();
    expect(xfo === "deny" || xfo === "sameorigin").toBe(true);
  });

  it("sets Referrer-Policy", () => {
    expect(res.headers.get("referrer-policy")).toBeTruthy();
  });

  it("does NOT set Content-Security-Policy (intentionally disabled for API)", () => {
    // CSP is disabled so the MCP/SSE stream and storefront.js work without
    // needing to allowlist inline scripts or event-stream.
    const csp = res.headers.get("content-security-policy");
    expect(csp).toBeNull();
  });
});

// ── 4. Regression: key endpoints still work ───────────────────────────────────

describe("Regression — endpoints still reachable", () => {
  it("GET /healthz returns 200", async () => {
    const res = await get(ALLOWED_ORIGIN, "/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(["ok", "degraded"]).toContain(body["status"]);
  });

  it("GET /storefront.js returns 200", async () => {
    const res = await fetch(`${ctx.baseUrl}/storefront.js`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    expect(res.status).toBe(200);
  });
});
