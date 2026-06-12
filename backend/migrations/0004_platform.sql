-- ============================================================================
-- 0004_PLATFORM — API keys + exchange rates
--
-- Sources:
--   api_keys   ← webcrft-mono: 20260415000043_platform_api_keys.sql (subset)
--   exchange_rates ← webcrft-mono: 20260218000017_exchange_rates.sql (verbatim)
--
-- Cartcrft adaptations for api_keys:
--   • Table renamed: platform_api_keys → api_keys
--   • organization_id: plain uuid not null (no FK to platform organisations)
--   • site_id replaced by store_id references public.stores(id) ON DELETE CASCADE
--   • created_by: plain uuid (no FK to platform profiles)
--   • Key prefixes: wc_pub_ / wc_prv_ → cc_pub_ / cc_prv_
--   • Dropped: 'alter table public.stores add column if not exists site_id…'
--     (irrelevant in cartcrft — no sites table)
--   • Dropped: 'drop table if exists public.store_api_keys cascade'
--     (not applicable)
--   • RLS added for api_keys in 0006_rls.sql
-- ============================================================================

begin;

-- ============================================================================
-- 1. API KEYS
-- ============================================================================

create table public.api_keys (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,           -- plain uuid; no FK
  store_id        uuid        references public.stores(id) on delete cascade,
  name            text        not null,
  key_prefix      text        not null generated always as (left(key_hash, 8)) stored,
  key_hash        text        not null unique,     -- SHA-256(raw_key) for lookup
  key_masked      text        not null,            -- cc_pub_xxxx...yyyy — safe to display in UI
  scopes          text[]      not null default '{}',
  last_used_at    timestamptz,
  expires_at      timestamptz,
  is_active       boolean     not null default true,
  created_by      uuid,                            -- nullable; no FK (no platform profiles)
  metadata        jsonb       not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Enforce cc_pub_ / cc_prv_ prefix convention in the masked representation
  check (
    key_masked like 'cc_pub_%' or
    key_masked like 'cc_prv_%' or
    key_masked like 'cc_test_%'
  )
);

comment on table  public.api_keys                 is 'API keys for programmatic access to the Cartcrft API. Use cc_pub_ for client-side publishable keys and cc_prv_ for server-side secret keys.';
comment on column public.api_keys.organization_id is 'Owning organisation. Plain UUID — no FK.';
comment on column public.api_keys.store_id        is 'Optional store scope. NULL = organisation-level key (access all stores).';
comment on column public.api_keys.key_hash        is 'SHA-256 hex digest of the raw API key. The raw key is shown once at creation and never stored.';
comment on column public.api_keys.key_masked      is 'Display-safe masked form shown in the dashboard, e.g. cc_pub_abc123...xyz789.';
comment on column public.api_keys.scopes          is 'Granted permission scopes, e.g. {orders:read, products:write, webhooks:manage}.';
comment on column public.api_keys.key_prefix      is 'First 8 chars of key_hash — used for fast index-based key lookup before full hash comparison.';

create index idx_api_keys_org        on public.api_keys(organization_id);
create index idx_api_keys_store      on public.api_keys(store_id) where store_id is not null;
create index idx_api_keys_hash       on public.api_keys(key_hash);
create index idx_api_keys_prefix     on public.api_keys(key_prefix, is_active);

create trigger api_keys_updated_at
  before update on public.api_keys
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 2. EXCHANGE RATES
-- ============================================================================

create table public.exchange_rates (
  id         uuid        primary key default gen_random_uuid(),
  base       char(3)     not null default 'USD',   -- ISO 4217 base currency
  rates      jsonb       not null,                  -- { "EUR": 0.9234, "GBP": 0.7912, … }
  fetched_at timestamptz not null default now()
);

comment on table  public.exchange_rates            is 'Snapshot exchange rates. Fetched periodically by the currency worker. Latest row per base used for price conversion.';
comment on column public.exchange_rates.base       is 'ISO 4217 three-letter base currency code, e.g. USD.';
comment on column public.exchange_rates.rates      is 'Map of target ISO 4217 codes → exchange rate relative to base.';
comment on column public.exchange_rates.fetched_at is 'UTC timestamp when this rate snapshot was fetched from the provider.';

create index idx_exchange_rates_fetched on public.exchange_rates(fetched_at desc);
create index idx_exchange_rates_base    on public.exchange_rates(base, fetched_at desc);

commit;
