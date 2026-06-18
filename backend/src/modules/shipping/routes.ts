/**
 * shipping/routes.ts — Fastify plugin for shipping management.
 *
 * Routes per parity-endpoints.md T2.6:
 *   GET/POST        /commerce/stores/:storeId/shipping-zones
 *   PUT/DELETE      /commerce/stores/:storeId/shipping-zones/:zoneId
 *   GET/POST        /commerce/stores/:storeId/shipping-zones/:zoneId/rates
 *   PUT/DELETE      /commerce/stores/:storeId/shipping-zones/:zoneId/rates/:rateId
 *   GET             /commerce/stores/:storeId/shipping-rates/available   (read auth)
 *   GET/POST/DELETE /commerce/stores/:storeId/shipping-providers
 *   GET/POST        /commerce/stores/:storeId/collection-points
 *   PUT/DELETE      /commerce/stores/:storeId/collection-points/:pointId
 *   GET/POST        /commerce/stores/:storeId/orders/:orderId/shipments
 *   PUT             /commerce/stores/:storeId/orders/:orderId/shipments/:shipmentId
 *   GET             /commerce/stores/:storeId/orders/:orderId/shipments/:shipmentId/tracking
 *   GET/POST        /commerce/stores/:storeId/orders/:orderId/fulfillment-orders
 *   PUT             /commerce/stores/:storeId/fulfillment-orders/:foId
 *   POST            /webhooks/:storeId/tracking/:shipmentId   (carrier push, no auth — HMAC sig)
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  storeAuthAdmin,
  storeAuthRead,
  storeAuthWrite,
} from "../../lib/auth/middleware.js";
import { decodeSecretValue } from "../../lib/secrets.js";
import {
  listShippingZones,
  createShippingZone,
  updateShippingZone,
  deleteShippingZone,
  listShippingRates,
  createShippingRate,
  updateShippingRate,
  deleteShippingRate,
  getAvailableShippingRates,
  listShippingProviders,
  upsertShippingProvider,
  deleteShippingProvider,
  listCollectionPoints,
  upsertCollectionPoint,
  updateCollectionPoint,
  deleteCollectionPoint,
  listShipments,
  createShipment,
  updateShipment,
  listShipmentTracking,
  pushTrackingEvent,
  getShipmentWebhookSecret,
  listFulfillmentOrders,
  createFulfillmentOrder,
  updateFulfillmentOrder,
} from "./service.js";

// ── Schemas ────────────────────────────────────────────────────────────────────

const StoreParams = z.object({ storeId: z.string().uuid() });
const ZoneParams = z.object({ storeId: z.string().uuid(), zoneId: z.string().uuid() });
const ZoneRateParams = z.object({ storeId: z.string().uuid(), zoneId: z.string().uuid(), rateId: z.string().uuid() });
const ProviderParams = z.object({ storeId: z.string().uuid(), providerId: z.string().uuid() });
const PointParams = z.object({ storeId: z.string().uuid(), pointId: z.string().uuid() });
const ShipmentParams = z.object({ storeId: z.string().uuid(), orderId: z.string().uuid(), shipmentId: z.string().uuid() });
const OrderParams = z.object({ storeId: z.string().uuid(), orderId: z.string().uuid() });
const FoParams = z.object({ storeId: z.string().uuid(), foId: z.string().uuid() });
const WebhookTrackingParams = z.object({ storeId: z.string().uuid(), shipmentId: z.string().uuid() });

const RegionSchema = z.object({
  country_code: z.string().length(2),
  province_code: z.string().max(10).nullish(),
});

const CreateZoneBody = z.object({
  name: z.string().min(1).max(255),
  regions: z.array(RegionSchema).optional(),
});

const UpdateZoneBody = z.object({
  name: z.string().min(1).max(255).optional(),
  regions: z.array(RegionSchema).optional(),
});

// H3.2: price, min_order_total, max_order_total are money fields — use decimal-string input.
const MoneyString = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a decimal string (e.g. \"9.99\")");

const CreateRateBody = z.object({
  name: z.string().min(1).max(255),
  price: MoneyString.optional(),
  min_weight_g: z.number().int().min(0).nullish(),
  max_weight_g: z.number().int().min(0).nullish(),
  min_order_total: MoneyString.nullish(),
  max_order_total: MoneyString.nullish(),
  estimated_days_min: z.number().int().min(0).nullish(),
  estimated_days_max: z.number().int().min(0).nullish(),
  is_active: z.boolean().optional(),
});

const UpdateRateBody = CreateRateBody.partial();

const AvailableRatesQuery = z.object({
  country_code: z.string().min(1).max(2),
  province_code: z.string().optional(),
  weight_g: z.coerce.number().int().min(0).optional(),
  order_total: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
});

const CreateProviderBody = z.object({
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(64),
  webhook_url: z.string().url().nullish(),
  config: z.record(z.string(), z.unknown()).nullish(),
  is_active: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

const AddressSchema = z.record(z.string(), z.unknown());

const UpsertPointBody = z.object({
  name: z.string().min(1).max(255),
  address: AddressSchema.optional(),
  country_code: z.string().length(2).optional(),
  provider_id: z.string().uuid().nullish(),
  provider_ref: z.string().max(200).nullish(),
  coordinates: z.record(z.string(), z.unknown()).nullish(),
  operating_hours: z.record(z.string(), z.unknown()).nullish(),
  is_active: z.boolean().optional(),
});

const UpdatePointBody = z.object({
  name: z.string().max(255).nullish(),
  address: AddressSchema.nullish(),
  coordinates: z.record(z.string(), z.unknown()).nullish(),
  operating_hours: z.record(z.string(), z.unknown()).nullish(),
  is_active: z.boolean().nullish(),
});

const ShipmentLineSchema = z.object({
  order_line_id: z.string().uuid(),
  quantity: z.number().int().min(1),
  lot_id: z.string().uuid().nullish(),
  serial_id: z.string().uuid().nullish(),
});

const CreateShipmentBody = z.object({
  provider_id: z.string().uuid().nullish(),
  warehouse_id: z.string().uuid().nullish(),
  collection_point_id: z.string().uuid().nullish(),
  status: z.string().optional(),
  tracking_number: z.string().max(200).nullish(),
  tracking_url: z.string().url().nullish(),
  carrier: z.string().max(100).nullish(),
  service_level: z.string().max(100).nullish(),
  shipped_at: z.string().nullish(),
  estimated_delivery: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  lines: z.array(ShipmentLineSchema).optional(),
});

const UpdateShipmentBody = z.object({
  status: z.string().optional(),
  tracking_number: z.string().max(200).nullish(),
  tracking_url: z.string().url().nullish(),
  carrier: z.string().max(100).nullish(),
  service_level: z.string().max(100).nullish(),
  shipped_at: z.string().nullish(),
  estimated_delivery: z.string().nullish(),
  delivered_at: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const FoLineSchema = z.object({
  order_line_id: z.string().uuid(),
  quantity: z.number().int().min(1),
});

const CreateFoBody = z.object({
  warehouse_id: z.string().uuid().nullish(),
  status: z.string().optional(),
  notes: z.string().max(16384).nullish(),
  lines: z.array(FoLineSchema).optional(),
});

const UpdateFoBody = z.object({
  status: z.string().optional(),
  notes: z.string().max(16384).nullish(),
  warehouse_id: z.string().uuid().nullish(),
});

const TrackingPushBody = z.object({
  status: z.string().min(1),
  location: z.string().max(500).nullish(),
  description: z.string().max(2000).nullish(),
  occurred_at: z.string().nullish(),
  raw_data: z.record(z.string(), z.unknown()).optional(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const shippingPlugin: FastifyPluginAsyncZod = async (app) => {
  const base = "/commerce/stores/:storeId";

  // ── Shipping zones ──────────────────────────────────────────────────────────

  app.get(`${base}/shipping-zones`, {
    schema: { params: StoreParams },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    return reply.send({ zones: await listShippingZones(storeId) });
  });

  app.post(`${base}/shipping-zones`, {
    schema: { params: StoreParams, body: CreateZoneBody },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const id = await createShippingZone(storeId, request.body);
    return reply.status(201).send({ id });
  });

  app.put(`${base}/shipping-zones/:zoneId`, {
    schema: { params: ZoneParams, body: UpdateZoneBody },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, zoneId } = request.params;
    await updateShippingZone(storeId, zoneId, request.body);
    return reply.send({ ok: true });
  });

  app.delete(`${base}/shipping-zones/:zoneId`, {
    schema: { params: ZoneParams },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, zoneId } = request.params;
    await deleteShippingZone(storeId, zoneId);
    return reply.send({ ok: true });
  });

  // ── Static shipping rates ───────────────────────────────────────────────────

  app.get(`${base}/shipping-zones/:zoneId/rates`, {
    schema: { params: ZoneParams },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, zoneId } = request.params;
    return reply.send({ shipping_rates: await listShippingRates(storeId, zoneId) });
  });

  app.post(`${base}/shipping-zones/:zoneId/rates`, {
    schema: { params: ZoneParams, body: CreateRateBody },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, zoneId } = request.params;
    // H3.2: parse decimal-string money fields to numbers for the service layer
    const id = await createShippingRate(storeId, zoneId, {
      ...request.body,
      price: request.body.price != null ? parseFloat(request.body.price) : undefined,
      min_order_total: request.body.min_order_total != null ? parseFloat(request.body.min_order_total) : undefined,
      max_order_total: request.body.max_order_total != null ? parseFloat(request.body.max_order_total) : undefined,
    });
    if (!id) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "shipping zone not found" } });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/shipping-zones/:zoneId/rates/:rateId`, {
    schema: { params: ZoneRateParams, body: UpdateRateBody },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, zoneId, rateId } = request.params;
    // H3.2: parse decimal-string money fields to numbers for the service layer
    const ok = await updateShippingRate(storeId, zoneId, rateId, {
      ...request.body,
      price: request.body.price != null ? parseFloat(request.body.price) : undefined,
      min_order_total: request.body.min_order_total != null ? parseFloat(request.body.min_order_total) : undefined,
      max_order_total: request.body.max_order_total != null ? parseFloat(request.body.max_order_total) : undefined,
    });
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "shipping rate not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/shipping-zones/:zoneId/rates/:rateId`, {
    schema: { params: ZoneRateParams },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, zoneId, rateId } = request.params;
    await deleteShippingRate(storeId, zoneId, rateId);
    return reply.send({ ok: true });
  });

  // ── Available rates (public read) ───────────────────────────────────────────

  app.get(`${base}/shipping-rates/available`, {
    schema: { params: StoreParams, querystring: AvailableRatesQuery },
    preHandler: [storeAuthRead("shipping")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const rates = await getAvailableShippingRates(storeId, request.query);
    return reply.send({ shipping_rates: rates });
  });

  // ── Shipping providers ──────────────────────────────────────────────────────

  app.get(`${base}/shipping-providers`, {
    schema: { params: StoreParams },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    return reply.send({ providers: await listShippingProviders(storeId) });
  });

  app.post(`${base}/shipping-providers`, {
    schema: { params: StoreParams, body: CreateProviderBody },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const id = await upsertShippingProvider(storeId, request.body);
    return reply.status(201).send({ id });
  });

  app.delete(`${base}/shipping-providers/:providerId`, {
    schema: { params: ProviderParams },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, providerId } = request.params;
    await deleteShippingProvider(storeId, providerId);
    return reply.send({ ok: true });
  });

  // ── Collection points ───────────────────────────────────────────────────────

  app.get(`${base}/collection-points`, {
    schema: { params: StoreParams },
    preHandler: [storeAuthRead("shipping")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const q = request.query as { active?: string; provider_id?: string };
    const points = await listCollectionPoints(storeId, {
      active_only: q.active !== "false",
      provider_id: q.provider_id,
    });
    return reply.send({ points });
  });

  app.post(`${base}/collection-points`, {
    schema: { params: StoreParams, body: UpsertPointBody },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId } = request.params;
    // Build address: use provided address or construct from top-level country_code
    const address: Record<string, unknown> = request.body.address ?? {};
    if (request.body.country_code && !address["country_code"]) {
      address["country_code"] = request.body.country_code;
    }
    const id = await upsertCollectionPoint(storeId, { ...request.body, address });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/collection-points/:pointId`, {
    schema: { params: PointParams, body: UpdatePointBody },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, pointId } = request.params;
    const ok = await updateCollectionPoint(storeId, pointId, request.body as Parameters<typeof updateCollectionPoint>[2]);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "collection point not found" } });
    return reply.send({ ok: true });
  });

  app.delete(`${base}/collection-points/:pointId`, {
    schema: { params: PointParams },
    preHandler: [storeAuthAdmin("shipping")],
  }, async (request, reply) => {
    const { storeId, pointId } = request.params;
    await deleteCollectionPoint(storeId, pointId);
    return reply.send({ ok: true });
  });

  // ── Shipments ───────────────────────────────────────────────────────────────

  app.get(`${base}/orders/:orderId/shipments`, {
    schema: { params: OrderParams },
    preHandler: [storeAuthWrite("shipping")],
  }, async (request, reply) => {
    const { storeId, orderId } = request.params;
    return reply.send({ shipments: await listShipments(storeId, orderId) });
  });

  app.post(`${base}/orders/:orderId/shipments`, {
    schema: { params: OrderParams, body: CreateShipmentBody },
    preHandler: [storeAuthWrite("shipping")],
  }, async (request, reply) => {
    const { storeId, orderId } = request.params;
    const id = await createShipment(storeId, orderId, request.body);
    if (!id) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "order not found" } });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/orders/:orderId/shipments/:shipmentId`, {
    schema: { params: ShipmentParams, body: UpdateShipmentBody },
    preHandler: [storeAuthWrite("shipping")],
  }, async (request, reply) => {
    const { storeId, orderId, shipmentId } = request.params;
    const ok = await updateShipment(storeId, orderId, shipmentId, request.body);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "shipment not found" } });
    return reply.send({ ok: true });
  });

  app.get(`${base}/orders/:orderId/shipments/:shipmentId/tracking`, {
    schema: { params: ShipmentParams },
    preHandler: [storeAuthWrite("shipping")],
  }, async (request, reply) => {
    const { storeId, orderId, shipmentId } = request.params;
    return reply.send({ events: await listShipmentTracking(storeId, orderId, shipmentId) });
  });

  // ── Fulfillment orders ──────────────────────────────────────────────────────

  app.get(`${base}/orders/:orderId/fulfillment-orders`, {
    schema: { params: OrderParams },
    preHandler: [storeAuthWrite("shipping")],
  }, async (request, reply) => {
    const { storeId, orderId } = request.params;
    return reply.send({ fulfillment_orders: await listFulfillmentOrders(storeId, orderId) });
  });

  app.post(`${base}/orders/:orderId/fulfillment-orders`, {
    schema: { params: OrderParams, body: CreateFoBody },
    preHandler: [storeAuthWrite("shipping")],
  }, async (request, reply) => {
    const { storeId, orderId } = request.params;
    const id = await createFulfillmentOrder(storeId, orderId, request.body);
    if (!id) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "order not found" } });
    return reply.status(201).send({ id });
  });

  app.put(`${base}/fulfillment-orders/:foId`, {
    schema: { params: FoParams, body: UpdateFoBody },
    preHandler: [storeAuthWrite("shipping")],
  }, async (request, reply) => {
    const { storeId, foId } = request.params;
    const ok = await updateFulfillmentOrder(storeId, foId, request.body);
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "fulfillment order not found" } });
    return reply.send({ ok: true });
  });

  // ── Carrier tracking push webhook ───────────────────────────────────────────
  // POST /webhooks/:storeId/tracking/:shipmentId
  // No auth — authenticated by HMAC-SHA256 of the request body using the
  // shipping provider's webhook_secret. Falls back to open if no secret configured.
  //
  // NOTE (H3.1): Body schema is registered for OpenAPI, but manual safeParse is kept
  // below because the HMAC verification must happen before framework body validation
  // would run. The framework validates params; the body is re-validated manually after
  // HMAC so we keep the same error envelope. Follow-up: wire rawBody via a dedicated
  // Fastify hook so schema validation and HMAC can co-exist cleanly.

  app.post("/webhooks/:storeId/tracking/:shipmentId", {
    schema: { params: WebhookTrackingParams, body: TrackingPushBody },
    config: { rawBody: true },
  }, async (request, reply) => {
    const { storeId, shipmentId } = request.params;

    // Get stored (encrypted) webhook secret for this shipment's provider
    const storedSecret = await getShipmentWebhookSecret(storeId, shipmentId);
    if (storedSecret === null) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "shipment not found" } });
    }

    // Decrypt the stored secret (AES-GCM in production; passthrough in dev)
    const secretsKey = process.env["AUTH_SECRETS_KEY"] ?? "";
    let webhookSecret = "";
    if (storedSecret) {
      try {
        webhookSecret = decodeSecretValue(storedSecret, secretsKey);
      } catch {
        webhookSecret = storedSecret; // may be plaintext in dev
      }
    }

    if (webhookSecret) {
      // Verify HMAC-SHA256 signature
      const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
      const bodyBytes = rawBody ?? Buffer.from(JSON.stringify(request.body));

      const sigHeader = (
        request.headers["x-webhook-signature"] ??
        request.headers["x-hub-signature-256"] ??
        request.headers["x-signature"] ?? ""
      ) as string;

      if (!sigHeader) {
        return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "missing webhook signature" } });
      }

      const sig = sigHeader.replace(/^sha256=/, "");
      const mac = createHmac("sha256", webhookSecret);
      mac.update(bodyBytes);
      const expected = mac.digest("hex");

      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "invalid webhook signature" } });
      }
    }

    // Body already validated by Fastify schema (TrackingPushBody); use directly.
    const result = await pushTrackingEvent(storeId, shipmentId, request.body);
    if (!result) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "shipment not found" } });
    return reply.send({ id: result.id });
  });
};
