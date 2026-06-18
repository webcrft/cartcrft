/**
 * review-moderation — Product-review moderation + cached aggregate ratings.
 *
 * Covers (catalog module, review code paths only):
 *   • New reviews default to status='pending' and are NOT counted in aggregates.
 *   • Moderate→approved recomputes products.avg_rating / review_count.
 *   • Moderate→rejected excludes the review from the aggregate.
 *   • Deleting an approved review recomputes the aggregate.
 *   • Public/storefront listing (default status) returns approved only.
 *   • Aggregate math is correct across multiple ratings.
 *
 * Mirrors the conventions in catalog.test.ts (setupStore, api-key auth tiers).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  del,
  mintJwt,
  createApiKey,
  insertOrg,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

async function setupStore() {
  const userId = randomUUID();
  const org = await insertOrg(ctx.pool, { name: `ReviewOrg-${Date.now()}` });

  const token = await mintJwt({ userId, orgId: org.id });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: `ReviewStore-${Date.now()}`,
    currency: "USD",
  }, auth);
  expect(storeRes.status).toBe(201);
  const storeId = storeRes.json["id"] as string;

  const adminKey = await createApiKey(ctx, {
    orgId: org.id,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const adminAuth = { type: "api-key" as const, key: adminKey };

  const writeKey = await createApiKey(ctx, {
    orgId: org.id,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write"],
  });
  const writeAuth = { type: "api-key" as const, key: writeKey };

  const readKey = await createApiKey(ctx, {
    orgId: org.id,
    userId,
    storeId,
    type: "public",
    scopes: ["commerce:read"],
  });
  const readAuth = { type: "api-key" as const, key: readKey };

  return { storeId, adminAuth, writeAuth, readAuth };
}

async function createReview(
  storeId: string,
  productId: string,
  auth: { type: "api-key"; key: string },
  rating: number,
  name: string
): Promise<string> {
  const res = await post(
    ctx,
    `/commerce/stores/${storeId}/products/${productId}/reviews`,
    { rating, title: `${rating} stars`, body: "review body", reviewer_name: name },
    auth
  );
  expect(res.status).toBe(201);
  return res.json["id"] as string;
}

async function getProduct(
  storeId: string,
  productId: string,
  auth: { type: "api-key"; key: string }
): Promise<Record<string, unknown>> {
  const res = await get(ctx, `/commerce/stores/${storeId}/products/${productId}`, auth);
  expect(res.status).toBe(200);
  return res.json as Record<string, unknown>;
}

describe("Review moderation + cached aggregate ratings", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let productId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Aggregate Product",
      status: "active",
    }, writeAuth);
    expect(pRes.status).toBe(201);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("new product starts with zero aggregates", async () => {
    const p = await getProduct(storeId, productId, readAuth);
    expect(Number(p["avg_rating"])).toBe(0);
    expect(p["review_count"]).toBe(0);
  });

  it("pending reviews are not counted in aggregates", async () => {
    await createReview(storeId, productId, writeAuth, 5, "Alice");
    await createReview(storeId, productId, writeAuth, 3, "Bob");

    const p = await getProduct(storeId, productId, readAuth);
    expect(Number(p["avg_rating"])).toBe(0);
    expect(p["review_count"]).toBe(0);
  });

  it("public listing (default status) shows only approved reviews", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews`,
      readAuth
    );
    expect(res.status).toBe(200);
    const reviews = res.json["reviews"] as Array<Record<string, unknown>>;
    expect(reviews.length).toBe(0);
  });

  it("moderate→approved recomputes avg_rating + review_count", async () => {
    const r1 = await createReview(storeId, productId, writeAuth, 4, "Carol");
    const r2 = await createReview(storeId, productId, writeAuth, 2, "Dave");

    const mod1 = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews/${r1}/moderate`,
      { status: "approved" },
      adminAuth
    );
    expect(mod1.status).toBe(200);

    let p = await getProduct(storeId, productId, readAuth);
    expect(Number(p["avg_rating"])).toBe(4);
    expect(p["review_count"]).toBe(1);

    const mod2 = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews/${r2}/moderate`,
      { status: "approved" },
      adminAuth
    );
    expect(mod2.status).toBe(200);

    p = await getProduct(storeId, productId, readAuth);
    // (4 + 2) / 2 = 3.00
    expect(Number(p["avg_rating"])).toBe(3);
    expect(p["review_count"]).toBe(2);

    // Approved reviews now visible in the public listing.
    const listRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews`,
      readAuth
    );
    const reviews = listRes.json["reviews"] as Array<Record<string, unknown>>;
    expect(reviews.length).toBe(2);
    expect(reviews.every((r) => r["status"] === "approved")).toBe(true);
  });

  it("moderate→rejected excludes the review from the aggregate", async () => {
    const r = await createReview(storeId, productId, writeAuth, 1, "Eve");

    // Approve first → count becomes 3, avg = (4+2+1)/3 = 2.33
    await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews/${r}/moderate`,
      { status: "approved" },
      adminAuth
    );
    let p = await getProduct(storeId, productId, readAuth);
    expect(p["review_count"]).toBe(3);
    expect(Number(p["avg_rating"])).toBeCloseTo(2.33, 2);

    // Now reject it → back to 2 approved, avg = 3.00
    const rej = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews/${r}/moderate`,
      { status: "rejected" },
      adminAuth
    );
    expect(rej.status).toBe(200);

    p = await getProduct(storeId, productId, readAuth);
    expect(p["review_count"]).toBe(2);
    expect(Number(p["avg_rating"])).toBe(3);
  });

  it("deleting an approved review recomputes the aggregate", async () => {
    const r = await createReview(storeId, productId, writeAuth, 5, "Frank");
    await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews/${r}/moderate`,
      { status: "approved" },
      adminAuth
    );

    let p = await getProduct(storeId, productId, readAuth);
    // (4 + 2 + 5) / 3 = 3.67
    expect(p["review_count"]).toBe(3);
    expect(Number(p["avg_rating"])).toBeCloseTo(3.67, 2);

    const delRes = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews/${r}`,
      adminAuth
    );
    expect(delRes.status).toBe(200);

    p = await getProduct(storeId, productId, readAuth);
    // Back to the two approved reviews: (4 + 2) / 2 = 3.00
    expect(p["review_count"]).toBe(2);
    expect(Number(p["avg_rating"])).toBe(3);
  });

  it("moderating a non-existent review returns 404", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews/${randomUUID()}/moderate`,
      { status: "approved" },
      adminAuth
    );
    expect(res.status).toBe(404);
  });

  it("aggregate math correct across multiple ratings on a fresh product", async () => {
    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Math Product",
      status: "active",
    }, writeAuth);
    const pid = pRes.json["id"] as string;

    const ratings = [5, 5, 4, 1];
    for (const rating of ratings) {
      const id = await createReview(storeId, pid, writeAuth, rating, `r${rating}`);
      await post(
        ctx,
        `/commerce/stores/${storeId}/products/${pid}/reviews/${id}/moderate`,
        { status: "approved" },
        adminAuth
      );
    }

    const p = await getProduct(storeId, pid, readAuth);
    // (5 + 5 + 4 + 1) / 4 = 3.75
    expect(p["review_count"]).toBe(4);
    expect(Number(p["avg_rating"])).toBe(3.75);
  });
});
