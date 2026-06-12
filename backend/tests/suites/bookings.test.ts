/**
 * bookings — Full bookings module suite.
 *
 * Tests:
 *  1.  Create booking resource → 201
 *  2.  List resources → has the resource
 *  3.  Create cancellation policy → 201
 *  4.  Create price rule (seasonal) → 201
 *  5.  Get availability calendar → returns rows for set dates
 *  6.  Set availability block → dates blocked
 *  7.  Price rule math: base + seasonal + weekend precedence
 *  8.  Create booking → 201, booking_number, order row created
 *  9.  Confirm booking → status=confirmed
 * 10.  Cancel booking with policy → refund_pct returned
 * 11.  Double-booking race → exactly one 201, one 409
 * 12.  List bookings, get booking, list events
 * 13.  Send message, list messages
 * 14.  Create check-in token → 201
 * 15.  Create damage claim → 201
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { get, post, put, del, mintJwt } from "../shared/helpers.js";
import { randomUUID } from "node:crypto";
import { SimClock } from "../../src/clock.js";

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
  const res = await post(ctx, "/commerce/stores", { name: "Booking Test Store" }, auth);
  if (res.status !== 201) throw new Error(`createStore failed: ${JSON.stringify(res.body)}`);
  return res.json["id"] as string;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("Bookings CRUD + lifecycle", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;
  let resourceId: string;
  let policyId: string;
  let bookingId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(orgId, auth);
  });

  // ── 1. Create booking resource ──────────────────────────────────────────────

  it("1. Create booking resource → 201", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
      name: "Ocean View Suite",
      type: "accommodation",
      capacity: 2,
      time_unit: "nightly",
      base_price: "100.00",
      weekend_price: "150.00",
      cleaning_fee: "25.00",
      extra_guest_fee: "20.00",
      base_capacity: 2,
    }, auth);
    expect(res.status).toBe(201);
    expect(res.json["resource"]).toBeDefined();
    expect(res.json["resource"]["name"]).toBe("Ocean View Suite");
    expect(res.json["resource"]["base_price"]).toBe("100.00");
    resourceId = res.json["resource"]["id"] as string;
  });

  // ── 2. List resources ───────────────────────────────────────────────────────

  it("2. List resources → has the resource", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/booking-resources`, auth);
    expect(res.status).toBe(200);
    const resources = res.json["resources"] as Array<{ id: string }>;
    expect(resources.some(r => r.id === resourceId)).toBe(true);
  });

  // ── 3. Create cancellation policy ──────────────────────────────────────────

  it("3. Create cancellation policy → 201", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/booking-policies`, {
      name: "Moderate Policy",
      type: "moderate",
      rules: [
        { hours_before: 120, refund_pct: 100 },
        { hours_before: 0, refund_pct: 50 },
      ],
    }, auth);
    expect(res.status).toBe(201);
    expect(res.json["policy"]["name"]).toBe("Moderate Policy");
    policyId = res.json["policy"]["id"] as string;
  });

  // ── 4. Create price rule (seasonal +20%) ───────────────────────────────────

  it("4. Create price rule (seasonal) → 201", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/booking-resources/${resourceId}/price-rules`, {
      name: "Summer Season",
      type: "seasonal",
      starts_at: "2026-07-01",
      ends_at: "2026-08-31",
      adjustment_type: "percentage",
      adjustment_value: "20",
      priority: 10,
      is_active: true,
    }, auth);
    expect(res.status).toBe(201);
    expect(res.json["rule"]["name"]).toBe("Summer Season");
    expect(res.json["rule"]["adjustment_value"]).toBe("20.0000");
  });

  // ── 5. Get availability calendar ───────────────────────────────────────────

  it("5. Get availability calendar → returns rows for set dates", async () => {
    // First set some availability
    await post(ctx, `/commerce/stores/${storeId}/booking-resources/${resourceId}/availability`, {
      entries: [
        { date: "2026-09-01", is_available: false, notes: "Maintenance" },
        { date: "2026-09-02", is_available: true },
      ],
    }, auth);

    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/availability?start=2026-09-01&end=2026-09-03`,
      auth
    );
    expect(res.status).toBe(200);
    const availability = res.json["availability"] as Array<{ date: string; is_available: boolean }>;
    expect(Array.isArray(availability)).toBe(true);
    const blockedDay = availability.find(a => a.date === "2026-09-01");
    expect(blockedDay?.is_available).toBe(false);
  });

  // ── 6. Set availability block ───────────────────────────────────────────────

  it("6. Set availability block → dates blocked", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/booking-resources/${resourceId}/availability`, {
      entries: [
        { date: "2026-10-01", is_available: false, notes: "Owner block" },
        { date: "2026-10-02", is_available: false },
        { date: "2026-10-03", is_available: false },
      ],
    }, auth);
    expect(res.status).toBe(204);

    const calRes = await get(
      ctx,
      `/commerce/stores/${storeId}/booking-resources/${resourceId}/availability?start=2026-10-01&end=2026-10-04`,
      auth
    );
    expect(calRes.status).toBe(200);
    const av = calRes.json["availability"] as Array<{ is_available: boolean }>;
    expect(av.every(a => !a.is_available)).toBe(true);
  });

  // ── 7. Price rule math ──────────────────────────────────────────────────────

  it("7. Price rule math: computeBookingPrice via booking creation", async () => {
    // Create a fresh resource to avoid interference from blocked dates
    const mkRes = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
      name: "Price Test Room",
      type: "room",
      capacity: 2,
      time_unit: "nightly",
      base_price: "100.00",
      weekend_price: "150.00",
      cleaning_fee: "0.00",
      base_capacity: 2,
    }, auth);
    expect(mkRes.status).toBe(201);
    const priceRoomId = mkRes.json["resource"]["id"] as string;

    // Create seasonal rule +20% for Jan 2027
    await post(ctx, `/commerce/stores/${storeId}/booking-resources/${priceRoomId}/price-rules`, {
      name: "Peak Season",
      type: "seasonal",
      starts_at: "2027-01-01",
      ends_at: "2027-01-31",
      adjustment_type: "percentage",
      adjustment_value: "20",
      priority: 10,
    }, auth);

    // Mon-Thu booking in peak season: 4 nights @ 100 * 1.20 = 120 each = 480
    const bRes = await post(ctx, `/commerce/stores/${storeId}/bookings`, {
      resource_id: priceRoomId,
      check_in: "2027-01-04",   // Monday
      check_out: "2027-01-08",  // Friday (4 nights)
      num_guests: 2,
    }, auth);
    expect(bRes.status).toBe(201);
    const b = bRes.json["booking"] as Record<string, unknown>;
    expect(b["total_nights"]).toBe(4);
    // With +20% seasonal rule: nightly_rate should be 120.00
    expect(parseFloat(b["nightly_rate"] as string)).toBeCloseTo(120, 0);
    // subtotal = 4 * 120 = 480
    expect(parseFloat(b["subtotal"] as string)).toBeCloseTo(480, 0);

    // Fri-Sun in peak season: weekend_price (150) wins over base+seasonal rule?
    // weekend_price is the resource-level override applied only when no rule matches.
    // The seasonal rule has priority 10, so it applies and adjusts the weekend price too.
    // Fri-Sat = 2 nights. With seasonal +20% on base 100: 120 each. No weekend_price interaction (rule wins).
    const bWknd = await post(ctx, `/commerce/stores/${storeId}/bookings`, {
      resource_id: priceRoomId,
      check_in: "2027-01-08",   // Friday
      check_out: "2027-01-10",  // Sunday (2 nights: Fri, Sat)
      num_guests: 2,
    }, auth);
    expect(bWknd.status).toBe(201);
    const bw = bWknd.json["booking"] as Record<string, unknown>;
    expect(bw["total_nights"]).toBe(2);
    // Rule applies (high priority): 100 * 1.20 = 120 per night
    expect(parseFloat(bw["nightly_rate"] as string)).toBeCloseTo(120, 0);
  });

  // ── 8. Create booking → order row ──────────────────────────────────────────

  it("8. Create booking → 201, has booking_number, creates order row", async () => {
    // New resource for clean booking test
    const rRes = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
      name: "Clean Test Room",
      type: "room",
      capacity: 2,
      time_unit: "nightly",
      base_price: "80.00",
    }, auth);
    expect(rRes.status).toBe(201);
    const cleanRoomId = rRes.json["resource"]["id"] as string;

    const res = await post(ctx, `/commerce/stores/${storeId}/bookings`, {
      resource_id: cleanRoomId,
      check_in: "2026-12-01",
      check_out: "2026-12-04",
      num_guests: 2,
      guest_name: "Jane Smith",
      guest_email: "jane@example.com",
    }, auth);
    expect(res.status).toBe(201);
    const booking = res.json["booking"] as Record<string, unknown>;
    expect(booking["booking_number"]).toMatch(/^B/);
    expect(booking["total_nights"]).toBe(3);
    expect(booking["status"]).toBe("pending");
    bookingId = booking["id"] as string;

    // Verify order was created in DB
    const orderId = booking["order_id"] as string;
    expect(orderId).toBeTruthy();
    const { rows: orderRows } = await ctx.pool.query<{ id: string }>(
      `SELECT id::text FROM orders WHERE id = $1::uuid`,
      [orderId]
    );
    expect(orderRows.length).toBe(1);
  });

  // ── 9. Confirm booking ─────────────────────────────────────────────────────

  it("9. Confirm booking → status=confirmed", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/bookings/${bookingId}/confirm`, {}, auth);
    expect(res.status).toBe(200);
    expect(res.json["booking"]["status"]).toBe("confirmed");
    expect(res.json["booking"]["confirmed_at"]).toBeTruthy();
  });

  // ── 10. Cancel booking with policy ─────────────────────────────────────────

  it("10. Cancel booking → returns refund_pct", async () => {
    // Create a fresh resource + booking for cancellation
    const rRes = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
      name: "Cancel Test Room",
      type: "room",
      capacity: 1,
      time_unit: "nightly",
      base_price: "50.00",
    }, auth);
    const cancelRoomId = rRes.json["resource"]["id"] as string;

    const bRes = await post(ctx, `/commerce/stores/${storeId}/bookings`, {
      resource_id: cancelRoomId,
      check_in: "2026-12-20",
      check_out: "2026-12-25",
      num_guests: 1,
    }, auth);
    expect(bRes.status).toBe(201);
    const cancelBookingId = bRes.json["booking"]["id"] as string;

    const cRes = await post(ctx, `/commerce/stores/${storeId}/bookings/${cancelBookingId}/cancel`, {
      reason: "Changed plans",
    }, auth);
    expect(cRes.status).toBe(200);
    expect(cRes.json["booking"]["status"]).toBe("cancelled");
    expect(typeof cRes.json["refund_pct"]).toBe("number");
    expect(typeof cRes.json["refund_amount"]).toBe("string");
  });

  // ── 11. Double-booking race ─────────────────────────────────────────────────

  it("11. Double-booking race → exactly one 201, one 409", async () => {
    const rRes = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
      name: "Race Test Room",
      type: "room",
      capacity: 1,
      time_unit: "nightly",
      base_price: "60.00",
    }, auth);
    const raceRoomId = rRes.json["resource"]["id"] as string;

    const bookingPayload = {
      resource_id: raceRoomId,
      check_in: "2027-03-01",
      check_out: "2027-03-05",
      num_guests: 1,
    };

    // Launch two concurrent booking requests
    const [r1, r2] = await Promise.all([
      post(ctx, `/commerce/stores/${storeId}/bookings`, bookingPayload, auth),
      post(ctx, `/commerce/stores/${storeId}/bookings`, bookingPayload, auth),
    ]);

    const statuses = [r1.status, r2.status];
    // Exactly one should succeed (201) and one should be rejected (409)
    expect(statuses.filter(s => s === 201).length).toBe(1);
    expect(statuses.filter(s => s === 409).length).toBe(1);
  });

  // ── 12. List bookings, get booking, list events ─────────────────────────────

  it("12. List bookings → has our booking", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/bookings`, auth);
    expect(res.status).toBe(200);
    const bookings = res.json["bookings"] as Array<{ id: string }>;
    expect(bookings.some(b => b.id === bookingId)).toBe(true);
  });

  it("12b. Get booking → correct data", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/bookings/${bookingId}`, auth);
    expect(res.status).toBe(200);
    expect(res.json["booking"]["id"]).toBe(bookingId);
    expect(res.json["booking"]["status"]).toBe("confirmed");
  });

  it("12c. List booking events → has status_changed event", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/bookings/${bookingId}/events`, auth);
    expect(res.status).toBe(200);
    const events = res.json["events"] as Array<{ type: string }>;
    expect(events.some(e => e.type === "status_changed")).toBe(true);
  });

  // ── 13. Messages ────────────────────────────────────────────────────────────

  it("13. Send message → 201, list messages has it", async () => {
    const mRes = await post(ctx, `/commerce/stores/${storeId}/bookings/${bookingId}/messages`, {
      sender_role: "host",
      body: "Your booking is confirmed!",
    }, auth);
    expect(mRes.status).toBe(201);
    expect(mRes.json["message"]["body"]).toBe("Your booking is confirmed!");

    const listRes = await get(ctx, `/commerce/stores/${storeId}/bookings/${bookingId}/messages`, auth);
    expect(listRes.status).toBe(200);
    const messages = listRes.json["messages"] as Array<{ body: string }>;
    expect(messages.some(m => m.body === "Your booking is confirmed!")).toBe(true);
  });

  // ── 14. Check-in token ──────────────────────────────────────────────────────

  it("14. Create check-in token → 201", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/bookings/${bookingId}/check-in-tokens`, {
      access_type: "check_in",
    }, auth);
    expect(res.status).toBe(201);
    expect(res.json["token"]["token"]).toBeTruthy();
    expect(res.json["token"]["access_type"]).toBe("check_in");
  });

  // ── 15. Damage claim ────────────────────────────────────────────────────────

  it("15. Create damage claim → 201", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/bookings/${bookingId}/damage-claims`, {
      description: "Broken lamp",
      claim_amount: "75.00",
    }, auth);
    expect(res.status).toBe(201);
    expect(res.json["claim"]["description"]).toBe("Broken lamp");
    expect(res.json["claim"]["claim_amount"]).toBe("75.00");
  });

  // ── Modification roundtrip ───────────────────────────────────────────────────

  it("16. Create modification request → 201", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/bookings/${bookingId}/modifications`, {
      new_num_guests: 3,
      notes: "Adding a third guest",
    }, auth);
    expect(res.status).toBe(201);
    expect(res.json["modification"]["new_num_guests"]).toBe(3);
    expect(res.json["modification"]["status"]).toBe("pending");
  });
});

// ── Price Rule Precedence Suite ────────────────────────────────────────────────

describe("Price rule precedence", () => {
  const userId = randomUUID();
  const orgId = randomUUID();
  let auth: Awaited<ReturnType<typeof authFor>>;
  let storeId: string;
  let resourceId: string;

  beforeAll(async () => {
    auth = await authFor(userId, orgId);
    storeId = await createStore(orgId, auth);

    // Create resource: base=100, weekend=150, cleaning=30, extra_guest=15, base_capacity=2
    const rRes = await post(ctx, `/commerce/stores/${storeId}/booking-resources`, {
      name: "Precedence Test Room",
      type: "accommodation",
      capacity: 4,
      time_unit: "nightly",
      base_price: "100.00",
      weekend_price: "150.00",
      cleaning_fee: "30.00",
      extra_guest_fee: "15.00",
      base_capacity: 2,
    }, auth);
    resourceId = rRes.json["resource"]["id"] as string;
  });

  it("weekend_price applies on Fri/Sat when no rule matches", async () => {
    // Fri + Sat = 2 nights, all weekend, no price rules
    // Expected: 2 * 150 + 30 cleaning = 330
    const res = await post(ctx, `/commerce/stores/${storeId}/bookings`, {
      resource_id: resourceId,
      check_in: "2027-05-07",  // Friday
      check_out: "2027-05-09",  // Sunday (2 nights: Fri, Sat)
      num_guests: 2,
    }, auth);
    expect(res.status).toBe(201);
    const b = res.json["booking"] as Record<string, unknown>;
    expect(b["total_nights"]).toBe(2);
    // nightly_rate is the average; both nights are 150
    expect(parseFloat(b["nightly_rate"] as string)).toBeCloseTo(150, 0);
    expect(parseFloat(b["cleaning_fee"] as string)).toBeCloseTo(30, 0);
    expect(parseFloat(b["total"] as string)).toBeCloseTo(330, 0);
  });

  it("seasonal rule wins over weekend_price when priority is higher", async () => {
    // Add seasonal rule for May 2027 (+10%, priority 50)
    await post(ctx, `/commerce/stores/${storeId}/booking-resources/${resourceId}/price-rules`, {
      name: "May Peak",
      type: "seasonal",
      starts_at: "2027-05-01",
      ends_at: "2027-05-31",
      adjustment_type: "percentage",
      adjustment_value: "10",
      priority: 50,
    }, auth);

    // Same Fri-Sat stay — seasonal rule (priority 50) applies: 100 * 1.10 = 110 per night
    const res = await post(ctx, `/commerce/stores/${storeId}/bookings`, {
      resource_id: resourceId,
      check_in: "2027-05-14",  // Friday
      check_out: "2027-05-16",  // Sunday (2 nights: Fri, Sat)
      num_guests: 2,
    }, auth);
    expect(res.status).toBe(201);
    const b = res.json["booking"] as Record<string, unknown>;
    // seasonal rule with priority 50 overrides weekend_price fallback
    expect(parseFloat(b["nightly_rate"] as string)).toBeCloseTo(110, 0);
    expect(parseFloat(b["total"] as string)).toBeCloseTo(110 * 2 + 30, 0);
  });

  it("extra_guest_fee applied for guests above base_capacity", async () => {
    // 4 guests, base_capacity=2 → 2 extra guests, 3 nights, extra fee 15/night
    // base=100, no rules → 3 * 100 + 30 + 2*15*3 = 300 + 30 + 90 = 420
    const res = await post(ctx, `/commerce/stores/${storeId}/bookings`, {
      resource_id: resourceId,
      check_in: "2027-06-01",  // Mon
      check_out: "2027-06-04",  // Thu (3 weekday nights — no weekend/seasonal rule)
      num_guests: 4,
    }, auth);
    expect(res.status).toBe(201);
    const b = res.json["booking"] as Record<string, unknown>;
    expect(b["total_nights"]).toBe(3);
    expect(parseFloat(b["total"] as string)).toBeCloseTo(420, 0);
  });
});
