/**
 * catalog-validation — Validation-focused tests for the catalog module.
 *
 * Mirrors webcrft tests/suites/commerce_validation.go catalog section.
 *
 * Covers:
 *  1.  Product: empty title → 400
 *  2.  Product: invalid slug → 400
 *  3.  Product: invalid type → 400
 *  4.  Product: price=-1 → 400
 *  5.  Product: price="abc" → 400
 *  6.  Variant: price=0 → 400
 *  7.  Variant: negative price → 400
 *  8.  Collection: empty title → 400
 *  9.  Collection: duplicate slug → 409 DUPLICATE_SLUG
 *  10. Collection rule: missing field → 400
 *  11. Collection rule: invalid relation → 400
 *  12. Metafield: invalid type → 400
 *  13. Translation: locale="" → 400
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import {
  get,
  post,
  put,
  del,
  mintJwt,
  createApiKey,
  insertOrg,
  errorCode,
} from "../shared/helpers.js";
import { randomUUID } from "node:crypto";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

// ── Shared setup ──────────────────────────────────────────────────────────────

let storeId: string;
let writeAuth: { type: "api-key"; key: string };
let adminAuth: { type: "api-key"; key: string };
let readAuth: { type: "api-key"; key: string };
let testProductId: string;

beforeAll(async () => {
  const userId = randomUUID();
  const org = await insertOrg(ctx.pool, { name: `ValidationOrg-${Date.now()}` });

  const token = await mintJwt({ userId, orgId: org.id });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: `ValidationStore-${Date.now()}`,
    currency: "USD",
  }, auth);
  storeId = storeRes.json["id"] as string;

  writeAuth = {
    type: "api-key",
    key: await createApiKey(ctx, {
      orgId: org.id,
      userId,
      storeId,
      type: "private",
      scopes: ["commerce:read", "commerce:write"],
    }),
  };

  adminAuth = {
    type: "api-key",
    key: await createApiKey(ctx, {
      orgId: org.id,
      userId,
      storeId,
      type: "private",
      scopes: ["commerce:read", "commerce:write", "commerce:admin"],
    }),
  };

  readAuth = {
    type: "api-key",
    key: await createApiKey(ctx, {
      orgId: org.id,
      userId,
      storeId,
      type: "public",
      scopes: ["commerce:read"],
    }),
  };

  // Create a product for variant tests
  const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
    title: "Validation Test Product",
  }, writeAuth);
  testProductId = pRes.json["id"] as string;
}, 120_000);

// ══════════════════════════════════════════════════════════════════════════════
// Product validation
// ══════════════════════════════════════════════════════════════════════════════

describe("Product validation", () => {
  it("1. Empty title → 400 VALIDATION_ERROR", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("2a. Slug with spaces → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Valid Title",
      slug: "invalid slug with spaces",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("2b. Slug with uppercase → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Valid Title",
      slug: "Invalid-Uppercase-Slug",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("3. Invalid product type → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Widget",
      type: "not-a-valid-type",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("4. price=-1 (negative) → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Widget",
      price: "-1",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("5. price='abc' (non-numeric) → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Widget",
      price: "abc",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Product title too long (>500 chars) → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "A".repeat(501),
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Variant validation
// ══════════════════════════════════════════════════════════════════════════════

describe("Variant validation", () => {
  it("6. price=0 → 400 (must be > 0)", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${testProductId}/variants`,
      { price: "0" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("7. Negative price → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${testProductId}/variants`,
      { price: "-5.00" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Missing price entirely → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${testProductId}/variants`,
      { title: "No Price" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("price='abc' → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${testProductId}/variants`,
      { price: "not-a-number" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Collection validation
// ══════════════════════════════════════════════════════════════════════════════

describe("Collection validation", () => {
  it("8. Empty title → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/collections`, {
      title: "",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("9. Duplicate slug → 409 DUPLICATE_SLUG", async () => {
    const slug = `test-collection-${Date.now()}`;

    // First creation succeeds
    const first = await post(ctx, `/commerce/stores/${storeId}/collections`, {
      title: "First Collection",
      slug,
    }, writeAuth);
    expect(first.status).toBe(201);

    // Second creation with same slug fails
    const second = await post(ctx, `/commerce/stores/${storeId}/collections`, {
      title: "Second Collection",
      slug,
    }, writeAuth);
    expect(second.status).toBe(409);
    expect(errorCode(second)).toBe("DUPLICATE_SLUG");
  });

  it("Slug with uppercase → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/collections`, {
      title: "Test",
      slug: "UpperCase-Slug",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Collection rule validation
// ══════════════════════════════════════════════════════════════════════════════

describe("Collection rule validation", () => {
  let collectionId: string;

  beforeAll(async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/collections`, {
      title: `Rule Test Collection ${Date.now()}`,
    }, writeAuth);
    collectionId = res.json["id"] as string;
  });

  it("10. Missing field → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/rules`,
      { relation: "equals", value: "test" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("11. Invalid relation → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/rules`,
      { field: "title", relation: "fuzzy_match", value: "test" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Invalid field → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/rules`,
      { field: "inventory_count", relation: "greater_than", value: "5" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Metafield validation
// ══════════════════════════════════════════════════════════════════════════════

describe("Metafield validation", () => {
  it("12. Invalid type → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/metafields`, {
      owner_resource: "product",
      owner_id: randomUUID(),
      namespace: "custom",
      key: "color",
      value: "blue",
      type: "not-a-valid-type",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Missing owner_resource → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/metafields`, {
      owner_id: randomUUID(),
      namespace: "custom",
      key: "color",
      value: "blue",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Missing key → 400", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/metafields`, {
      owner_resource: "product",
      owner_id: randomUUID(),
      namespace: "custom",
    }, writeAuth);
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Translation validation
// ══════════════════════════════════════════════════════════════════════════════

describe("Translation validation", () => {
  it("13. locale='' (empty string) → 400", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/translations/product/${randomUUID()}/`,
      { fields: { title: "Title" } },
      writeAuth
    );
    // Empty locale in URL path results in route not found
    expect([400, 404]).toContain(res.status);
  });

  it("locale too short (1 char) → 400", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/translations/product/${randomUUID()}/x`,
      { fields: { title: "Title" } },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Invalid resourceType → 400", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/translations/invalid_type/${randomUUID()}/en`,
      { fields: { title: "Title" } },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Valid locale (2 chars) passes validation", async () => {
    const pid = testProductId;
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/translations/product/${pid}/en`,
      { fields: { title: "English Title" } },
      writeAuth
    );
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Product duplicate slug validation
// ══════════════════════════════════════════════════════════════════════════════

describe("Product duplicate slug", () => {
  it("Duplicate product slug → 409 DUPLICATE_SLUG", async () => {
    const slug = `test-product-${Date.now()}`;

    const first = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "First Product",
      slug,
    }, writeAuth);
    expect(first.status).toBe(201);

    const second = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Second Product",
      slug,
    }, writeAuth);
    expect(second.status).toBe(409);
    expect(errorCode(second)).toBe("DUPLICATE_SLUG");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Review validation
// ══════════════════════════════════════════════════════════════════════════════

describe("Review validation", () => {
  it("Rating=0 → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${testProductId}/reviews`,
      { rating: 0 },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Rating=6 → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${testProductId}/reviews`,
      { rating: 6 },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("Missing rating → 400", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${testProductId}/reviews`,
      { title: "Great!" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });
});
