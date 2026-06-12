/**
 * bookings/service.ts — Full business logic for the bookings module.
 *
 * Covers: cancellation policies, booking resources, availability calendar,
 * price rules, price computation engine, booking lifecycle, modifications,
 * messages, check-in tokens, and damage claims.
 *
 * Money: numeric(15,2) in DB, string in TypeScript API payloads.
 * All IDs: uuid text strings (cast with ::uuid in SQL).
 */

import { randomBytes } from "node:crypto";
import { getPool, withTx } from "../../db/pool.js";
import type { Clock } from "../../clock.js";
import type {
  CancellationPolicy,
  CancellationPolicyTranslation,
  CreateCancellationPolicyInput,
  UpdateCancellationPolicyInput,
  UpsertCancellationPolicyTranslationInput,
  BookingResource,
  BookingResourceTranslation,
  CreateBookingResourceInput,
  UpdateBookingResourceInput,
  UpsertBookingResourceTranslationInput,
  BookingAvailability,
  SetAvailabilityInput,
  BookingPriceRule,
  CreatePriceRuleInput,
  UpdatePriceRuleInput,
  BookingPriceResult,
  Booking,
  CreateBookingInput,
  BookingEvent,
  BookingModification,
  CreateModificationInput,
  BookingMessage,
  SendMessageInput,
  CheckInToken,
  GenerateCheckInTokenInput,
  DamageClaim,
  CreateDamageClaimInput,
  UpdateDamageClaimInput,
  CancelBookingResult,
} from "./types.js";

// ── Column helpers ─────────────────────────────────────────────────────────────

const POLICY_COLS = `
  id::text, store_id::text, name, type, rules, description, is_default,
  created_at, updated_at
`;

const RESOURCE_COLS = `
  id::text, store_id::text, product_id::text, name, type, parent_id::text,
  capacity, time_unit, min_duration, max_duration,
  check_in_time::text, check_out_time::text, buffer_hours, timezone,
  base_price::text, weekend_price::text, cleaning_fee::text,
  extra_guest_fee::text, base_capacity, security_deposit::text,
  cancellation_policy_id::text, instant_bookable,
  address, coordinates, amenities, rules, is_active, metadata,
  deleted_at, created_at, updated_at
`;

const BOOKING_COLS = `
  id::text, store_id::text, resource_id::text, customer_id::text, order_id::text,
  booking_number, check_in::text, check_out::text,
  check_in_time::text, check_out_time::text, num_guests,
  guest_name, guest_email, guest_phone, status,
  nightly_rate::text, cleaning_fee::text, extra_guest_fee::text,
  security_deposit::text, total_nights, subtotal::text, total::text, currency,
  source_channel, channel_reservation_id, channel_listing_id::text,
  cancellation_policy_id::text, special_requests, arrival_instructions,
  internal_notes, tax_lines, tax_amount::text,
  confirmed_at, cancelled_at, cancel_reason, deleted_at, metadata,
  created_at, updated_at
`;

// ── Error helpers ──────────────────────────────────────────────────────────────

function notFound(msg: string): Error {
  const e = new Error(msg);
  (e as NodeJS.ErrnoException).code = "NOT_FOUND";
  return e;
}

function conflict(msg: string): Error {
  const e = new Error(msg);
  (e as NodeJS.ErrnoException).code = "CONFLICT";
  return e;
}

function validation(msg: string): Error {
  const e = new Error(msg);
  (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
  return e;
}

// ── Cancellation Policies ──────────────────────────────────────────────────────

export async function listCancellationPolicies(
  storeId: string
): Promise<CancellationPolicy[]> {
  const pool = getPool();
  const { rows } = await pool.query<CancellationPolicy>(
    `SELECT ${POLICY_COLS} FROM cancellation_policies
     WHERE store_id = $1::uuid ORDER BY created_at ASC`,
    [storeId]
  );
  return rows;
}

export async function getCancellationPolicy(
  storeId: string,
  id: string
): Promise<CancellationPolicy> {
  const pool = getPool();
  const { rows } = await pool.query<CancellationPolicy>(
    `SELECT ${POLICY_COLS} FROM cancellation_policies
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [id, storeId]
  );
  if (!rows[0]) throw notFound("cancellation policy not found");
  return rows[0];
}

export async function createCancellationPolicy(
  storeId: string,
  input: CreateCancellationPolicyInput
): Promise<CancellationPolicy> {
  const pool = getPool();
  const { rows } = await pool.query<CancellationPolicy>(
    `INSERT INTO cancellation_policies (store_id, name, type, rules, description, is_default)
     VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6)
     RETURNING ${POLICY_COLS}`,
    [
      storeId,
      input.name,
      input.type ?? "moderate",
      JSON.stringify(input.rules ?? []),
      input.description ?? null,
      input.is_default ?? false,
    ]
  );
  if (!rows[0]) throw new Error("createCancellationPolicy: no row returned");
  return rows[0];
}

export async function updateCancellationPolicy(
  storeId: string,
  id: string,
  input: UpdateCancellationPolicyInput
): Promise<CancellationPolicy> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [id, storeId];
  let n = 3;

  if (input.name !== undefined) { sets.push(`name = $${n++}`); args.push(input.name); }
  if (input.type !== undefined) { sets.push(`type = $${n++}`); args.push(input.type); }
  if (input.rules !== undefined) { sets.push(`rules = $${n++}::jsonb`); args.push(JSON.stringify(input.rules)); }
  if (input.description !== undefined) { sets.push(`description = $${n++}`); args.push(input.description); }
  if (input.is_default !== undefined) { sets.push(`is_default = $${n++}`); args.push(input.is_default); }

  const { rows } = await pool.query<CancellationPolicy>(
    `UPDATE cancellation_policies SET ${sets.join(", ")}
     WHERE id = $1::uuid AND store_id = $2::uuid
     RETURNING ${POLICY_COLS}`,
    args
  );
  if (!rows[0]) throw notFound("cancellation policy not found");
  return rows[0];
}

export async function deleteCancellationPolicy(
  storeId: string,
  id: string
): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM cancellation_policies WHERE id = $1::uuid AND store_id = $2::uuid`,
    [id, storeId]
  );
  if (!rowCount) throw notFound("cancellation policy not found");
}

export async function upsertCancellationPolicyTranslation(
  policyId: string,
  locale: string,
  input: UpsertCancellationPolicyTranslationInput
): Promise<CancellationPolicyTranslation> {
  const pool = getPool();
  const { rows } = await pool.query<CancellationPolicyTranslation>(
    `INSERT INTO cancellation_policy_translations (policy_id, locale, name, description)
     VALUES ($1::uuid, $2, $3, $4)
     ON CONFLICT (policy_id, locale) DO UPDATE
       SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()
     RETURNING id::text, policy_id::text, locale, name, description, created_at, updated_at`,
    [policyId, locale, input.name ?? null, input.description ?? null]
  );
  if (!rows[0]) throw new Error("upsertCancellationPolicyTranslation: no row returned");
  return rows[0];
}

// ── Booking Resources ──────────────────────────────────────────────────────────

export interface ListBookingResourcesOpts {
  is_active?: boolean | undefined;
  parent_id?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listBookingResources(
  storeId: string,
  opts: ListBookingResourcesOpts = {}
): Promise<{ resources: BookingResource[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const where = ["store_id = $1::uuid", "deleted_at IS NULL"];
  const args: unknown[] = [storeId];
  let n = 2;

  if (opts.is_active !== undefined) { where.push(`is_active = $${n++}`); args.push(opts.is_active); }
  if (opts.parent_id !== undefined) { where.push(`parent_id = $${n++}::uuid`); args.push(opts.parent_id); }

  const w = where.join(" AND ");
  const [res, cnt] = await Promise.all([
    pool.query<BookingResource>(
      `SELECT ${RESOURCE_COLS} FROM booking_resources WHERE ${w} ORDER BY created_at ASC LIMIT $${n} OFFSET $${n+1}`,
      [...args, limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM booking_resources WHERE ${w}`, args
    ),
  ]);
  return { resources: res.rows, total: parseInt(cnt.rows[0]?.count ?? "0", 10) };
}

export async function getBookingResource(
  storeId: string,
  id: string
): Promise<BookingResource> {
  const pool = getPool();
  const { rows } = await pool.query<BookingResource>(
    `SELECT ${RESOURCE_COLS} FROM booking_resources
     WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [id, storeId]
  );
  if (!rows[0]) throw notFound("booking resource not found");
  return rows[0];
}

export async function createBookingResource(
  storeId: string,
  input: CreateBookingResourceInput
): Promise<BookingResource> {
  const pool = getPool();
  const { rows } = await pool.query<BookingResource>(
    `INSERT INTO booking_resources
       (store_id, product_id, name, type, parent_id, capacity, time_unit,
        min_duration, max_duration, check_in_time, check_out_time, buffer_hours,
        timezone, base_price, weekend_price, cleaning_fee, extra_guest_fee,
        base_capacity, security_deposit, cancellation_policy_id, instant_bookable,
        address, coordinates, amenities, rules, is_active, metadata)
     VALUES
       ($1::uuid, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12,
        $13, $14::numeric, $15::numeric, $16::numeric, $17::numeric,
        $18, $19::numeric, $20, $21,
        $22::jsonb, $23::jsonb, $24, $25::jsonb, $26, $27::jsonb)
     RETURNING ${RESOURCE_COLS}`,
    [
      storeId,
      input.product_id ?? null,
      input.name,
      input.type ?? "accommodation",
      input.parent_id ?? null,
      input.capacity ?? 1,
      input.time_unit ?? "nightly",
      input.min_duration ?? 1,
      input.max_duration ?? null,
      input.check_in_time ?? null,
      input.check_out_time ?? null,
      input.buffer_hours ?? 0,
      input.timezone ?? "UTC",
      input.base_price,
      input.weekend_price ?? null,
      input.cleaning_fee ?? null,
      input.extra_guest_fee ?? null,
      input.base_capacity ?? 1,
      input.security_deposit ?? null,
      input.cancellation_policy_id ?? null,
      input.instant_bookable ?? false,
      JSON.stringify(input.address ?? null),
      JSON.stringify(input.coordinates ?? null),
      input.amenities ?? [],
      JSON.stringify(input.rules ?? {}),
      input.is_active ?? true,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  if (!rows[0]) throw new Error("createBookingResource: no row returned");
  return rows[0];
}

export async function updateBookingResource(
  storeId: string,
  id: string,
  input: UpdateBookingResourceInput
): Promise<BookingResource> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [id, storeId];
  let n = 3;

  const add = (col: string, val: unknown, cast = "") => {
    sets.push(`${col} = $${n++}${cast}`);
    args.push(val);
  };

  if (input.name !== undefined) add("name", input.name);
  if (input.type !== undefined) add("type", input.type);
  if ("product_id" in input) add("product_id", input.product_id ?? null);
  if ("parent_id" in input) add("parent_id", input.parent_id ?? null);
  if (input.capacity !== undefined) add("capacity", input.capacity);
  if (input.time_unit !== undefined) add("time_unit", input.time_unit);
  if (input.min_duration !== undefined) add("min_duration", input.min_duration);
  if ("max_duration" in input) add("max_duration", input.max_duration ?? null);
  if ("check_in_time" in input) add("check_in_time", input.check_in_time ?? null);
  if ("check_out_time" in input) add("check_out_time", input.check_out_time ?? null);
  if (input.buffer_hours !== undefined) add("buffer_hours", input.buffer_hours);
  if (input.timezone !== undefined) add("timezone", input.timezone);
  if (input.base_price !== undefined) add("base_price", input.base_price, "::numeric");
  if ("weekend_price" in input) add("weekend_price", input.weekend_price ?? null, "::numeric");
  if ("cleaning_fee" in input) add("cleaning_fee", input.cleaning_fee ?? null, "::numeric");
  if ("extra_guest_fee" in input) add("extra_guest_fee", input.extra_guest_fee ?? null, "::numeric");
  if (input.base_capacity !== undefined) add("base_capacity", input.base_capacity);
  if ("security_deposit" in input) add("security_deposit", input.security_deposit ?? null, "::numeric");
  if ("cancellation_policy_id" in input) add("cancellation_policy_id", input.cancellation_policy_id ?? null);
  if (input.instant_bookable !== undefined) add("instant_bookable", input.instant_bookable);
  if ("address" in input) add("address", JSON.stringify(input.address ?? null), "::jsonb");
  if ("coordinates" in input) add("coordinates", JSON.stringify(input.coordinates ?? null), "::jsonb");
  if (input.amenities !== undefined) add("amenities", input.amenities);
  if (input.rules !== undefined) add("rules", JSON.stringify(input.rules), "::jsonb");
  if (input.is_active !== undefined) add("is_active", input.is_active);
  if (input.metadata !== undefined) add("metadata", JSON.stringify(input.metadata), "::jsonb");

  const { rows } = await pool.query<BookingResource>(
    `UPDATE booking_resources SET ${sets.join(", ")}
     WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
     RETURNING ${RESOURCE_COLS}`,
    args
  );
  if (!rows[0]) throw notFound("booking resource not found");
  return rows[0];
}

export async function deleteBookingResource(
  storeId: string,
  id: string
): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE booking_resources SET deleted_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [id, storeId]
  );
  if (!rowCount) throw notFound("booking resource not found");
}

export async function upsertBookingResourceTranslation(
  resourceId: string,
  locale: string,
  input: UpsertBookingResourceTranslationInput
): Promise<BookingResourceTranslation> {
  const pool = getPool();
  const { rows } = await pool.query<BookingResourceTranslation>(
    `INSERT INTO booking_resource_translations
       (resource_id, locale, name, description, rules_text, amenities_labels)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (resource_id, locale) DO UPDATE
       SET name = EXCLUDED.name, description = EXCLUDED.description,
           rules_text = EXCLUDED.rules_text, amenities_labels = EXCLUDED.amenities_labels,
           updated_at = now()
     RETURNING id::text, resource_id::text, locale, name, description, rules_text, amenities_labels, created_at, updated_at`,
    [
      resourceId,
      locale,
      input.name ?? null,
      input.description ?? null,
      input.rules_text ?? null,
      JSON.stringify(input.amenities_labels ?? null),
    ]
  );
  if (!rows[0]) throw new Error("upsertBookingResourceTranslation: no row returned");
  return rows[0];
}

// ── Availability Calendar ──────────────────────────────────────────────────────

export async function getAvailabilityCalendar(
  resourceId: string,
  startDate: string,
  endDate: string
): Promise<BookingAvailability[]> {
  const pool = getPool();
  const { rows } = await pool.query<BookingAvailability>(
    `SELECT id::text, resource_id::text, date::text, is_available,
            custom_price::text, min_duration, notes, source
     FROM booking_availability
     WHERE resource_id = $1::uuid AND date >= $2::date AND date <= $3::date
     ORDER BY date ASC`,
    [resourceId, startDate, endDate]
  );
  return rows;
}

export async function setAvailability(
  resourceId: string,
  items: SetAvailabilityInput[]
): Promise<BookingAvailability[]> {
  if (items.length === 0) return [];
  const pool = getPool();
  const results: BookingAvailability[] = [];

  for (const item of items) {
    const { rows } = await pool.query<BookingAvailability>(
      `INSERT INTO booking_availability
         (resource_id, date, is_available, custom_price, min_duration, notes, source)
       VALUES ($1::uuid, $2::date, $3, $4::numeric, $5, $6, $7)
       ON CONFLICT (resource_id, date) DO UPDATE
         SET is_available = EXCLUDED.is_available,
             custom_price = EXCLUDED.custom_price,
             min_duration = EXCLUDED.min_duration,
             notes        = EXCLUDED.notes,
             source       = EXCLUDED.source
       RETURNING id::text, resource_id::text, date::text, is_available,
                 custom_price::text, min_duration, notes, source`,
      [
        resourceId,
        item.date,
        item.is_available,
        item.custom_price ?? null,
        item.min_duration ?? null,
        item.notes ?? null,
        item.source ?? "manual",
      ]
    );
    if (rows[0]) results.push(rows[0]);
  }
  return results;
}

// ── Price Rules ────────────────────────────────────────────────────────────────

export async function listPriceRules(
  resourceId: string
): Promise<BookingPriceRule[]> {
  const pool = getPool();
  const { rows } = await pool.query<BookingPriceRule>(
    `SELECT id::text, resource_id::text, name, type, min_occupancy_pct,
            starts_at::text, ends_at::text, days_of_week, days_before_min,
            days_before_max, min_duration, adjustment_type, adjustment_value::text,
            priority, is_active, created_at, updated_at
     FROM booking_price_rules
     WHERE resource_id = $1::uuid
     ORDER BY priority DESC, created_at ASC`,
    [resourceId]
  );
  return rows;
}

export async function createPriceRule(
  resourceId: string,
  input: CreatePriceRuleInput
): Promise<BookingPriceRule> {
  const pool = getPool();
  const { rows } = await pool.query<BookingPriceRule>(
    `INSERT INTO booking_price_rules
       (resource_id, name, type, min_occupancy_pct, starts_at, ends_at,
        days_of_week, days_before_min, days_before_max, min_duration,
        adjustment_type, adjustment_value, priority, is_active)
     VALUES
       ($1::uuid, $2, $3, $4, $5::date, $6::date,
        $7, $8, $9, $10,
        $11, $12::numeric, $13, $14)
     RETURNING id::text, resource_id::text, name, type, min_occupancy_pct,
               starts_at::text, ends_at::text, days_of_week, days_before_min,
               days_before_max, min_duration, adjustment_type, adjustment_value::text,
               priority, is_active, created_at, updated_at`,
    [
      resourceId,
      input.name,
      input.type,
      input.min_occupancy_pct ?? null,
      input.starts_at ?? null,
      input.ends_at ?? null,
      input.days_of_week ?? null,
      input.days_before_min ?? null,
      input.days_before_max ?? null,
      input.min_duration ?? null,
      input.adjustment_type ?? "percentage",
      input.adjustment_value,
      input.priority ?? 0,
      input.is_active ?? true,
    ]
  );
  if (!rows[0]) throw new Error("createPriceRule: no row returned");
  return rows[0];
}

export async function updatePriceRule(
  resourceId: string,
  id: string,
  input: UpdatePriceRuleInput
): Promise<BookingPriceRule> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [id, resourceId];
  let n = 3;

  const add = (col: string, val: unknown, cast = "") => {
    sets.push(`${col} = $${n++}${cast}`);
    args.push(val);
  };

  if (input.name !== undefined) add("name", input.name);
  if (input.type !== undefined) add("type", input.type);
  if ("min_occupancy_pct" in input) add("min_occupancy_pct", input.min_occupancy_pct ?? null);
  if ("starts_at" in input) add("starts_at", input.starts_at ?? null, "::date");
  if ("ends_at" in input) add("ends_at", input.ends_at ?? null, "::date");
  if ("days_of_week" in input) add("days_of_week", input.days_of_week ?? null);
  if ("days_before_min" in input) add("days_before_min", input.days_before_min ?? null);
  if ("days_before_max" in input) add("days_before_max", input.days_before_max ?? null);
  if ("min_duration" in input) add("min_duration", input.min_duration ?? null);
  if (input.adjustment_type !== undefined) add("adjustment_type", input.adjustment_type);
  if (input.adjustment_value !== undefined) add("adjustment_value", input.adjustment_value, "::numeric");
  if (input.priority !== undefined) add("priority", input.priority);
  if (input.is_active !== undefined) add("is_active", input.is_active);

  const { rows } = await pool.query<BookingPriceRule>(
    `UPDATE booking_price_rules SET ${sets.join(", ")}
     WHERE id = $1::uuid AND resource_id = $2::uuid
     RETURNING id::text, resource_id::text, name, type, min_occupancy_pct,
               starts_at::text, ends_at::text, days_of_week, days_before_min,
               days_before_max, min_duration, adjustment_type, adjustment_value::text,
               priority, is_active, created_at, updated_at`,
    args
  );
  if (!rows[0]) throw notFound("price rule not found");
  return rows[0];
}

export async function deletePriceRule(
  resourceId: string,
  id: string
): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM booking_price_rules WHERE id = $1::uuid AND resource_id = $2::uuid`,
    [id, resourceId]
  );
  if (!rowCount) throw notFound("price rule not found");
}

// ── Price Computation Engine ───────────────────────────────────────────────────

/**
 * computeBookingPrice — applies price rules to determine the total booking cost.
 *
 * Precedence algorithm:
 * 1. Load resource base_price, weekend_price, cleaning_fee, extra_guest_fee, base_capacity.
 * 2. Load all active price rules ordered by priority DESC.
 * 3. For each night n in [checkIn, checkOut):
 *    a. Check booking_availability for custom_price — if set, use it as nightly rate (skip rules).
 *    b. Otherwise start with base_price.
 *    c. Collect all rules that match this night:
 *       - type/date range: if starts_at/ends_at are set, n must fall within [starts_at, ends_at]
 *       - days_of_week: if set, getDay() of n must be in array
 *       - days_before conditions: days until checkIn from clock.now() must be within [days_before_min, days_before_max]
 *       - min_duration: totalNights must be >= min_duration
 *    d. Apply the single highest-priority matching rule (percentage or fixed adjustment).
 *    e. Weekend fallback: if no rule matched and weekend_price is set and day is Fri (5) or Sat (6),
 *       use weekend_price instead.
 * 4. Sum nightly rates → nights_subtotal.
 * 5. Add cleaning_fee once.
 * 6. Extra guest fee: max(0, guests - base_capacity) * extra_guest_fee * total_nights.
 * 7. Total = nights_subtotal + cleaning_fee + extra_guest_fee_total.
 * 8. Return { nightly_rate (avg), cleaning_fee, extra_guest_fee, total_nights, subtotal, total }.
 */
export async function computeBookingPrice(
  resourceId: string,
  checkIn: string,
  checkOut: string,
  guests: number,
  clock: Clock
): Promise<BookingPriceResult> {
  const pool = getPool();

  // Load resource pricing fields
  const { rows: rRows } = await pool.query<{
    base_price: string;
    weekend_price: string | null;
    cleaning_fee: string | null;
    extra_guest_fee: string | null;
    base_capacity: number;
  }>(
    `SELECT base_price::text, weekend_price::text, cleaning_fee::text,
            extra_guest_fee::text, base_capacity
     FROM booking_resources WHERE id = $1::uuid AND deleted_at IS NULL`,
    [resourceId]
  );
  if (!rRows[0]) throw notFound("booking resource not found");
  const resource = rRows[0];

  const basePrice = parseFloat(resource.base_price);
  const weekendPrice = resource.weekend_price ? parseFloat(resource.weekend_price) : null;
  const cleaningFee = resource.cleaning_fee ? parseFloat(resource.cleaning_fee) : 0;
  const extraGuestFeePerNight = resource.extra_guest_fee ? parseFloat(resource.extra_guest_fee) : 0;
  const baseCapacity = resource.base_capacity;

  // Load active price rules ordered by priority DESC
  const { rows: rules } = await pool.query<{
    type: string;
    min_occupancy_pct: number | null;
    starts_at: string | null;
    ends_at: string | null;
    days_of_week: number[] | null;
    days_before_min: number | null;
    days_before_max: number | null;
    min_duration: number | null;
    adjustment_type: string;
    adjustment_value: string;
    priority: number;
  }>(
    `SELECT type, min_occupancy_pct, starts_at::text, ends_at::text, days_of_week,
            days_before_min, days_before_max, min_duration, adjustment_type,
            adjustment_value::text, priority
     FROM booking_price_rules
     WHERE resource_id = $1::uuid AND is_active = true
     ORDER BY priority DESC`,
    [resourceId]
  );

  // Load availability custom prices for the range
  const { rows: avail } = await pool.query<{ date: string; custom_price: string | null }>(
    `SELECT date::text, custom_price::text
     FROM booking_availability
     WHERE resource_id = $1::uuid AND date >= $2::date AND date < $3::date`,
    [resourceId, checkIn, checkOut]
  );
  const customPriceMap = new Map<string, number>();
  for (const a of avail) {
    if (a.custom_price !== null) {
      customPriceMap.set(a.date, parseFloat(a.custom_price));
    }
  }

  // Build night dates: each date d where checkIn <= d < checkOut
  const checkInDate = new Date(checkIn + "T00:00:00Z");
  const checkOutDate = new Date(checkOut + "T00:00:00Z");
  const totalNights = Math.round((checkOutDate.getTime() - checkInDate.getTime()) / 86_400_000);

  if (totalNights <= 0) throw validation("check_out must be after check_in");

  const now = clock.now();
  const daysBeforeCheckIn = Math.floor((checkInDate.getTime() - now.getTime()) / 86_400_000);

  let nightsSubtotal = 0;
  for (let i = 0; i < totalNights; i++) {
    const nightDate = new Date(checkInDate.getTime() + i * 86_400_000);
    const nightStr = nightDate.toISOString().slice(0, 10);

    // Custom price overrides everything
    const cp = customPriceMap.get(nightStr);
    if (cp !== undefined) {
      nightsSubtotal += cp;
      continue;
    }

    // Start with base price, try to match a rule
    let nightRate = basePrice;
    const dayOfWeek = nightDate.getUTCDay();
    let ruleApplied = false;

    for (const rule of rules) {
      // Date range check
      if (rule.starts_at && nightStr < rule.starts_at) continue;
      if (rule.ends_at && nightStr > rule.ends_at) continue;

      // Days of week check
      if (rule.days_of_week && !rule.days_of_week.includes(dayOfWeek)) continue;

      // Days before check-in
      if (rule.days_before_min !== null && daysBeforeCheckIn < rule.days_before_min) continue;
      if (rule.days_before_max !== null && daysBeforeCheckIn > rule.days_before_max) continue;

      // Min duration
      if (rule.min_duration !== null && totalNights < rule.min_duration) continue;

      // Apply this rule (highest priority wins — first match due to ORDER BY priority DESC)
      const adjVal = parseFloat(rule.adjustment_value);
      if (rule.adjustment_type === "percentage") {
        nightRate = basePrice * (1 + adjVal / 100);
      } else {
        nightRate = basePrice + adjVal;
      }
      ruleApplied = true;
      break;
    }

    // Weekend fallback (Fri=5, Sat=6)
    if (!ruleApplied && weekendPrice !== null && (dayOfWeek === 5 || dayOfWeek === 6)) {
      nightRate = weekendPrice;
    }

    nightsSubtotal += Math.max(0, nightRate);
  }

  const extraGuests = Math.max(0, guests - baseCapacity);
  const extraGuestFeeTotal = extraGuests * extraGuestFeePerNight * totalNights;
  const total = nightsSubtotal + cleaningFee + extraGuestFeeTotal;
  const avgNightlyRate = totalNights > 0 ? nightsSubtotal / totalNights : 0;

  return {
    nightly_rate: avgNightlyRate.toFixed(2),
    cleaning_fee: cleaningFee.toFixed(2),
    extra_guest_fee: extraGuestFeeTotal.toFixed(2),
    total_nights: totalNights,
    subtotal: nightsSubtotal.toFixed(2),
    total: total.toFixed(2),
  };
}

// ── Bookings ───────────────────────────────────────────────────────────────────

export interface ListBookingsOpts {
  status?: string | undefined;
  resource_id?: string | undefined;
  customer_id?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listBookings(
  storeId: string,
  opts: ListBookingsOpts = {}
): Promise<{ bookings: Booking[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const where = ["store_id = $1::uuid", "deleted_at IS NULL"];
  const args: unknown[] = [storeId];
  let n = 2;

  if (opts.status) { where.push(`status = $${n++}`); args.push(opts.status); }
  if (opts.resource_id) { where.push(`resource_id = $${n++}::uuid`); args.push(opts.resource_id); }
  if (opts.customer_id) { where.push(`customer_id = $${n++}::uuid`); args.push(opts.customer_id); }

  const w = where.join(" AND ");
  const [res, cnt] = await Promise.all([
    pool.query<Booking>(
      `SELECT ${BOOKING_COLS} FROM bookings WHERE ${w}
       ORDER BY created_at DESC LIMIT $${n} OFFSET $${n+1}`,
      [...args, limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM bookings WHERE ${w}`, args
    ),
  ]);
  return { bookings: res.rows, total: parseInt(cnt.rows[0]?.count ?? "0", 10) };
}

export async function getBooking(
  storeId: string,
  id: string
): Promise<Booking> {
  const pool = getPool();
  const { rows } = await pool.query<Booking>(
    `SELECT ${BOOKING_COLS} FROM bookings
     WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [id, storeId]
  );
  if (!rows[0]) throw notFound("booking not found");
  return rows[0];
}

export async function createBooking(
  storeId: string,
  input: CreateBookingInput,
  clock: Clock,
  userId?: string | undefined
): Promise<Booking> {
  return withTx(async (client) => {
    // Acquire a row-level lock on the resource first.
    // This serializes all concurrent booking attempts for the same resource,
    // preventing phantom inserts from slipping through the overlap check below
    // (which can't lock non-existent rows). Both transactions will wait here;
    // only one proceeds, the other waits and re-checks for overlaps after.
    const { rows: rRows } = await client.query<{
      id: string;
      instant_bookable: boolean;
      cancellation_policy_id: string | null;
      base_price: string;
      security_deposit: string | null;
    }>(
      `SELECT id::text, instant_bookable, cancellation_policy_id::text,
              base_price::text, security_deposit::text
       FROM booking_resources
       WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       FOR UPDATE`,
      [input.resource_id, storeId]
    );
    if (!rRows[0]) throw notFound("booking resource not found or does not belong to store");
    const resource = rRows[0];

    // Check for blocked availability dates
    const { rows: blockedRows } = await client.query<{ date: string }>(
      `SELECT date::text FROM booking_availability
       WHERE resource_id = $1::uuid
         AND date >= $2::date
         AND date < $3::date
         AND is_available = false`,
      [input.resource_id, input.check_in, input.check_out]
    );
    if (blockedRows.length > 0) {
      throw conflict(`dates not available: ${blockedRows.map(r => r.date).join(", ")}`);
    }

    // Double-booking guard: check for overlapping active bookings.
    // The resource-row lock above ensures this check + insert is atomic
    // across concurrent transactions (no phantom inserts between the check
    // and the INSERT below).
    const { rows: overlapRows } = await client.query<{ id: string }>(
      `SELECT id FROM bookings
       WHERE resource_id = $1::uuid
         AND status IN ('pending','confirmed','checked_in')
         AND check_in < $3::date AND check_out > $2::date`,
      [input.resource_id, input.check_in, input.check_out]
    );
    if (overlapRows.length > 0) {
      throw conflict("dates not available");
    }

    // Compute price
    const price = await computeBookingPrice(
      input.resource_id,
      input.check_in,
      input.check_out,
      input.num_guests ?? 1,
      clock
    );

    // Get store currency
    const { rows: storeRows } = await client.query<{ currency: string }>(
      `SELECT currency FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    const currency = input.currency ?? storeRows[0]?.currency ?? "USD";

    // Generate booking number
    const { rows: numRows } = await client.query<{ next_booking_number: string }>(
      `SELECT next_booking_number($1::uuid)`,
      [storeId]
    );
    const bookingNumber = numRows[0]?.next_booking_number;
    if (!bookingNumber) throw new Error("failed to generate booking number");

    // Create backing order inline (within this transaction client — calling createOrder()
    // would issue its own withTx/BEGIN which creates a nested transaction in PostgreSQL
    // causing a hang or "WARNING: there is already a transaction in progress").
    // We replicate the order-creation logic directly using the existing client.
    const { rows: orderNumRows } = await client.query<{ next_order_number: string }>(
      `SELECT next_order_number($1::uuid)`,
      [storeId]
    );
    const orderNumber = orderNumRows[0]?.next_order_number;
    if (!orderNumber) throw new Error("createBooking: failed to generate order number");

    const bookingTotal = parseFloat(price.total);
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, order_number, status, financial_status, fulfillment_status,
          currency, subtotal, shipping_total, tax_total, discount_total, total,
          shipping_address, billing_address, source_name, notes, is_test)
       VALUES
         ($1::uuid, $2, $3, 'open', 'pending', 'unfulfilled',
          $4, 0, $5, 0, 0, $5,
          '{}', '{}', 'booking', $6, false)
       RETURNING id::text`,
      [
        storeId,
        input.customer_id ?? null,
        orderNumber,
        currency,
        bookingTotal,
        `Booking ${bookingNumber}`,
      ]
    );
    const orderId = orderRows[0]?.id;
    if (!orderId) throw new Error("createBooking: failed to create order");

    // Insert single order line for the accommodation
    await client.query(
      `INSERT INTO order_lines
         (order_id, title, quantity, price, total)
       VALUES ($1::uuid, $2, $3, 0, 0)`,
      [orderId, `Booking ${bookingNumber} — ${price.total_nights} night(s)`, price.total_nights]
    );

    // Insert order_created event
    await client.query(
      `INSERT INTO order_events (order_id, type, data, created_by)
       VALUES ($1::uuid, 'order_created', '{}', $2)`,
      [orderId, userId ?? null]
    );

    // Insert booking
    const { rows: bookingRows } = await client.query<Booking>(
      `INSERT INTO bookings
         (store_id, resource_id, customer_id, order_id, booking_number,
          check_in, check_out, num_guests, guest_name, guest_email, guest_phone,
          status, nightly_rate, cleaning_fee, extra_guest_fee, security_deposit,
          total_nights, subtotal, total, currency,
          source_channel, channel_reservation_id, cancellation_policy_id,
          special_requests, metadata)
       VALUES
         ($1::uuid, $2::uuid, $3, $4::uuid, $5,
          $6::date, $7::date, $8, $9, $10, $11,
          'pending', $12::numeric, $13::numeric, $14::numeric, $15::numeric,
          $16, $17::numeric, $18::numeric, $19,
          $20, $21, $22,
          $23, $24::jsonb)
       RETURNING ${BOOKING_COLS}`,
      [
        storeId,
        input.resource_id,
        input.customer_id ?? null,
        orderId,
        bookingNumber,
        input.check_in,
        input.check_out,
        input.num_guests ?? 1,
        input.guest_name ?? null,
        input.guest_email ?? null,
        input.guest_phone ?? null,
        price.nightly_rate,
        price.cleaning_fee,
        price.extra_guest_fee,
        resource.security_deposit ?? null,
        price.total_nights,
        price.subtotal,
        price.total,
        currency,
        input.source_channel ?? "direct",
        input.channel_reservation_id ?? null,
        resource.cancellation_policy_id ?? null,
        input.special_requests ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    if (!bookingRows[0]) throw new Error("createBooking: no row returned");
    let booking = bookingRows[0];

    const bookingId = booking.id;

    // Insert initial status event
    await client.query(
      `INSERT INTO booking_events (booking_id, type, data, created_by)
       VALUES ($1::uuid, 'status_changed', $2::jsonb, $3)`,
      [bookingId, JSON.stringify({ from: null, to: "pending" }), userId ?? null]
    );

    // Insert booking line items
    await client.query(
      `INSERT INTO booking_line_items
         (booking_id, resource_id, title, line_type, quantity, unit_price, total, currency,
          line_check_in, line_check_out)
       VALUES ($1::uuid, $2::uuid, $3, 'resource', $4, $5::numeric, $6::numeric, $7, $8::date, $9::date)`,
      [
        bookingId,
        input.resource_id,
        `Booking — ${price.total_nights} night(s)`,
        price.total_nights,
        price.nightly_rate,
        price.subtotal,
        currency,
        input.check_in,
        input.check_out,
      ]
    );

    if (parseFloat(price.cleaning_fee) > 0) {
      await client.query(
        `INSERT INTO booking_line_items
           (booking_id, resource_id, title, line_type, quantity, unit_price, total, currency)
         VALUES ($1::uuid, $2::uuid, 'Cleaning fee', 'fee', 1, $3::numeric, $3::numeric, $4)`,
        [bookingId, input.resource_id, price.cleaning_fee, currency]
      );
    }

    if (parseFloat(price.extra_guest_fee) > 0) {
      await client.query(
        `INSERT INTO booking_line_items
           (booking_id, resource_id, title, line_type, quantity, unit_price, total, currency)
         VALUES ($1::uuid, $2::uuid, 'Extra guest fee', 'fee', 1, $3::numeric, $3::numeric, $4)`,
        [bookingId, input.resource_id, price.extra_guest_fee, currency]
      );
    }

    // Instant booking: auto-confirm
    if (resource.instant_bookable) {
      const { rows: confirmedRows } = await client.query<Booking>(
        `UPDATE bookings SET status = 'confirmed', confirmed_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING ${BOOKING_COLS}`,
        [bookingId]
      );
      if (confirmedRows[0]) booking = confirmedRows[0];

      await client.query(
        `INSERT INTO booking_events (booking_id, type, data, created_by)
         VALUES ($1::uuid, 'status_changed', $2::jsonb, $3)`,
        [bookingId, JSON.stringify({ from: "pending", to: "confirmed" }), userId ?? null]
      );
    }

    return booking;
  });
}

// ── Status Transitions ─────────────────────────────────────────────────────────

async function transitionBooking(
  storeId: string,
  id: string,
  fromStatuses: string[],
  toStatus: string,
  extraSets: string = "",
  extraArgs: unknown[] = []
): Promise<Booking> {
  const pool = getPool();
  const placeholders = fromStatuses.map((_, i) => `$${4 + i}`).join(", ");
  const { rows } = await pool.query<Booking>(
    `UPDATE bookings
     SET status = $3, updated_at = now()${extraSets}
     WHERE id = $1::uuid AND store_id = $2::uuid
       AND status IN (${placeholders})
       AND deleted_at IS NULL
     RETURNING ${BOOKING_COLS}`,
    [id, storeId, toStatus, ...fromStatuses, ...extraArgs]
  );
  if (!rows[0]) throw notFound(`booking not found or invalid status transition to ${toStatus}`);
  return rows[0];
}

async function insertBookingEvent(
  bookingId: string,
  type: string,
  data: Record<string, unknown>,
  createdBy?: string | undefined
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO booking_events (booking_id, type, data, created_by)
     VALUES ($1::uuid, $2, $3::jsonb, $4)`,
    [bookingId, type, JSON.stringify(data), createdBy ?? null]
  );
}

export async function confirmBooking(
  storeId: string,
  id: string,
  userId?: string | undefined
): Promise<Booking> {
  const booking = await transitionBooking(
    storeId, id,
    ["pending", "inquiry"],
    "confirmed",
    ", confirmed_at = now()"
  );
  await insertBookingEvent(id, "status_changed", { from: booking.status === "confirmed" ? "pending" : "inquiry", to: "confirmed" }, userId);
  return booking;
}

export async function checkInBooking(
  storeId: string,
  id: string,
  userId?: string | undefined
): Promise<Booking> {
  const booking = await transitionBooking(storeId, id, ["confirmed"], "checked_in");
  await insertBookingEvent(id, "status_changed", { from: "confirmed", to: "checked_in" }, userId);
  return booking;
}

export async function checkOutBooking(
  storeId: string,
  id: string,
  userId?: string | undefined
): Promise<Booking> {
  const booking = await transitionBooking(storeId, id, ["checked_in"], "checked_out");
  await insertBookingEvent(id, "status_changed", { from: "checked_in", to: "checked_out" }, userId);
  return booking;
}

export async function noShowBooking(
  storeId: string,
  id: string,
  userId?: string | undefined
): Promise<Booking> {
  const booking = await transitionBooking(storeId, id, ["confirmed", "pending"], "no_show");
  await insertBookingEvent(id, "status_changed", { from: "confirmed", to: "no_show" }, userId);
  return booking;
}

export async function cancelBooking(
  storeId: string,
  id: string,
  reason: string | undefined,
  clock: Clock,
  userId?: string | undefined
): Promise<CancelBookingResult> {
  const pool = getPool();

  // Get booking with policy
  const { rows } = await pool.query<{
    id: string;
    status: string;
    total: string | null;
    check_in: string;
    cancellation_policy_id: string | null;
  }>(
    `SELECT id::text, status, total::text, check_in::text, cancellation_policy_id::text
     FROM bookings WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [id, storeId]
  );
  if (!rows[0]) throw notFound("booking not found");
  const b = rows[0];

  const cancellableStatuses = ["pending", "inquiry", "confirmed", "checked_in"];
  if (!cancellableStatuses.includes(b.status)) {
    throw conflict(`cannot cancel booking in status ${b.status}`);
  }

  // Calculate refund percentage
  let refundPct = 0;
  if (b.cancellation_policy_id) {
    const { rows: pRows } = await pool.query<{ type: string; rules: unknown }>(
      `SELECT type, rules FROM cancellation_policies WHERE id = $1::uuid`,
      [b.cancellation_policy_id]
    );
    if (pRows[0]) {
      const policy = pRows[0];
      const checkInDate = new Date(b.check_in + "T00:00:00Z");
      const now = clock.now();
      const hoursBeforeCheckIn = (checkInDate.getTime() - now.getTime()) / 3_600_000;

      if (policy.type === "custom") {
        const rules = (Array.isArray(policy.rules) ? policy.rules : []) as Array<{ hours_before: number; refund_pct: number }>;
        // Sort descending by hours_before; first rule where hoursBeforeCheckIn >= hours_before wins
        const sorted = [...rules].sort((a, b) => b.hours_before - a.hours_before);
        for (const rule of sorted) {
          if (hoursBeforeCheckIn >= rule.hours_before) {
            refundPct = rule.refund_pct;
            break;
          }
        }
      } else {
        // Standard policy types
        switch (policy.type) {
          case "flexible":
            refundPct = hoursBeforeCheckIn >= 24 ? 100 : 0;
            break;
          case "moderate":
            refundPct = hoursBeforeCheckIn >= 120 ? 100 : 0;
            break;
          case "strict":
            refundPct = hoursBeforeCheckIn >= 168 ? 50 : 0;
            break;
          case "super_strict":
            refundPct = hoursBeforeCheckIn >= 720 ? 50 : 0;
            break;
          case "non_refundable":
          default:
            refundPct = 0;
        }
      }
    }
  }

  const total = parseFloat(b.total ?? "0");
  const refundAmount = (total * refundPct / 100).toFixed(2);

  // Update booking status
  const { rows: updatedRows } = await pool.query<Booking>(
    `UPDATE bookings
     SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
     RETURNING ${BOOKING_COLS}`,
    [id, storeId, reason ?? null]
  );
  if (!updatedRows[0]) throw notFound("booking not found");

  await insertBookingEvent(id, "status_changed", { from: b.status, to: "cancelled", cancel_reason: reason }, userId);

  return {
    booking: updatedRows[0],
    refund_pct: refundPct,
    refund_amount: refundAmount,
  };
}

// ── Booking Events ─────────────────────────────────────────────────────────────

export async function listBookingEvents(
  storeId: string,
  bookingId: string
): Promise<BookingEvent[]> {
  const pool = getPool();
  // Verify booking belongs to store
  const { rows: check } = await pool.query<{ id: string }>(
    `SELECT id FROM bookings WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [bookingId, storeId]
  );
  if (!check[0]) throw notFound("booking not found");

  const { rows } = await pool.query<BookingEvent>(
    `SELECT id::text, booking_id::text, type, data, created_by::text, created_at
     FROM booking_events WHERE booking_id = $1::uuid ORDER BY created_at ASC`,
    [bookingId]
  );
  return rows;
}

// ── Booking Modifications ──────────────────────────────────────────────────────

export async function createModification(
  storeId: string,
  bookingId: string,
  input: CreateModificationInput
): Promise<BookingModification> {
  const pool = getPool();

  const { rows: bRows } = await pool.query<{
    check_in: string;
    check_out: string;
    num_guests: number;
    total: string | null;
    resource_id: string;
  }>(
    `SELECT check_in::text, check_out::text, num_guests, total::text, resource_id::text
     FROM bookings WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [bookingId, storeId]
  );
  if (!bRows[0]) throw notFound("booking not found");
  const b = bRows[0];

  const { rows } = await pool.query<BookingModification>(
    `INSERT INTO booking_modifications
       (booking_id, requested_by, old_check_in, old_check_out, old_num_guests, old_total, old_resource_id,
        new_check_in, new_check_out, new_num_guests, new_total, new_resource_id, notes)
     VALUES ($1::uuid, $2, $3::date, $4::date, $5, $6::numeric, $7::uuid,
             $8, $9, $10, $11, $12, $13)
     RETURNING id::text, booking_id::text, requested_by::text,
               old_check_in::text, old_check_out::text, old_num_guests, old_total::text, old_resource_id::text,
               new_check_in::text, new_check_out::text, new_num_guests, new_total::text, new_resource_id::text,
               status, notes, reviewed_by::text, reviewed_at, created_at`,
    [
      bookingId,
      input.requested_by ?? null,
      b.check_in,
      b.check_out,
      b.num_guests,
      b.total ?? null,
      b.resource_id,
      input.new_check_in ?? null,
      input.new_check_out ?? null,
      input.new_num_guests ?? null,
      null, // new_total computed later
      input.new_resource_id ?? null,
      input.notes ?? null,
    ]
  );
  if (!rows[0]) throw new Error("createModification: no row returned");
  return rows[0];
}

export async function approveModification(
  storeId: string,
  modId: string,
  userId?: string | undefined
): Promise<BookingModification> {
  const pool = getPool();
  const { rows } = await pool.query<BookingModification>(
    `UPDATE booking_modifications bm
     SET status = 'approved', reviewed_by = $2, reviewed_at = now()
     FROM bookings b
     WHERE bm.id = $1::uuid AND b.id = bm.booking_id AND b.store_id = $3::uuid
       AND bm.status = 'pending'
     RETURNING bm.id::text, bm.booking_id::text, bm.requested_by::text,
               bm.old_check_in::text, bm.old_check_out::text, bm.old_num_guests, bm.old_total::text, bm.old_resource_id::text,
               bm.new_check_in::text, bm.new_check_out::text, bm.new_num_guests, bm.new_total::text, bm.new_resource_id::text,
               bm.status, bm.notes, bm.reviewed_by::text, bm.reviewed_at, bm.created_at`,
    [modId, userId ?? null, storeId]
  );
  if (!rows[0]) throw notFound("modification not found or not in pending status");
  return rows[0];
}

export async function rejectModification(
  storeId: string,
  modId: string,
  userId?: string | undefined
): Promise<BookingModification> {
  const pool = getPool();
  const { rows } = await pool.query<BookingModification>(
    `UPDATE booking_modifications bm
     SET status = 'rejected', reviewed_by = $2, reviewed_at = now()
     FROM bookings b
     WHERE bm.id = $1::uuid AND b.id = bm.booking_id AND b.store_id = $3::uuid
       AND bm.status = 'pending'
     RETURNING bm.id::text, bm.booking_id::text, bm.requested_by::text,
               bm.old_check_in::text, bm.old_check_out::text, bm.old_num_guests, bm.old_total::text, bm.old_resource_id::text,
               bm.new_check_in::text, bm.new_check_out::text, bm.new_num_guests, bm.new_total::text, bm.new_resource_id::text,
               bm.status, bm.notes, bm.reviewed_by::text, bm.reviewed_at, bm.created_at`,
    [modId, userId ?? null, storeId]
  );
  if (!rows[0]) throw notFound("modification not found or not in pending status");
  return rows[0];
}

// ── Messages ───────────────────────────────────────────────────────────────────

export async function listMessages(
  storeId: string,
  bookingId: string
): Promise<BookingMessage[]> {
  const pool = getPool();
  const { rows: check } = await pool.query<{ id: string }>(
    `SELECT id FROM bookings WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [bookingId, storeId]
  );
  if (!check[0]) throw notFound("booking not found");

  const { rows } = await pool.query<BookingMessage>(
    `SELECT id::text, booking_id::text, sender_id::text, sender_role, body, read_at, created_at
     FROM booking_messages WHERE booking_id = $1::uuid ORDER BY created_at ASC`,
    [bookingId]
  );
  return rows;
}

export async function sendMessage(
  storeId: string,
  bookingId: string,
  input: SendMessageInput
): Promise<BookingMessage> {
  const pool = getPool();
  const { rows: check } = await pool.query<{ id: string }>(
    `SELECT id FROM bookings WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [bookingId, storeId]
  );
  if (!check[0]) throw notFound("booking not found");

  const { rows } = await pool.query<BookingMessage>(
    `INSERT INTO booking_messages (booking_id, sender_id, sender_role, body)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id::text, booking_id::text, sender_id::text, sender_role, body, read_at, created_at`,
    [bookingId, input.sender_id ?? null, input.sender_role, input.body]
  );
  if (!rows[0]) throw new Error("sendMessage: no row returned");
  return rows[0];
}

// ── Check-In Tokens ────────────────────────────────────────────────────────────

export async function generateCheckInToken(
  storeId: string,
  bookingId: string,
  input: GenerateCheckInTokenInput
): Promise<CheckInToken> {
  const pool = getPool();
  const { rows: check } = await pool.query<{ id: string }>(
    `SELECT id FROM bookings WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [bookingId, storeId]
  );
  if (!check[0]) throw notFound("booking not found");

  const token = randomBytes(24).toString("hex"); // 48-char hex

  // valid_from/valid_until are NOT NULL in the DB — default to now() + 30 days if not provided.
  const validFrom = input.valid_from ?? new Date().toISOString();
  const validUntil = input.valid_until ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { rows } = await pool.query<CheckInToken>(
    `INSERT INTO check_in_tokens (booking_id, token, access_type, valid_from, valid_until, metadata)
     VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)
     RETURNING id::text, booking_id::text, token, access_type, valid_from, valid_until, used_at, metadata`,
    [
      bookingId,
      token,
      input.access_type ?? "check_in",
      validFrom,
      validUntil,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  if (!rows[0]) throw new Error("generateCheckInToken: no row returned");
  return rows[0];
}

export async function redeemCheckInToken(token: string): Promise<CheckInToken> {
  const pool = getPool();
  const { rows } = await pool.query<CheckInToken>(
    `UPDATE check_in_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL
       AND (valid_until IS NULL OR valid_until > now())
     RETURNING id::text, booking_id::text, token, access_type, valid_from, valid_until, used_at, metadata`,
    [token]
  );
  if (!rows[0]) throw notFound("check-in token not found or already used");
  return rows[0];
}

// ── Damage Claims ──────────────────────────────────────────────────────────────

export async function listDamageClaims(
  storeId: string,
  bookingId: string
): Promise<DamageClaim[]> {
  const pool = getPool();
  const { rows: check } = await pool.query<{ id: string }>(
    `SELECT id FROM bookings WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [bookingId, storeId]
  );
  if (!check[0]) throw notFound("booking not found");

  const { rows } = await pool.query<DamageClaim>(
    `SELECT id::text, booking_id::text, reported_by::text, description, claim_amount::text,
            status, evidence, resolution_notes, resolved_at, created_at, updated_at
     FROM damage_claims WHERE booking_id = $1::uuid ORDER BY created_at DESC`,
    [bookingId]
  );
  return rows;
}

export async function createDamageClaim(
  storeId: string,
  bookingId: string,
  input: CreateDamageClaimInput
): Promise<DamageClaim> {
  const pool = getPool();
  const { rows: check } = await pool.query<{ id: string }>(
    `SELECT id FROM bookings WHERE id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
    [bookingId, storeId]
  );
  if (!check[0]) throw notFound("booking not found");

  const { rows } = await pool.query<DamageClaim>(
    `INSERT INTO damage_claims (booking_id, reported_by, description, claim_amount, evidence)
     VALUES ($1::uuid, $2, $3, $4::numeric, $5::jsonb)
     RETURNING id::text, booking_id::text, reported_by::text, description, claim_amount::text,
               status, evidence, resolution_notes, resolved_at, created_at, updated_at`,
    [
      bookingId,
      input.reported_by ?? null,
      input.description,
      input.claim_amount,
      JSON.stringify(input.evidence ?? null),
    ]
  );
  if (!rows[0]) throw new Error("createDamageClaim: no row returned");
  return rows[0];
}

export async function updateDamageClaim(
  storeId: string,
  claimId: string,
  input: UpdateDamageClaimInput
): Promise<DamageClaim> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [claimId, storeId];
  let n = 3;

  if (input.status !== undefined) { sets.push(`status = $${n++}`); args.push(input.status); }
  if (input.resolution_notes !== undefined) { sets.push(`resolution_notes = $${n++}`); args.push(input.resolution_notes); }
  if (input.resolved_at !== undefined) { sets.push(`resolved_at = $${n++}`); args.push(input.resolved_at); }

  const { rows } = await pool.query<DamageClaim>(
    `UPDATE damage_claims dc
     SET ${sets.join(", ")}
     FROM bookings b
     WHERE dc.id = $1::uuid AND b.id = dc.booking_id AND b.store_id = $2::uuid
     RETURNING dc.id::text, dc.booking_id::text, dc.reported_by::text, dc.description, dc.claim_amount::text,
               dc.status, dc.evidence, dc.resolution_notes, dc.resolved_at, dc.created_at, dc.updated_at`,
    args
  );
  if (!rows[0]) throw notFound("damage claim not found");
  return rows[0];
}
