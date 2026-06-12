/**
 * bookings-ical — iCal feed tests.
 *
 * Tests:
 *  1. Export iCal feed for resource with no bookings → valid VCALENDAR, no VEVENTs
 *  2. Import iCal payload → blocks dates, creates ical_sync_run record
 *  3. After import, blocked dates appear in availability calendar
 *  4. Create ical feed record → listed in GET
 *  5. Update ical feed record
 *  6. Delete ical feed → gone
 *  7. parseICalFeed: all-day events (DATE-only) parsed correctly
 *  8. parseICalFeed: datetime events parsed correctly
 *  9. buildICalFeed: CRLF line endings, VCALENDAR structure
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, del, mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { parseICalFeed, buildICalFeed } from "../../src/modules/bookings/ical.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function authFor(userId: string, orgId: string) {
  const token = await mintJwt({ userId, orgId });
  return { type: "bearer" as const, token };
}

async function createStore(orgId: string, auth: { type: "bearer"; token: string }) {
  const res = await post(ctx, "/commerce/stores", { name: "iCal Test Store" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  return res.json["id"] as string;
}

async function createResource(storeId: string, auth: { type: "bearer"; token: string }) {
  const res = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
    name: "iCal Test Room",
    type: "accommodation",
    capacity: 2,
    time_unit: "nightly",
    base_price: "100.00",
  }, auth);
  if (res.status !== 201) throw new Error(`createResource failed: ${JSON.stringify(res.body)}`);
  return res.json["resource"]["id"] as string;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("iCal parser/serializer unit tests", () => {
  it("7. parseICalFeed: parses all-day DATE-only events", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:test-uid-001",
      "SUMMARY:Test Block",
      "DTSTART;VALUE=DATE:20270601",
      "DTEND;VALUE=DATE:20270605",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseICalFeed(ical);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.uid).toBe("test-uid-001");
    expect(evt.summary).toBe("Test Block");
    expect(evt.allDay).toBe(true);
    expect(evt.dtstart.getUTCFullYear()).toBe(2027);
    expect(evt.dtstart.getUTCMonth()).toBe(5); // June = 5 (0-indexed)
    expect(evt.dtstart.getUTCDate()).toBe(1);
    expect(evt.dtend.getUTCDate()).toBe(5);
  });

  it("8. parseICalFeed: parses DATETIME UTC events", () => {
    const ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:test-uid-002",
      "SUMMARY:DateTime Event",
      "DTSTART:20270701T150000Z",
      "DTEND:20270705T110000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const events = parseICalFeed(ical);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.allDay).toBe(false);
    expect(evt.dtstart.getUTCHours()).toBe(15);
    expect(evt.dtend.getUTCHours()).toBe(11);
  });

  it("8b. parseICalFeed: handles LF-only line endings", () => {
    const ical = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:lf-test\nSUMMARY:LF Test\nDTSTART;VALUE=DATE:20271001\nDTEND;VALUE=DATE:20271003\nEND:VEVENT\nEND:VCALENDAR\n";
    const events = parseICalFeed(ical);
    expect(events).toHaveLength(1);
    expect(events[0]!.uid).toBe("lf-test");
  });

  it("9. buildICalFeed: CRLF endings, VCALENDAR structure", () => {
    const events = [
      {
        uid: "build-test-001",
        summary: "Booking B-001",
        dtstart: new Date(Date.UTC(2027, 7, 1)), // 2027-08-01
        dtend: new Date(Date.UTC(2027, 7, 5)),   // 2027-08-05
        allDay: true,
      },
    ];

    const ical = buildICalFeed(events, "My Calendar");

    expect(ical).toContain("BEGIN:VCALENDAR");
    expect(ical).toContain("END:VCALENDAR");
    expect(ical).toContain("BEGIN:VEVENT");
    expect(ical).toContain("END:VEVENT");
    expect(ical).toContain("UID:build-test-001");
    expect(ical).toContain("SUMMARY:Booking B-001");
    expect(ical).toContain("DTSTART;VALUE=DATE:20270801");
    expect(ical).toContain("DTEND;VALUE=DATE:20270805");
    expect(ical).toContain("VERSION:2.0");

    // Verify CRLF line endings
    const lines = ical.split("\r\n");
    expect(lines.length).toBeGreaterThan(5);
    // Last split of a CRLF-terminated string will be empty
    expect(lines[lines.length - 1]).toBe("");
  });

  it("9b. buildICalFeed: no events → only VCALENDAR wrapper", () => {
    const ical = buildICalFeed([], "Empty Calendar");
    expect(ical).toContain("BEGIN:VCALENDAR");
    expect(ical).toContain("END:VCALENDAR");
    expect(ical).not.toContain("BEGIN:VEVENT");
  });
});

describe("iCal REST API — feed CRUD and import/export", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;
  let resourceId: string;
  let feedId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(orgId, auth);
    resourceId = await createResource(storeId, auth);
  });

  // ── 1. Export with no bookings ──────────────────────────────────────────────

  it("1. Export iCal feed (no bookings) → valid VCALENDAR, no VEVENTs", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/booking-resources/${resourceId}/ical.ics`,
    });
    expect(res.status).toBe(200);
    const body = res.body as string;
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("END:VCALENDAR");
    // No confirmed bookings → no VEVENTs
    expect(body).not.toContain("BEGIN:VEVENT");
  });

  // ── 2. Import iCal payload → blocks dates ──────────────────────────────────

  it("2. Create ical feed record → listed in GET", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds`, {
      channel: "airbnb",
      direction: "import",
      url: "https://airbnb.example.com/ical/test.ics",
      sync_interval_minutes: 60,
    }, auth);
    expect(res.status).toBe(201);
    expect(res.json["feed"]["channel"]).toBe("airbnb");
    expect(res.json["feed"]["direction"]).toBe("import");
    feedId = res.json["feed"]["id"] as string;

    const listRes = await get(ctx, `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds`, auth);
    expect(listRes.status).toBe(200);
    const feeds = listRes.json["feeds"] as Array<{ id: string }>;
    expect(feeds.some(f => f.id === feedId)).toBe(true);
  });

  it("3. Import iCal payload → blocks dates, creates sync run", async () => {
    const icalPayload = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Airbnb//Airbnb//EN",
      "BEGIN:VEVENT",
      `UID:airbnb-${randomUUID()}`,
      "SUMMARY:Not available",
      "DTSTART;VALUE=DATE:20270901",
      "DTEND;VALUE=DATE:20270906",
      "END:VEVENT",
      "BEGIN:VEVENT",
      `UID:airbnb-${randomUUID()}`,
      "SUMMARY:Reserved",
      "DTSTART;VALUE=DATE:20270910",
      "DTEND;VALUE=DATE:20270912",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds/${feedId}/import`,
      { ical_text: icalPayload },
      auth
    );
    expect(res.status).toBe(200);
    const run = res.json["run"] as Record<string, unknown>;
    expect(run["status"]).toBe("success");
    // 2 VEVENTs: first covers 5 nights (Sep 1-5), second covers 2 nights (Sep 10-11)
    expect((run["events_imported"] as number)).toBeGreaterThanOrEqual(2);
    expect((run["dates_blocked"] as number)).toBeGreaterThan(0);
  });

  it("3b. After import, blocked dates appear in availability calendar", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/availability?start=2027-09-01&end=2027-09-06`,
      auth
    );
    expect(res.status).toBe(200);
    const av = res.json["availability"] as Array<{ date: string; is_available: boolean; source: string }>;
    // Sep 1-5 should be blocked with source=ical
    const icalBlocks = av.filter(a => !a.is_available && a.source === "ical");
    expect(icalBlocks.length).toBeGreaterThanOrEqual(5);
  });

  // ── 5. Update iCal feed ─────────────────────────────────────────────────────

  it("5. Update iCal feed → is_active false", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds/${feedId}`,
      { is_active: false },
      auth
    );
    expect(res.status).toBe(200);
    expect(res.json["feed"]["is_active"]).toBe(false);
  });

  // ── 6. Delete iCal feed ─────────────────────────────────────────────────────

  it("6. Delete iCal feed → 204, gone from list", async () => {
    const delRes = await del(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds/${feedId}`,
      auth
    );
    expect(delRes.status).toBe(204);

    const listRes = await get(ctx, `/commerce/stores/${storeId}/booking-resources/${resourceId}/ical-feeds`, auth);
    const feeds = listRes.json["feeds"] as Array<{ id: string }>;
    expect(feeds.some(f => f.id === feedId)).toBe(false);
  });

  // ── Export after import shows blocked dates ─────────────────────────────────

  it("4. Export iCal feed shows blocked availability (manual blocks)", async () => {
    // Manually block a date
    await post(ctx, `/commerce/stores/${storeId}/booking-resources/${resourceId}/availability`, {
      entries: [
        { date: "2027-11-01", is_available: false, notes: "Export test block" },
        { date: "2027-11-02", is_available: false, notes: "Export test block" },
      ],
    }, auth);

    const res = await ctx.request({
      method: "GET",
      path: `/storefront/${storeId}/booking-resources/${resourceId}/ical.ics`,
    });
    expect(res.status).toBe(200);
    const body = res.body as string;
    // Export includes blocked dates as VEVENT
    expect(body).toContain("BEGIN:VEVENT");
    // Should include the BLOCKED-20271101 UID pattern or at least a VEVENT
    expect(body).toContain("DTSTART;VALUE=DATE:");
  });
});
