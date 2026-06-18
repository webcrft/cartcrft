/**
 * segments — customer segmentation (RFM-style) suite.
 *
 * Covers:
 *  - CRUD: create a segment with rules; list/get/update/delete.
 *  - Evaluation: total_spent >= X, order_count >= N, last_order within D days.
 *  - has_tag + email_domain conditions.
 *  - AND ("all") vs OR ("any") combinations.
 *  - customerSegments(): which active segments a given customer matches.
 *  - SQL-injection safety: a malicious value is bound as data, not executed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  del,
  mintJwt,
  insertStore,
  insertCustomer,
  isErrorEnvelope,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Setup helpers ────────────────────────────────────────────────────────────

async function setup() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

/** Insert a customer with optional tags. */
async function seedCustomer(
  storeId: string,
  email: string,
  tags: string[] = []
): Promise<string> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `INSERT INTO customers (store_id, email, tags)
     VALUES ($1::uuid, $2, $3::text[])
     RETURNING id::text`,
    [storeId, email, tags]
  );
  return rows[0]!.id;
}

/** Insert a paid order for a customer with the given total and age (days ago). */
async function seedOrder(
  storeId: string,
  customerId: string,
  total: string,
  daysAgo = 0
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO orders
       (store_id, customer_id, order_number, currency, status, financial_status,
        fulfillment_status, subtotal, shipping_total, tax_total, discount_total, total, created_at)
     VALUES ($1::uuid, $2::uuid, next_order_number($1::uuid), 'USD', 'open', 'paid',
             'unfulfilled', $3, 0, 0, 0, $3, now() - ($4 || ' days')::interval)`,
    [storeId, customerId, total, String(daysAgo)]
  );
}

function segmentsUrl(storeId: string) {
  return `/commerce/stores/${storeId}/segments`;
}

const allOf = (...conditions: unknown[]) => ({ match: "all", conditions });
const anyOf = (...conditions: unknown[]) => ({ match: "any", conditions });

// ── CRUD ───────────────────────────────────────────────────────────────────────

describe("segments CRUD", () => {
  it("creates, lists, gets, updates, and deletes a segment", async () => {
    const s = await setup();
    const rules = allOf({ field: "total_spent", op: ">=", value: 100 });

    const created = await post(ctx, segmentsUrl(s.store.id), { name: "VIPs", rules }, s.auth);
    expect(created.status).toBe(201);
    const segId = created.json["id"] as string;
    expect(created.json["name"]).toBe("VIPs");
    expect(created.json["is_active"]).toBe(true);

    const listed = await get(ctx, segmentsUrl(s.store.id), s.auth);
    expect(listed.status).toBe(200);
    expect((listed.json["segments"] as unknown[]).length).toBe(1);

    const got = await get(ctx, `${segmentsUrl(s.store.id)}/${segId}`, s.auth);
    expect(got.status).toBe(200);
    expect(got.json["id"]).toBe(segId);

    const updated = await put(
      ctx,
      `${segmentsUrl(s.store.id)}/${segId}`,
      { name: "Big Spenders", is_active: false },
      s.auth
    );
    expect(updated.status).toBe(200);
    expect(updated.json["name"]).toBe("Big Spenders");
    expect(updated.json["is_active"]).toBe(false);

    const removed = await del(ctx, `${segmentsUrl(s.store.id)}/${segId}`, s.auth);
    expect(removed.status).toBe(200);
    const after = await get(ctx, `${segmentsUrl(s.store.id)}/${segId}`, s.auth);
    expect(after.status).toBe(404);
  });

  it("rejects a duplicate name (409) and an unknown field (400)", async () => {
    const s = await setup();
    const rules = allOf({ field: "order_count", op: ">=", value: 1 });
    const first = await post(ctx, segmentsUrl(s.store.id), { name: "Dup", rules }, s.auth);
    expect(first.status).toBe(201);
    const dup = await post(ctx, segmentsUrl(s.store.id), { name: "Dup", rules }, s.auth);
    expect(dup.status).toBe(409);

    const bad = await post(
      ctx,
      segmentsUrl(s.store.id),
      { name: "Bad", rules: allOf({ field: "drop_table", op: ">=", value: 1 }) },
      s.auth
    );
    // Zod enum rejects the unknown field → 400 VALIDATION_ERROR.
    expect(bad.status).toBe(400);
    expect(isErrorEnvelope(bad)).toBe(true);
  });
});

// ── Evaluation ──────────────────────────────────────────────────────────────────

describe("segments evaluation", () => {
  it("matches by total_spent >= X", async () => {
    const s = await setup();
    const big = await seedCustomer(s.store.id, `big-${randomUUID()}@a.com`);
    const small = await seedCustomer(s.store.id, `small-${randomUUID()}@a.com`);
    await seedOrder(s.store.id, big, "150.00");
    await seedOrder(s.store.id, small, "20.00");

    const created = await post(
      ctx,
      segmentsUrl(s.store.id),
      { name: "Spend100", rules: allOf({ field: "total_spent", op: ">=", value: 100 }) },
      s.auth
    );
    const segId = created.json["id"] as string;

    const res = await get(ctx, `${segmentsUrl(s.store.id)}/${segId}/members`, s.auth);
    expect(res.status).toBe(200);
    expect(res.json["total"]).toBe(1);
    const members = res.json["members"] as Array<Record<string, unknown>>;
    expect(members.map((m) => m["id"])).toEqual([big]);
  });

  it("matches by order_count >= N and last_order_days_ago <= D (AND)", async () => {
    const s = await setup();
    const loyal = await seedCustomer(s.store.id, `loyal-${randomUUID()}@a.com`);
    const stale = await seedCustomer(s.store.id, `stale-${randomUUID()}@a.com`);
    // loyal: 2 recent orders
    await seedOrder(s.store.id, loyal, "10.00", 1);
    await seedOrder(s.store.id, loyal, "10.00", 5);
    // stale: 2 orders but old
    await seedOrder(s.store.id, stale, "10.00", 100);
    await seedOrder(s.store.id, stale, "10.00", 120);

    const created = await post(
      ctx,
      segmentsUrl(s.store.id),
      {
        name: "RecentRepeat",
        rules: allOf(
          { field: "order_count", op: ">=", value: 2 },
          { field: "last_order_days_ago", op: "<=", value: 30 }
        ),
      },
      s.auth
    );
    const segId = created.json["id"] as string;

    const res = await get(ctx, `${segmentsUrl(s.store.id)}/${segId}/members`, s.auth);
    expect(res.status).toBe(200);
    expect(res.json["total"]).toBe(1);
    expect((res.json["members"] as Array<Record<string, unknown>>)[0]!["id"]).toBe(loyal);
  });

  it("matches has_tag and email_domain", async () => {
    const s = await setup();
    const vip = await seedCustomer(s.store.id, `a-${randomUUID()}@acme.com`, ["vip", "early"]);
    const acme = await seedCustomer(s.store.id, `b-${randomUUID()}@acme.com`, []);
    await seedCustomer(s.store.id, `c-${randomUUID()}@other.com`, ["vip"]);

    // has_tag
    const tagSeg = await post(
      ctx,
      segmentsUrl(s.store.id),
      { name: "TagVip", rules: allOf({ field: "has_tag", op: "=", value: "vip" }) },
      s.auth
    );
    const tagRes = await get(ctx, `${segmentsUrl(s.store.id)}/${tagSeg.json["id"]}/members`, s.auth);
    expect(tagRes.json["total"]).toBe(2); // vip + the other.com vip

    // email_domain
    const domSeg = await post(
      ctx,
      segmentsUrl(s.store.id),
      { name: "AcmeDomain", rules: allOf({ field: "email_domain", op: "=", value: "acme.com" }) },
      s.auth
    );
    const domRes = await get(ctx, `${segmentsUrl(s.store.id)}/${domSeg.json["id"]}/members`, s.auth);
    expect(domRes.json["total"]).toBe(2); // vip + acme, both @acme.com
    const ids = (domRes.json["members"] as Array<Record<string, unknown>>).map((m) => m["id"]).sort();
    expect(ids).toEqual([vip, acme].sort());

    // AND: vip tag AND acme domain → only the first customer
    const andSeg = await post(
      ctx,
      segmentsUrl(s.store.id),
      {
        name: "VipAcme",
        rules: allOf(
          { field: "has_tag", op: "=", value: "vip" },
          { field: "email_domain", op: "=", value: "acme.com" }
        ),
      },
      s.auth
    );
    const andRes = await get(ctx, `${segmentsUrl(s.store.id)}/${andSeg.json["id"]}/members`, s.auth);
    expect(andRes.json["total"]).toBe(1);
    expect((andRes.json["members"] as Array<Record<string, unknown>>)[0]!["id"]).toBe(vip);
  });

  it("OR (any) combination unions the matches", async () => {
    const s = await setup();
    const spender = await seedCustomer(s.store.id, `sp-${randomUUID()}@x.com`);
    const tagged = await seedCustomer(s.store.id, `tg-${randomUUID()}@x.com`, ["wholesale"]);
    await seedCustomer(s.store.id, `no-${randomUUID()}@x.com`); // matches neither
    await seedOrder(s.store.id, spender, "500.00");

    const seg = await post(
      ctx,
      segmentsUrl(s.store.id),
      {
        name: "BigOrWholesale",
        rules: anyOf(
          { field: "total_spent", op: ">=", value: 300 },
          { field: "has_tag", op: "=", value: "wholesale" }
        ),
      },
      s.auth
    );
    const res = await get(ctx, `${segmentsUrl(s.store.id)}/${seg.json["id"]}/members`, s.auth);
    expect(res.json["total"]).toBe(2);
    const ids = (res.json["members"] as Array<Record<string, unknown>>).map((m) => m["id"]).sort();
    expect(ids).toEqual([spender, tagged].sort());
  });
});

// ── customer → segments ──────────────────────────────────────────────────────────

describe("customer segments lookup", () => {
  it("returns only the active segments a customer matches", async () => {
    const s = await setup();
    const cust = await seedCustomer(s.store.id, `c-${randomUUID()}@acme.com`, ["vip"]);
    await seedOrder(s.store.id, cust, "200.00");

    // Matches: total_spent + has_tag. Does not match: email_domain other.com.
    await post(ctx, segmentsUrl(s.store.id), { name: "Spenders", rules: allOf({ field: "total_spent", op: ">=", value: 100 }) }, s.auth);
    await post(ctx, segmentsUrl(s.store.id), { name: "Vips", rules: allOf({ field: "has_tag", op: "=", value: "vip" }) }, s.auth);
    await post(ctx, segmentsUrl(s.store.id), { name: "Others", rules: allOf({ field: "email_domain", op: "=", value: "other.com" }) }, s.auth);
    // An inactive matching segment must be excluded.
    const inactive = await post(ctx, segmentsUrl(s.store.id), { name: "InactiveVip", rules: allOf({ field: "has_tag", op: "=", value: "vip" }) }, s.auth);
    await put(ctx, `${segmentsUrl(s.store.id)}/${inactive.json["id"]}`, { is_active: false }, s.auth);

    const res = await get(ctx, `/commerce/stores/${s.store.id}/customers/${cust}/segments`, s.auth);
    expect(res.status).toBe(200);
    const names = (res.json["segments"] as Array<Record<string, unknown>>).map((x) => x["name"]).sort();
    expect(names).toEqual(["Spenders", "Vips"]);
  });
});

// ── SQL-injection safety ──────────────────────────────────────────────────────────

describe("segments SQL-injection safety", () => {
  it("treats a malicious value as bound data, not executable SQL", async () => {
    const s = await setup();
    // A customer whose tag is literally a SQL-injection attempt.
    const evil = "x'; DROP TABLE customers; --";
    const cust = await seedCustomer(s.store.id, `evil-${randomUUID()}@a.com`, [evil]);

    const seg = await post(
      ctx,
      segmentsUrl(s.store.id),
      { name: "InjTag", rules: allOf({ field: "has_tag", op: "=", value: evil }) },
      s.auth
    );
    expect(seg.status).toBe(201);

    // Evaluation must succeed, match exactly the one customer carrying that tag,
    // and — critically — the customers table must still exist afterwards.
    const res = await get(ctx, `${segmentsUrl(s.store.id)}/${seg.json["id"]}/members`, s.auth);
    expect(res.status).toBe(200);
    expect(res.json["total"]).toBe(1);
    expect((res.json["members"] as Array<Record<string, unknown>>)[0]!["id"]).toBe(cust);

    // Table integrity check: the injection did not drop the table.
    const { rows } = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM customers WHERE store_id = $1::uuid`,
      [s.store.id]
    );
    expect(parseInt(rows[0]!.n, 10)).toBeGreaterThanOrEqual(1);
  });
});
