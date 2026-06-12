/**
 * catalog/routes.ts — Fastify plugin for the catalog module.
 *
 * Auth tiers:
 *   read  → storeAuthRead  (cc_pub_ / cc_prv_ commerce:read / JWT)
 *   write → storeAuthWrite (cc_prv_ commerce:write+ / JWT)
 *   admin → storeAuthAdmin (cc_prv_ commerce:admin / JWT)
 *
 * All routes prefixed with /commerce/stores/:storeId/...
 * Money: prices received as strings, validated with zod.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  storeAuthRead,
  storeAuthWrite,
  storeAuthAdmin,
} from "../../lib/auth/middleware.js";
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  listVariants,
  createVariant,
  updateVariant,
  deleteVariant,
  listOptions,
  createOption,
  deleteOption,
  addMedia,
  deleteMedia,
  listBundleItems,
  addBundleItem,
  updateBundleItem,
  deleteBundleItem,
  listDigitalFiles,
  createDigitalFile,
  deleteDigitalFile,
  listReviews,
  createReview,
  updateReview,
  getProductTags,
  setProductTags,
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addProductToCollection,
  removeProductFromCollection,
  getCollectionProducts,
  listCollectionRules,
  addCollectionRule,
  deleteCollectionRule,
  listPriceLists,
  getPriceList,
  createPriceList,
  updatePriceList,
  deletePriceList,
  listPriceListItems,
  upsertPriceListItem,
  updatePriceListItem,
  deletePriceListItem,
  listMetafields,
  upsertMetafield,
  updateMetafield,
  deleteMetafield,
  listMetafieldDefinitions,
  createMetafieldDefinition,
  updateMetafieldDefinition,
  deleteMetafieldDefinition,
  listTranslations,
  upsertTranslation,
  deleteTranslation,
} from "./service.js";

// ── Zod helpers ───────────────────────────────────────────────────────────────

const UUID = z.string().uuid();

const PriceStr = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "price must be a valid decimal (e.g. '9.99')");

const PricePositive = PriceStr.refine((v) => parseFloat(v) > 0, {
  message: "price must be greater than 0",
});

const SlugStr = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric + hyphens only");

const ProductTypeEnum = z.enum([
  "simple",
  "bundle",
  "configurable",
  "digital",
  "service",
  "subscription",
  "rental",
]);

const ProductStatusEnum = z.enum(["draft", "active", "archived"]);

const MediaTypeEnum = z.enum(["image", "video", "3d_model"]);

const RuleFieldEnum = z.enum(["title", "vendor", "status", "type", "tag"]);

const RuleRelationEnum = z.enum([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "greater_than",
  "less_than",
]);

const MetafieldTypeEnum = z.enum([
  "string",
  "integer",
  "boolean",
  "json",
  "date",
  "url",
]);

const PriceListTypeEnum = z.enum([
  "retail",
  "wholesale",
  "vip",
  "staff",
  "custom",
]);

const ReviewStatusEnum = z.enum(["pending", "approved", "rejected"]);

const TranslationResourceTypeEnum = z.enum([
  "product",
  "variant",
  "option",
  "option_value",
  "collection",
]);

// ── Error helpers ──────────────────────────────────────────────────────────────

function validationError(
  details: unknown
): { error: { code: string; message: string; details: unknown } } {
  return {
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details,
    },
  };
}

function notFound(msg: string): { error: { code: string; message: string } } {
  return { error: { code: "NOT_FOUND", message: msg } };
}

function isDuplicateSlugError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "DUPLICATE_SLUG"
  );
}

function isNotFoundError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "NOT_FOUND"
  );
}

const StoreParams = z.object({
  storeId: UUID,
});

const ProductParams = z.object({
  storeId: UUID,
  productId: UUID,
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const catalogPlugin: FastifyPluginAsync = async (app) => {
  // ══════════════════════════════════════════════════════════════════════════
  // PRODUCTS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products
  app.get(
    "/commerce/stores/:storeId/products",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const q = z
        .object({
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .safeParse(request.query);

      const products = await listProducts(params.data.storeId, q.success ? q.data : {});
      return reply.send({ products });
    }
  );

  // POST /commerce/stores/:storeId/products
  app.post(
    "/commerce/stores/:storeId/products",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        title: z.string().min(1).max(500),
        slug: SlugStr.optional(),
        description: z.string().optional(),
        type: ProductTypeEnum.optional(),
        status: ProductStatusEnum.optional(),
        vendor: z.string().optional(),
        seo_title: z.string().optional(),
        seo_desc: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        price: PricePositive.optional(),
        images: z.array(z.string().url()).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await createProduct(params.data.storeId, parsed.data);
        return reply.status(201).send({ id });
      } catch (err) {
        if (isDuplicateSlugError(err)) {
          return reply.status(409).send({
            error: {
              code: "DUPLICATE_SLUG",
              message: (err as Error).message,
            },
          });
        }
        throw err;
      }
    }
  );

  // GET /commerce/stores/:storeId/products/:productId
  app.get(
    "/commerce/stores/:storeId/products/:productId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const product = await getProduct(params.data.storeId, params.data.productId);
      if (!product) return reply.status(404).send(notFound("product not found"));
      return reply.send(product);
    }
  );

  // PUT /commerce/stores/:storeId/products/:productId
  app.put(
    "/commerce/stores/:storeId/products/:productId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        title: z.string().min(1).max(500).optional(),
        slug: SlugStr.optional(),
        description: z.string().optional(),
        type: ProductTypeEnum.optional(),
        status: ProductStatusEnum.optional(),
        vendor: z.string().optional(),
        seo_title: z.string().optional(),
        seo_desc: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const updated = await updateProduct(
          params.data.storeId,
          params.data.productId,
          parsed.data
        );
        if (!updated) return reply.status(404).send(notFound("product not found"));
        return reply.send({ ok: true });
      } catch (err) {
        if (isDuplicateSlugError(err)) {
          return reply.status(409).send({
            error: { code: "DUPLICATE_SLUG", message: (err as Error).message },
          });
        }
        throw err;
      }
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId
  app.delete(
    "/commerce/stores/:storeId/products/:productId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteProduct(params.data.storeId, params.data.productId);
      if (!deleted) return reply.status(404).send(notFound("product not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // VARIANTS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products/:productId/variants
  app.get(
    "/commerce/stores/:storeId/products/:productId/variants",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const variants = await listVariants(params.data.storeId, params.data.productId);
      return reply.send({ variants });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/variants
  app.post(
    "/commerce/stores/:storeId/products/:productId/variants",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        sku: z.string().optional(),
        barcode: z.string().optional(),
        title: z.string().optional(),
        price: PricePositive,
        compare_at_price: PriceStr.optional(),
        cost_price: PriceStr.optional(),
        weight_g: z.number().int().min(0).optional(),
        requires_shipping: z.boolean().optional(),
        is_taxable: z.boolean().optional(),
        track_inventory: z.boolean().optional(),
        allow_backorder: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
        is_active: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        inventory_quantity: z.number().int().min(0).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await createVariant(
          params.data.storeId,
          params.data.productId,
          parsed.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // PUT /commerce/stores/:storeId/products/:productId/variants/:variantId
  app.put(
    "/commerce/stores/:storeId/products/:productId/variants/:variantId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, productId: UUID, variantId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        sku: z.string().optional(),
        barcode: z.string().optional(),
        title: z.string().optional(),
        price: PricePositive.optional(),
        compare_at_price: PriceStr.optional(),
        cost_price: PriceStr.optional(),
        weight_g: z.number().int().min(0).optional(),
        requires_shipping: z.boolean().optional(),
        is_taxable: z.boolean().optional(),
        track_inventory: z.boolean().optional(),
        allow_backorder: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
        is_active: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const updated = await updateVariant(
        params.data.storeId,
        params.data.productId,
        params.data.variantId,
        parsed.data
      );
      if (!updated) return reply.status(404).send(notFound("variant not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId/variants/:variantId
  app.delete(
    "/commerce/stores/:storeId/products/:productId/variants/:variantId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, productId: UUID, variantId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteVariant(
        params.data.storeId,
        params.data.productId,
        params.data.variantId
      );
      if (!deleted) return reply.status(404).send(notFound("variant not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // OPTIONS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products/:productId/options
  app.get(
    "/commerce/stores/:storeId/products/:productId/options",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const options = await listOptions(params.data.storeId, params.data.productId);
      return reply.send({ options });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/options
  app.post(
    "/commerce/stores/:storeId/products/:productId/options",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        name: z.string().min(1),
        values: z.array(z.string()).optional(),
        position: z.number().int().min(0).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await createOption(
          params.data.storeId,
          params.data.productId,
          parsed.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId/options/:optionId
  app.delete(
    "/commerce/stores/:storeId/products/:productId/options/:optionId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, productId: UUID, optionId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteOption(
        params.data.storeId,
        params.data.productId,
        params.data.optionId
      );
      if (!deleted) return reply.status(404).send(notFound("option not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // MEDIA
  // ══════════════════════════════════════════════════════════════════════════

  // POST /commerce/stores/:storeId/products/:productId/media
  app.post(
    "/commerce/stores/:storeId/products/:productId/media",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        url: z.string().url("url is required and must be a valid URL"),
        type: MediaTypeEnum.optional(),
        variant_id: UUID.optional(),
        alt_text: z.string().optional(),
        position: z.number().int().min(0).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await addMedia(
          params.data.storeId,
          params.data.productId,
          parsed.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId/media/:mediaId
  app.delete(
    "/commerce/stores/:storeId/products/:productId/media/:mediaId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, productId: UUID, mediaId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteMedia(
        params.data.storeId,
        params.data.productId,
        params.data.mediaId
      );
      if (!deleted) return reply.status(404).send(notFound("media not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // BUNDLE ITEMS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products/:productId/bundle-items
  app.get(
    "/commerce/stores/:storeId/products/:productId/bundle-items",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const items = await listBundleItems(params.data.storeId, params.data.productId);
      return reply.send({ bundle_items: items });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/bundle-items
  app.post(
    "/commerce/stores/:storeId/products/:productId/bundle-items",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        variant_id: UUID,
        quantity: z.number().int().min(1).optional(),
        is_optional: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await addBundleItem(
          params.data.storeId,
          params.data.productId,
          parsed.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // PUT /commerce/stores/:storeId/products/:productId/bundle-items/:itemId
  app.put(
    "/commerce/stores/:storeId/products/:productId/bundle-items/:itemId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, productId: UUID, itemId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        quantity: z.number().int().min(1).optional(),
        is_optional: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const updated = await updateBundleItem(
        params.data.storeId,
        params.data.productId,
        params.data.itemId,
        parsed.data
      );
      if (!updated) return reply.status(404).send(notFound("bundle item not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId/bundle-items/:itemId
  app.delete(
    "/commerce/stores/:storeId/products/:productId/bundle-items/:itemId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, productId: UUID, itemId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteBundleItem(
        params.data.storeId,
        params.data.productId,
        params.data.itemId
      );
      if (!deleted) return reply.status(404).send(notFound("bundle item not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // DIGITAL FILES
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products/:productId/digital-files
  app.get(
    "/commerce/stores/:storeId/products/:productId/digital-files",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const files = await listDigitalFiles(params.data.storeId, params.data.productId);
      return reply.send({ files });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/digital-files
  app.post(
    "/commerce/stores/:storeId/products/:productId/digital-files",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        name: z.string().min(1),
        file_url: z.string().url(),
        variant_id: UUID.optional(),
        file_size: z.number().int().min(0).optional(),
        mime_type: z.string().optional(),
        version: z.string().optional(),
        download_limit: z.number().int().min(0).optional(),
        is_active: z.boolean().optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await createDigitalFile(
          params.data.storeId,
          params.data.productId,
          parsed.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId/digital-files/:fileId
  app.delete(
    "/commerce/stores/:storeId/products/:productId/digital-files/:fileId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, productId: UUID, fileId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteDigitalFile(
        params.data.storeId,
        params.data.productId,
        params.data.fileId
      );
      if (!deleted) return reply.status(404).send(notFound("digital file not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // REVIEWS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products/:productId/reviews
  app.get(
    "/commerce/stores/:storeId/products/:productId/reviews",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const q = z
        .object({
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .safeParse(request.query);

      const reviews = await listReviews(
        params.data.storeId,
        params.data.productId,
        q.success ? q.data : {}
      );
      return reply.send({ reviews });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/reviews
  app.post(
    "/commerce/stores/:storeId/products/:productId/reviews",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        rating: z.number().int().min(1).max(5),
        title: z.string().optional(),
        body: z.string().optional(),
        reviewer_name: z.string().optional(),
        reviewer_email: z.string().email().optional(),
        customer_id: UUID.optional(),
        order_id: UUID.optional(),
        media_urls: z.unknown().optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await createReview(
          params.data.storeId,
          params.data.productId,
          parsed.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // PUT /commerce/stores/:storeId/reviews/:reviewId
  app.put(
    "/commerce/stores/:storeId/reviews/:reviewId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, reviewId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        status: ReviewStatusEnum.optional(),
        reply: z.string().optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const updated = await updateReview(
        params.data.storeId,
        params.data.reviewId,
        parsed.data
      );
      if (!updated) return reply.status(404).send(notFound("review not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PRODUCT TAGS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products/:productId/tags
  app.get(
    "/commerce/stores/:storeId/products/:productId/tags",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const tags = await getProductTags(params.data.storeId, params.data.productId);
      return reply.send({ tags });
    }
  );

  // PUT /commerce/stores/:storeId/products/:productId/tags
  app.put(
    "/commerce/stores/:storeId/products/:productId/tags",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = ProductParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        tags: z.array(z.string()),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        await setProductTags(params.data.storeId, params.data.productId, parsed.data.tags);
        return reply.send({ ok: true });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // COLLECTIONS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/collections
  app.get(
    "/commerce/stores/:storeId/collections",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const q = PaginationQuery.safeParse(request.query);
      const collections = await listCollections(
        params.data.storeId,
        q.success ? q.data : {}
      );
      return reply.send({ collections });
    }
  );

  // POST /commerce/stores/:storeId/collections
  app.post(
    "/commerce/stores/:storeId/collections",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        title: z.string().min(1),
        slug: SlugStr.optional(),
        description: z.string().optional(),
        parent_id: UUID.optional(),
        image_url: z.string().url().optional(),
        seo_title: z.string().optional(),
        seo_desc: z.string().optional(),
        sort_order: z.string().optional(),
        is_active: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await createCollection(params.data.storeId, parsed.data);
        return reply.status(201).send({ id });
      } catch (err) {
        if (isDuplicateSlugError(err)) {
          return reply.status(409).send({
            error: { code: "DUPLICATE_SLUG", message: (err as Error).message },
          });
        }
        throw err;
      }
    }
  );

  // GET /commerce/stores/:storeId/collections/:collectionId
  app.get(
    "/commerce/stores/:storeId/collections/:collectionId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const collection = await getCollection(params.data.storeId, params.data.collectionId);
      if (!collection) return reply.status(404).send(notFound("collection not found"));
      return reply.send(collection);
    }
  );

  // PUT /commerce/stores/:storeId/collections/:collectionId
  app.put(
    "/commerce/stores/:storeId/collections/:collectionId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        title: z.string().min(1).optional(),
        slug: SlugStr.optional(),
        description: z.string().optional(),
        parent_id: UUID.optional(),
        image_url: z.string().url().optional(),
        seo_title: z.string().optional(),
        seo_desc: z.string().optional(),
        sort_order: z.string().optional(),
        is_active: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const updated = await updateCollection(
          params.data.storeId,
          params.data.collectionId,
          parsed.data
        );
        if (!updated) return reply.status(404).send(notFound("collection not found"));
        return reply.send({ ok: true });
      } catch (err) {
        if (isDuplicateSlugError(err)) {
          return reply.status(409).send({
            error: { code: "DUPLICATE_SLUG", message: (err as Error).message },
          });
        }
        throw err;
      }
    }
  );

  // DELETE /commerce/stores/:storeId/collections/:collectionId
  app.delete(
    "/commerce/stores/:storeId/collections/:collectionId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteCollection(params.data.storeId, params.data.collectionId);
      if (!deleted) return reply.status(404).send(notFound("collection not found"));
      return reply.send({ ok: true });
    }
  );

  // POST /commerce/stores/:storeId/collections/:collectionId/products
  app.post(
    "/commerce/stores/:storeId/collections/:collectionId/products",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({ product_id: UUID });
      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        await addProductToCollection(
          params.data.storeId,
          params.data.collectionId,
          parsed.data.product_id
        );
        return reply.status(201).send({ ok: true });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // DELETE /commerce/stores/:storeId/collections/:collectionId/products/:productId
  app.delete(
    "/commerce/stores/:storeId/collections/:collectionId/products/:productId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID, productId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const removed = await removeProductFromCollection(
        params.data.storeId,
        params.data.collectionId,
        params.data.productId
      );
      if (!removed) return reply.status(404).send(notFound("product not in collection"));
      return reply.send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/collections/:collectionId/products
  // (list products in collection — convenience endpoint, not in spec but needed for smart rules test)
  app.get(
    "/commerce/stores/:storeId/collections/:collectionId/products",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const q = PaginationQuery.safeParse(request.query);
      const products = await getCollectionProducts(
        params.data.storeId,
        params.data.collectionId,
        q.success ? q.data : {}
      );
      return reply.send({ products });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // COLLECTION RULES
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/collections/:collectionId/rules
  app.get(
    "/commerce/stores/:storeId/collections/:collectionId/rules",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const rules = await listCollectionRules(params.data.storeId, params.data.collectionId);
      return reply.send({ rules });
    }
  );

  // POST /commerce/stores/:storeId/collections/:collectionId/rules
  app.post(
    "/commerce/stores/:storeId/collections/:collectionId/rules",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        field: RuleFieldEnum,
        relation: RuleRelationEnum,
        value: z.string().min(1),
        position: z.number().int().min(0).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await addCollectionRule(
          params.data.storeId,
          params.data.collectionId,
          parsed.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // DELETE /commerce/stores/:storeId/collections/:collectionId/rules/:ruleId
  app.delete(
    "/commerce/stores/:storeId/collections/:collectionId/rules/:ruleId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, collectionId: UUID, ruleId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteCollectionRule(
        params.data.storeId,
        params.data.collectionId,
        params.data.ruleId
      );
      if (!deleted) return reply.status(404).send(notFound("rule not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PRICE LISTS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/price-lists
  app.get(
    "/commerce/stores/:storeId/price-lists",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const q = PaginationQuery.safeParse(request.query);
      const priceLists = await listPriceLists(params.data.storeId, q.success ? q.data : {});
      return reply.send({ price_lists: priceLists });
    }
  );

  // POST /commerce/stores/:storeId/price-lists
  app.post(
    "/commerce/stores/:storeId/price-lists",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        name: z.string().min(1),
        currency: z.string().length(3),
        type: PriceListTypeEnum.optional(),
        is_default: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const id = await createPriceList(params.data.storeId, parsed.data);
      return reply.status(201).send({ id });
    }
  );

  // GET /commerce/stores/:storeId/price-lists/:listId
  app.get(
    "/commerce/stores/:storeId/price-lists/:listId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, listId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const pl = await getPriceList(params.data.storeId, params.data.listId);
      if (!pl) return reply.status(404).send(notFound("price list not found"));
      return reply.send(pl);
    }
  );

  // PUT /commerce/stores/:storeId/price-lists/:listId
  app.put(
    "/commerce/stores/:storeId/price-lists/:listId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, listId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        name: z.string().min(1).optional(),
        currency: z.string().length(3).optional(),
        type: PriceListTypeEnum.optional(),
        is_default: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const updated = await updatePriceList(
        params.data.storeId,
        params.data.listId,
        parsed.data
      );
      if (!updated) return reply.status(404).send(notFound("price list not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/price-lists/:listId
  app.delete(
    "/commerce/stores/:storeId/price-lists/:listId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, listId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deletePriceList(params.data.storeId, params.data.listId);
      if (!deleted) return reply.status(404).send(notFound("price list not found"));
      return reply.send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/price-lists/:listId/items
  app.get(
    "/commerce/stores/:storeId/price-lists/:listId/items",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, listId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const q = PaginationQuery.safeParse(request.query);
      const items = await listPriceListItems(
        params.data.storeId,
        params.data.listId,
        q.success ? q.data : {}
      );
      return reply.send({ items });
    }
  );

  // POST /commerce/stores/:storeId/price-lists/:listId/items
  app.post(
    "/commerce/stores/:storeId/price-lists/:listId/items",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, listId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        variant_id: UUID,
        price: PricePositive,
        min_qty: z.number().int().min(1).optional(),
        max_qty: z.number().int().min(1).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      try {
        const id = await upsertPriceListItem(
          params.data.storeId,
          params.data.listId,
          parsed.data
        );
        return reply.status(201).send({ id });
      } catch (err) {
        if (isNotFoundError(err)) return reply.status(404).send(notFound((err as Error).message));
        throw err;
      }
    }
  );

  // PUT /commerce/stores/:storeId/price-lists/:listId/items/:itemId
  app.put(
    "/commerce/stores/:storeId/price-lists/:listId/items/:itemId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, listId: UUID, itemId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        price: PricePositive.optional(),
        min_qty: z.number().int().min(1).optional(),
        max_qty: z.number().int().min(1).optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const updated = await updatePriceListItem(
        params.data.storeId,
        params.data.listId,
        params.data.itemId,
        parsed.data
      );
      if (!updated) return reply.status(404).send(notFound("price list item not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/price-lists/:listId/items/:itemId
  app.delete(
    "/commerce/stores/:storeId/price-lists/:listId/items/:itemId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, listId: UUID, itemId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deletePriceListItem(
        params.data.storeId,
        params.data.listId,
        params.data.itemId
      );
      if (!deleted) return reply.status(404).send(notFound("price list item not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // METAFIELDS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/metafields
  app.get(
    "/commerce/stores/:storeId/metafields",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const q = z
        .object({
          owner_resource: z.string().optional(),
          owner_id: z.string().optional(),
          namespace: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .safeParse(request.query);

      const metafields = await listMetafields(
        params.data.storeId,
        q.success ? q.data : {}
      );
      return reply.send({ metafields });
    }
  );

  // POST /commerce/stores/:storeId/metafields
  app.post(
    "/commerce/stores/:storeId/metafields",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        owner_resource: z.string().min(1),
        owner_id: UUID,
        namespace: z.string().min(1),
        key: z.string().min(1),
        value: z.string().optional(),
        type: MetafieldTypeEnum.optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const id = await upsertMetafield(params.data.storeId, parsed.data);
      return reply.status(201).send({ id });
    }
  );

  // PUT /commerce/stores/:storeId/metafields/:metafieldId
  app.put(
    "/commerce/stores/:storeId/metafields/:metafieldId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, metafieldId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        value: z.string().optional(),
        type: MetafieldTypeEnum.optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const updated = await updateMetafield(
        params.data.storeId,
        params.data.metafieldId,
        parsed.data
      );
      if (!updated) return reply.status(404).send(notFound("metafield not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/metafields/:metafieldId
  app.delete(
    "/commerce/stores/:storeId/metafields/:metafieldId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, metafieldId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteMetafield(params.data.storeId, params.data.metafieldId);
      if (!deleted) return reply.status(404).send(notFound("metafield not found"));
      return reply.send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/metafield-definitions
  app.get(
    "/commerce/stores/:storeId/metafield-definitions",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const q = PaginationQuery.safeParse(request.query);
      const defs = await listMetafieldDefinitions(
        params.data.storeId,
        q.success ? q.data : {}
      );
      return reply.send({ definitions: defs });
    }
  );

  // POST /commerce/stores/:storeId/metafield-definitions
  app.post(
    "/commerce/stores/:storeId/metafield-definitions",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = StoreParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        name: z.string().min(1),
        namespace: z.string().min(1),
        key: z.string().min(1),
        owner_resource: z.string().min(1),
        description: z.string().optional(),
        type: MetafieldTypeEnum.optional(),
        validations: z.unknown().optional(),
        is_required: z.boolean().optional(),
        pin_to_form: z.boolean().optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const id = await createMetafieldDefinition(params.data.storeId, parsed.data);
      return reply.status(201).send({ id });
    }
  );

  // PUT /commerce/stores/:storeId/metafield-definitions/:defId
  app.put(
    "/commerce/stores/:storeId/metafield-definitions/:defId",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, defId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        type: MetafieldTypeEnum.optional(),
        validations: z.unknown().optional(),
        is_required: z.boolean().optional(),
        pin_to_form: z.boolean().optional(),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      const updated = await updateMetafieldDefinition(
        params.data.storeId,
        params.data.defId,
        parsed.data
      );
      if (!updated) return reply.status(404).send(notFound("metafield definition not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/metafield-definitions/:defId
  app.delete(
    "/commerce/stores/:storeId/metafield-definitions/:defId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({ storeId: UUID, defId: UUID })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteMetafieldDefinition(params.data.storeId, params.data.defId);
      if (!deleted) return reply.status(404).send(notFound("metafield definition not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSLATIONS
  // ══════════════════════════════════════════════════════════════════════════

  const TranslationParams = z.object({
    storeId: UUID,
    resourceType: TranslationResourceTypeEnum,
    resourceId: UUID,
  });

  // GET /commerce/stores/:storeId/translations/:resourceType/:resourceId
  app.get(
    "/commerce/stores/:storeId/translations/:resourceType/:resourceId",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = TranslationParams.safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const translations = await listTranslations(
        params.data.storeId,
        params.data.resourceType,
        params.data.resourceId
      );
      return reply.send({ translations });
    }
  );

  // PUT /commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale
  app.put(
    "/commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = z
        .object({
          storeId: UUID,
          resourceType: TranslationResourceTypeEnum,
          resourceId: UUID,
          locale: z.string().min(2),
        })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const Body = z.object({
        fields: z.record(z.string(), z.string().nullable()),
      });

      const parsed = Body.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send(validationError(parsed.error.issues));

      await upsertTranslation(
        params.data.storeId,
        params.data.resourceType,
        params.data.resourceId,
        params.data.locale,
        { fields: parsed.data.fields }
      );
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale
  app.delete(
    "/commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = z
        .object({
          storeId: UUID,
          resourceType: TranslationResourceTypeEnum,
          resourceId: UUID,
          locale: z.string().min(2),
        })
        .safeParse(request.params);
      if (!params.success) return reply.status(400).send(validationError(params.error.issues));

      const deleted = await deleteTranslation(
        params.data.storeId,
        params.data.resourceType,
        params.data.resourceId,
        params.data.locale
      );
      if (!deleted) return reply.status(404).send(notFound("translation not found"));
      return reply.send({ ok: true });
    }
  );
};
