/**
 * ssrf.test.ts — DB-free unit tests for the outbound-URL SSRF guard.
 *
 * Literal-IP cases need no DNS. Hostname cases (localhost, public/private DNS)
 * stub dns.promises.lookup with vi so the suite is deterministic and offline.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { promises as dns } from "node:dns";
import { assertSafeOutboundUrl, SsrfBlockedError } from "../../src/lib/net/ssrf.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Stub dns.lookup({ all: true }) to return a fixed address set. */
function stubLookup(records: Array<{ address: string; family: number }>) {
  vi.spyOn(dns, "lookup").mockImplementation((async () => records) as never);
}

describe("assertSafeOutboundUrl — blocks unsafe targets", () => {
  it("blocks cloud metadata IP 169.254.169.254", async () => {
    await expect(assertSafeOutboundUrl("http://169.254.169.254/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks localhost (resolves to loopback)", async () => {
    stubLookup([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertSafeOutboundUrl("http://localhost/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks loopback literal 127.0.0.1", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks private IPv4 10.0.0.5", async () => {
    await expect(assertSafeOutboundUrl("http://10.0.0.5/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks private IPv4 literal 192.168.1.1", async () => {
    await expect(assertSafeOutboundUrl("http://192.168.1.1/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks IPv6 loopback [::1]", async () => {
    await expect(assertSafeOutboundUrl("http://[::1]/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks a private/ULA IPv6 [fc00::1]", async () => {
    await expect(assertSafeOutboundUrl("http://[fc00::1]/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks link-local IPv6 [fe80::1]", async () => {
    await expect(assertSafeOutboundUrl("http://[fe80::1]/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks CGNAT 100.64.0.1", async () => {
    await expect(assertSafeOutboundUrl("http://100.64.0.1/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks metadata.google.internal hostname", async () => {
    await expect(
      assertSafeOutboundUrl("http://metadata.google.internal/")
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks a hostname that resolves to a private IP", async () => {
    stubLookup([{ address: "10.1.2.3", family: 4 }]);
    await expect(assertSafeOutboundUrl("http://evil.example.com/")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks non-http schemes (file:)", async () => {
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });

  it("blocks invalid URLs", async () => {
    await expect(assertSafeOutboundUrl("not a url")).rejects.toBeInstanceOf(
      SsrfBlockedError
    );
  });
});

describe("assertSafeOutboundUrl — allows safe public targets", () => {
  it("allows a public IPv4 literal 1.1.1.1", async () => {
    const url = await assertSafeOutboundUrl("https://1.1.1.1/webhook");
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("1.1.1.1");
  });

  it("allows a hostname resolving to a public IP", async () => {
    stubLookup([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertSafeOutboundUrl("https://example.com/hook");
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe("example.com");
  });

  it("allows http (not just https) for a public host", async () => {
    const url = await assertSafeOutboundUrl("http://1.1.1.1/");
    expect(url).toBeInstanceOf(URL);
  });
});
