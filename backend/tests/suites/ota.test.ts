/**
 * ota — OTA live channel push tests (C-10a).
 *
 * Tests:
 *  1.  pushChannelSync with iCal channel → ok + feed_url (no HTTP call)
 *  2.  pushChannelSync with direct OTA channel + no provider → credential_missing
 *  3.  pushARIToProvider with mocked channel HTTP → success + push_log rows
 *  4.  pushARIToProvider + rate push: rate log row written + correct amounts
 *  5.  pushARIToProvider with HTTP 500 from channel → status=error + push_log failure row
 *  6.  pushARIToProvider with provider status=inactive → credential_missing
 *  7.  pushARIToProvider with missing api_key → credential_missing
 *  8.  pushARIToProvider with missing base_url → credential_missing
 *  9.  push via REST endpoint POST .../channel-listings/:id/push → 200 (iCal path)
 * 10.  push via REST endpoint POST .../channel-listings/:id/push → 200 (direct OTA mocked)
 * 11.  iCal sync still works after OTA additions (regression)
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import {
  pushChannelSync,
  pushARIToProvider,
  createChannelProvider,
  createChannelListing,
} from "../../src/modules/bookings/ota.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const REAL_FETCH = globalThis.fetch;

function stubChannelFetch(
  availResponse: Record<string, unknown> = { status: "ok" },
  rateResponse: Record<string, unknown> = { status: "ok" },
  opts: { availStatus?: number; rateStatus?: number } = {}
) {
  const availStatus = opts.availStatus ?? 200;
  const rateStatus = opts.rateStatus ?? 200;

  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;

    // Pass-through for local test server
    if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
      return REAL_FETCH(url as string, init);
    }

    // Mock channel ARI API
    const status = urlStr.includes("/rates") ? rateStatus : availStatus;
    const body = urlStr.includes("/rates") ? rateResponse : availResponse;
    const ok = status >= 200 && status < 300;

    return {
      ok,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  });
}

async function setupStoreAndResource() {
  const userId = randomUUID();
  const orgId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: `OTA Test Store ${randomUUID().slice(0, 8)}`,
    currency: "USD",
    timezone: "UTC",
  }, auth);
  if (storeRes.status !== 201) throw new Error(`store: ${storeRes.status} ${JSON.stringify(storeRes.body)}`);
  const storeId = storeRes.json["id"] as string;

  const resourceRes = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
    name: "Test Room",
    type: "accommodation",
    capacity: 2,
    time_unit: "nightly",
    base_price: "150.00",
  }, auth);
  if (resourceRes.status !== 201) throw new Error(`resource: ${resourceRes.status} ${JSON.stringify(resourceRes.body)}`);
  const resourceId = resourceRes.json["resource"]["id"] as string;

  return { storeId, resourceId, auth, userId, orgId };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("OTA Channel Push (C-10a)", () => {

  it("1. pushChannelSync iCal channel → ok + feed_url, no HTTP call", async () => {
    const { storeId, resourceId } = await setupStoreAndResource();

    // Create an iCal-type listing (airbnb = iCal channel)
    const listing = await createChannelListing(resourceId, {
      channel: "airbnb",
      status: "active",
    });

    const result = await pushChannelSync(storeId, listing.id);
    expect(result.status).toBe("ok");
    expect(result.feed_url).toContain(resourceId);
    expect(result.message).toMatch(/iCal/i);
  });

  it("2. pushChannelSync direct-OTA channel without provider → falls back to iCal URL (no credential needed)", async () => {
    const { storeId, resourceId } = await setupStoreAndResource();

    // A direct-OTA listing (expedia) with no managed_by_provider_id.
    // pushChannelSync falls back to iCal feed URL since no ARI provider configured.
    const listing = await createChannelListing(resourceId, {
      channel: "expedia",
      status: "active",
      // No managed_by_provider_id → iCal fallback
    });

    const result = await pushChannelSync(storeId, listing.id);
    // iCal fallback: returns ok + feed_url, no ARI credentials needed
    expect(result.status).toBe("ok");
    expect(result.message).toMatch(/iCal/i);
    expect(result.feed_url).toContain(resourceId);
  });

  it("3. pushARIToProvider with mocked channel → success + push_log rows", async () => {
    const { storeId, resourceId } = await setupStoreAndResource();

    // Create provider with credentials
    const provider = await createChannelProvider(storeId, {
      channel: "booking_com",
      name: "Test Booking.com",
      api_key: "hotel-123",
      api_secret: "secret-abc",
      push_rates: true,
      push_availability: true,
      status: "active",
      config: {
        base_url: "https://ari.mock-channel.example.com",
        room_type_id: "ROOM_A",
        rate_plan_id: "PLAN_1",
      },
    });

    // Create listing linked to provider
    const listing = await createChannelListing(resourceId, {
      channel: "booking_com",
      status: "active",
      sync_rates: true,
      sync_availability: true,
      managed_by_provider_id: provider.id,
      channel_listing_id: "ext-listing-001",
      channel_property_id: "hotel-123",
    });

    // Mock channel HTTP responses
    stubChannelFetch({ status: "ok", updated: 7 }, { status: "ok", updated: 7 });

    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

    const result = await pushARIToProvider(storeId, listing.id, today, week, provider.id);

    expect(result.status).toBe("ok");
    expect(result.availability_updated).toBeGreaterThan(0);
    expect(result.rates_updated).toBeGreaterThan(0);
    expect(result.push_log_id).toBeTruthy();

    // Verify push_log rows exist in DB
    const { rows: logRows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM booking_channel_push_log WHERE channel_listing_id = $1::uuid`,
      [listing.id]
    );
    expect(parseInt(logRows[0]?.count ?? "0", 10)).toBeGreaterThanOrEqual(2); // avail + rate
  });

  it("4. Rate updates include correct amounts and markup_pct", async () => {
    const { storeId, resourceId } = await setupStoreAndResource();

    const provider = await createChannelProvider(storeId, {
      channel: "booking_com",
      name: "Markup Provider",
      api_key: "hotel-456",
      api_secret: "sec-xyz",
      push_rates: true,
      push_availability: true,
      status: "active",
      config: {
        base_url: "https://ari.mock-channel.example.com",
        room_type_id: "ROOM_B",
      },
    });

    // 10% markup on channel
    const listing = await createChannelListing(resourceId, {
      channel: "booking_com",
      status: "active",
      sync_rates: true,
      sync_availability: true,
      managed_by_provider_id: provider.id,
      markup_pct: "10",
    });

    let capturedRateBody: Record<string, unknown> | undefined;

    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes("127.0.0.1") || urlStr.includes("localhost")) {
        return REAL_FETCH(url as string, init);
      }
      if (urlStr.includes("/rates") && init?.body) {
        capturedRateBody = JSON.parse(init.body as string) as Record<string, unknown>;
      }
      return { ok: true, status: 200, text: async () => '{"status":"ok"}', json: async () => ({ status: "ok" }) };
    });

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10);

    await pushARIToProvider(storeId, listing.id, today, tomorrow, provider.id);

    expect(capturedRateBody).toBeDefined();
    const updates = capturedRateBody!["updates"] as Array<{ amount: string; date: string }>;
    expect(updates).toBeDefined();
    expect(updates.length).toBeGreaterThan(0);

    // base_price=150, 10% markup → 165.00
    for (const upd of updates) {
      const amt = parseFloat(upd.amount);
      expect(amt).toBeCloseTo(165.0, 1);
    }
  });

  it("5. pushARIToProvider with HTTP 500 from channel → status=error + failure log", async () => {
    const { storeId, resourceId } = await setupStoreAndResource();

    const provider = await createChannelProvider(storeId, {
      channel: "booking_com",
      name: "Failing Provider",
      api_key: "hotel-err",
      api_secret: "sec",
      push_rates: true,
      push_availability: true,
      status: "active",
      config: {
        base_url: "https://ari.mock-fail.example.com",
        room_type_id: "ROOM_ERR",
      },
    });

    const listing = await createChannelListing(resourceId, {
      channel: "booking_com",
      status: "active",
      sync_rates: true,
      sync_availability: true,
      managed_by_provider_id: provider.id,
    });

    // Mock HTTP 500 responses
    stubChannelFetch(
      { error: "Internal Server Error" },
      { error: "Internal Server Error" },
      { availStatus: 500, rateStatus: 500 }
    );

    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const result = await pushARIToProvider(storeId, listing.id, today, tomorrow, provider.id);

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/failed/i);

    // Failure log rows should exist
    const { rows: logRows } = await ctx.pool.query<{ success: boolean; error_code: string | null }>(
      `SELECT success, error_code FROM booking_channel_push_log
       WHERE channel_listing_id = $1::uuid ORDER BY created_at DESC LIMIT 2`,
      [listing.id]
    );
    expect(logRows.some((r) => !r.success)).toBe(true);
    expect(logRows.some((r) => r.error_code === "HTTP_ERROR")).toBe(true);
  });

  it("6. pushARIToProvider with provider status=disconnected → credential_missing", async () => {
    const { storeId, resourceId } = await setupStoreAndResource();

    // Use 'disconnected' (valid check constraint value for inactive-like state)
    const provider = await createChannelProvider(storeId, {
      channel: "booking_com",
      name: "Disconnected Provider",
      api_key: "hotel-disconnected",
      api_secret: "sec",
      status: "disconnected",
      config: { base_url: "https://ari.mock.example.com", room_type_id: "R1" },
    });

    const listing = await createChannelListing(resourceId, {
      channel: "booking_com",
      status: "active",
      managed_by_provider_id: provider.id,
    });

    const result = await pushARIToProvider(storeId, listing.id, "2024-01-01", "2024-01-07", provider.id);
    expect(result.status).toBe("credential_missing");
    expect(result.message).toMatch(/active/i);
  });

  it("7. pushARIToProvider with missing api_key → credential_missing", async () => {
    const { storeId, resourceId } = await setupStoreAndResource();

    // Provider without api_key
    const provider = await createChannelProvider(storeId, {
      channel: "booking_com",
      name: "No-Key Provider",
      // No api_key
      status: "active",
      config: { base_url: "https://ari.mock.example.com", room_type_id: "R1" },
    });

    const listing = await createChannelListing(resourceId, {
      channel: "booking_com",
      status: "active",
      managed_by_provider_id: provider.id,
    });

    const result = await pushARIToProvider(storeId, listing.id, "2024-01-01", "2024-01-07", provider.id);
    expect(result.status).toBe("credential_missing");
    expect(result.message).toMatch(/api_key/i);
  });

  it("8. pushARIToProvider with missing base_url → credential_missing", async () => {
    const { storeId, resourceId } = await setupStoreAndResource();

    const provider = await createChannelProvider(storeId, {
      channel: "booking_com",
      name: "No-URL Provider",
      api_key: "hotel-nurl",
      api_secret: "sec",
      status: "active",
      config: {}, // No base_url
    });

    const listing = await createChannelListing(resourceId, {
      channel: "booking_com",
      status: "active",
      managed_by_provider_id: provider.id,
    });

    const result = await pushARIToProvider(storeId, listing.id, "2024-01-01", "2024-01-07", provider.id);
    expect(result.status).toBe("credential_missing");
    expect(result.message).toMatch(/base_url/i);
  });

  it("9. REST push endpoint: iCal channel → 200 with feed_url", async () => {
    const { storeId, resourceId, auth } = await setupStoreAndResource();

    const listingRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/channel-listings`,
      { channel: "airbnb", status: "active" },
      auth
    );
    expect(listingRes.status).toBe(201);
    const listingId = listingRes.json["listing"]["id"] as string;

    const pushRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/channel-listings/${listingId}/push`,
      {},
      auth
    );
    expect(pushRes.status).toBe(200);
    expect(pushRes.json["status"]).toBe("ok");
    expect(pushRes.json["feed_url"]).toContain(resourceId);
  });

  it("10. REST push endpoint: direct OTA channel with provider (mocked) → 200", async () => {
    const { storeId, resourceId, auth } = await setupStoreAndResource();

    // Create provider via REST
    const provRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-channel-providers`,
      {
        channel: "booking_com",
        name: "REST Provider",
        api_key: "rest-hotel-789",
        api_secret: "rest-sec",
        push_rates: true,
        push_availability: true,
        status: "active",
        config: {
          base_url: "https://ari.mock-rest.example.com",
          room_type_id: "REST_ROOM",
        },
      },
      auth
    );
    expect(provRes.status).toBe(201);
    const providerId = provRes.json["id"] as string;

    const listingRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/channel-listings`,
      {
        channel: "booking_com",
        status: "active",
        sync_rates: true,
        sync_availability: true,
        managed_by_provider_id: providerId,
      },
      auth
    );
    expect(listingRes.status).toBe(201);
    const listingId = listingRes.json["listing"]["id"] as string;

    // Mock the channel HTTP calls
    stubChannelFetch();

    const pushRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/channel-listings/${listingId}/push`,
      {},
      auth
    );
    expect(pushRes.status).toBe(200);
    expect(["ok", "error", "credential_missing"]).toContain(pushRes.json["status"]);
    // status should be ok with mocked 200 responses
    expect(pushRes.json["status"]).toBe("ok");
  });

  it("11. iCal import still works after OTA additions (regression)", async () => {
    const { storeId, resourceId, auth } = await setupStoreAndResource();

    // Create a feed
    const feedRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds`,
      { channel: "airbnb", direction: "import", url: "https://example.com/cal.ics" },
      auth
    );
    expect(feedRes.status).toBe(201);
    const feedId = (feedRes.json["feed"]?.["id"] ?? feedRes.json["id"]) as string;

    // Import a basic iCal payload
    const ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:test-event-001@test",
      "DTSTART;VALUE=DATE:20240601",
      "DTEND;VALUE=DATE:20240603",
      "SUMMARY:Test block",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const importRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds/${feedId}/import`,
      { ical_text: ical },
      auth
    );
    expect(importRes.status).toBe(200);
    // Response is { run: { status, events_imported, dates_blocked } }
    const run = importRes.json["run"] ?? importRes.json;
    expect(run["status"]).toBe("success");
    expect(run["events_imported"]).toBe(1);

    // Verify dates are blocked
    const availRes = await get(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/availability?start=2024-06-01&end=2024-06-03`,
      auth
    );
    expect(availRes.status).toBe(200);
    // Response is { availability: [...] }
    const days = (availRes.json["availability"] ?? availRes.json["days"] ?? []) as Array<{ date: string; is_available: boolean }>;
    const blockedDays = days.filter((d) => !d.is_available);
    expect(blockedDays.length).toBeGreaterThanOrEqual(1);
  });
});
