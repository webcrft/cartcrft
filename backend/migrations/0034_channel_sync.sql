-- ============================================================================
-- 0034_channel_sync — Outbound sales-channel sync (push products/inventory to
-- external channels via API, beyond the read-only XML merchant feed).
--
-- Two store-scoped tables:
--
--   channel_syncs       — one row per (store, channel). `channel` selects the
--                         connector (google_shopping today; more slot in via the
--                         service-layer registry). `config` is non-secret jsonb
--                         (e.g. merchant_id, country/currency overrides). The
--                         OAuth ACCESS TOKEN is NOT stored here — it is read from
--                         the store's store_integrations row (encrypted via the
--                         AUTH_SECRETS_KEY path), exactly like shipping/payments
--                         provider secrets. is_active gates worker discovery.
--                         last_synced_at / last_status / last_error record the
--                         most recent run for observability.
--
--   channel_sync_items  — per-(channel_sync, product) sync state. external_id is
--                         the id the channel assigned (Content API offerId/REST
--                         resource id). status tracks pending|synced|error with a
--                         last error string. unique(channel_sync_id, product_id)
--                         makes upsert idempotent so re-running a sync updates the
--                         existing row instead of duplicating it — the basis for
--                         incremental sync + diffing.
--
-- RLS: org-gated exactly like 0019_rls_tenant_isolation via is_store_member()
-- (+ the standard cartcrft_app grants), like every other tenant table. The
-- background worker uses the BYPASSRLS owner connection (getPool) because it has
-- no per-request tenant context; the store_id column scopes every query.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── channel_syncs — per-(store, channel) outbound sync config ────────────────
create table if not exists public.channel_syncs (
  id              uuid        primary key default gen_random_uuid(),
  store_id        uuid        not null references public.stores(id) on delete cascade,
  channel         text        not null check (channel in ('google_shopping')),
  is_active       boolean     not null default true,
  -- Non-secret connector config: { merchant_id:text, country:text, currency:text,
  -- integration_slug:text, integration_name:text }. The access token is read
  -- from store_integrations (encrypted), never stored here. Service-validated.
  config          jsonb       not null default '{}',
  last_synced_at  timestamptz,
  last_status     text        check (last_status in ('ok', 'error', 'partial')),
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (store_id, channel),
  check (octet_length(config::text) <= 16384)
);

comment on table  public.channel_syncs is
  'Per-(store, channel) outbound sync config. channel selects the connector; config is non-secret jsonb (merchant_id etc.); the OAuth access token is read from store_integrations (encrypted).';
comment on column public.channel_syncs.config is
  'Non-secret connector config (merchant_id, country, currency, integration_slug/name). Secrets (access token) live in store_integrations.';

create index if not exists idx_channel_syncs_store
  on public.channel_syncs (store_id);
-- Worker discovery: active syncs across all stores.
create index if not exists idx_channel_syncs_active
  on public.channel_syncs (channel)
  where is_active = true;

-- ── channel_sync_items — per-product sync state (incremental + diffing) ──────
create table if not exists public.channel_sync_items (
  id               uuid        primary key default gen_random_uuid(),
  store_id         uuid        not null references public.stores(id) on delete cascade,
  channel_sync_id  uuid        not null references public.channel_syncs(id) on delete cascade,
  product_id       uuid        not null references public.products(id) on delete cascade,
  -- Id assigned by the external channel (Content API offerId / REST resource id).
  external_id      text,
  status           text        not null default 'pending'
                     check (status in ('pending', 'synced', 'error')),
  error            text,
  synced_at        timestamptz,
  updated_at       timestamptz not null default now(),
  -- Idempotent per-product state: re-running a sync updates this row in place.
  unique (channel_sync_id, product_id)
);

comment on table  public.channel_sync_items is
  'Per-(channel_sync, product) sync state. external_id is the channel-assigned id; unique(channel_sync_id, product_id) makes sync upserts idempotent (incremental sync + diffing).';

create index if not exists idx_channel_sync_items_store
  on public.channel_sync_items (store_id);
create index if not exists idx_channel_sync_items_sync
  on public.channel_sync_items (channel_sync_id);
create index if not exists idx_channel_sync_items_product
  on public.channel_sync_items (product_id);

-- ── RLS — org-gated, mirrors 0019 tenant isolation ──────────────────────────
alter table public.channel_syncs       enable row level security;
alter table public.channel_sync_items  enable row level security;

drop policy if exists channel_syncs_isolation on public.channel_syncs;
create policy channel_syncs_isolation on public.channel_syncs
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

drop policy if exists channel_sync_items_isolation on public.channel_sync_items;
create policy channel_sync_items_isolation on public.channel_sync_items
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0019/0028/0031/0032/0033) ────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.channel_syncs      to cartcrft_app;
    grant select, insert, update, delete on public.channel_sync_items to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_channel_syncs_updated_at on public.channel_syncs;
    create trigger trg_channel_syncs_updated_at
      before update on public.channel_syncs
      for each row execute function public.set_updated_at();

    drop trigger if exists trg_channel_sync_items_updated_at on public.channel_sync_items;
    create trigger trg_channel_sync_items_updated_at
      before update on public.channel_sync_items
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
