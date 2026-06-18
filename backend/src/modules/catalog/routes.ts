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
  moderateReview,
  deleteReview,
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

const MediaTypeEnum = z.enum(["image", "video", "model_3d"]);

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

// ── Params schemas ────────────────────────────────────────────────────────────

const StoreParams = z.object({
  storeId: UUID,
});

const ProductParams = z.object({
  storeId: UUID,
  productId: UUID,
});

const VariantParams = z.object({
  storeId: UUID,
  productId: UUID,
  variantId: UUID,
});

const OptionParams = z.object({
  storeId: UUID,
  productId: UUID,
  optionId: UUID,
});

const MediaParams = z.object({
  storeId: UUID,
  productId: UUID,
  mediaId: UUID,
});

const BundleItemParams = z.object({
  storeId: UUID,
  productId: UUID,
  itemId: UUID,
});

const DigitalFileParams = z.object({
  storeId: UUID,
  productId: UUID,
  fileId: UUID,
});

const ReviewParams = z.object({
  storeId: UUID,
  reviewId: UUID,
});

const CollectionParams = z.object({
  storeId: UUID,
  collectionId: UUID,
});

const CollectionProductParams = z.object({
  storeId: UUID,
  collectionId: UUID,
  productId: UUID,
});

const RuleParams = z.object({
  storeId: UUID,
  collectionId: UUID,
  ruleId: UUID,
});

const PriceListParams = z.object({
  storeId: UUID,
  listId: UUID,
});

const PriceListItemParams = z.object({
  storeId: UUID,
  listId: UUID,
  itemId: UUID,
});

const MetafieldParams = z.object({
  storeId: UUID,
  metafieldId: UUID,
});

const MetafieldDefParams = z.object({
  storeId: UUID,
  defId: UUID,
});

const TranslationParams = z.object({
  storeId: UUID,
  resourceType: TranslationResourceTypeEnum,
  resourceId: UUID,
});

const TranslationLocaleParams = z.object({
  storeId: UUID,
  resourceType: TranslationResourceTypeEnum,
  resourceId: UUID,
  locale: z.string().min(2),
});

const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// ── Body schemas ──────────────────────────────────────────────────────────────

const CreateProductBody = z.object({
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

const UpdateProductBody = z.object({
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

const ProductsQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateVariantBody = z.object({
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

const UpdateVariantBody = z.object({
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

const CreateOptionBody = z.object({
  name: z.string().min(1),
  values: z.array(z.string()).optional(),
  position: z.number().int().min(0).optional(),
});

const AddMediaBody = z.object({
  url: z.string().url("url is required and must be a valid URL"),
  type: MediaTypeEnum.optional(),
  variant_id: UUID.optional(),
  alt_text: z.string().optional(),
  position: z.number().int().min(0).optional(),
});

const AddBundleItemBody = z.object({
  variant_id: UUID,
  quantity: z.number().int().min(1).optional(),
  is_optional: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

const UpdateBundleItemBody = z.object({
  quantity: z.number().int().min(1).optional(),
  is_optional: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

const CreateDigitalFileBody = z.object({
  name: z.string().min(1),
  file_url: z.string().url(),
  variant_id: UUID.optional(),
  file_size: z.number().int().min(0).optional(),
  mime_type: z.string().optional(),
  version: z.string().optional(),
  download_limit: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
});

const ReviewsQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const CreateReviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().optional(),
  body: z.string().optional(),
  reviewer_name: z.string().optional(),
  reviewer_email: z.string().email().optional(),
  customer_id: UUID.optional(),
  order_id: UUID.optional(),
  media_urls: z.unknown().optional(),
});

const UpdateReviewBody = z.object({
  status: ReviewStatusEnum.optional(),
  reply: z.string().optional(),
});

const ModerateReviewBody = z.object({
  status: z.enum(["approved", "rejected"]),
});

const ProductReviewParams = z.object({
  storeId: UUID,
  productId: UUID,
  reviewId: UUID,
});

const SetTagsBody = z.object({
  tags: z.array(z.string()),
});

const CreateCollectionBody = z.object({
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

const UpdateCollectionBody = z.object({
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

const AddCollectionProductBody = z.object({ product_id: UUID });

const AddCollectionRuleBody = z.object({
  field: RuleFieldEnum,
  relation: RuleRelationEnum,
  value: z.string().min(1),
  position: z.number().int().min(0).optional(),
});

const CreatePriceListBody = z.object({
  name: z.string().min(1),
  currency: z.string().length(3),
  type: PriceListTypeEnum.optional(),
  is_default: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpdatePriceListBody = z.object({
  name: z.string().min(1).optional(),
  currency: z.string().length(3).optional(),
  type: PriceListTypeEnum.optional(),
  is_default: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const UpsertPriceListItemBody = z.object({
  variant_id: UUID,
  price: PricePositive,
  min_qty: z.number().int().min(1).optional(),
  max_qty: z.number().int().min(1).optional(),
});

const UpdatePriceListItemBody = z.object({
  price: PricePositive.optional(),
  min_qty: z.number().int().min(1).optional(),
  max_qty: z.number().int().min(1).optional(),
});

const MetafieldsQuery = z.object({
  owner_resource: z.string().optional(),
  owner_id: z.string().optional(),
  namespace: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const UpsertMetafieldBody = z.object({
  owner_resource: z.string().min(1),
  owner_id: UUID,
  namespace: z.string().min(1),
  key: z.string().min(1),
  value: z.string().optional(),
  type: MetafieldTypeEnum.optional(),
});

const UpdateMetafieldBody = z.object({
  value: z.string().optional(),
  type: MetafieldTypeEnum.optional(),
});

const CreateMetafieldDefinitionBody = z.object({
  name: z.string().min(1),
  namespace: z.string().min(1),
  key: z.string().min(1),
  owner_resource: z.string().min(1),
  description: z.string().optional(),
  type: MetafieldTypeEnum.optional(),
  validations: z.unknown().optional(),
  is_required: z.boolean().optional(),
});

const UpdateMetafieldDefinitionBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: MetafieldTypeEnum.optional(),
  validations: z.unknown().optional(),
  is_required: z.boolean().optional(),
});

const UpsertTranslationBody = z.object({
  fields: z.record(z.string(), z.string().nullable()),
});

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

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const catalogPlugin: FastifyPluginAsync = async (app) => {
  // ══════════════════════════════════════════════════════════════════════════
  // PRODUCTS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products
  // The "catalog" resource tag makes storeAuthRead enforce the catalog:read
  // OAuth scope per-resource (a no-op for cc_pub_/cc_prv_/JWT principals).
  app.get(
    "/commerce/stores/:storeId/products",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: StoreParams, querystring: ProductsQuery },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const q = request.query as z.infer<typeof ProductsQuery>;
      const products = await listProducts(storeId, q);
      return reply.send({ products });
    }
  );

  // POST /commerce/stores/:storeId/products
  app.post(
    "/commerce/stores/:storeId/products",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: StoreParams, body: CreateProductBody },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const data = request.body as z.infer<typeof CreateProductBody>;

      try {
        const id = await createProduct(storeId, data);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: ProductParams },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const product = await getProduct(storeId, productId);
      if (!product) return reply.status(404).send(notFound("product not found"));
      return reply.send(product);
    }
  );

  // PUT /commerce/stores/:storeId/products/:productId
  app.put(
    "/commerce/stores/:storeId/products/:productId",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: ProductParams, body: UpdateProductBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const data = request.body as z.infer<typeof UpdateProductBody>;

      try {
        const updated = await updateProduct(storeId, productId, data);
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
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: ProductParams },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const deleted = await deleteProduct(storeId, productId);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: ProductParams },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const variants = await listVariants(storeId, productId);
      return reply.send({ variants });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/variants
  app.post(
    "/commerce/stores/:storeId/products/:productId/variants",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: ProductParams, body: CreateVariantBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const data = request.body as z.infer<typeof CreateVariantBody>;

      try {
        const id = await createVariant(storeId, productId, data);
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
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: VariantParams, body: UpdateVariantBody },
    },
    async (request, reply) => {
      const { storeId, productId, variantId } = request.params as z.infer<typeof VariantParams>;
      const data = request.body as z.infer<typeof UpdateVariantBody>;

      const updated = await updateVariant(storeId, productId, variantId, data);
      if (!updated) return reply.status(404).send(notFound("variant not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId/variants/:variantId
  app.delete(
    "/commerce/stores/:storeId/products/:productId/variants/:variantId",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: VariantParams },
    },
    async (request, reply) => {
      const { storeId, productId, variantId } = request.params as z.infer<typeof VariantParams>;
      const deleted = await deleteVariant(storeId, productId, variantId);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: ProductParams },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const options = await listOptions(storeId, productId);
      return reply.send({ options });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/options
  app.post(
    "/commerce/stores/:storeId/products/:productId/options",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: ProductParams, body: CreateOptionBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const data = request.body as z.infer<typeof CreateOptionBody>;

      try {
        const id = await createOption(storeId, productId, data);
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
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: OptionParams },
    },
    async (request, reply) => {
      const { storeId, productId, optionId } = request.params as z.infer<typeof OptionParams>;
      const deleted = await deleteOption(storeId, productId, optionId);
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
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: ProductParams, body: AddMediaBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const data = request.body as z.infer<typeof AddMediaBody>;

      try {
        const id = await addMedia(storeId, productId, data);
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
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: MediaParams },
    },
    async (request, reply) => {
      const { storeId, productId, mediaId } = request.params as z.infer<typeof MediaParams>;
      const deleted = await deleteMedia(storeId, productId, mediaId);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: ProductParams },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const items = await listBundleItems(storeId, productId);
      return reply.send({ bundle_items: items });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/bundle-items
  app.post(
    "/commerce/stores/:storeId/products/:productId/bundle-items",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: ProductParams, body: AddBundleItemBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const data = request.body as z.infer<typeof AddBundleItemBody>;

      try {
        const id = await addBundleItem(storeId, productId, data);
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
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: BundleItemParams, body: UpdateBundleItemBody },
    },
    async (request, reply) => {
      const { storeId, productId, itemId } = request.params as z.infer<typeof BundleItemParams>;
      const data = request.body as z.infer<typeof UpdateBundleItemBody>;

      const updated = await updateBundleItem(storeId, productId, itemId, data);
      if (!updated) return reply.status(404).send(notFound("bundle item not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId/bundle-items/:itemId
  app.delete(
    "/commerce/stores/:storeId/products/:productId/bundle-items/:itemId",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: BundleItemParams },
    },
    async (request, reply) => {
      const { storeId, productId, itemId } = request.params as z.infer<typeof BundleItemParams>;
      const deleted = await deleteBundleItem(storeId, productId, itemId);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: ProductParams },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const files = await listDigitalFiles(storeId, productId);
      return reply.send({ files });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/digital-files
  app.post(
    "/commerce/stores/:storeId/products/:productId/digital-files",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: ProductParams, body: CreateDigitalFileBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const data = request.body as z.infer<typeof CreateDigitalFileBody>;

      try {
        const id = await createDigitalFile(storeId, productId, data);
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
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: DigitalFileParams },
    },
    async (request, reply) => {
      const { storeId, productId, fileId } = request.params as z.infer<typeof DigitalFileParams>;
      const deleted = await deleteDigitalFile(storeId, productId, fileId);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: ProductParams, querystring: ReviewsQuery },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const q = request.query as z.infer<typeof ReviewsQuery>;
      const reviews = await listReviews(storeId, productId, q);
      return reply.send({ reviews });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/reviews
  app.post(
    "/commerce/stores/:storeId/products/:productId/reviews",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: ProductParams, body: CreateReviewBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const data = request.body as z.infer<typeof CreateReviewBody>;

      try {
        const id = await createReview(storeId, productId, data);
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
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: ReviewParams, body: UpdateReviewBody },
    },
    async (request, reply) => {
      const { storeId, reviewId } = request.params as z.infer<typeof ReviewParams>;
      const data = request.body as z.infer<typeof UpdateReviewBody>;

      const updated = await updateReview(storeId, reviewId, data);
      if (!updated) return reply.status(404).send(notFound("review not found"));
      return reply.send({ ok: true });
    }
  );

  // POST /commerce/stores/:storeId/products/:productId/reviews/:reviewId/moderate
  // Admin moderation: approve|reject a review, then recompute cached aggregates.
  app.post(
    "/commerce/stores/:storeId/products/:productId/reviews/:reviewId/moderate",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: ProductReviewParams, body: ModerateReviewBody },
    },
    async (request, reply) => {
      const { storeId, reviewId } = request.params as z.infer<typeof ProductReviewParams>;
      const { status } = request.body as z.infer<typeof ModerateReviewBody>;

      const ok = await moderateReview(storeId, reviewId, status);
      if (!ok) return reply.status(404).send(notFound("review not found"));
      return reply.send({ ok: true, status });
    }
  );

  // DELETE /commerce/stores/:storeId/products/:productId/reviews/:reviewId
  // Admin delete: removes the review and recomputes cached aggregates.
  app.delete(
    "/commerce/stores/:storeId/products/:productId/reviews/:reviewId",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: ProductReviewParams },
    },
    async (request, reply) => {
      const { storeId, reviewId } = request.params as z.infer<typeof ProductReviewParams>;
      const ok = await deleteReview(storeId, reviewId);
      if (!ok) return reply.status(404).send(notFound("review not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // PRODUCT TAGS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/products/:productId/tags
  app.get(
    "/commerce/stores/:storeId/products/:productId/tags",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: ProductParams },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const tags = await getProductTags(storeId, productId);
      return reply.send({ tags });
    }
  );

  // PUT /commerce/stores/:storeId/products/:productId/tags
  app.put(
    "/commerce/stores/:storeId/products/:productId/tags",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: ProductParams, body: SetTagsBody },
    },
    async (request, reply) => {
      const { storeId, productId } = request.params as z.infer<typeof ProductParams>;
      const { tags } = request.body as z.infer<typeof SetTagsBody>;

      try {
        await setProductTags(storeId, productId, tags);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: StoreParams, querystring: PaginationQuery },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const q = request.query as z.infer<typeof PaginationQuery>;
      const collections = await listCollections(storeId, q);
      return reply.send({ collections });
    }
  );

  // POST /commerce/stores/:storeId/collections
  app.post(
    "/commerce/stores/:storeId/collections",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: StoreParams, body: CreateCollectionBody },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const data = request.body as z.infer<typeof CreateCollectionBody>;

      try {
        const id = await createCollection(storeId, data);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: CollectionParams },
    },
    async (request, reply) => {
      const { storeId, collectionId } = request.params as z.infer<typeof CollectionParams>;
      const collection = await getCollection(storeId, collectionId);
      if (!collection) return reply.status(404).send(notFound("collection not found"));
      return reply.send(collection);
    }
  );

  // PUT /commerce/stores/:storeId/collections/:collectionId
  app.put(
    "/commerce/stores/:storeId/collections/:collectionId",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: CollectionParams, body: UpdateCollectionBody },
    },
    async (request, reply) => {
      const { storeId, collectionId } = request.params as z.infer<typeof CollectionParams>;
      const data = request.body as z.infer<typeof UpdateCollectionBody>;

      try {
        const updated = await updateCollection(storeId, collectionId, data);
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
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: CollectionParams },
    },
    async (request, reply) => {
      const { storeId, collectionId } = request.params as z.infer<typeof CollectionParams>;
      const deleted = await deleteCollection(storeId, collectionId);
      if (!deleted) return reply.status(404).send(notFound("collection not found"));
      return reply.send({ ok: true });
    }
  );

  // POST /commerce/stores/:storeId/collections/:collectionId/products
  app.post(
    "/commerce/stores/:storeId/collections/:collectionId/products",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: CollectionParams, body: AddCollectionProductBody },
    },
    async (request, reply) => {
      const { storeId, collectionId } = request.params as z.infer<typeof CollectionParams>;
      const { product_id } = request.body as z.infer<typeof AddCollectionProductBody>;

      try {
        await addProductToCollection(storeId, collectionId, product_id);
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
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: CollectionProductParams },
    },
    async (request, reply) => {
      const { storeId, collectionId, productId } = request.params as z.infer<typeof CollectionProductParams>;
      const removed = await removeProductFromCollection(storeId, collectionId, productId);
      if (!removed) return reply.status(404).send(notFound("product not in collection"));
      return reply.send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/collections/:collectionId/products
  // (list products in collection — convenience endpoint, not in spec but needed for smart rules test)
  app.get(
    "/commerce/stores/:storeId/collections/:collectionId/products",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: CollectionParams, querystring: PaginationQuery },
    },
    async (request, reply) => {
      const { storeId, collectionId } = request.params as z.infer<typeof CollectionParams>;
      const q = request.query as z.infer<typeof PaginationQuery>;
      const products = await getCollectionProducts(storeId, collectionId, q);
      return reply.send({ products });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // COLLECTION RULES
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/collections/:collectionId/rules
  app.get(
    "/commerce/stores/:storeId/collections/:collectionId/rules",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: CollectionParams },
    },
    async (request, reply) => {
      const { storeId, collectionId } = request.params as z.infer<typeof CollectionParams>;
      const rules = await listCollectionRules(storeId, collectionId);
      return reply.send({ rules });
    }
  );

  // POST /commerce/stores/:storeId/collections/:collectionId/rules
  app.post(
    "/commerce/stores/:storeId/collections/:collectionId/rules",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: CollectionParams, body: AddCollectionRuleBody },
    },
    async (request, reply) => {
      const { storeId, collectionId } = request.params as z.infer<typeof CollectionParams>;
      const data = request.body as z.infer<typeof AddCollectionRuleBody>;

      try {
        const id = await addCollectionRule(storeId, collectionId, data);
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
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: RuleParams },
    },
    async (request, reply) => {
      const { storeId, collectionId, ruleId } = request.params as z.infer<typeof RuleParams>;
      const deleted = await deleteCollectionRule(storeId, collectionId, ruleId);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: StoreParams, querystring: PaginationQuery },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const q = request.query as z.infer<typeof PaginationQuery>;
      const priceLists = await listPriceLists(storeId, q);
      return reply.send({ price_lists: priceLists });
    }
  );

  // POST /commerce/stores/:storeId/price-lists
  app.post(
    "/commerce/stores/:storeId/price-lists",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: StoreParams, body: CreatePriceListBody },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const data = request.body as z.infer<typeof CreatePriceListBody>;
      const id = await createPriceList(storeId, data);
      return reply.status(201).send({ id });
    }
  );

  // GET /commerce/stores/:storeId/price-lists/:listId
  app.get(
    "/commerce/stores/:storeId/price-lists/:listId",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: PriceListParams },
    },
    async (request, reply) => {
      const { storeId, listId } = request.params as z.infer<typeof PriceListParams>;
      const pl = await getPriceList(storeId, listId);
      if (!pl) return reply.status(404).send(notFound("price list not found"));
      return reply.send(pl);
    }
  );

  // PUT /commerce/stores/:storeId/price-lists/:listId
  app.put(
    "/commerce/stores/:storeId/price-lists/:listId",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: PriceListParams, body: UpdatePriceListBody },
    },
    async (request, reply) => {
      const { storeId, listId } = request.params as z.infer<typeof PriceListParams>;
      const data = request.body as z.infer<typeof UpdatePriceListBody>;
      const updated = await updatePriceList(storeId, listId, data);
      if (!updated) return reply.status(404).send(notFound("price list not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/price-lists/:listId
  app.delete(
    "/commerce/stores/:storeId/price-lists/:listId",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: PriceListParams },
    },
    async (request, reply) => {
      const { storeId, listId } = request.params as z.infer<typeof PriceListParams>;
      const deleted = await deletePriceList(storeId, listId);
      if (!deleted) return reply.status(404).send(notFound("price list not found"));
      return reply.send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/price-lists/:listId/items
  app.get(
    "/commerce/stores/:storeId/price-lists/:listId/items",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: PriceListParams, querystring: PaginationQuery },
    },
    async (request, reply) => {
      const { storeId, listId } = request.params as z.infer<typeof PriceListParams>;
      const q = request.query as z.infer<typeof PaginationQuery>;
      const items = await listPriceListItems(storeId, listId, q);
      return reply.send({ items });
    }
  );

  // POST /commerce/stores/:storeId/price-lists/:listId/items
  app.post(
    "/commerce/stores/:storeId/price-lists/:listId/items",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: PriceListParams, body: UpsertPriceListItemBody },
    },
    async (request, reply) => {
      const { storeId, listId } = request.params as z.infer<typeof PriceListParams>;
      const data = request.body as z.infer<typeof UpsertPriceListItemBody>;

      try {
        const id = await upsertPriceListItem(storeId, listId, data);
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
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: PriceListItemParams, body: UpdatePriceListItemBody },
    },
    async (request, reply) => {
      const { storeId, listId, itemId } = request.params as z.infer<typeof PriceListItemParams>;
      const data = request.body as z.infer<typeof UpdatePriceListItemBody>;
      const updated = await updatePriceListItem(storeId, listId, itemId, data);
      if (!updated) return reply.status(404).send(notFound("price list item not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/price-lists/:listId/items/:itemId
  app.delete(
    "/commerce/stores/:storeId/price-lists/:listId/items/:itemId",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: PriceListItemParams },
    },
    async (request, reply) => {
      const { storeId, listId, itemId } = request.params as z.infer<typeof PriceListItemParams>;
      const deleted = await deletePriceListItem(storeId, listId, itemId);
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
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: StoreParams, querystring: MetafieldsQuery },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const q = request.query as z.infer<typeof MetafieldsQuery>;
      const metafields = await listMetafields(storeId, q);
      return reply.send({ metafields });
    }
  );

  // POST /commerce/stores/:storeId/metafields
  app.post(
    "/commerce/stores/:storeId/metafields",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: StoreParams, body: UpsertMetafieldBody },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const data = request.body as z.infer<typeof UpsertMetafieldBody>;
      const id = await upsertMetafield(storeId, data);
      return reply.status(201).send({ id });
    }
  );

  // PUT /commerce/stores/:storeId/metafields/:metafieldId
  app.put(
    "/commerce/stores/:storeId/metafields/:metafieldId",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: MetafieldParams, body: UpdateMetafieldBody },
    },
    async (request, reply) => {
      const { storeId, metafieldId } = request.params as z.infer<typeof MetafieldParams>;
      const data = request.body as z.infer<typeof UpdateMetafieldBody>;
      const updated = await updateMetafield(storeId, metafieldId, data);
      if (!updated) return reply.status(404).send(notFound("metafield not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/metafields/:metafieldId
  app.delete(
    "/commerce/stores/:storeId/metafields/:metafieldId",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: MetafieldParams },
    },
    async (request, reply) => {
      const { storeId, metafieldId } = request.params as z.infer<typeof MetafieldParams>;
      const deleted = await deleteMetafield(storeId, metafieldId);
      if (!deleted) return reply.status(404).send(notFound("metafield not found"));
      return reply.send({ ok: true });
    }
  );

  // GET /commerce/stores/:storeId/metafield-definitions
  app.get(
    "/commerce/stores/:storeId/metafield-definitions",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: StoreParams, querystring: PaginationQuery },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const q = request.query as z.infer<typeof PaginationQuery>;
      const defs = await listMetafieldDefinitions(storeId, q);
      return reply.send({ definitions: defs });
    }
  );

  // POST /commerce/stores/:storeId/metafield-definitions
  app.post(
    "/commerce/stores/:storeId/metafield-definitions",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: StoreParams, body: CreateMetafieldDefinitionBody },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof StoreParams>;
      const data = request.body as z.infer<typeof CreateMetafieldDefinitionBody>;
      const id = await createMetafieldDefinition(storeId, data);
      return reply.status(201).send({ id });
    }
  );

  // PUT /commerce/stores/:storeId/metafield-definitions/:defId
  app.put(
    "/commerce/stores/:storeId/metafield-definitions/:defId",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: MetafieldDefParams, body: UpdateMetafieldDefinitionBody },
    },
    async (request, reply) => {
      const { storeId, defId } = request.params as z.infer<typeof MetafieldDefParams>;
      const data = request.body as z.infer<typeof UpdateMetafieldDefinitionBody>;
      const updated = await updateMetafieldDefinition(storeId, defId, data);
      if (!updated) return reply.status(404).send(notFound("metafield definition not found"));
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/metafield-definitions/:defId
  app.delete(
    "/commerce/stores/:storeId/metafield-definitions/:defId",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: MetafieldDefParams },
    },
    async (request, reply) => {
      const { storeId, defId } = request.params as z.infer<typeof MetafieldDefParams>;
      const deleted = await deleteMetafieldDefinition(storeId, defId);
      if (!deleted) return reply.status(404).send(notFound("metafield definition not found"));
      return reply.send({ ok: true });
    }
  );

  // ══════════════════════════════════════════════════════════════════════════
  // TRANSLATIONS
  // ══════════════════════════════════════════════════════════════════════════

  // GET /commerce/stores/:storeId/translations/:resourceType/:resourceId
  app.get(
    "/commerce/stores/:storeId/translations/:resourceType/:resourceId",
    {
      preHandler: [storeAuthRead("catalog")],
      schema: { params: TranslationParams },
    },
    async (request, reply) => {
      const { storeId, resourceType, resourceId } = request.params as z.infer<typeof TranslationParams>;
      const translations = await listTranslations(storeId, resourceType, resourceId);
      return reply.send({ translations });
    }
  );

  // PUT /commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale
  app.put(
    "/commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale",
    {
      preHandler: [storeAuthWrite("catalog")],
      schema: { params: TranslationLocaleParams, body: UpsertTranslationBody },
    },
    async (request, reply) => {
      const { storeId, resourceType, resourceId, locale } = request.params as z.infer<typeof TranslationLocaleParams>;
      const { fields } = request.body as z.infer<typeof UpsertTranslationBody>;

      await upsertTranslation(storeId, resourceType, resourceId, locale, { fields });
      return reply.send({ ok: true });
    }
  );

  // DELETE /commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale
  app.delete(
    "/commerce/stores/:storeId/translations/:resourceType/:resourceId/:locale",
    {
      preHandler: [storeAuthAdmin("catalog")],
      schema: { params: TranslationLocaleParams },
    },
    async (request, reply) => {
      const { storeId, resourceType, resourceId, locale } = request.params as z.infer<typeof TranslationLocaleParams>;
      const deleted = await deleteTranslation(storeId, resourceType, resourceId, locale);
      if (!deleted) return reply.status(404).send(notFound("translation not found"));
      return reply.send({ ok: true });
    }
  );
};
