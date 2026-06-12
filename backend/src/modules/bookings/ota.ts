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

// ── Channel Sync Push ──────────────────────────────────────────────────────────

export async function pushChannelSync(
  storeId: string,
  listingId: string
): Promise<{ status: string; message: string; feed_url?: string | undefined }> {
  const pool = getPool();

  const { rows } = await pool.query<{ id: string; channel: string; resource_id: string }>(
    `SELECT cl.id::text, cl.channel, cl.resource_id::text
     FROM booking_channel_listings cl
     JOIN booking_resources r ON r.id = cl.resource_id
     WHERE cl.id = $1::uuid AND r.store_id = $2::uuid`,
    [listingId, storeId]
  );
  if (!rows[0]) throw notFound("channel listing not found");
  const listing = rows[0];

  // For iCal-based channels: return feed URL stub
  // For direct OTA API channels: NOT_IMPLEMENTED stub
  const icalChannels = ["airbnb", "booking_com", "vrbo", "expedia", "hotels_com", "tripadvisor", "google_vacation_rentals", "google_reserve"];

  if (icalChannels.includes(listing.channel)) {
    const feedUrl = `/storefront/${storeId}/booking-resources/${listing.resource_id}/ical.ics`;
    // Update last_pushed_at
    await pool.query(
      `UPDATE booking_channel_listings SET last_pushed_at = now(), updated_at = now() WHERE id = $1::uuid`,
      [listingId]
    );
    return { status: "ok", message: "iCal feed URL ready", feed_url: feedUrl };
  }

  // Direct OTA: log not implemented
  await pool.query(
    `INSERT INTO booking_channel_sync_jobs
       (store_id, channel_listing_id, channel, job_type, status, scheduled_at, error)
     VALUES ($1::uuid, $2::uuid, $3, 'push_rates', 'failed', now(), 'NOT_IMPLEMENTED')`,
    [storeId, listingId, listing.channel]
  );

  return { status: "not_implemented", message: "Direct OTA push not yet implemented for this channel" };
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
