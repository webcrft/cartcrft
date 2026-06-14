/**
 * ical-pull — H5.2: Scheduled iCal pull worker + OTA ARI push route.
 *
 * Part 1 — iCal pull worker:
 *   Seeds an import ical_feed with a fake URL, injects a fetch that returns a
 *   known iCal payload (VEVENT block), runs one pull tick (runIcalPullPass), and
 *   asserts the booking availability blocks were created and last_synced_at
 *   advanced. Also asserts a future-due feed (recently synced) is NOT re-pulled.
 *
 * Part 2 — push-ari route:
 *   Exercises POST /commerce/stores/:storeId/booking-channel-listings/:listingId/
 *   push-ari with an injected OTA fetch (setOtaFetchForTesting) so no real HTTP
 *   happens, and asserts the ARI push succeeds and writes a push log.
 *
 * Strategy mirrors subscription-scheduler.test.ts / bookings-ical.test.ts:
 *   createCtx() boots the app against an isolated DB schema. The remote/OTA
 *   fetch is injected — we never stub the global fetch the test client uses.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { post, mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { runIcalPullPass, setIcalFetchForTesting } from "../../src/modules/bookings/ical-pull.js";
import { setOtaFetchForTesting } from "../../src/modules/bookings/ota.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  setIcalFetchForTesting(null);
  setOtaFetchForTesting(null);
  await ctx.teardown();
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

async function createStore(auth: { type: "bearer"; token: string }) {
  const res = await post(ctx, "/commerce/stores", { name: "iCal Pull Store" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  return res.json["id"] as string;
}

async function createResource(storeId: string, auth: { type: "bearer"; token: string }) {
  const res = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
    name: "Pull Room",
    type: "accommodation",
    capacity: 2,
    time_unit: "nightly",
    base_price: "120.00",
  }, auth);
  if (res.status !== 201) throw new Error(`createResource failed: ${JSON.stringify(res.body)}`);
  return res.json["resource"]["id"] as string;
}

const PULLED_ICAL = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Airbnb//Airbnb//EN",
  "BEGIN:VEVENT",
  `UID:pull-${randomUUID()}`,
  "SUMMARY:Not available",
  "DTSTART;VALUE=DATE:20280301",
  "DTEND;VALUE=DATE:20280305",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

// ── Part 1: iCal pull worker ─────────────────────────────────────────────────

describe("iCal pull worker — scheduled remote pull", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;
  let resourceId: string;
  let feedId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(auth);
    resourceId = await createResource(storeId, auth);

    // Seed an import feed with a fake remote URL (never_synced → due immediately).
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds`,
      {
        channel: "airbnb",
        direction: "import",
        url: "https://airbnb.example.com/ical/pull-test.ics",
        sync_interval_minutes: 60,
      },
      auth
    );
    expect(res.status).toBe(201);
    feedId = res.json["feed"]["id"] as string;
  });

  it("pulls remote iCal, blocks dates, and advances last_synced_at", async () => {
    let fetchedUrl: string | null = null;
    setIcalFetchForTesting(async (url: string | URL | Request) => {
      fetchedUrl = String(url);
      return new Response(PULLED_ICAL, {
        status: 200,
        headers: { "Content-Type": "text/calendar" },
      });
    });

    const result = await runIcalPullPass(new Date());

    // The seeded feed was due (last_synced_at NULL) → fetched + synced.
    expect(fetchedUrl).toBe("https://airbnb.example.com/ical/pull-test.ics");
    expect(result.feeds_synced).toBeGreaterThanOrEqual(1);
    expect(result.feeds_failed).toBe(0);

    // Availability blocks created from the VEVENT (Mar 1-4, 2028).
    const { rows: blocks } = await ctx.pool.query<{ date: string }>(
      `SELECT date::text FROM booking_availability
       WHERE resource_id = $1::uuid AND is_available = false AND source = 'ical'
         AND date BETWEEN '2028-03-01' AND '2028-03-04'`,
      [resourceId]
    );
    expect(blocks.length).toBe(4);

    // last_synced_at advanced from NULL.
    const { rows: feedRows } = await ctx.pool.query<{ last_synced_at: Date | null; last_error: string | null }>(
      `SELECT last_synced_at, last_error FROM ical_feeds WHERE id = $1::uuid`,
      [feedId]
    );
    expect(feedRows[0]?.last_synced_at).not.toBeNull();
    expect(feedRows[0]?.last_error).toBeNull();
  });

  it("does not re-pull a feed that was just synced (interval not elapsed)", async () => {
    let calls = 0;
    setIcalFetchForTesting(async () => {
      calls++;
      return new Response(PULLED_ICAL, { status: 200 });
    });

    // Immediately after the previous sync, the 60-min interval has not elapsed.
    const result = await runIcalPullPass(new Date());

    expect(calls).toBe(0);
    expect(result.feeds_synced).toBe(0);
  });
});

// ── Part 2: push-ari route ───────────────────────────────────────────────────

describe("OTA push-ari route", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;
  let resourceId: string;
  let providerId: string;
  let listingId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(auth);
    resourceId = await createResource(storeId, auth);

    // Provider with ARI credentials + base_url configured.
    const provRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-channel-providers`,
      {
        provider_type: "direct_ota",
        channel: "booking_com",
        name: "Booking.com ARI",
        api_key: "HOTEL-123",
        api_secret: "secret-xyz",
        config: { base_url: "https://ari.example.com/v1", room_type_id: "RT-1" },
      },
      auth
    );
    expect(provRes.status).toBe(201);
    providerId = provRes.json["provider"]["id"] as string;

    // Listing managed by that provider.
    const listRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/channel-listings`,
      {
        channel: "booking_com",
        sync_rates: true,
        sync_availability: true,
        managed_by_provider_id: providerId,
      },
      auth
    );
    expect(listRes.status).toBe(201);
    listingId = listRes.json["listing"]["id"] as string;
  });

  it("pushes ARI for a window via the injected OTA fetch and logs the push", async () => {
    const seenUrls: string[] = [];
    setOtaFetchForTesting(async (url: string | URL | Request) => {
      seenUrls.push(String(url));
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-channel-listings/${listingId}/push-ari`,
      { window_start: "2028-04-01", window_end: "2028-04-03" },
      auth
    );

    expect(res.status).toBe(200);
    expect(res.json["status"]).toBe("ok");
    // Both availability + rates endpoints hit on our injected fetch.
    expect(seenUrls.some((u) => u.endsWith("/availability"))).toBe(true);
    expect(seenUrls.some((u) => u.endsWith("/rates"))).toBe(true);

    // A push-log row recorded for this listing.
    const { rows } = await ctx.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM booking_channel_push_log
       WHERE channel_listing_id = $1::uuid AND success = true`,
      [listingId]
    );
    expect(parseInt(rows[0]?.count ?? "0", 10)).toBeGreaterThanOrEqual(1);
  });

  it("returns credential_missing when no provider is resolvable", async () => {
    // A listing without managed_by_provider_id and no provider_id passed.
    const listRes = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/channel-listings`,
      { channel: "airbnb", sync_availability: true },
      auth
    );
    expect(listRes.status).toBe(201);
    const bareListingId = listRes.json["listing"]["id"] as string;

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-channel-listings/${bareListingId}/push-ari`,
      { window_start: "2028-04-01", window_end: "2028-04-02" },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["status"]).toBe("credential_missing");
  });
});
