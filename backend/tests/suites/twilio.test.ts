/**
 * twilio.test.ts — Unit tests for the Twilio Messages API client.
 *
 * Pure unit tests: global `fetch` is stubbed, no database is involved.
 * Covers SMS, WhatsApp prefixing, MessagingServiceSid, error branch, factory.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  TwilioClient,
  TwilioAPIError,
  newTwilioClient,
} from "../../src/providers/notifications/twilio.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/**
 * Stub global fetch, capturing the request, and return the given body/status.
 */
function stubFetch(
  responseBody: Record<string, unknown>,
  opts: { status?: number } = {}
): { calls: CapturedCall[] } {
  const status = opts.status ?? 201;
  const calls: CapturedCall[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(responseBody),
      json: async () => responseBody,
    } as unknown as Response;
  });
  return { calls };
}

/** Parse the urlencoded body of a captured call into a URLSearchParams. */
function bodyParams(call: CapturedCall): URLSearchParams {
  return new URLSearchParams(String(call.init.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TwilioClient.sendSms", () => {
  it("POSTs urlencoded To/From/Body to Messages.json with Basic auth and returns the parsed result", async () => {
    const { calls } = stubFetch(
      { sid: "SM123", status: "queued", to: "+15558675309", from: "+15551112222" },
      { status: 201 }
    );

    const client = new TwilioClient({
      accountSid: "AC_test_sid",
      authToken: "tok_secret",
      fromNumber: "+15551112222",
    });

    const result = await client.sendSms({ to: "+15558675309", body: "Hello there" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC_test_sid/Messages.json"
    );
    expect(call.init.method).toBe("POST");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const expectedAuth = Buffer.from("AC_test_sid:tok_secret").toString("base64");
    expect(headers["Authorization"]).toBe(`Basic ${expectedAuth}`);

    const params = bodyParams(call);
    expect(params.get("To")).toBe("+15558675309");
    expect(params.get("From")).toBe("+15551112222");
    expect(params.get("Body")).toBe("Hello there");
    expect(params.get("MessagingServiceSid")).toBeNull();

    expect(result.sid).toBe("SM123");
    expect(result.status).toBe("queued");
    expect(result.to).toBe("+15558675309");
  });
});

describe("TwilioClient.sendWhatsapp", () => {
  it("prefixes whatsapp: on To and From", async () => {
    const { calls } = stubFetch(
      { sid: "SM456", status: "queued", to: "whatsapp:+15558675309" },
      { status: 201 }
    );

    const client = new TwilioClient({
      accountSid: "AC_test_sid",
      authToken: "tok_secret",
      fromNumber: "+15551112222",
    });

    await client.sendWhatsapp({ to: "+15558675309", body: "Hi via WA" });

    const params = bodyParams(calls[0]!);
    expect(params.get("To")).toBe("whatsapp:+15558675309");
    expect(params.get("From")).toBe("whatsapp:+15551112222");
    expect(params.get("Body")).toBe("Hi via WA");
  });

  it("does not double-prefix when whatsapp: is already present", async () => {
    const { calls } = stubFetch({ sid: "SM789", status: "queued", to: "whatsapp:+15558675309" });

    const client = new TwilioClient({
      accountSid: "AC_test_sid",
      authToken: "tok_secret",
      fromNumber: "whatsapp:+15551112222",
    });

    await client.sendWhatsapp({ to: "whatsapp:+15558675309", body: "x" });

    const params = bodyParams(calls[0]!);
    expect(params.get("To")).toBe("whatsapp:+15558675309");
    expect(params.get("From")).toBe("whatsapp:+15551112222");
  });
});

describe("TwilioClient — MessagingServiceSid", () => {
  it("sends MessagingServiceSid instead of From when configured", async () => {
    const { calls } = stubFetch({ sid: "SMms", status: "queued", to: "+15558675309" });

    const client = new TwilioClient({
      accountSid: "AC_test_sid",
      authToken: "tok_secret",
      fromNumber: "+15551112222",
      messagingServiceSid: "MG_service_sid",
    });

    await client.sendSms({ to: "+15558675309", body: "msg" });

    const params = bodyParams(calls[0]!);
    expect(params.get("MessagingServiceSid")).toBe("MG_service_sid");
    expect(params.get("From")).toBeNull();
  });
});

describe("TwilioClient — error branches", () => {
  it("throws TwilioAPIError when Twilio returns status >= 400", async () => {
    stubFetch(
      { code: 21211, message: "The 'To' number is not a valid phone number." },
      { status: 400 }
    );

    const client = new TwilioClient({
      accountSid: "AC_test_sid",
      authToken: "tok_secret",
      fromNumber: "+15551112222",
    });

    await expect(
      client.sendSms({ to: "not-a-number", body: "x" })
    ).rejects.toBeInstanceOf(TwilioAPIError);
  });
});

describe("newTwilioClient factory", () => {
  it("returns a working TwilioClient", async () => {
    const { calls } = stubFetch({ sid: "SMfac", status: "queued", to: "+15558675309" });

    const client = newTwilioClient({
      accountSid: "AC_test_sid",
      authToken: "tok_secret",
      fromNumber: "+15551112222",
    });
    expect(client).toBeInstanceOf(TwilioClient);

    const result = await client.sendSms({ to: "+15558675309", body: "via factory" });
    expect(result.sid).toBe("SMfac");
    expect(calls).toHaveLength(1);
  });
});
