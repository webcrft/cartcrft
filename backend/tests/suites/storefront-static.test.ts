/**
 * storefront-static — T5.2 suite.
 *
 * Verifies that the backend serves the pre-built storefront.js IIFE bundle
 * at GET /storefront.js with the correct Content-Type.
 *
 * Acceptance criteria:
 *  1. GET /storefront.js → 200 with Content-Type: application/javascript
 *  2. Response body is non-empty JavaScript (starts with the Cartcrft banner
 *     comment or contains the CartcrftCart global assignment).
 *  3. Response body is not a JSON error envelope.
 *  4. Cache-Control header is present.
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

describe("GET /storefront.js", () => {
  it("returns 200", async () => {
    const res = await ctx.request({ method: "GET", path: "/storefront.js" });
    expect(res.status).toBe(200);
  });

  it("returns Content-Type: application/javascript", async () => {
    // Use raw fetch so we can inspect headers.
    const url = `${ctx.baseUrl}/storefront.js`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toMatch(/application\/javascript/);
  });

  it("response body is non-empty text (not a JSON object)", async () => {
    const res = await ctx.request({ method: "GET", path: "/storefront.js" });
    // The ctx request helper JSON-parses the response; if it's JS the body
    // will be a string (the raw text), not a parsed JSON object.
    expect(typeof res.body === "string" || typeof res.body !== "object").toBe(true);
    // Body should be substantial — at least a few kilobytes.
    const body = res.body as string;
    expect(body.length).toBeGreaterThan(1000);
  });

  it("body contains CartcrftCart global export", async () => {
    const url = `${ctx.baseUrl}/storefront.js`;
    const res = await fetch(url);
    const text = await res.text();
    // The IIFE assigns window.CartcrftCart
    expect(text).toContain("CartcrftCart");
  });

  it("body contains CartcrftAuth global export", async () => {
    const url = `${ctx.baseUrl}/storefront.js`;
    const res = await fetch(url);
    const text = await res.text();
    expect(text).toContain("CartcrftAuth");
  });

  it("Cache-Control header is present", async () => {
    const url = `${ctx.baseUrl}/storefront.js`;
    const res = await fetch(url);
    const cc = res.headers.get("cache-control");
    expect(cc).toBeTruthy();
  });

  it("body does NOT look like a JSON error envelope", async () => {
    const url = `${ctx.baseUrl}/storefront.js`;
    const res = await fetch(url);
    const text = await res.text();
    // Error envelopes are small JSON like {"error":{...}}; the bundle is large JS.
    let parsedAsJson = false;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
        parsedAsJson = true;
      }
    } catch {
      // Not JSON — good.
    }
    expect(parsedAsJson).toBe(false);
  });
});
