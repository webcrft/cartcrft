/**
 * bookings/ota.ts — OTA/iCal service.
 *
 * Manages iCal feeds, channel providers (with encrypted credentials),
 * channel listings, sync jobs, and webhook logging.
 */

import { getPool } from "../../db/pool.js";
import { encodeSecretValue, decodeSecretValue } from "../../lib/secrets.js";
import { config } from "../../config/config.js";
import { parseICalFeed, buildICalFeed } from "./ical.js";
import type { ICalEvent } from "./ical.js";

// ── iCal Feed types ────────────────────────────────────────────────────────────

export interface ICalFeed {
  id: string;
  resource_id: string;
  channel: string;
  direction: "import" | "export";
  url: string | null;
  sync_interval_minutes: number;
  last_synced_at: string | null;
  last_error: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateICalFeedInput {
  channel: string;
  direction: "import" | "export";
  url?: string | undefined;
  sync_interval_minutes?: number | undefined;
  is_active?: boolean | undefined;
}

export interface UpdateICalFeedInput {
  url?: string | null | undefined;
  sync_interval_minutes?: number | undefined;
  is_active?: boolean | undefined;
}

// ── Channel Provider types ─────────────────────────────────────────────────────

export interface ChannelProvider {
  id: string;
  store_id: string;
  provider_type: string;
  channel: string;
  name: string;
  api_key: string | null;
  api_secret: string | null;
  webhook_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  push_rates: boolean;
  push_availability: boolean;
  status: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateChannelProviderInput {
  provider_type?: string | undefined;
  channel: string;
  name: string;
  api_key?: string | undefined;
  api_secret?: string | undefined;
  webhook_secret?: string | undefined;
  access_token?: string | undefined;
  refresh_token?: string | undefined;
  token_expires_at?: string | undefined;
  push_rates?: boolean | undefined;
  push_availability?: boolean | undefined;
  status?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

export interface UpdateChannelProviderInput {
  name?: string | undefined;
  api_key?: string | null | undefined;
  api_secret?: string | null | undefined;
  webhook_secret?: string | null | undefined;
  access_token?: string | null | undefined;
  refresh_token?: string | null | undefined;
  token_expires_at?: string | null | undefined;
  push_rates?: boolean | undefined;
  push_availability?: boolean | undefined;
  status?: string | undefined;
  config?: Record<string, unknown> | undefined;
}

// ── Channel Listing types ──────────────────────────────────────────────────────

export interface ChannelListing {
  id: string;
  resource_id: string;
  channel: string;
  channel_listing_id: string | null;
  channel_property_id: string | null;
  sync_rates: boolean;
  sync_availability: boolean;
  sync_restrictions: boolean;
  markup_pct: string | null;
  status: string;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
  error_message: string | null;
  managed_by_provider_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateChannelListingInput {
  channel: string;
  channel_listing_id?: string | undefined;
  channel_property_id?: string | undefined;
  sync_rates?: boolean | undefined;
  sync_availability?: boolean | undefined;
  sync_restrictions?: boolean | undefined;
  markup_pct?: string | undefined;
  status?: string | undefined;
  managed_by_provider_id?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface UpdateChannelListingInput {
  channel_listing_id?: string | null | undefined;
  channel_property_id?: string | null | undefined;
  sync_rates?: boolean | undefined;
  sync_availability?: boolean | undefined;
  sync_restrictions?: boolean | undefined;
  markup_pct?: string | null | undefined;
  status?: string | undefined;
  managed_by_provider_id?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

// ── Sync Job types ─────────────────────────────────────────────────────────────

export interface ChannelSyncJob {
  id: string;
  store_id: string;
  channel_listing_id: string | null;
  provider_id: string | null;
  channel: string;
  job_type: string;
  window_start: string | null;
  window_end: string | null;
  status: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  next_retry_at: string | null;
  error: string | null;
  payload: Record<string, unknown> | null;
}

export interface EnqueueSyncJobInput {
  channel_listing_id?: string | undefined;
  provider_id?: string | undefined;
  channel: string;
  job_type: string;
  window_start?: string | undefined;
  window_end?: string | undefined;
  priority?: number | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface ListSyncJobsOpts {
  status?: string | undefined;
  channel?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

// ── Helper ─────────────────────────────────────────────────────────────────────

function notFound(msg: string): Error {
  const e = new Error(msg);
  (e as NodeJS.ErrnoException).code = "NOT_FOUND";
  return e;
}

// ── Injectable fetch (for tests) ─────────────────────────────────────────────
//
// The outbound ARI HTTP calls go through `otaFetch` rather than the global
// `fetch` directly, so tests can inject a stub without monkey-patching the
// global fetch used by the test HTTP client. setOtaFetchForTesting(null)
// restores the real global fetch.

type FetchFn = typeof fetch;

let _otaFetch: FetchFn = (...args) => fetch(...args);

/** The fetch used for outbound OTA/ARI HTTP. Tests can override via setOtaFetchForTesting. */
function otaFetch(...args: Parameters<FetchFn>): ReturnType<FetchFn> {
  return _otaFetch(...args);
}

/**
 * Override the fetch used for outbound OTA ARI HTTP calls. Pass null to restore
 * the real global fetch. Test-only.
 */
export function setOtaFetchForTesting(fn: FetchFn | null): void {
  _otaFetch = fn ?? ((...args) => fetch(...args));
}

function secretsKey(): string {
  return config.AUTH_SECRETS_KEY ?? "";
}

function encryptCred(value: string | undefined | null): string | null {
  if (!value) return null;
  return encodeSecretValue(value, secretsKey());
}

function decryptCred(stored: string | null): string | null {
  if (!stored) return null;
  return decodeSecretValue(stored, secretsKey());
}

// ── iCal Feeds ─────────────────────────────────────────────────────────────────

const ICAL_FEED_COLS = `
  id::text, resource_id::text, channel, direction, url,
  sync_interval_minutes, last_synced_at, last_error, is_active, created_at, updated_at
`;

export async function listICalFeeds(resourceId: string): Promise<ICalFeed[]> {
  const pool = getPool();
  const { rows } = await pool.query<ICalFeed>(
    `SELECT ${ICAL_FEED_COLS} FROM ical_feeds
     WHERE resource_id = $1::uuid ORDER BY created_at ASC`,
    [resourceId]
  );
  return rows;
}

export async function createICalFeed(
  resourceId: string,
  input: CreateICalFeedInput
): Promise<ICalFeed> {
  const pool = getPool();
  const { rows } = await pool.query<ICalFeed>(
    `INSERT INTO ical_feeds (resource_id, channel, direction, url, sync_interval_minutes, is_active)
     VALUES ($1::uuid, $2, $3, $4, $5, $6)
     RETURNING ${ICAL_FEED_COLS}`,
    [
      resourceId,
      input.channel,
      input.direction,
      input.url ?? null,
      input.sync_interval_minutes ?? 60,
      input.is_active ?? true,
    ]
  );
  if (!rows[0]) throw new Error("createICalFeed: no row returned");
  return rows[0];
}

export async function updateICalFeed(
  resourceId: string,
  feedId: string,
  input: UpdateICalFeedInput
): Promise<ICalFeed> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [feedId, resourceId];
  let n = 3;

  if ("url" in input) { sets.push(`url = $${n++}`); args.push(input.url ?? null); }
  if (input.sync_interval_minutes !== undefined) { sets.push(`sync_interval_minutes = $${n++}`); args.push(input.sync_interval_minutes); }
  if (input.is_active !== undefined) { sets.push(`is_active = $${n++}`); args.push(input.is_active); }

  const { rows } = await pool.query<ICalFeed>(
    `UPDATE ical_feeds SET ${sets.join(", ")}
     WHERE id = $1::uuid AND resource_id = $2::uuid
     RETURNING ${ICAL_FEED_COLS}`,
    args
  );
  if (!rows[0]) throw notFound("ical feed not found");
  return rows[0];
}

export async function deleteICalFeed(
  resourceId: string,
  feedId: string
): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM ical_feeds WHERE id = $1::uuid AND resource_id = $2::uuid`,
    [feedId, resourceId]
  );
  if (!rowCount) throw notFound("ical feed not found");
}

// ── iCal Export ────────────────────────────────────────────────────────────────

export async function exportICalFeed(resourceId: string): Promise<string> {
  const pool = getPool();

  // Get resource name
  const { rows: rRows } = await pool.query<{ name: string }>(
    `SELECT name FROM booking_resources WHERE id = $1::uuid AND deleted_at IS NULL`,
    [resourceId]
  );
  const calName = rRows[0]?.name ?? "Booking Calendar";

  // Confirmed bookings
  const { rows: bookingRows } = await pool.query<{
    id: string;
    booking_number: string;
    check_in: string;
    check_out: string;
    guest_name: string | null;
  }>(
    `SELECT id::text, booking_number, check_in::text, check_out::text, guest_name
     FROM bookings
     WHERE resource_id = $1::uuid
       AND status IN ('confirmed', 'checked_in', 'checked_out')
       AND deleted_at IS NULL`,
    [resourceId]
  );

  // Manual/ical blocked dates
  const { rows: blockedRows } = await pool.query<{ date: string; notes: string | null }>(
    `SELECT date::text, notes FROM booking_availability
     WHERE resource_id = $1::uuid AND is_available = false`,
    [resourceId]
  );

  const events: ICalEvent[] = [];

  for (const b of bookingRows) {
    events.push({
      uid: `booking-${b.id}@cartcrft`,
      summary: b.guest_name ? `Booking ${b.booking_number} - ${b.guest_name}` : `Booking ${b.booking_number}`,
      dtstart: new Date(b.check_in + "T00:00:00Z"),
      dtend: new Date(b.check_out + "T00:00:00Z"),
      allDay: true,
    });
  }

  for (const blocked of blockedRows) {
    // Single-day blocked: dtend = next day
    const startDate = new Date(blocked.date + "T00:00:00Z");
    const endDate = new Date(startDate.getTime() + 86_400_000);
    events.push({
      uid: `blocked-${resourceId}-${blocked.date}@cartcrft`,
      summary: blocked.notes ?? "Blocked",
      dtstart: startDate,
      dtend: endDate,
      allDay: true,
    });
  }

  return buildICalFeed(events, calName);
}

// ── iCal Import ────────────────────────────────────────────────────────────────

export async function importICalFeed(
  resourceId: string,
  feedId: string,
  icalText: string
): Promise<{ status: string; events_imported: number; dates_blocked: number }> {
  const pool = getPool();

  // Verify feed exists
  const { rows: feedRows } = await pool.query<{ id: string }>(
    `SELECT id FROM ical_feeds WHERE id = $1::uuid AND resource_id = $2::uuid`,
    [feedId, resourceId]
  );
  if (!feedRows[0]) throw notFound("ical feed not found");

  // Insert sync run record
  const { rows: runRows } = await pool.query<{ id: string }>(
    `INSERT INTO ical_sync_runs (feed_id, status, bytes_fetched)
     VALUES ($1::uuid, 'running', $2)
     RETURNING id::text`,
    [feedId, Buffer.byteLength(icalText, "utf8")]
  );
  const runId = runRows[0]?.id;

  const events = parseICalFeed(icalText);
  let datesBlocked = 0;

  try {
    for (const evt of events) {
      // Block all dates from dtstart to dtend (exclusive)
      const startMs = evt.dtstart.getTime();
      const endMs = evt.dtend.getTime();
      const days = Math.round((endMs - startMs) / 86_400_000);

      for (let i = 0; i < Math.max(days, 1); i++) {
        const dateMs = startMs + i * 86_400_000;
        const dateStr = new Date(dateMs).toISOString().slice(0, 10);

        await pool.query(
          `INSERT INTO booking_availability
             (resource_id, date, is_available, notes, source)
           VALUES ($1::uuid, $2::date, false, $3, 'ical')
           ON CONFLICT (resource_id, date) DO UPDATE
             SET is_available = false, notes = EXCLUDED.notes, source = 'ical'`,
          [resourceId, dateStr, evt.uid]
        );
        datesBlocked++;
      }
    }

    // Update sync run to success
    await pool.query(
      `UPDATE ical_sync_runs
       SET status = 'success', events_imported = $1, dates_blocked = $2, finished_at = now()
       WHERE id = $3::uuid`,
      [events.length, datesBlocked, runId]
    );

    // Update feed last_synced_at
    await pool.query(
      `UPDATE ical_feeds SET last_synced_at = now(), last_error = null, updated_at = now()
       WHERE id = $1::uuid`,
      [feedId]
    );
  } catch (err) {
    // Update sync run to failed
    await pool.query(
      `UPDATE ical_sync_runs
       SET status = 'failed', error = $1, finished_at = now()
       WHERE id = $2::uuid`,
      [err instanceof Error ? err.message : String(err), runId]
    );
    await pool.query(
      `UPDATE ical_feeds SET last_error = $2, updated_at = now() WHERE id = $1::uuid`,
      [feedId, err instanceof Error ? err.message : String(err)]
    );
    throw err;
  }

  return { status: "success", events_imported: events.length, dates_blocked: datesBlocked };
}

// ── Channel Providers ──────────────────────────────────────────────────────────

const PROVIDER_COLS = `
  id::text, store_id::text, provider_type, channel, name,
  api_key, api_secret, webhook_secret, access_token, refresh_token,
  token_expires_at, push_rates, push_availability, status, config,
  created_at, updated_at
`;

function maskProviderRow(row: ChannelProvider): ChannelProvider {
  // Decrypt credentials before returning
  return {
    ...row,
    api_key: decryptCred(row.api_key),
    api_secret: decryptCred(row.api_secret),
    webhook_secret: decryptCred(row.webhook_secret),
    access_token: decryptCred(row.access_token),
    refresh_token: decryptCred(row.refresh_token),
  };
}

export async function listChannelProviders(storeId: string): Promise<ChannelProvider[]> {
  const pool = getPool();
  const { rows } = await pool.query<ChannelProvider>(
    `SELECT ${PROVIDER_COLS} FROM booking_channel_providers
     WHERE store_id = $1::uuid ORDER BY created_at ASC`,
    [storeId]
  );
  return rows.map(maskProviderRow);
}

export async function createChannelProvider(
  storeId: string,
  input: CreateChannelProviderInput
): Promise<ChannelProvider> {
  const pool = getPool();
  const { rows } = await pool.query<ChannelProvider>(
    `INSERT INTO booking_channel_providers
       (store_id, provider_type, channel, name, api_key, api_secret, webhook_secret,
        access_token, refresh_token, token_expires_at, push_rates, push_availability, status, config)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     RETURNING ${PROVIDER_COLS}`,
    [
      storeId,
      input.provider_type ?? "direct_ota",
      input.channel,
      input.name,
      encryptCred(input.api_key),
      encryptCred(input.api_secret),
      encryptCred(input.webhook_secret),
      encryptCred(input.access_token),
      encryptCred(input.refresh_token),
      input.token_expires_at ?? null,
      input.push_rates ?? true,
      input.push_availability ?? true,
      input.status ?? "active",
      JSON.stringify(input.config ?? {}),
    ]
  );
  if (!rows[0]) throw new Error("createChannelProvider: no row returned");
  return maskProviderRow(rows[0]);
}

export async function updateChannelProvider(
  storeId: string,
  id: string,
  input: UpdateChannelProviderInput
): Promise<ChannelProvider> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [id, storeId];
  let n = 3;

  const add = (col: string, val: unknown, cast = "") => {
    sets.push(`${col} = $${n++}${cast}`);
    args.push(val);
  };

  if (input.name !== undefined) add("name", input.name);
  if ("api_key" in input) add("api_key", encryptCred(input.api_key ?? undefined));
  if ("api_secret" in input) add("api_secret", encryptCred(input.api_secret ?? undefined));
  if ("webhook_secret" in input) add("webhook_secret", encryptCred(input.webhook_secret ?? undefined));
  if ("access_token" in input) add("access_token", encryptCred(input.access_token ?? undefined));
  if ("refresh_token" in input) add("refresh_token", encryptCred(input.refresh_token ?? undefined));
  if ("token_expires_at" in input) add("token_expires_at", input.token_expires_at ?? null);
  if (input.push_rates !== undefined) add("push_rates", input.push_rates);
  if (input.push_availability !== undefined) add("push_availability", input.push_availability);
  if (input.status !== undefined) add("status", input.status);
  if (input.config !== undefined) add("config", JSON.stringify(input.config), "::jsonb");

  const { rows } = await pool.query<ChannelProvider>(
    `UPDATE booking_channel_providers SET ${sets.join(", ")}
     WHERE id = $1::uuid AND store_id = $2::uuid
     RETURNING ${PROVIDER_COLS}`,
    args
  );
  if (!rows[0]) throw notFound("channel provider not found");
  return maskProviderRow(rows[0]);
}

export async function deleteChannelProvider(
  storeId: string,
  id: string
): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM booking_channel_providers WHERE id = $1::uuid AND store_id = $2::uuid`,
    [id, storeId]
  );
  if (!rowCount) throw notFound("channel provider not found");
}

// ── Channel Listings ───────────────────────────────────────────────────────────

const LISTING_COLS = `
  id::text, resource_id::text, channel, channel_listing_id, channel_property_id,
  sync_rates, sync_availability, sync_restrictions, markup_pct::text, status,
  last_pushed_at, last_pulled_at, error_message, managed_by_provider_id::text,
  metadata, created_at, updated_at
`;

export async function listChannelListings(resourceId: string): Promise<ChannelListing[]> {
  const pool = getPool();
  const { rows } = await pool.query<ChannelListing>(
    `SELECT ${LISTING_COLS} FROM booking_channel_listings
     WHERE resource_id = $1::uuid ORDER BY created_at ASC`,
    [resourceId]
  );
  return rows;
}

export async function createChannelListing(
  resourceId: string,
  input: CreateChannelListingInput
): Promise<ChannelListing> {
  const pool = getPool();
  const { rows } = await pool.query<ChannelListing>(
    `INSERT INTO booking_channel_listings
       (resource_id, channel, channel_listing_id, channel_property_id,
        sync_rates, sync_availability, sync_restrictions, markup_pct,
        status, managed_by_provider_id, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11::jsonb)
     RETURNING ${LISTING_COLS}`,
    [
      resourceId,
      input.channel,
      input.channel_listing_id ?? null,
      input.channel_property_id ?? null,
      input.sync_rates ?? true,
      input.sync_availability ?? true,
      input.sync_restrictions ?? true,
      input.markup_pct ?? null,
      input.status ?? "active",
      input.managed_by_provider_id ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  if (!rows[0]) throw new Error("createChannelListing: no row returned");
  return rows[0];
}

export async function updateChannelListing(
  resourceId: string,
  id: string,
  input: UpdateChannelListingInput
): Promise<ChannelListing> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const args: unknown[] = [id, resourceId];
  let n = 3;

  const add = (col: string, val: unknown, cast = "") => {
    sets.push(`${col} = $${n++}${cast}`);
    args.push(val);
  };

  if ("channel_listing_id" in input) add("channel_listing_id", input.channel_listing_id ?? null);
  if ("channel_property_id" in input) add("channel_property_id", input.channel_property_id ?? null);
  if (input.sync_rates !== undefined) add("sync_rates", input.sync_rates);
  if (input.sync_availability !== undefined) add("sync_availability", input.sync_availability);
  if (input.sync_restrictions !== undefined) add("sync_restrictions", input.sync_restrictions);
  if ("markup_pct" in input) add("markup_pct", input.markup_pct ?? null, "::numeric");
  if (input.status !== undefined) add("status", input.status);
  if ("managed_by_provider_id" in input) add("managed_by_provider_id", input.managed_by_provider_id ?? null);
  if (input.metadata !== undefined) add("metadata", JSON.stringify(input.metadata), "::jsonb");

  const { rows } = await pool.query<ChannelListing>(
    `UPDATE booking_channel_listings SET ${sets.join(", ")}
     WHERE id = $1::uuid AND resource_id = $2::uuid
     RETURNING ${LISTING_COLS}`,
    args
  );
  if (!rows[0]) throw notFound("channel listing not found");
  return rows[0];
}

export async function deleteChannelListing(
  resourceId: string,
  id: string
): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM booking_channel_listings WHERE id = $1::uuid AND resource_id = $2::uuid`,
    [id, resourceId]
  );
  if (!rowCount) throw notFound("channel listing not found");
}

// ── OTA ARI Push (Availability, Rates, Inventory) ─────────────────────────────
//
// Implements a generic ARI push adapter compatible with common channel manager
// APIs (e.g. Booking.com Connectivity API v2 / SiteMinder-style endpoints).
//
// The "direct_ota" provider_type uses a REST ARI push model where you send:
//   POST <base_url>/availability  — date-by-date open/closed + min-stay
//   POST <base_url>/rates         — date-range rate updates
//
// CREDENTIAL SETUP (to go live):
//   Create a booking_channel_providers row with:
//     channel:    "booking_com" (or any non-iCal channel)
//     provider_type: "direct_ota"
//     api_key:    Your OTA property/hotel ID (e.g. Booking.com hotel_id)
//     api_secret: Your OTA API secret / Basic-auth password
//     config.base_url: The channel's ARI endpoint base URL, e.g.
//                 "https://supply-xml.booking.com/hotels/ota/1.0"
//                 (Booking.com Connectivity XML API)
//                 OR a generic JSON ARI gateway URL for a channel manager
//     config.room_type_id: Channel-side room/rate-plan identifier
//
//   The provider credentials are AES-256-GCM encrypted at rest
//   (AUTH_SECRETS_KEY required in prod). Call createChannelProvider() via
//   POST /commerce/stores/:storeId/booking-channel-providers to store them.
//
// ARI PUSH API SHAPE (JSON / REST variant — matches Booking.com Partner API v2
// and generic channel-manager ARI endpoints):
//
//   POST {base_url}/availability
//   Authorization: Basic base64(api_key:api_secret)
//   Content-Type: application/json
//   {
//     "hotel_id": "<api_key>",
//     "room_type_id": "<config.room_type_id>",
//     "updates": [
//       { "date": "2024-06-01", "available": true, "min_stay": 1 },
//       { "date": "2024-06-02", "available": false }
//     ]
//   }
//   → 200 { "status": "ok" }
//
//   POST {base_url}/rates
//   Authorization: Basic base64(api_key:api_secret)
//   {
//     "hotel_id": "<api_key>",
//     "room_type_id": "<config.room_type_id>",
//     "rate_plan_id": "<config.rate_plan_id>",
//     "updates": [
//       { "date": "2024-06-01", "amount": "150.00", "currency": "USD" }
//     ]
//   }
//   → 200 { "status": "ok" }

export interface ARIAvailabilityUpdate {
  date: string;
  available: boolean;
  min_stay?: number | undefined;
}

export interface ARIRateUpdate {
  date: string;
  amount: string;
  currency: string;
}

export interface PushARIResult {
  status: "ok" | "credential_missing" | "error";
  message: string;
  push_log_id?: string | undefined;
  availability_updated?: number | undefined;
  rates_updated?: number | undefined;
}

/**
 * Push ARI (Availability, Rates, Inventory) to a direct-OTA channel provider
 * for a specific window of dates.
 *
 * This is the core implementation for the generic ARI push adapter. It reads
 * availability and price data from the DB, builds the OTA-shaped payloads,
 * makes the HTTP calls, and records results in booking_channel_push_log.
 */
export async function pushARIToProvider(
  storeId: string,
  listingId: string,
  windowStart: string,
  windowEnd: string,
  providerId?: string | undefined
): Promise<PushARIResult> {
  const pool = getPool();

  // ── 1. Load listing + resource ─────────────────────────────────────────────
  const { rows: listingRows } = await pool.query<{
    id: string;
    channel: string;
    resource_id: string;
    store_id: string;
    channel_listing_id: string | null;
    channel_property_id: string | null;
    sync_rates: boolean;
    sync_availability: boolean;
    markup_pct: string | null;
    managed_by_provider_id: string | null;
  }>(
    `SELECT cl.id::text, cl.channel, cl.resource_id::text,
            r.store_id::text, cl.channel_listing_id, cl.channel_property_id,
            cl.sync_rates, cl.sync_availability, cl.markup_pct::text,
            cl.managed_by_provider_id::text
     FROM booking_channel_listings cl
     JOIN booking_resources r ON r.id = cl.resource_id
     WHERE cl.id = $1::uuid AND r.store_id = $2::uuid`,
    [listingId, storeId]
  );
  if (!listingRows[0]) throw notFound("channel listing not found");
  const listing = listingRows[0];

  // ── 2. Resolve provider (explicit or via managed_by_provider_id) ───────────
  const resolvedProviderId = providerId ?? listing.managed_by_provider_id;
  if (!resolvedProviderId) {
    return {
      status: "credential_missing",
      message: "No provider configured for this listing. Set managed_by_provider_id or pass providerId.",
    };
  }

  const { rows: providerRows } = await pool.query<{
    id: string;
    provider_type: string;
    channel: string;
    api_key: string | null;
    api_secret: string | null;
    status: string;
    config: Record<string, unknown>;
  }>(
    `SELECT id::text, provider_type, channel, api_key, api_secret, status, config
     FROM booking_channel_providers
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [resolvedProviderId, storeId]
  );
  if (!providerRows[0]) {
    return { status: "credential_missing", message: "Provider not found or not in this store." };
  }
  const provider = providerRows[0];

  if (provider.status !== "active") {
    return { status: "credential_missing", message: `Provider status is '${provider.status}'; must be 'active' to push.` };
  }

  const apiKey = decryptCred(provider.api_key);
  const apiSecret = decryptCred(provider.api_secret);
  if (!apiKey) {
    return { status: "credential_missing", message: "Provider api_key is missing. Set credentials via PUT /booking-channel-providers/:id." };
  }

  const baseUrl = (provider.config["base_url"] as string | undefined) ?? "";
  if (!baseUrl) {
    return { status: "credential_missing", message: "Provider config.base_url is missing. Configure the OTA ARI endpoint URL." };
  }

  const roomTypeId = (provider.config["room_type_id"] as string | undefined) ?? apiKey;
  const ratePlanId = (provider.config["rate_plan_id"] as string | undefined) ?? roomTypeId;

  // ── 3. Load resource base info (currency etc.) ─────────────────────────────
  const { rows: resourceRows } = await pool.query<{
    base_price: string;
    currency: string;
    min_duration: number;
  }>(
    `SELECT r.base_price::text, s.currency, r.min_duration
     FROM booking_resources r
     JOIN stores s ON s.id = r.store_id
     WHERE r.id = $1::uuid`,
    [listing.resource_id]
  );
  const resource = resourceRows[0];
  const currency = resource?.currency ?? "USD";
  const globalMinStay = resource?.min_duration ?? 1;

  // ── 4. Gather availability rows for the window ─────────────────────────────
  const { rows: availRows } = await pool.query<{
    date: string;
    is_available: boolean;
    custom_price: string | null;
    min_duration: number | null;
  }>(
    `SELECT date::text, is_available, custom_price::text, min_duration
     FROM booking_availability
     WHERE resource_id = $1::uuid AND date BETWEEN $2::date AND $3::date`,
    [listing.resource_id, windowStart, windowEnd]
  );
  const availMap = new Map(availRows.map((r) => [r.date, r]));

  // ── 5. Gather price rules and confirmed bookings ───────────────────────────
  const { rows: priceRuleRows } = await pool.query<{
    starts_at: string | null;
    ends_at: string | null;
    adjustment_type: string;
    adjustment_value: string;
    priority: number;
    type: string;
    days_of_week: number[] | null;
  }>(
    `SELECT starts_at::text, ends_at::text, adjustment_type,
            adjustment_value::text, priority, type, days_of_week
     FROM booking_price_rules
     WHERE resource_id = $1::uuid AND is_active = true
       AND (starts_at IS NULL OR starts_at <= $3::date)
       AND (ends_at IS NULL OR ends_at >= $2::date)`,
    [listing.resource_id, windowStart, windowEnd]
  );

  // ── 6. Gather confirmed bookings in the window (blocked dates) ─────────────
  const { rows: bookingRows } = await pool.query<{
    check_in: string;
    check_out: string;
  }>(
    `SELECT check_in::text, check_out::text
     FROM bookings
     WHERE resource_id = $1::uuid
       AND status IN ('confirmed','checked_in','checked_out')
       AND check_in <= $3::date AND check_out > $2::date
       AND deleted_at IS NULL`,
    [listing.resource_id, windowStart, windowEnd]
  );

  // Build set of booked dates
  const bookedDates = new Set<string>();
  for (const b of bookingRows) {
    const start = new Date(b.check_in + "T00:00:00Z");
    const end = new Date(b.check_out + "T00:00:00Z");
    for (let d = start.getTime(); d < end.getTime(); d += 86_400_000) {
      bookedDates.add(new Date(d).toISOString().slice(0, 10));
    }
  }

  // ── 7. Build update arrays day-by-day ─────────────────────────────────────
  const availUpdates: ARIAvailabilityUpdate[] = [];
  const rateUpdates: ARIRateUpdate[] = [];

  const markupPct = listing.markup_pct ? parseFloat(listing.markup_pct) : 0;
  const basePrice = parseFloat(resource?.base_price ?? "0");

  const start = new Date(windowStart + "T00:00:00Z");
  const end = new Date(windowEnd + "T00:00:00Z");

  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) {
    const dateStr = new Date(d).toISOString().slice(0, 10);
    const avail = availMap.get(dateStr);
    const booked = bookedDates.has(dateStr);

    const isAvailable = !booked && (avail ? avail.is_available : true);
    const minStay = avail?.min_duration ?? globalMinStay;

    if (listing.sync_availability) {
      const upd: ARIAvailabilityUpdate = { date: dateStr, available: isAvailable };
      if (minStay > 1) upd.min_stay = minStay;
      availUpdates.push(upd);
    }

    if (listing.sync_rates && isAvailable) {
      // Use custom_price override, then apply price rules, then apply markup
      let price = avail?.custom_price ? parseFloat(avail.custom_price) : basePrice;

      // Apply the highest-priority matching price rule
      const dayOfWeek = new Date(d).getUTCDay(); // 0=Sun ... 6=Sat
      let bestPriority = -Infinity;
      let bestAdj: { type: string; value: number } | undefined;

      for (const rule of priceRuleRows) {
        // Date range check
        if (rule.starts_at && dateStr < rule.starts_at) continue;
        if (rule.ends_at && dateStr > rule.ends_at) continue;
        // Day-of-week check
        if (rule.days_of_week && !rule.days_of_week.includes(dayOfWeek)) continue;

        const priority = rule.priority;
        if (priority > bestPriority) {
          bestPriority = priority;
          bestAdj = { type: rule.adjustment_type, value: parseFloat(rule.adjustment_value) };
        }
      }

      if (bestAdj) {
        if (bestAdj.type === "percentage") {
          price = price * (1 + bestAdj.value / 100);
        } else {
          price = price + bestAdj.value;
        }
      }

      // Apply channel markup
      if (markupPct !== 0) {
        price = price * (1 + markupPct / 100);
      }

      price = Math.max(0, price);
      rateUpdates.push({ date: dateStr, amount: price.toFixed(2), currency });
    }
  }

  // ── 8. Build auth header ───────────────────────────────────────────────────
  const basicAuth = Buffer.from(`${apiKey}:${apiSecret ?? ""}`).toString("base64");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Basic ${basicAuth}`,
    "Accept": "application/json",
    "User-Agent": "Cartcrft-OTA-Push/1.0",
  };

  const hotelId = listing.channel_property_id ?? apiKey;
  let syncJobId: string | undefined;

  // ── 9. Create sync job record ──────────────────────────────────────────────
  const { rows: jobRows } = await pool.query<{ id: string }>(
    `INSERT INTO booking_channel_sync_jobs
       (store_id, channel_listing_id, provider_id, channel, job_type,
        window_start, window_end, status, priority, payload)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'full_refresh',
             $5::date, $6::date, 'running', 0, $7::jsonb)
     RETURNING id::text`,
    [
      storeId, listingId, resolvedProviderId, listing.channel,
      windowStart, windowEnd,
      JSON.stringify({ availability_count: availUpdates.length, rate_count: rateUpdates.length }),
    ]
  );
  syncJobId = jobRows[0]?.id;

  // ── 10. Push availability ──────────────────────────────────────────────────
  let availLogId: string | undefined;
  let availSuccess = false;
  let availError: string | undefined;
  let availHttpStatus: number | undefined;
  let availDuration: number | undefined;

  if (listing.sync_availability && availUpdates.length > 0) {
    const availPayload = JSON.stringify({
      hotel_id: hotelId,
      room_type_id: roomTypeId,
      updates: availUpdates,
    });

    const availUrl = `${baseUrl}/availability`;
    const t0 = Date.now();
    let availRespBody = "";

    try {
      const resp = await otaFetch(availUrl, {
        method: "POST",
        headers,
        body: availPayload,
        signal: AbortSignal.timeout(30_000),
      });
      availHttpStatus = resp.status;
      availRespBody = (await resp.text()).slice(0, 32_768);
      availSuccess = resp.ok;
      if (!resp.ok) {
        availError = `HTTP ${resp.status}: ${availRespBody.slice(0, 200)}`;
      }
    } catch (err) {
      availError = err instanceof Error ? err.message : String(err);
      availHttpStatus = 0;
    }

    availDuration = Date.now() - t0;

    // Record push log
    const { rows: logRows } = await pool.query<{ id: string }>(
      `INSERT INTO booking_channel_push_log
         (store_id, sync_job_id, channel_listing_id, provider_id, channel,
          operation, request_url, request_body, http_status, response_body,
          success, error_code, error_message, duration_ms,
          dates_affected)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5,
               'availability_update', $6, $7, $8, $9,
               $10, $11, $12, $13,
               daterange($14::date, $15::date, '[]'))
       RETURNING id::text`,
      [
        storeId, syncJobId ?? null, listingId, resolvedProviderId, listing.channel,
        availUrl, availPayload.slice(0, 32_768), availHttpStatus, availRespBody,
        availSuccess,
        availSuccess ? null : "HTTP_ERROR",
        availError ?? null,
        availDuration,
        windowStart, windowEnd,
      ]
    );
    availLogId = logRows[0]?.id;
  }

  // ── 11. Push rates ─────────────────────────────────────────────────────────
  let rateLogId: string | undefined;
  let rateSuccess = false;
  let rateError: string | undefined;
  let rateHttpStatus: number | undefined;
  let rateDuration: number | undefined;

  if (listing.sync_rates && rateUpdates.length > 0) {
    const ratePayload = JSON.stringify({
      hotel_id: hotelId,
      room_type_id: roomTypeId,
      rate_plan_id: ratePlanId,
      updates: rateUpdates,
    });

    const rateUrl = `${baseUrl}/rates`;
    const t0 = Date.now();
    let rateRespBody = "";

    try {
      const resp = await otaFetch(rateUrl, {
        method: "POST",
        headers,
        body: ratePayload,
        signal: AbortSignal.timeout(30_000),
      });
      rateHttpStatus = resp.status;
      rateRespBody = (await resp.text()).slice(0, 32_768);
      rateSuccess = resp.ok;
      if (!resp.ok) {
        rateError = `HTTP ${resp.status}: ${rateRespBody.slice(0, 200)}`;
      }
    } catch (err) {
      rateError = err instanceof Error ? err.message : String(err);
      rateHttpStatus = 0;
    }

    rateDuration = Date.now() - t0;

    const { rows: logRows } = await pool.query<{ id: string }>(
      `INSERT INTO booking_channel_push_log
         (store_id, sync_job_id, channel_listing_id, provider_id, channel,
          operation, request_url, request_body, http_status, response_body,
          success, error_code, error_message, duration_ms,
          dates_affected)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5,
               'rate_update', $6, $7, $8, $9,
               $10, $11, $12, $13,
               daterange($14::date, $15::date, '[]'))
       RETURNING id::text`,
      [
        storeId, syncJobId ?? null, listingId, resolvedProviderId, listing.channel,
        rateUrl, ratePayload.slice(0, 32_768), rateHttpStatus, rateRespBody,
        rateSuccess,
        rateSuccess ? null : "HTTP_ERROR",
        rateError ?? null,
        rateDuration,
        windowStart, windowEnd,
      ]
    );
    rateLogId = logRows[0]?.id;
  }

  // ── 12. Update sync job status ─────────────────────────────────────────────
  const overallSuccess = (availUpdates.length === 0 || availSuccess) &&
                         (rateUpdates.length === 0 || rateSuccess);
  const overallError = [availError, rateError].filter(Boolean).join("; ");

  if (syncJobId) {
    await pool.query(
      `UPDATE booking_channel_sync_jobs
       SET status = $1, finished_at = now(), error = $2, updated_at = now()
       WHERE id = $3::uuid`,
      [overallSuccess ? "success" : "failed", overallError || null, syncJobId]
    );
  }

  // ── 13. Update listing last_pushed_at ──────────────────────────────────────
  if (overallSuccess) {
    await pool.query(
      `UPDATE booking_channel_listings
       SET last_pushed_at = now(), updated_at = now(),
           status = 'active', error_message = null
       WHERE id = $1::uuid`,
      [listingId]
    );
  } else {
    await pool.query(
      `UPDATE booking_channel_listings
       SET error_message = $1, updated_at = now()
       WHERE id = $2::uuid`,
      [overallError.slice(0, 500), listingId]
    );
  }

  return {
    status: overallSuccess ? "ok" : "error",
    message: overallSuccess
      ? `ARI push succeeded: ${availUpdates.length} availability + ${rateUpdates.length} rate updates`
      : `ARI push failed: ${overallError}`,
    push_log_id: availLogId ?? rateLogId,
    availability_updated: availUpdates.length,
    rates_updated: rateUpdates.length,
  };
}

// ── Channel Sync Push ──────────────────────────────────────────────────────────

export async function pushChannelSync(
  storeId: string,
  listingId: string
): Promise<{ status: string; message: string; feed_url?: string | undefined }> {
  const pool = getPool();

  const { rows } = await pool.query<{
    id: string;
    channel: string;
    resource_id: string;
    managed_by_provider_id: string | null;
  }>(
    `SELECT cl.id::text, cl.channel, cl.resource_id::text,
            cl.managed_by_provider_id::text
     FROM booking_channel_listings cl
     JOIN booking_resources r ON r.id = cl.resource_id
     WHERE cl.id = $1::uuid AND r.store_id = $2::uuid`,
    [listingId, storeId]
  );
  if (!rows[0]) throw notFound("channel listing not found");
  const listing = rows[0];

  // Decision logic:
  // 1. If the listing has a managed_by_provider_id (ARI credential configured),
  //    always attempt a direct ARI push — regardless of channel type. This is the
  //    most correct path: the operator has explicitly configured an API integration.
  // 2. If no provider configured, fall back to iCal feed URL for direct OTA channels
  //    that support iCal (Airbnb, Booking.com, VRBO, etc.).
  // 3. Channel managers (Guesty, Hostaway, SiteMinder, etc.) REQUIRE a provider;
  //    without one, return credential_missing.

  if (listing.managed_by_provider_id) {
    // Direct ARI push via configured provider. Default window: today + 365 days.
    const today = new Date().toISOString().slice(0, 10);
    const yearOut = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    const result = await pushARIToProvider(storeId, listingId, today, yearOut, listing.managed_by_provider_id);
    return { status: result.status, message: result.message };
  }

  // No provider: for direct OTA channels that support iCal, return the feed URL.
  // The OTA polls this URL to pull availability — no direct push from our side needed.
  const icalChannels = [
    "airbnb", "booking_com", "vrbo", "expedia", "hotels_com",
    "tripadvisor", "google_vacation_rentals", "google_reserve",
  ];

  if (icalChannels.includes(listing.channel)) {
    const feedUrl = `/storefront/${storeId}/booking-resources/${listing.resource_id}/ical.ics`;
    await pool.query(
      `UPDATE booking_channel_listings SET last_pushed_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [listingId]
    );
    return { status: "ok", message: "iCal feed URL ready", feed_url: feedUrl };
  }

  // Channel manager without ARI credentials → credential_missing.
  return {
    status: "credential_missing",
    message: "No provider configured for this channel manager listing. Set managed_by_provider_id via PUT channel-listings/:id.",
  };
}

// ── Webhook Logging ────────────────────────────────────────────────────────────

export async function logWebhook(
  storeId: string | null,
  channel: string,
  eventType: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  channelReservationId?: string | null | undefined
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO booking_channel_webhook_log
       (store_id, channel, event_type, method, path, headers, body, channel_reservation_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING id::text`,
    [
      storeId,
      channel,
      eventType,
      method,
      path,
      JSON.stringify(headers),
      body,
      channelReservationId ?? null,
    ]
  );
  return rows[0]?.id ?? "";
}

// ── Sync Jobs ──────────────────────────────────────────────────────────────────

export async function listSyncJobs(
  storeId: string,
  opts: ListSyncJobsOpts = {}
): Promise<{ jobs: ChannelSyncJob[]; total: number }> {
  const pool = getPool();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const where = ["store_id = $1::uuid"];
  const args: unknown[] = [storeId];
  let n = 2;

  if (opts.status) { where.push(`status = $${n++}`); args.push(opts.status); }
  if (opts.channel) { where.push(`channel = $${n++}`); args.push(opts.channel); }

  const w = where.join(" AND ");
  const [res, cnt] = await Promise.all([
    pool.query<ChannelSyncJob>(
      `SELECT id::text, store_id::text, channel_listing_id::text, provider_id::text,
              channel, job_type, window_start::text, window_end::text, status,
              priority, attempts, max_attempts, scheduled_at, started_at, finished_at,
              next_retry_at, error, payload
       FROM booking_channel_sync_jobs WHERE ${w}
       ORDER BY scheduled_at DESC LIMIT $${n} OFFSET $${n+1}`,
      [...args, limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM booking_channel_sync_jobs WHERE ${w}`, args
    ),
  ]);
  return { jobs: res.rows, total: parseInt(cnt.rows[0]?.count ?? "0", 10) };
}

export async function enqueueSyncJob(
  storeId: string,
  input: EnqueueSyncJobInput
): Promise<ChannelSyncJob> {
  const pool = getPool();
  const { rows } = await pool.query<ChannelSyncJob>(
    `INSERT INTO booking_channel_sync_jobs
       (store_id, channel_listing_id, provider_id, channel, job_type,
        window_start, window_end, priority, payload)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7::date, $8, $9::jsonb)
     RETURNING id::text, store_id::text, channel_listing_id::text, provider_id::text,
               channel, job_type, window_start::text, window_end::text, status,
               priority, attempts, max_attempts, scheduled_at, started_at, finished_at,
               next_retry_at, error, payload`,
    [
      storeId,
      input.channel_listing_id ?? null,
      input.provider_id ?? null,
      input.channel,
      input.job_type,
      input.window_start ?? null,
      input.window_end ?? null,
      input.priority ?? 0,
      JSON.stringify(input.payload ?? null),
    ]
  );
  if (!rows[0]) throw new Error("enqueueSyncJob: no row returned");
  return rows[0];
}
