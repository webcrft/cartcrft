-- ============================================================================
-- 0035_threepl — 3PL / fulfillment-network adapter (ShipBob-style).
--
-- Submit orders to an external 3PL for pick/pack/ship and track status. This is
-- self-contained and does NOT touch the shipping module's fulfillment_orders —
-- the 3PL module owns its OWN tracking table (threepl_fulfillments).
--
-- Two store-scoped tables:
--
--   threepl_providers     — one row per (store, provider). `provider` selects the
--                           connector (shipbob today; more slot in via the
--                           service-layer registry). `config` is non-secret jsonb
--                           (e.g. shipping_method, integration_slug/name pointing
--                           at the store_integrations row that holds the API
--                           token). The API TOKEN is NOT stored here — it is read
--                           decrypted from store_integrations (AUTH_SECRETS_KEY
--                           path) exactly like shipping/payments/channel secrets.
--                           is_active gates submit + worker discovery.
--
--   threepl_fulfillments  — one row per (order, provider). external_id is the id
--                           the 3PL assigned. status tracks the fulfillment
--                           lifecycle; tracking_number/tracking_url carry the
--                           carrier tracking once shipped. unique(order_id,
--                           provider) makes submit idempotent so a re-submit
--                           returns the existing row instead of double-submitting.
--
-- RLS: org-gated exactly like 0019_rls_tenant_isolation / 0034_channel_sync via
-- is_store_member() (+ the standard cartcrft_app grants). The background status
-- worker uses the BYPASSRLS owner connection (getPool) because it has no
-- per-request tenant context; the store_id column scopes every query.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── threepl_providers — per-(store, provider) 3PL config ─────────────────────
create table if not exists public.threepl_providers (
  id              uuid        primary key default gen_random_uuid(),
  store_id        uuid        not null references public.stores(id) on delete cascade,
  provider        text        not null check (provider in ('shipbob')),
  is_active       boolean     not null default true,
  -- Non-secret connector config: { shipping_method:text, integration_slug:text,
  -- integration_name:text }. The API token is read from store_integrations
  -- (encrypted), never stored here. Service-validated.
  config          jsonb       not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (store_id, provider),
  check (octet_length(config::text) <= 16384)
);

comment on table  public.threepl_providers is
  'Per-(store, provider) 3PL/fulfillment-network config. provider selects the connector; config is non-secret jsonb; the API token is read from store_integrations (encrypted).';
comment on column public.threepl_providers.config is
  'Non-secret connector config (shipping_method, integration_slug/name). Secrets (API token) live in store_integrations.';

create index if not exists idx_threepl_providers_store
  on public.threepl_providers (store_id);
-- Worker discovery: active providers across all stores.
create index if not exists idx_threepl_providers_active
  on public.threepl_providers (provider)
  where is_active = true;

-- ── threepl_fulfillments — per-(order, provider) fulfillment state ───────────
create table if not exists public.threepl_fulfillments (
  id               uuid        primary key default gen_random_uuid(),
  store_id         uuid        not null references public.stores(id) on delete cascade,
  order_id         uuid        not null references public.orders(id) on delete cascade,
  provider         text        not null,
  -- Id assigned by the external 3PL (e.g. ShipBob order id).
  external_id      text,
  status           text        not null default 'pending'
                     check (status in (
                       'pending', 'submitted', 'processing',
                       'shipped', 'delivered', 'cancelled', 'error'
                     )),
  tracking_number  text,
  tracking_url     text,
  last_error       text,
  submitted_at     timestamptz,
  last_synced_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- Idempotent submit: re-submitting an order updates this row in place.
  unique (order_id, provider)
);

comment on table  public.threepl_fulfillments is
  'Per-(order, provider) 3PL fulfillment state. external_id is the 3PL-assigned id; unique(order_id, provider) makes submit idempotent (no double-submit). Distinct from shipping.fulfillment_orders.';

create index if not exists idx_threepl_fulfillments_store
  on public.threepl_fulfillments (store_id);
create index if not exists idx_threepl_fulfillments_order
  on public.threepl_fulfillments (order_id);
-- Worker discovery: non-terminal fulfillments that still need a status pull.
create index if not exists idx_threepl_fulfillments_open
  on public.threepl_fulfillments (store_id)
  where status in ('submitted', 'processing', 'shipped');

-- ── RLS — org-gated, mirrors 0019 / 0034 ────────────────────────────────────
alter table public.threepl_providers      enable row level security;
alter table public.threepl_fulfillments   enable row level security;

drop policy if exists threepl_providers_isolation on public.threepl_providers;
create policy threepl_providers_isolation on public.threepl_providers
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

drop policy if exists threepl_fulfillments_isolation on public.threepl_fulfillments;
create policy threepl_fulfillments_isolation on public.threepl_fulfillments
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0019/0034) ───────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.threepl_providers    to cartcrft_app;
    grant select, insert, update, delete on public.threepl_fulfillments to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ────────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_threepl_providers_updated_at on public.threepl_providers;
    create trigger trg_threepl_providers_updated_at
      before update on public.threepl_providers
      for each row execute function public.set_updated_at();

    drop trigger if exists trg_threepl_fulfillments_updated_at on public.threepl_fulfillments;
    create trigger trg_threepl_fulfillments_updated_at
      before update on public.threepl_fulfillments
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
