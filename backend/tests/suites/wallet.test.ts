/**
 * wallet — Store credits (ledger) suite.
 *
 * Covers:
 *  - IssueStoreCredit: creates wallet row + transaction entry
 *  - AdjustStoreCredit positive: ledger invariant (sum of deltas == balance)
 *  - AdjustStoreCredit negative: ledger invariant
 *  - Negative adjust below zero: 422 INSUFFICIENT_CREDIT
 *  - Concurrent +10 adjustments (5x): verify final balance = 50
 *  - ListStoreCreditTransactions: ordered, has balance_after entries
 *  - balance_after on each transaction matches the running total
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
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

// ── Helpers ────────────────────────────────────────────────────────────────────

async function setup() {
  // Organizations are plain UUIDs (no organizations table in this schema).
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  const customer = await insertCustomer(ctx.pool, { storeId: store.id });
  const userId = randomUUID();
  const token = await mintJwt({ userId, orgId });
  const auth = { type: "bearer" as const, token };
  return { orgId, store, customer, userId, auth };
}

function creditsUrl(storeId: string, customerId: string) {
  return `/commerce/stores/${storeId}/customers/${customerId}/credits`;
}

function issueUrl(storeId: string, customerId: string) {
  return `/commerce/stores/${storeId}/customers/${customerId}/credits/issue`;
}

function adjustUrl(storeId: string, customerId: string) {
  return `/commerce/stores/${storeId}/customers/${customerId}/credits/adjust`;
}

function txUrl(storeId: string, customerId: string) {
  return `/commerce/stores/${storeId}/customers/${customerId}/credits/transactions`;
}

// ── IssueStoreCredit ──────────────────────────────────────────────────────────

describe("IssueStoreCredit", () => {
  let storeId = "";
  let customerId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    customerId = s.customer.id;
    auth = s.auth;
  });

  it("GET /credits → empty before any issue", async () => {
    const res = await get(ctx, creditsUrl(storeId, customerId), auth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json["credits"])).toBe(true);
    expect((res.json["credits"] as unknown[]).length).toBe(0);
  });

  it("POST /credits/issue → creates wallet and transaction", async () => {
    const res = await post(
      ctx,
      issueUrl(storeId, customerId),
      { currency: "ZAR", amount: "100.00", notes: "Welcome bonus" },
      auth
    );
    expect(res.status).toBe(201);
    const body = res.json;
    expect(body["credit"]).toBeDefined();
    expect(body["transaction"]).toBeDefined();

    const credit = body["credit"] as Record<string, unknown>;
    expect(credit["balance"]).toBe("100.00");
    expect(credit["currency"]).toBe("ZAR");

    const tx = body["transaction"] as Record<string, unknown>;
    expect(tx["type"]).toBe("issue");
    expect(tx["amount_delta"]).toBe("100.00");
    expect(tx["balance_after"]).toBe("100.00");
    expect(tx["notes"]).toBe("Welcome bonus");
  });

  it("GET /credits → shows the wallet with correct balance", async () => {
    const res = await get(ctx, creditsUrl(storeId, customerId), auth);
    expect(res.status).toBe(200);
    const credits = res.json["credits"] as Array<Record<string, unknown>>;
    expect(credits.length).toBe(1);
    expect(credits[0]!["balance"]).toBe("100.00");
    expect(credits[0]!["currency"]).toBe("ZAR");
  });

  it("POST /credits/issue again → balance accumulates (second issue)", async () => {
    const res = await post(
      ctx,
      issueUrl(storeId, customerId),
      { currency: "ZAR", amount: "50.00" },
      auth
    );
    expect(res.status).toBe(201);
    const credit = res.json["credit"] as Record<string, unknown>;
    expect(credit["balance"]).toBe("150.00");
  });
});

// ── AdjustStoreCredit ─────────────────────────────────────────────────────────

describe("AdjustStoreCredit", () => {
  let storeId = "";
  let customerId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    customerId = s.customer.id;
    auth = s.auth;

    // Seed the wallet with 100 ZAR
    await post(
      ctx,
      issueUrl(storeId, customerId),
      { currency: "ZAR", amount: "100.00" },
      auth
    );
  });

  it("positive delta → type='issue', balance increases", async () => {
    const res = await post(
      ctx,
      adjustUrl(storeId, customerId),
      { currency: "ZAR", delta: "25.00" },
      auth
    );
    expect(res.status).toBe(200);
    const tx = res.json["transaction"] as Record<string, unknown>;
    expect(tx["type"]).toBe("issue");
    expect(tx["amount_delta"]).toBe("25.00");
    expect(tx["balance_after"]).toBe("125.00");
  });

  it("negative delta → type='adjust', balance decreases", async () => {
    const res = await post(
      ctx,
      adjustUrl(storeId, customerId),
      { currency: "ZAR", delta: "-50.00" },
      auth
    );
    expect(res.status).toBe(200);
    const tx = res.json["transaction"] as Record<string, unknown>;
    expect(tx["type"]).toBe("adjust");
    expect(tx["amount_delta"]).toBe("-50.00");
    expect(tx["balance_after"]).toBe("75.00");
  });

  it("negative adjust to exact zero → allowed", async () => {
    const res = await post(
      ctx,
      adjustUrl(storeId, customerId),
      { currency: "ZAR", delta: "-75.00" },
      auth
    );
    expect(res.status).toBe(200);
    const credit = res.json["credit"] as Record<string, unknown>;
    expect(credit["balance"]).toBe("0.00");
  });

  it("negative adjust below zero → 422 INSUFFICIENT_CREDIT", async () => {
    // Balance is now 0.00
    const res = await post(
      ctx,
      adjustUrl(storeId, customerId),
      { currency: "ZAR", delta: "-1.00" },
      auth
    );
    expect(res.status).toBe(422);
    expect(isErrorEnvelope(res)).toBe(true);
    const errorEnv = res.json["error"] as Record<string, unknown>;
    expect(errorEnv["code"]).toBe("INSUFFICIENT_CREDIT");
  });

  it("adjust on unknown currency → 404", async () => {
    const res = await post(
      ctx,
      adjustUrl(storeId, customerId),
      { currency: "USD", delta: "-10.00" },
      auth
    );
    expect(res.status).toBe(404);
    expect(isErrorEnvelope(res)).toBe(true);
  });
});

// ── Ledger invariant ──────────────────────────────────────────────────────────

describe("Store credit ledger invariant", () => {
  let storeId = "";
  let customerId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    customerId = s.customer.id;
    auth = s.auth;
  });

  it("sum of transaction deltas equals final balance", async () => {
    // Issue 200
    await post(
      ctx,
      issueUrl(storeId, customerId),
      { currency: "ZAR", amount: "200.00" },
      auth
    );
    // Adjust +50
    await post(
      ctx,
      adjustUrl(storeId, customerId),
      { currency: "ZAR", delta: "50.00" },
      auth
    );
    // Adjust -80
    await post(
      ctx,
      adjustUrl(storeId, customerId),
      { currency: "ZAR", delta: "-80.00" },
      auth
    );

    // Expected balance: 200 + 50 - 80 = 170
    const creditsRes = await get(ctx, creditsUrl(storeId, customerId), auth);
    const credits = creditsRes.json["credits"] as Array<Record<string, unknown>>;
    const zarCredit = credits.find((c) => c["currency"] === "ZAR");
    expect(zarCredit?.["balance"]).toBe("170.00");
  });

  it("balance_after on each transaction matches running total", async () => {
    const txRes = await get(ctx, txUrl(storeId, customerId), auth);
    expect(txRes.status).toBe(200);
    const txs = txRes.json["transactions"] as Array<Record<string, unknown>>;

    // Transactions are ordered DESC by created_at; reverse to check running total
    const ordered = [...txs].reverse();
    let running = 0;
    for (const tx of ordered) {
      running += parseFloat(tx["amount_delta"] as string);
      const balanceAfter = parseFloat(tx["balance_after"] as string);
      expect(Math.abs(balanceAfter - running)).toBeLessThan(0.005);
    }
  });
});

// ── ListStoreCreditTransactions ordering ──────────────────────────────────────

describe("ListStoreCreditTransactions", () => {
  let storeId = "";
  let customerId = "";
  let auth: { type: "bearer"; token: string };

  beforeAll(async () => {
    const s = await setup();
    storeId = s.store.id;
    customerId = s.customer.id;
    auth = s.auth;

    // Issue 3 times
    for (const amount of ["10.00", "20.00", "30.00"]) {
      await post(
        ctx,
        issueUrl(storeId, customerId),
        { currency: "ZAR", amount },
        auth
      );
    }
  });

  it("returns transactions in DESC order (most recent first)", async () => {
    const res = await get(ctx, txUrl(storeId, customerId), auth);
    expect(res.status).toBe(200);
    const txs = res.json["transactions"] as Array<Record<string, unknown>>;
    expect(txs.length).toBeGreaterThanOrEqual(3);

    // Verify descending order by created_at
    for (let i = 1; i < txs.length; i++) {
      const prev = new Date(txs[i - 1]!["created_at"] as string).getTime();
      const curr = new Date(txs[i]!["created_at"] as string).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it("all transactions have balance_after field", async () => {
    const res = await get(ctx, txUrl(storeId, customerId), auth);
    const txs = res.json["transactions"] as Array<Record<string, unknown>>;
    for (const tx of txs) {
      expect(typeof tx["balance_after"]).toBe("string");
      expect(parseFloat(tx["balance_after"] as string)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── Concurrent adjustments ────────────────────────────────────────────────────

describe("Concurrent store credit adjustments", () => {
  it("5 concurrent +10 ZAR adjustments → final balance = 50", async () => {
    const s = await setup();
    const storeId = s.store.id;
    const customerId = s.customer.id;
    const auth = s.auth;

    // Seed wallet with 0 by issuing 0.01 then adjust back (or just issue 0 as a base)
    // Actually just issue 0 to create the wallet, then do all adjustments concurrently.
    // We issue a small amount first to create the wallet row:
    await post(
      ctx,
      issueUrl(storeId, customerId),
      { currency: "ZAR", amount: "0.01" },
      auth
    );
    // Adjust -0.01 to zero out
    await post(
      ctx,
      adjustUrl(storeId, customerId),
      { currency: "ZAR", delta: "-0.01" },
      auth
    );

    // Now fire 5 concurrent +10 adjustments
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(
          ctx,
          adjustUrl(storeId, customerId),
          { currency: "ZAR", delta: "10.00" },
          auth
        )
      )
    );

    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // Final balance should be exactly 50.00
    const creditsRes = await get(ctx, creditsUrl(storeId, customerId), auth);
    const credits = creditsRes.json["credits"] as Array<Record<string, unknown>>;
    const zarCredit = credits.find((c) => c["currency"] === "ZAR");
    expect(zarCredit?.["balance"]).toBe("50.00");
  });
});
