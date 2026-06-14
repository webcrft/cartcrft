-- 0020_analytics_partition_retention
--
-- Scalability improvements for analytics:
--
--  1. worker_leader table — row-claim leader election for distributed worker
--     locks (replaces session-level pg_try_advisory_lock which breaks under
--     Neon transaction-mode connection pooling).
--
--  2. analytics_events_daily_rollup — precomputed daily aggregations of
--     analytics_events keyed (site_id, day) with indexes matching the
--     dashboard query pattern (COUNT(*) FILTER + date_trunc). This avoids
--     full-table scans of the raw events table as it grows.
--
--  3. Analytics retention / archival job — function + supplementary index
--     to support scheduled deletion of events older than a configurable
--     retention window (default 90 days). App-layer worker calls this
--     periodically to keep the raw table bounded.
--
--  4. Missing composite index on analytics_events (site_id, event_name,
--     occurred_at) to accelerate event-name-level funnel queries.
--
-- NOTE on full partitioning: Converting the existing analytics_events table
-- to a RANGE-partitioned table requires recreating it with PARTITION BY RANGE
-- and migrating existing rows — too invasive for an in-flight production DB.
-- The rollup table + retention function is the safe incremental approach.
-- Full partitioning is documented in tasks.md Discovered as a follow-up.

-- ── 1. worker_leader — row-claim distributed lock table ───────────────────────
--
-- Used by lib/workerlock.ts (_PostgresWorkerLock) for leader election.
-- Each named lock is a single row; ownership is held by instance_id until
-- expires_at passes (TTL-based expiry allows automatic failover on crash).
--
-- Acquire: INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < now()
-- Release: DELETE WHERE lock_name = $1 AND instance_id = $2
-- This is safe under any connection-pooling mode (no session state required).

create table if not exists public.worker_leader (
  lock_name   text        primary key,
  instance_id text        not null,
  -- acquired_at for observability / debugging
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- Fast expiry sweep: when stealing expired locks, the WHERE expires_at < now()
-- predicate is used. An index on expires_at lets the GC job quickly find stale rows.
create index if not exists idx_worker_leader_expires_at
  on public.worker_leader (expires_at);

-- ── 2. analytics_events_daily_rollup — precomputed daily aggregates ───────────
--
-- Stores one row per (site_id, day, event_name) with running counts / totals.
-- Dashboard aggregate queries (COUNT(*) FILTER + date_trunc) should be directed
-- at this table instead of the raw events table for performance.
--
-- Refresh strategy:
--   The app-layer analytics rollup job (to be wired in the worker) calls
--   refresh_analytics_daily_rollup(site_id, day) which does an UPSERT from the
--   raw events table for the given day. Run after each write batch or on a
--   short interval (e.g. every 5 minutes) for near-real-time dashboard data.
--
-- Query pattern:
--   SELECT sum(event_count), sum(revenue_total)
--   FROM analytics_events_daily_rollup
--   WHERE site_id = $1 AND day BETWEEN $2 AND $3
--   GROUP BY day, event_name
--   ORDER BY day;

create table if not exists public.analytics_events_daily_rollup (
  site_id      uuid    not null,
  day          date    not null,   -- date_trunc('day', occurred_at)::date
  event_name   text    not null,
  event_count  bigint  not null default 0,
  -- revenue_total: sum of properties->>'total' where parseable, else 0
  revenue_total numeric(15,2) not null default 0,
  -- session cardinality (distinct sessions in this day bucket)
  session_count bigint not null default 0,
  -- refreshed_at for staleness tracking
  refreshed_at timestamptz not null default now(),

  primary key (site_id, day, event_name)
);

-- Primary dashboard index: filter by store, range by day, group by event_name.
create index if not exists idx_analytics_daily_rollup_site_day
  on public.analytics_events_daily_rollup (site_id, day desc);

-- ── 3. Rollup refresh function ────────────────────────────────────────────────
--
-- Recomputes (or inserts) the rollup row for a given site_id + day from
-- the raw analytics_events table. Idempotent — safe to call repeatedly.
--
-- Parameters:
--   p_site_id  — the store / site UUID
--   p_day      — the UTC calendar day to refresh
--
-- The worker calls this for yesterday + today on each tick so the dashboard
-- is always within one tick of current (or use pg_cron for a scheduled call).

create or replace function public.refresh_analytics_daily_rollup(
  p_site_id uuid,
  p_day     date
)
returns void
language plpgsql
as $$
begin
  insert into public.analytics_events_daily_rollup
    (site_id, day, event_name, event_count, revenue_total, session_count, refreshed_at)
  select
    site_id,
    p_day                                           as day,
    event_name,
    count(*)                                        as event_count,
    coalesce(sum(
      case
        when (properties->>'total') ~ '^[0-9]+(\.[0-9]+)?$'
        then (properties->>'total')::numeric
        else 0
      end
    ), 0)                                           as revenue_total,
    count(distinct session_id)                      as session_count,
    now()                                           as refreshed_at
  from public.analytics_events
  where site_id = p_site_id
    and (occurred_at at time zone 'UTC')::date = p_day
  group by site_id, event_name
  on conflict (site_id, day, event_name) do update
    set event_count   = excluded.event_count,
        revenue_total = excluded.revenue_total,
        session_count = excluded.session_count,
        refreshed_at  = excluded.refreshed_at;
end;
$$;

-- ── 4. Retention / archival function ─────────────────────────────────────────
--
-- Deletes analytics_events rows older than p_retention_days (default 90).
-- Returns the number of rows deleted so the caller can log it.
--
-- Usage: SELECT purge_analytics_events(90);
-- Wire into the worker's periodic job (e.g. run nightly or weekly).
--
-- CAUTION: On a large table, run in small batches to avoid long-running
-- transactions.  For now we delete all at once (acceptable for < few million
-- rows). Add a loop+LIMIT if needed.

create or replace function public.purge_analytics_events(
  p_retention_days int default 90
)
returns bigint
language plpgsql
as $$
declare
  v_deleted bigint;
begin
  delete from public.analytics_events
  where occurred_at < now() - (p_retention_days || ' days')::interval;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ── 5. Supplementary index on occurred_at for retention queries ───────────────
--
-- The purge_analytics_events function filters on occurred_at; without an index
-- it does a seqscan on the full events table. This index also benefits
-- time-range dashboard queries that go direct to the raw table.

create index if not exists idx_analytics_events_occurred_at
  on public.analytics_events (occurred_at);

-- ── 6. Grant access to cartcrft_app role ─────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete
      on public.worker_leader to cartcrft_app;
    grant select, insert, update, delete
      on public.analytics_events_daily_rollup to cartcrft_app;
    execute 'grant execute on function public.refresh_analytics_daily_rollup(uuid, date) to cartcrft_app';
    execute 'grant execute on function public.purge_analytics_events(int) to cartcrft_app';
  end if;
end;
$$;

comment on table public.worker_leader is
  'Row-claim distributed leader election for worker jobs. '
  'Safe under Neon transaction-mode connection pooling (no session state). '
  'lib/workerlock.ts _PostgresWorkerLock uses this table.';

comment on table public.analytics_events_daily_rollup is
  'Precomputed daily analytics aggregates per (site_id, day, event_name). '
  'Dashboard queries should prefer this table over analytics_events for performance. '
  'Refreshed by refresh_analytics_daily_rollup(site_id, day).';
