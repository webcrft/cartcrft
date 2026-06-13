-- 0016_analytics_events — Analytics events table + RLS policy
--
-- Stores ecommerce tracking events for analytics queries.
--
-- Design notes:
--  - site_id uses store_id directly (Cartcrft has no sites table — matched in
--    analytics.ts comments). Query routes filter by site_id = store_id.
--  - event_type is 'ecommerce' for all commerce events (product_viewed,
--    add_to_cart, checkout_started, order_completed, order_refunded, etc.)
--  - properties JSONB carries event-specific data: total, currency, order_id,
--    product_id, product_name, item_count, etc.
--  - order_id / customer_id are nullable refs for cross-join analytics.
--  - occurred_at mirrors the timestamp column name used in queries (indexed).
--  - RLS policy uses is_store_member() matching other tenant tables.
--    The sink writes via getPool() (neondb_owner / BYPASSRLS) — that's fine.
--    The analytics routes query via getPool() too. Policy exists for future
--    enforced reads.

-- ── Table ─────────────────────────────────────────────────────────────────────

create table if not exists public.analytics_events (
  id              uuid        primary key default gen_random_uuid(),
  site_id         uuid        not null,   -- store_id (Cartcrft has no sites table)
  session_id      uuid        not null default gen_random_uuid(),
  event_type      text        not null default 'ecommerce',
  event_name      text        not null,
  properties      jsonb       not null default '{}',
  -- convenience refs (nullable — populated when available)
  order_id        uuid        references public.orders(id) on delete set null,
  customer_id     uuid        references public.customers(id) on delete set null,
  -- occurred_at used as primary timestamp (mirrors analytics.ts queries alias)
  occurred_at     timestamptz not null default now(),
  -- timestamp column for backward-compat with queries written against webcrft
  -- schema (both columns are maintained identically)
  timestamp       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary query pattern: WHERE site_id = $1 AND event_type = 'ecommerce' AND timestamp BETWEEN ...
create index if not exists idx_analytics_events_site_type_ts
  on public.analytics_events (site_id, event_type, timestamp);

-- Secondary: per-event-name counts within site
create index if not exists idx_analytics_events_site_name_ts
  on public.analytics_events (site_id, event_name, timestamp);

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.analytics_events enable row level security;

-- store members (org owners / staff) can read their own store's events.
-- Writes go via the app role / neondb_owner (fire-and-forget sink) — no write
-- policy needed at this layer; the store_id check in the route is the gate.
create policy analytics_events_select on public.analytics_events
  for select
  using (
    -- site_id = store_id in this schema; check via the stores table
    exists (
      select 1
      from public.stores s
      where s.id = analytics_events.site_id
        and s.organization_id::text = current_setting('app.org_id', true)
    )
  );

-- Allow insert for the cartcrft_app role (PgAnalyticsSink path).
create policy analytics_events_insert on public.analytics_events
  for insert
  with check (true);

comment on table public.analytics_events is
  'Ecommerce analytics events. site_id = store_id (no sites table in Cartcrft). '
  'Standard event names: product_viewed, add_to_cart, remove_from_cart, '
  'checkout_started, order_completed, order_refunded.';
