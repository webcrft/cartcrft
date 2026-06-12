/**
 * catalog — Full CRUD integration tests for the catalog module.
 *
 * Covers:
 *  1.  Products CRUD
 *  2.  Variants
 *  3.  Options + values
 *  4.  Media
 *  5.  Bundle items
 *  6.  Digital files
 *  7.  Collections CRUD
 *  8.  Collection products (add / remove)
 *  9.  Collection rules + smart membership
 *  10. Product tags
 *  11. Reviews
 *  12. Price lists + items
 *  13. Metafields
 *  14. Metafield definitions
 *  15. Translations
 *  16. Auth enforcement
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
  insertStore,
  isErrorEnvelope,
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

// ── Shared helpers ─────────────────────────────────────────────────────────────

async function setupStore() {
  const userId = randomUUID();
  const orgId = randomUUID();

  // Insert org
  const org = await insertOrg(ctx.pool, { name: `CatalogOrg-${Date.now()}` });

  // Create store via REST (ensures org+userId are tracked)
  const token = await mintJwt({ userId, orgId: org.id });
  const auth = { type: "bearer" as const, token };

  const storeRes = await post(ctx, "/commerce/stores", {
    name: `CatalogStore-${Date.now()}`,
    currency: "USD",
  }, auth);
  expect(storeRes.status).toBe(201);
  const storeId = storeRes.json["id"] as string;

  // Create admin API key
  const adminKey = await createApiKey(ctx, {
    orgId: org.id,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write", "commerce:admin"],
  });
  const adminAuth = { type: "api-key" as const, key: adminKey };

  // Create write API key
  const writeKey = await createApiKey(ctx, {
    orgId: org.id,
    userId,
    storeId,
    type: "private",
    scopes: ["commerce:read", "commerce:write"],
  });
  const writeAuth = { type: "api-key" as const, key: writeKey };

  // Create read (public) API key
  const readKey = await createApiKey(ctx, {
    orgId: org.id,
    userId,
    storeId,
    type: "public",
    scopes: ["commerce:read"],
  });
  const readAuth = { type: "api-key" as const, key: readKey };

  return { storeId, adminAuth, writeAuth, readAuth, org, userId, orgId: org.id };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Products CRUD
// ══════════════════════════════════════════════════════════════════════════════

describe("Products CRUD", () => {
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
  }, 60_000);

  it("POST /products → creates product, returns id", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Test Widget",
      type: "simple",
      status: "active",
    }, writeAuth);
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    productId = res.json["id"] as string;
  });

  it("POST /products → creates product with inline price (auto-variant)", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Product With Price",
      price: "29.99",
    }, writeAuth);
    expect(res.status).toBe(201);
    const pid = res.json["id"] as string;

    // Check that a default variant was created
    const vRes = await get(ctx, `/commerce/stores/${storeId}/products/${pid}/variants`, readAuth);
    expect(vRes.status).toBe(200);
    const variants = vRes.json["variants"] as Array<Record<string, unknown>>;
    expect(variants.length).toBeGreaterThanOrEqual(1);
    expect(variants[0]?.["price"]).toBe("29.99");
  });

  it("GET /products/:productId → returns product with variants+options+media", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/products/${productId}`, readAuth);
    expect(res.status).toBe(200);
    const p = res.json as Record<string, unknown>;
    expect(p["title"]).toBe("Test Widget");
    expect(p["type"]).toBe("simple");
    expect(p["status"]).toBe("active");
    expect(Array.isArray(p["variants"])).toBe(true);
    expect(Array.isArray(p["media"])).toBe(true);
    expect(Array.isArray(p["options"])).toBe(true);
  });

  it("GET /products → lists products with status filter", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products?status=active`,
      readAuth
    );
    expect(res.status).toBe(200);
    const products = res.json["products"] as Array<Record<string, unknown>>;
    expect(Array.isArray(products)).toBe(true);
    expect(products.length).toBeGreaterThanOrEqual(1);
    // All returned products should be active
    for (const p of products) {
      expect(p["status"]).toBe("active");
    }
  });

  it("PUT /products/:productId → updates title", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}`,
      { title: "Updated Widget", status: "archived" },
      writeAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);

    const getRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}`,
      readAuth
    );
    expect(getRes.json["title"]).toBe("Updated Widget");
    expect(getRes.json["status"]).toBe("archived");
  });

  it("DELETE /products/:productId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /products/:productId → 404 on second delete", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}`,
      adminAuth
    );
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Variants
// ══════════════════════════════════════════════════════════════════════════════

describe("Variants", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let productId: string;
  let variantId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Variant Product",
      status: "active",
    }, writeAuth);
    expect(pRes.status).toBe(201);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("POST /variants → creates with price", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/variants`,
      { price: "19.99", title: "Size M", sku: "WIDGET-M" },
      writeAuth
    );
    expect(res.status).toBe(201);
    expect(typeof res.json["id"]).toBe("string");
    variantId = res.json["id"] as string;
  });

  it("POST /variants → 400 without price", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/variants`,
      { title: "No Price Variant" },
      writeAuth
    );
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe("VALIDATION_ERROR");
  });

  it("GET /variants → lists variants", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/variants`,
      readAuth
    );
    expect(res.status).toBe(200);
    const variants = res.json["variants"] as Array<Record<string, unknown>>;
    expect(variants.length).toBeGreaterThanOrEqual(1);
    const v = variants.find((v) => v["id"] === variantId);
    expect(v).toBeDefined();
    expect(v?.["sku"]).toBe("WIDGET-M");
  });

  it("PUT /variants/:variantId → updates price and title", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/variants/${variantId}`,
      { price: "24.99", title: "Size L" },
      writeAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
  });

  it("DELETE /variants/:variantId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/variants/${variantId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Options + values
// ══════════════════════════════════════════════════════════════════════════════

describe("Options + values", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let productId: string;
  let optionId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Option Product",
      status: "active",
    }, writeAuth);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("POST /options → creates with values[]", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/options`,
      { name: "Color", values: ["Red", "Blue", "Green"] },
      writeAuth
    );
    expect(res.status).toBe(201);
    optionId = res.json["id"] as string;
  });

  it("GET /options → lists with values in response", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/options`,
      readAuth
    );
    expect(res.status).toBe(200);
    const options = res.json["options"] as Array<Record<string, unknown>>;
    expect(options.length).toBeGreaterThanOrEqual(1);
    const opt = options.find((o) => o["id"] === optionId) as Record<string, unknown> | undefined;
    expect(opt).toBeDefined();
    const values = opt?.["values"] as Array<Record<string, unknown>>;
    expect(Array.isArray(values)).toBe(true);
    expect(values.length).toBe(3);
  });

  it("DELETE /options/:optionId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/options/${optionId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Media
// ══════════════════════════════════════════════════════════════════════════════

describe("Media", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let productId: string;
  let mediaId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;

    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Media Product",
    }, writeAuth);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("POST /media → adds media", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/media`,
      { url: "https://example.com/image.jpg", type: "image", alt_text: "Main image" },
      writeAuth
    );
    expect(res.status).toBe(201);
    mediaId = res.json["id"] as string;
  });

  it("DELETE /media/:mediaId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/media/${mediaId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });

  it("DELETE /media/:mediaId → 404 on second delete", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/media/${mediaId}`,
      adminAuth
    );
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Bundle items
// ══════════════════════════════════════════════════════════════════════════════

describe("Bundle items", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let bundleProductId: string;
  let variantId: string;
  let itemId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    // Create a bundle product
    const bpRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Bundle Box",
      type: "bundle",
    }, writeAuth);
    bundleProductId = bpRes.json["id"] as string;

    // Create a component product with a variant
    const cpRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Component Widget",
      price: "9.99",
    }, writeAuth);
    const componentPid = cpRes.json["id"] as string;

    // Get the auto-created variant
    const vRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${componentPid}/variants`,
      readAuth
    );
    const variants = vRes.json["variants"] as Array<Record<string, unknown>>;
    variantId = variants[0]?.["id"] as string;
    expect(variantId).toBeTruthy();
  }, 60_000);

  it("POST /bundle-items → adds bundle item", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${bundleProductId}/bundle-items`,
      { variant_id: variantId, quantity: 2 },
      writeAuth
    );
    expect(res.status).toBe(201);
    itemId = res.json["id"] as string;
  });

  it("GET /bundle-items → lists bundle items", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${bundleProductId}/bundle-items`,
      readAuth
    );
    expect(res.status).toBe(200);
    const items = res.json["bundle_items"] as Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    expect(items[0]?.["quantity"]).toBe(2);
  });

  it("PUT /bundle-items/:itemId → updates quantity", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/products/${bundleProductId}/bundle-items/${itemId}`,
      { quantity: 3 },
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("DELETE /bundle-items/:itemId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${bundleProductId}/bundle-items/${itemId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Digital files
// ══════════════════════════════════════════════════════════════════════════════

describe("Digital files", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let productId: string;
  let fileId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Digital Product",
      type: "digital",
    }, writeAuth);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("POST /digital-files → creates file", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/digital-files`,
      {
        name: "User Manual",
        file_url: "https://example.com/manual.pdf",
        mime_type: "application/pdf",
        download_limit: 5,
      },
      writeAuth
    );
    expect(res.status).toBe(201);
    fileId = res.json["id"] as string;
  });

  it("GET /digital-files → lists files", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/digital-files`,
      readAuth
    );
    expect(res.status).toBe(200);
    const files = res.json["files"] as Array<Record<string, unknown>>;
    expect(files.length).toBe(1);
    expect(files[0]?.["name"]).toBe("User Manual");
  });

  it("DELETE /digital-files/:fileId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/digital-files/${fileId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Collections CRUD
// ══════════════════════════════════════════════════════════════════════════════

describe("Collections CRUD", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let collectionId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;
  }, 60_000);

  it("POST /collections → creates collection", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/collections`, {
      title: "Summer Sale",
      description: "Hot deals",
    }, writeAuth);
    expect(res.status).toBe(201);
    collectionId = res.json["id"] as string;
  });

  it("GET /collections → lists collections", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/collections`, readAuth);
    expect(res.status).toBe(200);
    const cols = res.json["collections"] as Array<Record<string, unknown>>;
    expect(cols.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /collections/:collectionId → returns collection", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}`,
      readAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["title"]).toBe("Summer Sale");
  });

  it("PUT /collections/:collectionId → updates title", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}`,
      { title: "Summer Deals" },
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("DELETE /collections/:collectionId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });

  it("DELETE /collections/:collectionId → 404 on second delete", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}`,
      adminAuth
    );
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. Collection products (add / remove)
// ══════════════════════════════════════════════════════════════════════════════

describe("Collection products", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let collectionId: string;
  let productId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    const colRes = await post(ctx, `/commerce/stores/${storeId}/collections`, {
      title: "Test Collection",
    }, writeAuth);
    collectionId = colRes.json["id"] as string;

    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Product In Collection",
      status: "active",
    }, writeAuth);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("POST /collections/:id/products → adds product", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/products`,
      { product_id: productId },
      writeAuth
    );
    expect(res.status).toBe(201);
  });

  it("GET /collections/:id/products → lists collection products", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/products`,
      readAuth
    );
    expect(res.status).toBe(200);
    const products = res.json["products"] as Array<Record<string, unknown>>;
    expect(products.some((p) => p["id"] === productId)).toBe(true);
  });

  it("DELETE /collections/:id/products/:productId → removes product", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/products/${productId}`,
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("Collection products list is empty after removal", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/products`,
      readAuth
    );
    expect(res.status).toBe(200);
    const products = res.json["products"] as Array<Record<string, unknown>>;
    expect(products.some((p) => p["id"] === productId)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. Collection rules + smart membership
// ══════════════════════════════════════════════════════════════════════════════

describe("Collection rules + smart membership", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let collectionId: string;
  let matchingProductId: string;
  let nonMatchingProductId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    // Create smart collection
    const colRes = await post(ctx, `/commerce/stores/${storeId}/collections`, {
      title: "Smart Widgets",
    }, writeAuth);
    collectionId = colRes.json["id"] as string;

    // Create matching product (status=active, title contains 'Widget')
    const mpRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Blue Widget Pro",
      status: "active",
    }, writeAuth);
    matchingProductId = mpRes.json["id"] as string;

    // Create non-matching product
    const npRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Simple Tee",
      status: "active",
    }, writeAuth);
    nonMatchingProductId = npRes.json["id"] as string;

    // Add rule: title contains 'Widget'
    await post(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/rules`,
      { field: "title", relation: "contains", value: "Widget" },
      writeAuth
    );
  }, 60_000);

  it("Collection has is_smart=true after adding rule", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}`,
      readAuth
    );
    expect(res.status).toBe(200);
    expect(res.json["is_smart"]).toBe(true);
  });

  it("Matching product appears in smart collection", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/products`,
      readAuth
    );
    expect(res.status).toBe(200);
    const products = res.json["products"] as Array<Record<string, unknown>>;
    expect(products.some((p) => p["id"] === matchingProductId)).toBe(true);
  });

  it("Non-matching product NOT in smart collection", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/products`,
      readAuth
    );
    const products = res.json["products"] as Array<Record<string, unknown>>;
    expect(products.some((p) => p["id"] === nonMatchingProductId)).toBe(false);
  });

  it("GET /rules → lists rules", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/rules`,
      readAuth
    );
    expect(res.status).toBe(200);
    const rules = res.json["rules"] as Array<Record<string, unknown>>;
    expect(rules.length).toBe(1);
    expect(rules[0]?.["field"]).toBe("title");
    expect(rules[0]?.["relation"]).toBe("contains");
    expect(rules[0]?.["value"]).toBe("Widget");
  });

  it("DELETE /rules/:ruleId → removes rule and refreshes membership", async () => {
    const rulesRes = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/rules`,
      readAuth
    );
    const ruleId = (rulesRes.json["rules"] as Array<Record<string, unknown>>)[0]?.["id"] as string;

    const delRes = await del(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/rules/${ruleId}`,
      adminAuth
    );
    expect(delRes.status).toBe(200);

    // After deletion, no products should be in the collection
    const prodRes = await get(
      ctx,
      `/commerce/stores/${storeId}/collections/${collectionId}/products`,
      readAuth
    );
    const products = prodRes.json["products"] as Array<Record<string, unknown>>;
    expect(products.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. Product tags
// ══════════════════════════════════════════════════════════════════════════════

describe("Product tags", () => {
  let storeId: string;
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let productId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Tagged Product",
    }, writeAuth);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("GET /tags → empty initially", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/tags`,
      readAuth
    );
    expect(res.status).toBe(200);
    expect((res.json["tags"] as string[]).length).toBe(0);
  });

  it("PUT /tags → sets tags (lowercase, trimmed)", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/tags`,
      { tags: ["Sale", "  Trending  ", "NEW"] },
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("GET /tags → returns normalized tags", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/tags`,
      readAuth
    );
    expect(res.status).toBe(200);
    const tags = res.json["tags"] as string[];
    expect(tags).toContain("sale");
    expect(tags).toContain("trending");
    expect(tags).toContain("new");
  });

  it("PUT /tags → overwrites all tags", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/tags`,
      { tags: ["clearance"] },
      writeAuth
    );
    expect(res.status).toBe(200);

    const getRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/tags`,
      readAuth
    );
    const tags = getRes.json["tags"] as string[];
    expect(tags.length).toBe(1);
    expect(tags).toContain("clearance");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. Reviews
// ══════════════════════════════════════════════════════════════════════════════

describe("Reviews", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let productId: string;
  let reviewId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Reviewable Product",
      status: "active",
    }, writeAuth);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("POST /reviews → creates review (pending by default)", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews`,
      {
        rating: 5,
        title: "Great product!",
        body: "I love it.",
        reviewer_name: "Alice",
      },
      writeAuth
    );
    expect(res.status).toBe(201);
    reviewId = res.json["id"] as string;
  });

  it("GET /reviews → default status=approved → empty (review is pending)", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews`,
      readAuth
    );
    expect(res.status).toBe(200);
    const reviews = res.json["reviews"] as Array<Record<string, unknown>>;
    // Pending review should not appear in approved list
    expect(reviews.some((r) => r["id"] === reviewId)).toBe(false);
  });

  it("GET /reviews?status=pending → lists pending review", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews?status=pending`,
      readAuth
    );
    expect(res.status).toBe(200);
    const reviews = res.json["reviews"] as Array<Record<string, unknown>>;
    expect(reviews.some((r) => r["id"] === reviewId)).toBe(true);
  });

  it("PUT /reviews/:reviewId → admin updates status to approved", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/reviews/${reviewId}`,
      { status: "approved", reply: "Thank you for your feedback!" },
      adminAuth
    );
    expect(res.status).toBe(200);
  });

  it("GET /reviews → now appears in approved list", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}/reviews`,
      readAuth
    );
    const reviews = res.json["reviews"] as Array<Record<string, unknown>>;
    expect(reviews.some((r) => r["id"] === reviewId)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. Price lists + items
// ══════════════════════════════════════════════════════════════════════════════

describe("Price lists + items", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let listId: string;
  let variantId: string;
  let itemId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;

    // Create a product with a variant
    const pRes = await post(ctx, `/commerce/stores/${storeId}/products`, {
      title: "Price Test Product",
      price: "50.00",
    }, writeAuth);
    const pid = pRes.json["id"] as string;
    const vRes = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${pid}/variants`,
      readAuth
    );
    variantId = (vRes.json["variants"] as Array<Record<string, unknown>>)[0]?.["id"] as string;
  }, 60_000);

  it("POST /price-lists → creates list", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/price-lists`, {
      name: "Wholesale List",
      currency: "USD",
      type: "wholesale",
    }, writeAuth);
    expect(res.status).toBe(201);
    listId = res.json["id"] as string;
  });

  it("GET /price-lists → lists price lists", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/price-lists`, readAuth);
    expect(res.status).toBe(200);
    const pls = res.json["price_lists"] as Array<Record<string, unknown>>;
    expect(pls.some((pl) => pl["id"] === listId)).toBe(true);
  });

  it("GET /price-lists/:listId → get list", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/price-lists/${listId}`, readAuth);
    expect(res.status).toBe(200);
    expect(res.json["name"]).toBe("Wholesale List");
  });

  it("PUT /price-lists/:listId → update name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/price-lists/${listId}`,
      { name: "B2B Wholesale" },
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("POST /price-lists/:listId/items → upsert item", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/price-lists/${listId}/items`,
      { variant_id: variantId, price: "40.00" },
      writeAuth
    );
    expect(res.status).toBe(201);
    itemId = res.json["id"] as string;
  });

  it("GET /price-lists/:listId/items → lists items", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/price-lists/${listId}/items`,
      readAuth
    );
    expect(res.status).toBe(200);
    const items = res.json["items"] as Array<Record<string, unknown>>;
    expect(items.some((i) => i["id"] === itemId)).toBe(true);
    expect(items.find((i) => i["id"] === itemId)?.["price"]).toBe("40.00");
  });

  it("PUT /price-lists/:listId/items/:itemId → updates price", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/price-lists/${listId}/items/${itemId}`,
      { price: "35.00" },
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("POST /items upsert → updates price on conflict", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/price-lists/${listId}/items`,
      { variant_id: variantId, price: "45.00" },
      writeAuth
    );
    expect(res.status).toBe(201);
    // Should return same id (upsert)
    expect(res.json["id"]).toBe(itemId);
  });

  it("DELETE /items/:itemId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/price-lists/${listId}/items/${itemId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });

  it("DELETE /price-lists/:listId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/price-lists/${listId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 13. Metafields
// ══════════════════════════════════════════════════════════════════════════════

describe("Metafields", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let metafieldId: string;
  const ownerId = randomUUID();

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;
  }, 60_000);

  it("POST /metafields → upsert creates metafield", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/metafields`, {
      owner_resource: "product",
      owner_id: ownerId,
      namespace: "custom",
      key: "color",
      value: "blue",
      type: "string",
    }, writeAuth);
    expect(res.status).toBe(201);
    metafieldId = res.json["id"] as string;
  });

  it("GET /metafields → lists with filter", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/metafields?owner_resource=product&owner_id=${ownerId}`,
      readAuth
    );
    expect(res.status).toBe(200);
    const mfs = res.json["metafields"] as Array<Record<string, unknown>>;
    expect(mfs.length).toBeGreaterThanOrEqual(1);
    expect(mfs.some((m) => m["id"] === metafieldId)).toBe(true);
  });

  it("PUT /metafields/:id → updates value", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/metafields/${metafieldId}`,
      { value: "red" },
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("POST /metafields → upsert updates existing on conflict", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/metafields`, {
      owner_resource: "product",
      owner_id: ownerId,
      namespace: "custom",
      key: "color",
      value: "green",
    }, writeAuth);
    expect(res.status).toBe(201);
    // Should return same id (upsert)
    expect(res.json["id"]).toBe(metafieldId);
  });

  it("DELETE /metafields/:id → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/metafields/${metafieldId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 14. Metafield definitions
// ══════════════════════════════════════════════════════════════════════════════

describe("Metafield definitions", () => {
  let storeId: string;
  let adminAuth: { type: "api-key"; key: string };
  let writeAuth: { type: "api-key"; key: string };
  let readAuth: { type: "api-key"; key: string };
  let defId: string;

  beforeAll(async () => {
    const s = await setupStore();
    storeId = s.storeId;
    adminAuth = s.adminAuth;
    writeAuth = s.writeAuth;
    readAuth = s.readAuth;
  }, 60_000);

  it("POST /metafield-definitions → creates definition", async () => {
    const res = await post(ctx, `/commerce/stores/${storeId}/metafield-definitions`, {
      name: "Product Color",
      namespace: "custom",
      key: "color",
      owner_resource: "product",
      type: "string",
    }, writeAuth);
    expect(res.status).toBe(201);
    defId = res.json["id"] as string;
  });

  it("GET /metafield-definitions → lists definitions", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/metafield-definitions`, readAuth);
    expect(res.status).toBe(200);
    const defs = res.json["definitions"] as Array<Record<string, unknown>>;
    expect(defs.some((d) => d["id"] === defId)).toBe(true);
  });

  it("PUT /metafield-definitions/:defId → updates name", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/metafield-definitions/${defId}`,
      { name: "Color Attribute" },
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("DELETE /metafield-definitions/:defId → 200 ok", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/metafield-definitions/${defId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 15. Translations
// ══════════════════════════════════════════════════════════════════════════════

describe("Translations", () => {
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
      title: "Translatable Product",
    }, writeAuth);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("PUT /translations/product/:id/fr → upserts translation", async () => {
    const res = await put(
      ctx,
      `/commerce/stores/${storeId}/translations/product/${productId}/fr`,
      { fields: { title: "Produit Traduisible", description: "Une description en français" } },
      writeAuth
    );
    expect(res.status).toBe(200);
  });

  it("GET /translations/product/:id → lists all locales", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/translations/product/${productId}`,
      readAuth
    );
    expect(res.status).toBe(200);
    const translations = res.json["translations"] as Array<Record<string, unknown>>;
    const fr = translations.find((t) => t["locale"] === "fr") as Record<string, unknown> | undefined;
    expect(fr).toBeDefined();
    const fields = fr?.["fields"] as Record<string, unknown>;
    expect(fields?.["title"]).toBe("Produit Traduisible");
  });

  it("DELETE /translations/product/:id/fr → deletes locale", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/translations/product/${productId}/fr`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });

  it("Translations list empty after deletion", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/translations/product/${productId}`,
      readAuth
    );
    const translations = res.json["translations"] as Array<Record<string, unknown>>;
    expect(translations.find((t) => t["locale"] === "fr")).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 16. Auth enforcement
// ══════════════════════════════════════════════════════════════════════════════

describe("Auth enforcement", () => {
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
      title: "Auth Test Product",
      status: "active",
    }, writeAuth);
    productId = pRes.json["id"] as string;
  }, 60_000);

  it("Read endpoints accessible with cc_pub_ key", async () => {
    const res = await get(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}`,
      readAuth
    );
    expect(res.status).toBe(200);
  });

  it("List products accessible with cc_pub_ key", async () => {
    const res = await get(ctx, `/commerce/stores/${storeId}/products`, readAuth);
    expect(res.status).toBe(200);
  });

  it("Write endpoints reject cc_pub_ key with 403", async () => {
    const res = await post(
      ctx,
      `/commerce/stores/${storeId}/products`,
      { title: "Should Fail" },
      readAuth
    );
    expect(res.status).toBe(403);
  });

  it("Admin DELETE rejects cc_prv_ with only commerce:write scope", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}`,
      writeAuth
    );
    expect(res.status).toBe(403);
  });

  it("Admin DELETE succeeds with commerce:admin scope", async () => {
    const res = await del(
      ctx,
      `/commerce/stores/${storeId}/products/${productId}`,
      adminAuth
    );
    expect(res.status).toBe(200);
  });
});
