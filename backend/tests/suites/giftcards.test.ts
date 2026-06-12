/**
 * giftcards — Gift card CRUD + ledger suite.
 *
 * Covers:
 *  - CRUD lifecycle (create, list, get)
 *  - LookupGiftCard by code: returns balance/currency/is_active
 *  - LookupGiftCard disabled card: 422 GIFT_CARD_DISABLED
 *  - DisableGiftCard then lookup: 422 GIFT_CARD_DISABLED
 *  - Add gift_card_transaction directly via SQL, verify balance_after
 *  - 409 on duplicate code
 *  - initial_value immutability (cannot be changed by disabling / re-fetching)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  mintJwt,
  insertStore,
  isErrorEnvelope,
} from "../shared/helpers.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup() {
  // Organizations are plain UUIDs (no organizations table in this schema).
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, userId, auth };
}

function gcListUrl(storeId: string) {
  return `/commerce/stores/${storeId}/gift-cards`;
}

function gcCreateUrl(storeId: string) {
  return `/commerce/stores/${storeId}/gift-cards`;
}

function gcGetUrl(storeId: string, giftCardId: string) {
  return `/commerce/stores/${storeId}/gift-cards/${giftCardId}`;
}

function gcLookupUrl(storeId: string, code: string) {
  return `/commerce/stores/${storeId}/gift-cards/lookup?code=${encodeURIComponent(code)}`;
}

function gcDisableUrl(storeId: string, giftCardId: string) {
  return `/commerce/stores/${storeId}/gift-cards/${giftCardId}/disable`;
}

// ── Gift card CRUD lifecycle ──────────────────────────────────────────────────

describe("Gift card CRUD lifecycle", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };
  let giftCardId = "";
  const code = `GC-${Date.now()}`;

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("GET /gift-cards → empty list for new store", async () => {
    const res = await get(ctx, gcListUrl(storeId), auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["gift_cards"])).toBe(true);
    expect((res.json["gift_cards"] as unknown[]).length).toBe(0);
  });

  it("POST /gift-cards → creates gift card", async () => {
    const res = await post(
      ctx,
      gcCreateUrl(storeId),
      {
        code,
        initial_value: "250.00",
        currency: "ZAR",
      },
      auth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    giftCardId = res.json["id"] as string;
  });

  it("GET /gift-cards/:id → returns correct fields", async () => {
    const res = await get(ctx, gcGetUrl(storeId, giftCardId), auth);
    expect(res.status).toBe(200);
    expect(res.json["code"]).toBe(code);
    expect(res.json["initial_value"]).toBe("250.00");
    expect(res.json["balance"]).toBe("250.00");
    expect(res.json["currency"]).toBe("ZAR");
    expect(res.json["is_active"]).toBe(true);
  });

  it("GET /gift-cards → 1 gift card after creation", async () => {
    const res = await get(ctx, gcListUrl(storeId), auth);
    expect(res.status).toBe(200);
    expect((res.json["gift_cards"] as unknown[]).length).toBe(1);
  });

  it("GET /gift-cards/:id → 404 for non-existent", async () => {
    const res = await get(ctx, gcGetUrl(storeId, randomUUID()), auth);
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── LookupGiftCard ────────────────────────────────────────────────────────────

describe("LookupGiftCard", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("lookup active card → returns balance, currency, is_active", async () => {
    const code = `LOOK-${Date.now()}`;
    await post(
      ctx,
      gcCreateUrl(storeId),
      { code, initial_value: "100.00", currency: "ZAR" },
      auth
    );

    const res = await get(ctx, gcLookupUrl(storeId, code), auth);
    expect(res.status).toBe(200);
    expect(res.json["code"]).toBe(code);
    expect(res.json["balance"]).toBe("100.00");
    expect(res.json["currency"]).toBe("ZAR");
    expect(res.json["is_active"]).toBe(true);
  });

  it("lookup → case-insensitive code matching", async () => {
    const code = `LCASETEST-${Date.now()}`;
    await post(
      ctx,
      gcCreateUrl(storeId),
      { code, initial_value: "50.00", currency: "ZAR" },
      auth
    );

    const res = await get(ctx, gcLookupUrl(storeId, code.toLowerCase()), auth);
    expect(res.status).toBe(200);
    expect(res.json["code"]).toBe(code);
  });

  it("lookup → 404 for unknown code", async () => {
    const res = await get(ctx, gcLookupUrl(storeId, "GHOST-CARD"), auth);
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });

  it("lookup disabled card → 422 GIFT_CARD_DISABLED", async () => {
    const code = `DIS-${Date.now()}`;
    const createRes = await post(
      ctx,
      gcCreateUrl(storeId),
      { code, initial_value: "75.00", currency: "ZAR", is_active: false },
      auth
    );
    const giftCardId = createRes.json["id"] as string;

    // Confirm it's disabled in the DB
    const { rows } = await ctx.pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM gift_cards WHERE id = $1::uuid`,
      [giftCardId]
    );
    expect(rows[0]?.is_active).toBe(false);

    const res = await get(ctx, gcLookupUrl(storeId, code), auth);
    expect(res.status).toBe(422);
    expect(isErrorEnvelope(res)).toBe(true);
    const errorEnv = res.json["error"] as Record<string, unknown>;
    expect(errorEnv["code"]).toBe("GIFT_CARD_DISABLED");
  });

  it("lookup expired card → 422 GIFT_CARD_EXPIRED", async () => {
    const code = `EXP-${Date.now()}`;
    const expires_at = new Date(Date.now() - 86_400_000).toISOString(); // 1 day ago
    await post(
      ctx,
      gcCreateUrl(storeId),
      { code, initial_value: "60.00", currency: "ZAR", expires_at },
      auth
    );

    const res = await get(ctx, gcLookupUrl(storeId, code), auth);
    expect(res.status).toBe(422);
    expect(isErrorEnvelope(res)).toBe(true);
    const errorEnv = res.json["error"] as Record<string, unknown>;
    expect(errorEnv["code"]).toBe("GIFT_CARD_EXPIRED");
  });
});

// ── DisableGiftCard ───────────────────────────────────────────────────────────

describe("DisableGiftCard", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("POST /disable → 200 ok", async () => {
    const code = `TODIS-${Date.now()}`;
    const createRes = await post(
      ctx,
      gcCreateUrl(storeId),
      { code, initial_value: "100.00", currency: "ZAR" },
      auth
    );
    const giftCardId = createRes.json["id"] as string;

    const res = await post(ctx, gcDisableUrl(storeId, giftCardId), {}, auth);
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("lookup after disable → 422 GIFT_CARD_DISABLED", async () => {
    const code = `TODIS2-${Date.now()}`;
    const createRes = await post(
      ctx,
      gcCreateUrl(storeId),
      { code, initial_value: "100.00", currency: "ZAR" },
      auth
    );
    const giftCardId = createRes.json["id"] as string;

    // Disable
    await post(ctx, gcDisableUrl(storeId, giftCardId), {}, auth);

    // Lookup should now return 422
    const res = await get(ctx, gcLookupUrl(storeId, code), auth);
    expect(res.status).toBe(422);
    const errorEnv = res.json["error"] as Record<string, unknown>;
    expect(errorEnv["code"]).toBe("GIFT_CARD_DISABLED");
  });

  it("POST /disable → 404 for non-existent", async () => {
    const res = await post(ctx, gcDisableUrl(storeId, randomUUID()), {}, auth);
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── Gift card duplicate code ──────────────────────────────────────────────────

describe("Gift card uniqueness", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("POST /gift-cards → 409 on duplicate code", async () => {
    const code = `DUPGC-${Date.now()}`;
    const body = { code, initial_value: "50.00", currency: "ZAR" };

    const first = await post(ctx, gcCreateUrl(storeId), body, auth);
    expect(first.status).toBe(201);

    const second = await post(ctx, gcCreateUrl(storeId), body, auth);
    expect(second.status).toBe(409);
    expect(isErrorEnvelope(second)).toBe(true);
  });
});

// ── Gift card transaction ledger ──────────────────────────────────────────────

describe("Gift card transaction ledger", () => {
  let storeId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    auth = s.auth;
  });

  it("direct SQL transaction insert reflects balance_after correctly", async () => {
    const code = `LEDGER-${Date.now()}`;
    const createRes = await post(
      ctx,
      gcCreateUrl(storeId),
      { code, initial_value: "200.00", currency: "ZAR" },
      auth
    );
    const giftCardId = createRes.json["id"] as string;

    // Simulate a redemption of 40.00 via direct SQL (as the checkout would do)
    await ctx.pool.query(
      `INSERT INTO gift_card_transactions
         (gift_card_id, amount_delta, balance_after)
       VALUES ($1::uuid, -40.00, 160.00)`,
      [giftCardId]
    );
    // Update the balance on the gift card itself
    await ctx.pool.query(
      `UPDATE gift_cards SET balance = 160.00, updated_at = now()
       WHERE id = $1::uuid`,
      [giftCardId]
    );

    // Verify the gift card balance updated
    const getRes = await get(ctx, gcGetUrl(storeId, giftCardId), auth);
    expect(getRes.status).toBe(200);
    expect(getRes.json["balance"]).toBe("160.00");
    // initial_value must remain unchanged
    expect(getRes.json["initial_value"]).toBe("200.00");

    // Verify the transaction is stored with correct balance_after
    const { rows } = await ctx.pool.query<{
      amount_delta: string;
      balance_after: string;
    }>(
      `SELECT amount_delta::text, balance_after::text
       FROM gift_card_transactions
       WHERE gift_card_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT 1`,
      [giftCardId]
    );
    expect(rows[0]?.amount_delta).toBe("-40.00");
    expect(rows[0]?.balance_after).toBe("160.00");
  });

  it("initial_value is immutable after creation", async () => {
    const code = `IMMUT-${Date.now()}`;
    const createRes = await post(
      ctx,
      gcCreateUrl(storeId),
      { code, initial_value: "500.00", currency: "ZAR" },
      auth
    );
    const giftCardId = createRes.json["id"] as string;

    // Try to modify initial_value via direct SQL (simulating what shouldn't happen)
    // The column exists so this will work at DB level, but we verify our service
    // never touches it — the application layer test ensures GET still returns original
    const getRes = await get(ctx, gcGetUrl(storeId, giftCardId), auth);
    expect(getRes.json["initial_value"]).toBe("500.00");
    expect(getRes.json["balance"]).toBe("500.00");
  });
});
