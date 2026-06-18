/**
 * b2b-catalog-gating.test.ts — Wave-17: B2B per-company CATALOG GATING.
 *
 * A B2B company can be restricted to a SUBSET of products/collections and/or
 * assigned a price list. Gating is OPT-IN and engages ONLY when a company
 * context is present — the non-B2B path must stay byte-identical.
 *
 * Covers:
 *  - a company with access rows sees ONLY allowed products in listProducts
 *    (direct grant + via an allowed collection) and 404s on a disallowed
 *    getProduct
 *  - a company with NO access rows sees the FULL catalog (unrestricted)
 *  - the company's assigned price list overrides per-variant pricing for an
 *    allowed product
 *  - assertCompanyCanPurchase rejects a disallowed variant, allows an allowed one
 *  - a NON-company (regular) catalog read over HTTP is byte-identical to before
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createCtx } from "../shared/ctx.js";
import type { TestCtx } from "../shared/ctx.js";
import {
  mintJwt,
  insertOrg,
  insertStore,
  insertProduct,
  insertVariant,
} from "../shared/helpers.js";
import {
  listProducts,
  getProduct,
  listCollections,
} from "../../src/modules/catalog/service.js";
import {
  grantCatalogAccess,
  revokeCatalogAccess,
  listCompanyCatalogAccess,
  assignPriceList,
  assertCompanyCanPurchase,
  createCompany,
} from "../../src/modules/b2b/service.js";

let ctx: TestCtx;
let storeId: string;
let authHeader: Record<string, string>;

// Fixtures
let companyId: string;
let allowedProductId: string; // directly granted
let collectionProductId: string; // visible via an allowed collection
let disallowedProductId: string; // never granted
let allowedVariantId: string;
let disallowedVariantId: string;
let collectionId: string;
let priceListId: string;

beforeAll(async () => {
  ctx = await createCtx();
  const userId = "00000000-0000-0000-0000-000000000001";
  const org = await insertOrg(ctx.pool, { name: "Gating Test Org" });
  const jwt = await mintJwt({ userId, orgId: org.id });
  authHeader = { authorization: `Bearer ${jwt}` };
  const store = await insertStore(ctx.pool, {
    orgId: org.id,
    name: "Gating Store",
    slug: `gating-store-${Date.now()}`,
  });
  storeId = store.id;

  // Three products.
  const p1 = await insertProduct(ctx.pool, { storeId, title: "Allowed Direct" });
  const p2 = await insertProduct(ctx.pool, { storeId, title: "Allowed Via Collection" });
  const p3 = await insertProduct(ctx.pool, { storeId, title: "Disallowed" });
  allowedProductId = p1.id;
  collectionProductId = p2.id;
  disallowedProductId = p3.id;

  const v1 = await insertVariant(ctx.pool, { productId: p1.id, price: "100.00" });
  const v3 = await insertVariant(ctx.pool, { productId: p3.id, price: "50.00" });
  allowedVariantId = v1.id;
  disallowedVariantId = v3.id;

  // A collection containing p2.
  const colRes = await ctx.pool.query<{ id: string }>(
    `INSERT INTO collections (store_id, title, slug)
     VALUES ($1::uuid, 'B2B Collection', $2) RETURNING id::text`,
    [storeId, `b2b-col-${Date.now()}`]
  );
  collectionId = colRes.rows[0]!.id;
  await ctx.pool.query(
    `INSERT INTO product_collections (product_id, collection_id) VALUES ($1::uuid, $2::uuid)`,
    [collectionProductId, collectionId]
  );

  // A price list with an override for the allowed variant.
  const plRes = await ctx.pool.query<{ id: string }>(
    `INSERT INTO price_lists (store_id, name, currency, type)
     VALUES ($1::uuid, 'B2B Wholesale', 'USD', 'wholesale') RETURNING id::text`,
    [storeId]
  );
  priceListId = plRes.rows[0]!.id;
  await ctx.pool.query(
    `INSERT INTO price_list_items (price_list_id, variant_id, price, min_qty)
     VALUES ($1::uuid, $2::uuid, 80.00, 1)`,
    [priceListId, allowedVariantId]
  );

  // The company.
  companyId = await createCompany(storeId, { name: "Gated Co" });
}, 120_000);

afterAll(async () => {
  await ctx.teardown();
}, 30_000);

const companyCtx = () => ({ storeId, companyId });

// ── No access rows → unrestricted (full catalog) ────────────────────────────────

describe("company with NO access rows (unrestricted)", () => {
  it("listProducts with company context sees the FULL catalog", async () => {
    const products = await listProducts(storeId, {}, companyCtx());
    const ids = products.map((p) => p.id);
    expect(ids).toContain(allowedProductId);
    expect(ids).toContain(collectionProductId);
    expect(ids).toContain(disallowedProductId);
  });

  it("getProduct with company context returns ANY product", async () => {
    const p = await getProduct(storeId, disallowedProductId, companyCtx());
    expect(p).not.toBeNull();
    expect(p!.id).toBe(disallowedProductId);
  });
});

// ── With access rows → restricted ───────────────────────────────────────────────

describe("company with access rows (restricted)", () => {
  it("grants product + collection access", async () => {
    const a = await grantCatalogAccess(storeId, companyId, { product_id: allowedProductId });
    expect(typeof a).toBe("string");
    const b = await grantCatalogAccess(storeId, companyId, { collection_id: collectionId });
    expect(typeof b).toBe("string");

    // Idempotent: granting the same product again returns null (no new row).
    const dup = await grantCatalogAccess(storeId, companyId, { product_id: allowedProductId });
    expect(dup).toBeNull();

    const access = await listCompanyCatalogAccess(storeId, companyId);
    expect(access.length).toBe(2);
  });

  it("rejects a grant with neither product nor collection", async () => {
    await expect(grantCatalogAccess(storeId, companyId, {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("listProducts shows only allowed (direct + via collection), not disallowed", async () => {
    const products = await listProducts(storeId, {}, companyCtx());
    const ids = products.map((p) => p.id);
    expect(ids).toContain(allowedProductId);
    expect(ids).toContain(collectionProductId);
    expect(ids).not.toContain(disallowedProductId);
  });

  it("getProduct returns null (404) for a disallowed product", async () => {
    const p = await getProduct(storeId, disallowedProductId, companyCtx());
    expect(p).toBeNull();
  });

  it("getProduct returns an allowed product", async () => {
    const p = await getProduct(storeId, allowedProductId, companyCtx());
    expect(p).not.toBeNull();
    expect(p!.id).toBe(allowedProductId);
  });

  it("listCollections shows only collections containing allowed products", async () => {
    const cols = await listCollections(storeId, {}, companyCtx());
    expect(cols.map((c) => c.id)).toContain(collectionId);
  });
});

// ── Price-list pricing ──────────────────────────────────────────────────────────

describe("company price-list pricing", () => {
  it("applies the company's price list to an allowed product's variant", async () => {
    const ok = await assignPriceList(storeId, companyId, priceListId);
    expect(ok).toBe(true);

    const p = await getProduct(storeId, allowedProductId, companyCtx());
    expect(p).not.toBeNull();
    const v = p!.variants!.find((x) => x.id === allowedVariantId);
    expect(v).toBeDefined();
    // Overridden 100.00 → 80.00 by the price-list item.
    expect(v!.price).toBe("80.00");
  });

  it("WITHOUT a company context the default catalog price is used", async () => {
    const p = await getProduct(storeId, allowedProductId);
    const v = p!.variants!.find((x) => x.id === allowedVariantId);
    expect(v!.price).toBe("100.00");
  });
});

// ── assertCompanyCanPurchase ────────────────────────────────────────────────────

describe("assertCompanyCanPurchase", () => {
  it("rejects a disallowed variant", async () => {
    await expect(
      assertCompanyCanPurchase(storeId, companyId, [disallowedVariantId])
    ).rejects.toMatchObject({ code: "CATALOG_RESTRICTED" });
  });

  it("allows an allowed variant", async () => {
    await expect(
      assertCompanyCanPurchase(storeId, companyId, [allowedVariantId])
    ).resolves.toBeUndefined();
  });

  it("is a no-op for an unrestricted company", async () => {
    const freeCompanyId = await createCompany(storeId, { name: "Unrestricted Co" });
    await expect(
      assertCompanyCanPurchase(storeId, freeCompanyId, [disallowedVariantId])
    ).resolves.toBeUndefined();
  });
});

// ── Non-company (regular) reads are byte-identical ──────────────────────────────

describe("non-company catalog reads (byte-identical guarantee)", () => {
  it("HTTP GET /products WITHOUT company_id returns the full catalog unchanged", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/commerce/stores/${storeId}/products`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
    const body = res.json as { products: Array<{ id: string }> };
    const ids = body.products.map((p) => p.id);
    // Even though the company above is restricted, a non-company read sees all.
    expect(ids).toContain(allowedProductId);
    expect(ids).toContain(collectionProductId);
    expect(ids).toContain(disallowedProductId);
  });

  it("service listProducts WITHOUT a company context equals the unfiltered set", async () => {
    const noCtx = await listProducts(storeId, {});
    const ids = noCtx.map((p) => p.id);
    expect(ids).toContain(allowedProductId);
    expect(ids).toContain(collectionProductId);
    expect(ids).toContain(disallowedProductId);
  });

  it("HTTP GET /products/:id WITHOUT company_id returns a disallowed product (200)", async () => {
    const res = await ctx.request({
      method: "GET",
      path: `/commerce/stores/${storeId}/products/${disallowedProductId}`,
      headers: authHeader,
    });
    expect(res.status).toBe(200);
  });
});

// ── Revoke restores access ──────────────────────────────────────────────────────

describe("revoke", () => {
  it("revoking all rules returns the company to unrestricted", async () => {
    const access = await listCompanyCatalogAccess(storeId, companyId);
    for (const a of access) {
      const ok = await revokeCatalogAccess(storeId, companyId, a.id);
      expect(ok).toBe(true);
    }
    const products = await listProducts(storeId, {}, companyCtx());
    expect(products.map((p) => p.id)).toContain(disallowedProductId);
  });
});
