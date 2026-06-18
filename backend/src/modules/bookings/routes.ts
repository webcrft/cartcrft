/**
 * bookings/routes.ts — Fastify plugin for bookings, resources, availability,
 * price rules, iCal feeds, and OTA channel management.
 *
 * Routes:
 *   Cancellation Policies:
 *     GET    /commerce/stores/:storeId/booking-policies
 *     POST   /commerce/stores/:storeId/booking-policies
 *     GET    /commerce/stores/:storeId/booking-policies/:policyId
 *     PUT    /commerce/stores/:storeId/booking-policies/:policyId
 *     DELETE /commerce/stores/:storeId/booking-policies/:policyId
 *     PUT    /commerce/stores/:storeId/booking-policies/:policyId/translations/:locale
 *
 *   Booking Resources:
 *     GET    /commerce/stores/:storeId/booking-resources
 *     POST   /commerce/stores/:storeId/booking-resources
 *     GET    /commerce/stores/:storeId/booking-resources/:resourceId
 *     PUT    /commerce/stores/:storeId/booking-resources/:resourceId
 *     DELETE /commerce/stores/:storeId/booking-resources/:resourceId
 *     PUT    /commerce/stores/:storeId/booking-resources/:resourceId/translations/:locale
 *
 *   Availability:
 *     GET    /commerce/stores/:storeId/booking-resources/:resourceId/availability
 *     POST   /commerce/stores/:storeId/booking-resources/:resourceId/availability
 *
 *   Price Rules:
 *     GET    /commerce/stores/:storeId/booking-resources/:resourceId/price-rules
 *     POST   /commerce/stores/:storeId/booking-resources/:resourceId/price-rules
 *     PUT    /commerce/stores/:storeId/booking-resources/:resourceId/price-rules/:ruleId
 *     DELETE /commerce/stores/:storeId/booking-resources/:resourceId/price-rules/:ruleId
 *
 *   Bookings:
 *     GET    /commerce/stores/:storeId/bookings
 *     POST   /commerce/stores/:storeId/bookings
 *     GET    /commerce/stores/:storeId/bookings/:bookingId
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/confirm
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/check-in
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/check-out
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/cancel
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/no-show
 *     GET    /commerce/stores/:storeId/bookings/:bookingId/events
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/modifications
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/modifications/:modId/approve
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/modifications/:modId/reject
 *     GET    /commerce/stores/:storeId/bookings/:bookingId/messages
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/messages
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/check-in-tokens
 *     GET    /commerce/stores/:storeId/bookings/:bookingId/damage-claims
 *     POST   /commerce/stores/:storeId/bookings/:bookingId/damage-claims
 *     PUT    /commerce/stores/:storeId/bookings/:bookingId/damage-claims/:claimId
 *
 *   iCal:
 *     GET    /commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds
 *     POST   /commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds
 *     PUT    /commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds/:feedId
 *     DELETE /commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds/:feedId
 *     GET    /storefront/:storeId/booking-resources/:resourceId/ical.ics  (public)
 *     POST   /commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds/:feedId/import
 *
 *   OTA Channel Providers:
 *     GET    /commerce/stores/:storeId/booking-channel-providers
 *     POST   /commerce/stores/:storeId/booking-channel-providers
 *     PUT    /commerce/stores/:storeId/booking-channel-providers/:providerId
 *     DELETE /commerce/stores/:storeId/booking-channel-providers/:providerId
 *
 *   OTA Channel Listings:
 *     GET    /commerce/stores/:storeId/booking-resources/:resourceId/channel-listings
 *     POST   /commerce/stores/:storeId/booking-resources/:resourceId/channel-listings
 *     PUT    /commerce/stores/:storeId/booking-resources/:resourceId/channel-listings/:listingId
 *     DELETE /commerce/stores/:storeId/booking-resources/:resourceId/channel-listings/:listingId
 *     POST   /commerce/stores/:storeId/booking-resources/:resourceId/channel-listings/:listingId/push
 *
 *   Sync Jobs:
 *     GET    /commerce/stores/:storeId/booking-channel-sync-jobs
 *     POST   /commerce/stores/:storeId/booking-channel-sync-jobs
 *
 *   Inbound Webhook:
 *     POST   /webhooks/booking-channels/:channel
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthWrite } from "../../lib/auth/middleware.js";
import { SystemClock } from "../../clock.js";
import {
  listCancellationPolicies,
  getCancellationPolicy,
  createCancellationPolicy,
  updateCancellationPolicy,
  deleteCancellationPolicy,
  upsertCancellationPolicyTranslation,
  listBookingResources,
  getBookingResource,
  createBookingResource,
  updateBookingResource,
  deleteBookingResource,
  upsertBookingResourceTranslation,
  getAvailabilityCalendar,
  setAvailability,
  listPriceRules,
  createPriceRule,
  updatePriceRule,
  deletePriceRule,
  listBookings,
  getBooking,
  createBooking,
  confirmBooking,
  checkInBooking,
  checkOutBooking,
  noShowBooking,
  cancelBooking,
  listBookingEvents,
  createModification,
  approveModification,
  rejectModification,
  listMessages,
  sendMessage,
  generateCheckInToken,
  listDamageClaims,
  createDamageClaim,
  updateDamageClaim,
} from "./service.js";
import {
  listICalFeeds,
  createICalFeed,
  updateICalFeed,
  deleteICalFeed,
  exportICalFeed,
  importICalFeed,
  listChannelProviders,
  createChannelProvider,
  updateChannelProvider,
  deleteChannelProvider,
  listChannelListings,
  createChannelListing,
  updateChannelListing,
  deleteChannelListing,
  pushChannelSync,
  pushARIToProvider,
  logWebhook,
  listSyncJobs,
  enqueueSyncJob,
} from "./ota.js";

const clock = new SystemClock();

// ── Common params ──────────────────────────────────────────────────────────────

const StoreParams = z.object({
  storeId: z.string().uuid(),
});

const StorePolicyParams = z.object({
  storeId: z.string().uuid(),
  policyId: z.string().uuid(),
});

const StorePolicyLocaleParams = z.object({
  storeId: z.string().uuid(),
  policyId: z.string().uuid(),
  locale: z.string().min(2).max(10),
});

const StoreResourceParams = z.object({
  storeId: z.string().uuid(),
  resourceId: z.string().uuid(),
});

const StoreResourceLocaleParams = z.object({
  storeId: z.string().uuid(),
  resourceId: z.string().uuid(),
  locale: z.string().min(2).max(10),
});

const StoreResourceRuleParams = z.object({
  storeId: z.string().uuid(),
  resourceId: z.string().uuid(),
  ruleId: z.string().uuid(),
});

const StoreBookingParams = z.object({
  storeId: z.string().uuid(),
  bookingId: z.string().uuid(),
});

const StoreBookingModParams = z.object({
  storeId: z.string().uuid(),
  bookingId: z.string().uuid(),
  modId: z.string().uuid(),
});

const StoreBookingClaimParams = z.object({
  storeId: z.string().uuid(),
  bookingId: z.string().uuid(),
  claimId: z.string().uuid(),
});

const StoreResourceFeedParams = z.object({
  storeId: z.string().uuid(),
  resourceId: z.string().uuid(),
  feedId: z.string().uuid(),
});

const StoreProviderParams = z.object({
  storeId: z.string().uuid(),
  providerId: z.string().uuid(),
});

const StoreResourceListingParams = z.object({
  storeId: z.string().uuid(),
  resourceId: z.string().uuid(),
  listingId: z.string().uuid(),
});

const StoreListingParams = z.object({
  storeId: z.string().uuid(),
  listingId: z.string().uuid(),
});

// ── Error code mapping ─────────────────────────────────────────────────────────

function httpError(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND", message: err.message };
    if (code === "CONFLICT") return { status: 409, code: "CONFLICT", message: err.message };
    if (code === "VALIDATION_ERROR") return { status: 400, code: "VALIDATION_ERROR", message: err.message };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "An unexpected error occurred" };
}

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const bookingsPlugin: FastifyPluginAsync = async (app) => {

  // ────────────────────────────────────────────────────────────────────────────
  // CANCELLATION POLICIES
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/booking-policies",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      try {
        const policies = await listCancellationPolicies(storeId);
        return reply.send({ policies });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-policies",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      const Body = z.object({
        name: z.string().min(1).max(500),
        type: z.enum(["flexible", "moderate", "strict", "super_strict", "non_refundable", "custom"]).optional(),
        rules: z.array(z.object({ hours_before: z.number(), refund_pct: z.number() })).optional(),
        description: z.string().max(2000).optional(),
        is_default: z.boolean().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const policy = await createCancellationPolicy(storeId, body);
        return reply.status(201).send({ policy });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.get(
    "/commerce/stores/:storeId/booking-policies/:policyId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, policyId } = StorePolicyParams.parse(request.params);
      try {
        const policy = await getCancellationPolicy(storeId, policyId);
        return reply.send({ policy });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/booking-policies/:policyId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, policyId } = StorePolicyParams.parse(request.params);
      const Body = z.object({
        name: z.string().min(1).max(500).optional(),
        type: z.enum(["flexible", "moderate", "strict", "super_strict", "non_refundable", "custom"]).optional(),
        rules: z.array(z.object({ hours_before: z.number(), refund_pct: z.number() })).optional(),
        description: z.string().max(2000).optional().nullable(),
        is_default: z.boolean().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const policy = await updateCancellationPolicy(storeId, policyId, body);
        return reply.send({ policy });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/booking-policies/:policyId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, policyId } = StorePolicyParams.parse(request.params);
      try {
        await deleteCancellationPolicy(storeId, policyId);
        return reply.status(204).send();
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/booking-policies/:policyId/translations/:locale",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { policyId, locale } = StorePolicyLocaleParams.parse(request.params);
      const Body = z.object({
        name: z.string().max(500).optional(),
        description: z.string().max(2000).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const translation = await upsertCancellationPolicyTranslation(policyId, locale, body);
        return reply.send({ translation });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // BOOKING RESOURCES
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/booking-resources",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      const Query = z.object({
        is_active: z.coerce.boolean().optional(),
        parent_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      });
      const q = Query.parse(request.query);
      try {
        const result = await listBookingResources(storeId, q);
        return reply.send(result);
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-resources",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      const Body = z.object({
        name: z.string().min(1).max(500),
        type: z.enum(["accommodation", "room", "property", "vehicle", "experience", "desk", "equipment", "event_space"]).optional(),
        product_id: z.string().uuid().optional(),
        parent_id: z.string().uuid().optional(),
        capacity: z.number().int().min(1).optional(),
        time_unit: z.enum(["nightly", "daily", "hourly"]).optional(),
        min_duration: z.number().int().min(1).optional(),
        max_duration: z.number().int().min(1).optional(),
        check_in_time: z.string().optional(),
        check_out_time: z.string().optional(),
        buffer_hours: z.number().int().min(0).optional(),
        timezone: z.string().max(100).optional(),
        base_price: z.string().regex(/^\d+(\.\d{1,2})?$/),
        weekend_price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        cleaning_fee: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        extra_guest_fee: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        base_capacity: z.number().int().min(1).optional(),
        security_deposit: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        cancellation_policy_id: z.string().uuid().optional(),
        instant_bookable: z.boolean().optional(),
        address: z.record(z.string(), z.unknown()).optional(),
        coordinates: z.record(z.string(), z.unknown()).optional(),
        amenities: z.array(z.string()).optional(),
        rules: z.record(z.string(), z.unknown()).optional(),
        is_active: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const resource = await createBookingResource(storeId, body);
        return reply.status(201).send({ resource });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.get(
    "/commerce/stores/:storeId/booking-resources/:resourceId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, resourceId } = StoreResourceParams.parse(request.params);
      try {
        const resource = await getBookingResource(storeId, resourceId);
        return reply.send({ resource });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/booking-resources/:resourceId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, resourceId } = StoreResourceParams.parse(request.params);
      const Body = z.object({
        name: z.string().min(1).max(500).optional(),
        type: z.enum(["accommodation", "room", "property", "vehicle", "experience", "desk", "equipment", "event_space"]).optional(),
        product_id: z.string().uuid().optional().nullable(),
        parent_id: z.string().uuid().optional().nullable(),
        capacity: z.number().int().min(1).optional(),
        time_unit: z.enum(["nightly", "daily", "hourly"]).optional(),
        min_duration: z.number().int().min(1).optional(),
        max_duration: z.number().int().min(1).optional().nullable(),
        check_in_time: z.string().optional().nullable(),
        check_out_time: z.string().optional().nullable(),
        buffer_hours: z.number().int().min(0).optional(),
        timezone: z.string().max(100).optional(),
        base_price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        weekend_price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional().nullable(),
        cleaning_fee: z.string().regex(/^\d+(\.\d{1,2})?$/).optional().nullable(),
        extra_guest_fee: z.string().regex(/^\d+(\.\d{1,2})?$/).optional().nullable(),
        base_capacity: z.number().int().min(1).optional(),
        security_deposit: z.string().regex(/^\d+(\.\d{1,2})?$/).optional().nullable(),
        cancellation_policy_id: z.string().uuid().optional().nullable(),
        instant_bookable: z.boolean().optional(),
        address: z.record(z.string(), z.unknown()).optional().nullable(),
        coordinates: z.record(z.string(), z.unknown()).optional().nullable(),
        amenities: z.array(z.string()).optional(),
        rules: z.record(z.string(), z.unknown()).optional(),
        is_active: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const resource = await updateBookingResource(storeId, resourceId, body);
        return reply.send({ resource });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/booking-resources/:resourceId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, resourceId } = StoreResourceParams.parse(request.params);
      try {
        await deleteBookingResource(storeId, resourceId);
        return reply.status(204).send();
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/booking-resources/:resourceId/translations/:locale",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId, locale } = StoreResourceLocaleParams.parse(request.params);
      const Body = z.object({
        name: z.string().max(500).optional(),
        description: z.string().max(5000).optional(),
        rules_text: z.string().max(5000).optional(),
        amenities_labels: z.record(z.string(), z.string()).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const translation = await upsertBookingResourceTranslation(resourceId, locale, body);
        return reply.send({ translation });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // AVAILABILITY
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/booking-resources/:resourceId/availability",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      const Query = z.object({
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      });
      const q = Query.parse(request.query);
      try {
        const availability = await getAvailabilityCalendar(resourceId, q.start, q.end);
        return reply.send({ availability });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-resources/:resourceId/availability",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      const EntrySchema = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        is_available: z.boolean(),
        custom_price: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        min_duration: z.number().int().min(1).optional(),
        notes: z.string().max(500).optional(),
        source: z.enum(["manual", "ical", "api", "channel"]).optional(),
      });
      const Body = z.object({
        entries: z.array(EntrySchema).min(1).max(366),
      });
      const { entries } = Body.parse(request.body);
      try {
        await setAvailability(resourceId, entries);
        return reply.status(204).send();
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // PRICE RULES
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/booking-resources/:resourceId/price-rules",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      try {
        const rules = await listPriceRules(resourceId);
        return reply.send({ rules });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-resources/:resourceId/price-rules",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      const Body = z.object({
        name: z.string().min(1).max(500),
        type: z.enum(["weekend", "seasonal", "last_minute", "early_bird", "length_of_stay", "occupancy_based", "custom"]),
        min_occupancy_pct: z.number().int().min(0).max(100).optional(),
        starts_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        ends_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        days_of_week: z.array(z.number().int().min(0).max(6)).optional(),
        days_before_min: z.number().int().min(0).optional(),
        days_before_max: z.number().int().min(0).optional(),
        min_duration: z.number().int().min(1).optional(),
        adjustment_type: z.enum(["percentage", "fixed"]).optional(),
        adjustment_value: z.string().regex(/^-?\d+(\.\d{1,4})?$/),
        priority: z.number().int().min(0).optional(),
        is_active: z.boolean().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const rule = await createPriceRule(resourceId, body);
        return reply.status(201).send({ rule });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/booking-resources/:resourceId/price-rules/:ruleId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId, ruleId } = StoreResourceRuleParams.parse(request.params);
      const Body = z.object({
        name: z.string().min(1).max(500).optional(),
        type: z.enum(["weekend", "seasonal", "last_minute", "early_bird", "length_of_stay", "occupancy_based", "custom"]).optional(),
        min_occupancy_pct: z.number().int().min(0).max(100).optional().nullable(),
        starts_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
        ends_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
        days_of_week: z.array(z.number().int().min(0).max(6)).optional().nullable(),
        days_before_min: z.number().int().min(0).optional().nullable(),
        days_before_max: z.number().int().min(0).optional().nullable(),
        min_duration: z.number().int().min(1).optional().nullable(),
        adjustment_type: z.enum(["percentage", "fixed"]).optional(),
        adjustment_value: z.string().regex(/^-?\d+(\.\d{1,4})?$/).optional(),
        priority: z.number().int().min(0).optional(),
        is_active: z.boolean().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const rule = await updatePriceRule(resourceId, ruleId, body);
        return reply.send({ rule });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/booking-resources/:resourceId/price-rules/:ruleId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId, ruleId } = StoreResourceRuleParams.parse(request.params);
      try {
        await deletePriceRule(resourceId, ruleId);
        return reply.status(204).send();
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // BOOKINGS
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/bookings",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      const Query = z.object({
        status: z.string().optional(),
        resource_id: z.string().uuid().optional(),
        customer_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      });
      const q = Query.parse(request.query);
      try {
        const result = await listBookings(storeId, q);
        return reply.send(result);
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      const Body = z.object({
        resource_id: z.string().uuid(),
        customer_id: z.string().uuid().optional(),
        check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        num_guests: z.number().int().min(1).optional(),
        guest_name: z.string().max(500).optional(),
        guest_email: z.string().email().optional(),
        guest_phone: z.string().max(50).optional(),
        source_channel: z.enum([
          "direct", "airbnb", "booking_com", "expedia", "vrbo",
          "hotels_com", "tripadvisor", "google", "google_vacation_rentals",
          "google_reserve", "api", "pos",
        ]).optional(),
        channel_reservation_id: z.string().max(200).optional(),
        channel_listing_id: z.string().uuid().optional(),
        special_requests: z.string().max(5000).optional(),
        currency: z.string().length(3).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body);
      const userId = (request as { auth?: { userId?: string } }).auth?.userId;
      try {
        const booking = await createBooking(storeId, body, clock, userId);
        return reply.status(201).send({ booking });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.get(
    "/commerce/stores/:storeId/bookings/:bookingId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      try {
        const booking = await getBooking(storeId, bookingId);
        return reply.send({ booking });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/confirm",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      try {
        const booking = await confirmBooking(storeId, bookingId);
        return reply.send({ booking });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/check-in",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      try {
        const booking = await checkInBooking(storeId, bookingId);
        return reply.send({ booking });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/check-out",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      try {
        const booking = await checkOutBooking(storeId, bookingId);
        return reply.send({ booking });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/cancel",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      const Body = z.object({
        reason: z.string().max(2000).optional(),
      });
      const { reason } = Body.parse(request.body ?? {});
      try {
        const result = await cancelBooking(storeId, bookingId, reason, clock);
        return reply.send(result);
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/no-show",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      try {
        const booking = await noShowBooking(storeId, bookingId);
        return reply.send({ booking });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.get(
    "/commerce/stores/:storeId/bookings/:bookingId/events",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      try {
        const events = await listBookingEvents(storeId, bookingId);
        return reply.send({ events });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ── Modifications ────────────────────────────────────────────────────────────

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/modifications",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      const Body = z.object({
        new_check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        new_check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        new_num_guests: z.number().int().min(1).optional(),
        new_resource_id: z.string().uuid().optional(),
        notes: z.string().max(2000).optional(),
        requested_by: z.string().uuid().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const modification = await createModification(storeId, bookingId, body);
        return reply.status(201).send({ modification });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/modifications/:modId/approve",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId, modId } = StoreBookingModParams.parse(request.params);
      try {
        const modification = await approveModification(storeId, modId);
        // suppress unused bookingId lint — route param kept for URL readability
        void bookingId;
        return reply.send({ modification });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/modifications/:modId/reject",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId, modId } = StoreBookingModParams.parse(request.params);
      try {
        const modification = await rejectModification(storeId, modId);
        void bookingId;
        return reply.send({ modification });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ── Messages ─────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/bookings/:bookingId/messages",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      try {
        const messages = await listMessages(storeId, bookingId);
        return reply.send({ messages });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/messages",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      const Body = z.object({
        sender_id: z.string().uuid().optional(),
        sender_role: z.enum(["guest", "host", "system"]),
        body: z.string().min(1).max(5000),
      });
      const body = Body.parse(request.body);
      try {
        const msg = await sendMessage(storeId, bookingId, body);
        return reply.status(201).send({ message: msg });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ── Check-in tokens ───────────────────────────────────────────────────────────

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/check-in-tokens",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      const Body = z.object({
        access_type: z.enum(["check_in", "check_out", "full_stay"]).optional(),
        valid_from: z.string().optional(),
        valid_until: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body ?? {});
      try {
        const token = await generateCheckInToken(storeId, bookingId, body);
        return reply.status(201).send({ token });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ── Damage Claims ─────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/bookings/:bookingId/damage-claims",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      try {
        const claims = await listDamageClaims(storeId, bookingId);
        return reply.send({ claims });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/bookings/:bookingId/damage-claims",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId } = StoreBookingParams.parse(request.params);
      const Body = z.object({
        reported_by: z.string().uuid().optional(),
        description: z.string().min(1).max(5000),
        claim_amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
        evidence: z.unknown().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const claim = await createDamageClaim(storeId, bookingId, body);
        return reply.status(201).send({ claim });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/bookings/:bookingId/damage-claims/:claimId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, bookingId, claimId } = StoreBookingClaimParams.parse(request.params);
      void bookingId;
      const Body = z.object({
        status: z.enum(["open", "evidence_requested", "disputed", "approved", "rejected", "paid"]).optional(),
        resolution_notes: z.string().max(5000).optional(),
        resolved_at: z.string().optional(),
      });
      const body = Body.parse(request.body);
      try {
        // Cast status type to satisfy our service's type (which uses the DB enum)
        const claim = await updateDamageClaim(storeId, claimId, body as Parameters<typeof updateDamageClaim>[2]);
        return reply.send({ claim });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // ICAL FEEDS
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      try {
        const feeds = await listICalFeeds(resourceId);
        return reply.send({ feeds });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      const Body = z.object({
        channel: z.string().min(1).max(100),
        direction: z.enum(["import", "export"]),
        url: z.string().url().optional(),
        sync_interval_minutes: z.number().int().min(15).max(1440).optional(),
        is_active: z.boolean().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const feed = await createICalFeed(resourceId, body);
        return reply.status(201).send({ feed });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds/:feedId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId, feedId } = StoreResourceFeedParams.parse(request.params);
      const Body = z.object({
        url: z.string().url().optional().nullable(),
        sync_interval_minutes: z.number().int().min(15).max(1440).optional(),
        is_active: z.boolean().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const feed = await updateICalFeed(resourceId, feedId, body);
        return reply.send({ feed });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds/:feedId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId, feedId } = StoreResourceFeedParams.parse(request.params);
      try {
        await deleteICalFeed(resourceId, feedId);
        return reply.status(204).send();
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // Public iCal export (no auth required — used by OTA subscriptions)
  app.get(
    "/storefront/:storeId/booking-resources/:resourceId/ical.ics",
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      try {
        const icalText = await exportICalFeed(resourceId);
        return reply
          .header("Content-Type", "text/calendar; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="calendar-${resourceId}.ics"`)
          .send(icalText);
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // Import endpoint: accepts raw iCal text or JSON with ical_text field
  app.post(
    "/commerce/stores/:storeId/booking-resources/:resourceId/ical-feeds/:feedId/import",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId, feedId } = StoreResourceFeedParams.parse(request.params);
      // Accept raw text/calendar body or JSON { ical_text: string }
      let icalText: string;
      const contentType = request.headers["content-type"] ?? "";
      if (contentType.includes("text/calendar") || contentType.includes("text/plain")) {
        icalText = request.body as string;
      } else {
        const Body = z.object({ ical_text: z.string().min(1) });
        const parsed = Body.parse(request.body);
        icalText = parsed.ical_text;
      }
      try {
        const run = await importICalFeed(resourceId, feedId, icalText);
        return reply.send({ run });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // OTA CHANNEL PROVIDERS
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/booking-channel-providers",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      try {
        const providers = await listChannelProviders(storeId);
        return reply.send({ providers });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-channel-providers",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      const Body = z.object({
        provider_type: z.enum(["direct_ota", "channel_manager"]).optional(),
        channel: z.string().min(1).max(100),
        name: z.string().min(1).max(500),
        api_key: z.string().max(2000).optional(),
        api_secret: z.string().max(2000).optional(),
        webhook_secret: z.string().max(2000).optional(),
        access_token: z.string().max(2000).optional(),
        refresh_token: z.string().max(2000).optional(),
        token_expires_at: z.string().optional(),
        push_rates: z.boolean().optional(),
        push_availability: z.boolean().optional(),
        status: z.enum(["active", "error", "disconnected", "pending_auth"]).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const provider = await createChannelProvider(storeId, body);
        return reply.status(201).send({ provider });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/booking-channel-providers/:providerId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, providerId } = StoreProviderParams.parse(request.params);
      const Body = z.object({
        name: z.string().min(1).max(500).optional(),
        api_key: z.string().max(2000).optional().nullable(),
        api_secret: z.string().max(2000).optional().nullable(),
        webhook_secret: z.string().max(2000).optional().nullable(),
        access_token: z.string().max(2000).optional().nullable(),
        refresh_token: z.string().max(2000).optional().nullable(),
        token_expires_at: z.string().optional().nullable(),
        push_rates: z.boolean().optional(),
        push_availability: z.boolean().optional(),
        status: z.enum(["active", "error", "disconnected", "pending_auth"]).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const provider = await updateChannelProvider(storeId, providerId, body);
        return reply.send({ provider });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/booking-channel-providers/:providerId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, providerId } = StoreProviderParams.parse(request.params);
      try {
        await deleteChannelProvider(storeId, providerId);
        return reply.status(204).send();
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // OTA CHANNEL LISTINGS
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/booking-resources/:resourceId/channel-listings",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      try {
        const listings = await listChannelListings(resourceId);
        return reply.send({ listings });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-resources/:resourceId/channel-listings",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId } = StoreResourceParams.parse(request.params);
      const Body = z.object({
        channel: z.string().min(1).max(100),
        channel_listing_id: z.string().max(500).optional(),
        channel_property_id: z.string().max(500).optional(),
        sync_rates: z.boolean().optional(),
        sync_availability: z.boolean().optional(),
        sync_restrictions: z.boolean().optional(),
        markup_pct: z.string().regex(/^-?\d+(\.\d{1,4})?$/).optional(),
        status: z.enum(["active", "paused", "error", "disconnected"]).optional(),
        managed_by_provider_id: z.string().uuid().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const listing = await createChannelListing(resourceId, body);
        return reply.status(201).send({ listing });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.put(
    "/commerce/stores/:storeId/booking-resources/:resourceId/channel-listings/:listingId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId, listingId } = StoreResourceListingParams.parse(request.params);
      const Body = z.object({
        channel_listing_id: z.string().max(500).optional().nullable(),
        channel_property_id: z.string().max(500).optional().nullable(),
        sync_rates: z.boolean().optional(),
        sync_availability: z.boolean().optional(),
        sync_restrictions: z.boolean().optional(),
        markup_pct: z.string().regex(/^-?\d+(\.\d{1,4})?$/).optional().nullable(),
        status: z.enum(["active", "paused", "error", "disconnected"]).optional(),
        managed_by_provider_id: z.string().uuid().optional().nullable(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const listing = await updateChannelListing(resourceId, listingId, body);
        return reply.send({ listing });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.delete(
    "/commerce/stores/:storeId/booking-resources/:resourceId/channel-listings/:listingId",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { resourceId, listingId } = StoreResourceListingParams.parse(request.params);
      try {
        await deleteChannelListing(resourceId, listingId);
        return reply.status(204).send();
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-resources/:resourceId/channel-listings/:listingId/push",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, resourceId, listingId } = StoreResourceListingParams.parse(request.params);
      void resourceId;
      try {
        const result = await pushChannelSync(storeId, listingId);
        return reply.send(result);
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // Direct ARI push for a window — drives the generic OTA ARI adapter
  // (pushARIToProvider) for an explicit date window + optional provider override.
  app.post(
    "/commerce/stores/:storeId/booking-channel-listings/:listingId/push-ari",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId, listingId } = StoreListingParams.parse(request.params);
      const Body = z.object({
        window_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        window_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        provider_id: z.string().uuid().optional(),
      });
      const body = Body.parse(request.body);
      try {
        const result = await pushARIToProvider(
          storeId,
          listingId,
          body.window_start,
          body.window_end,
          body.provider_id
        );
        return reply.send(result);
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // SYNC JOBS
  // ────────────────────────────────────────────────────────────────────────────

  app.get(
    "/commerce/stores/:storeId/booking-channel-sync-jobs",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      const Query = z.object({
        status: z.string().optional(),
        channel: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      });
      const q = Query.parse(request.query);
      try {
        const result = await listSyncJobs(storeId, q);
        return reply.send(result);
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  app.post(
    "/commerce/stores/:storeId/booking-channel-sync-jobs",
    { preHandler: storeAuthWrite("bookings") },
    async (request, reply) => {
      const { storeId } = StoreParams.parse(request.params);
      const Body = z.object({
        channel_listing_id: z.string().uuid().optional(),
        provider_id: z.string().uuid().optional(),
        channel: z.string().min(1).max(100),
        job_type: z.enum([
          "push_availability", "push_rates", "push_restrictions",
          "push_listing", "pull_reservations", "pull_rates", "full_refresh",
        ]),
        window_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        window_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        priority: z.number().int().min(0).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      });
      const body = Body.parse(request.body);
      try {
        const job = await enqueueSyncJob(storeId, body);
        return reply.status(201).send({ job });
      } catch (err) {
        const { status, code, message } = httpError(err);
        return reply.status(status).send({ error: { code, message } });
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // INBOUND CHANNEL WEBHOOK (no auth — OTA pushes here)
  // ────────────────────────────────────────────────────────────────────────────

  app.post(
    "/webhooks/booking-channels/:channel",
    async (request, reply) => {
      const { channel } = z.object({ channel: z.string().min(1).max(100) }).parse(request.params);
      const startAt = Date.now();
      let rawBody: string;
      try {
        rawBody = JSON.stringify(request.body ?? {});
      } catch {
        rawBody = String(request.body ?? "");
      }
      // Truncate at 64 KB
      if (rawBody.length > 65536) rawBody = rawBody.slice(0, 65536);

      // Extract common fields from body (best-effort)
      const bodyObj = (typeof request.body === "object" && request.body !== null)
        ? (request.body as Record<string, unknown>)
        : {};
      const eventType = String(bodyObj["event"] ?? bodyObj["type"] ?? bodyObj["event_type"] ?? "webhook");
      const channelReservationId = typeof bodyObj["reservation_id"] === "string"
        ? bodyObj["reservation_id"]
        : null;

      await logWebhook(
        null, // store_id — can be resolved later from channel_reservation_id
        channel,
        eventType,
        request.method,
        request.url,
        request.headers as Record<string, string>,
        rawBody,
        channelReservationId
      );

      const duration = Date.now() - startAt;
      return reply.send({ received: true, duration_ms: duration });
    }
  );
};
