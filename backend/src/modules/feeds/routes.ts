/**
 * feeds/routes.ts — Fastify plugin for product feeds and merchant feed config.
 *
 * Public (no auth):
 *   GET /storefront/:storeId/feeds/google-shopping  — Google Merchant XML
 *   GET /storefront/:storeId/feeds/facebook-catalog — Facebook Catalog XML
 *
 * Admin:
 *   GET    /commerce/stores/:storeId/merchant-feeds
 *   POST   /commerce/stores/:storeId/merchant-feeds
 *   PUT    /commerce/stores/:storeId/merchant-feeds/:feedId
 *   DELETE /commerce/stores/:storeId/merchant-feeds/:feedId
 *
 * Read (auth):
 *   GET /commerce/stores/:storeId/variants/:variantId/feed-data
 *   PUT /commerce/stores/:storeId/variants/:variantId/feed-data
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin, storeAuthRead, storeAuthWrite } from "../../lib/auth/middleware.js";
import {
  getStoreInfo,
  feedExists,
  updateFeedGeneratedAt,
  getFeedItems,
  getFacebookFeedItems,
  listMerchantFeeds,
  createMerchantFeed,
  updateMerchantFeed,
  deleteMerchantFeed,
  getProductFeedData,
  upsertProductFeedData,
} from "./service.js";
import {
  buildFeedXml,
  renderGoogleItem,
  renderFacebookItem,
  stripHtml,
} from "./xml.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreIdParams = z.object({
  storeId: z.string().uuid(),
});

const FeedParams = z.object({
  storeId: z.string().uuid(),
  feedId: z.string().uuid(),
});

const VariantFeedParams = z.object({
  storeId: z.string().uuid(),
  variantId: z.string().uuid(),
});

const FeedQuerystring = z.object({
  locale: z.string().optional(),
  country_code: z.string().optional(),
  currency: z.string().length(3).optional(),
});

const CreateMerchantFeedBody = z.object({
  channel: z.string().optional(),
  name: z.string().optional(),
  locale: z.string().optional(),
  country_code: z.string().optional(),
  currency: z.string().length(3).optional(),
  format: z.string().optional(),
  include_out_of_stock: z.boolean().optional(),
  generation_interval_minutes: z.number().int().min(1).optional(),
  store_integration_id: z.string().uuid().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const UpdateMerchantFeedBody = z.object({
  name: z.string().optional(),
  include_out_of_stock: z.boolean().optional(),
  generation_interval_minutes: z.number().int().min(1).optional(),
  status: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const UpsertFeedDataBody = z.object({
  gtin: z.string().optional(),
  mpn: z.string().optional(),
  brand: z.string().optional(),
  google_product_category: z.string().optional(),
  condition: z.string().optional(),
  age_group: z.string().optional(),
  gender: z.string().optional(),
  size_type: z.string().optional(),
  size_system: z.string().optional(),
  material: z.string().optional(),
  pattern: z.string().optional(),
  multipack: z.number().int().min(1).optional(),
  is_bundle: z.boolean().optional(),
  custom_label_0: z.string().optional(),
  custom_label_1: z.string().optional(),
  custom_label_2: z.string().optional(),
  custom_label_3: z.string().optional(),
  custom_label_4: z.string().optional(),
  image_url: z.string().optional(),
  ads_redirect: z.string().optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const feedsPlugin: FastifyPluginAsync = async (app) => {

  // ── GET /storefront/:storeId/feeds/google-shopping ───────────────────────
  app.get("/storefront/:storeId/feeds/google-shopping", async (request, reply) => {
    const params = StoreIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
    }
    const { storeId } = params.data;
    const query = FeedQuerystring.safeParse(request.query);
    const currency = query.success ? query.data.currency : undefined;

    const store = await getStoreInfo(storeId);
    if (!store) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "store not found" } });
    }

    const active = await feedExists(storeId, "google_shopping");
    if (!active) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "google shopping feed not configured" } });
    }

    const feedCurrency = currency ?? store.currency;
    const items = await getFeedItems(storeId);
    const renderedItems = items.map((item) => {
      const desc = stripHtml(item.description);
      return renderGoogleItem({ ...item, description: desc }, store.url, feedCurrency);
    });

    const xml = buildFeedXml({
      storeName: store.name,
      storeUrl: store.url,
      description: `${store.name} product feed`,
      items: renderedItems,
    });

    await updateFeedGeneratedAt(storeId, "google_shopping");

    void reply.header("Content-Type", "application/xml; charset=utf-8");
    void reply.header("Cache-Control", "public, max-age=3600");
    return reply.status(200).send(xml);
  });

  // ── GET /storefront/:storeId/feeds/facebook-catalog ──────────────────────
  app.get("/storefront/:storeId/feeds/facebook-catalog", async (request, reply) => {
    const params = StoreIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
    }
    const { storeId } = params.data;
    const query = FeedQuerystring.safeParse(request.query);
    const currency = query.success ? query.data.currency : undefined;

    const store = await getStoreInfo(storeId);
    if (!store) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "store not found" } });
    }

    const active = await feedExists(storeId, "facebook_catalog");
    if (!active) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "facebook catalog feed not configured" } });
    }

    const feedCurrency = currency ?? store.currency;
    const items = await getFacebookFeedItems(storeId);
    const renderedItems = items.map((item) => {
      const desc = stripHtml(item.description);
      return renderFacebookItem({ ...item, description: desc }, store.url, feedCurrency, item.productType);
    });

    const xml = buildFeedXml({
      storeName: store.name,
      storeUrl: store.url,
      description: `${store.name} catalog`,
      items: renderedItems,
    });

    await updateFeedGeneratedAt(storeId, "facebook_catalog");

    void reply.header("Content-Type", "application/xml; charset=utf-8");
    void reply.header("Cache-Control", "public, max-age=3600");
    return reply.status(200).send(xml);
  });

  // ── GET /commerce/stores/:storeId/merchant-feeds ─────────────────────────
  app.get(
    "/commerce/stores/:storeId/merchant-feeds",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const feeds = await listMerchantFeeds(params.data.storeId);
      return reply.send({ feeds });
    }
  );

  // ── POST /commerce/stores/:storeId/merchant-feeds ─────────────────────────
  app.post(
    "/commerce/stores/:storeId/merchant-feeds",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid storeId" } });
      }
      const parsed = CreateMerchantFeedBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      try {
        const id = await createMerchantFeed(params.data.storeId, parsed.data);
        return reply.status(201).send({ id });
      } catch (err) {
        throw err;
      }
    }
  );

  // ── PUT /commerce/stores/:storeId/merchant-feeds/:feedId ─────────────────
  app.put(
    "/commerce/stores/:storeId/merchant-feeds/:feedId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = FeedParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const parsed = UpdateMerchantFeedBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      const updated = await updateMerchantFeed(params.data.feedId, params.data.storeId, parsed.data);
      if (!updated) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "feed not found" } });
      }
      return reply.send({ ok: true });
    }
  );

  // ── DELETE /commerce/stores/:storeId/merchant-feeds/:feedId ──────────────
  app.delete(
    "/commerce/stores/:storeId/merchant-feeds/:feedId",
    { preHandler: [storeAuthAdmin] },
    async (request, reply) => {
      const params = FeedParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      await deleteMerchantFeed(params.data.feedId, params.data.storeId);
      return reply.send({ ok: true });
    }
  );

  // ── GET /commerce/stores/:storeId/variants/:variantId/feed-data ───────────
  app.get(
    "/commerce/stores/:storeId/variants/:variantId/feed-data",
    { preHandler: [storeAuthRead] },
    async (request, reply) => {
      const params = VariantFeedParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const data = await getProductFeedData(params.data.variantId, params.data.storeId);
      return reply.send({ feed_data: data ?? null });
    }
  );

  // ── PUT /commerce/stores/:storeId/variants/:variantId/feed-data ───────────
  app.put(
    "/commerce/stores/:storeId/variants/:variantId/feed-data",
    { preHandler: [storeAuthWrite] },
    async (request, reply) => {
      const params = VariantFeedParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid params" } });
      }
      const parsed = UpsertFeedDataBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: parsed.error.issues },
        });
      }
      try {
        const id = await upsertProductFeedData(params.data.variantId, params.data.storeId, parsed.data);
        return reply.send({ id });
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: "variant not found" } });
        }
        throw err;
      }
    }
  );
};
