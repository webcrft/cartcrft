-- ============================================================================
-- 0036_duties — Import duties / landed-cost (DDP) rates.
--
-- Adds a single store-scoped table, `duty_rates`, that models per-destination
-- import duty applied on cross-border orders (Delivered Duty Paid). A store
-- sells from its base country (stores.country_code) and configures the duty it
-- collects when shipping into a given destination country.
--
--   duty_rates
--     destination_country — ISO 3166-1 alpha-2 of the SHIP-TO country. Duty
--                           only applies cross-border (origin ≠ destination).
--     category            — optional product category / HS chapter label. NULL
--                           means the rate applies to ALL products in that
--                           destination; a non-NULL value scopes the rate to
--                           orders that declare a matching category.
--     rate_pct            — duty percentage applied to the declared value.
--     de_minimis_value    — declared-value threshold below which duty is waived
--                           (declaredValue <= de_minimis_value ⇒ that rate
--                           contributes 0). NULL = no threshold (always apply).
--
-- Computation lives in backend/src/lib/tax.ts (calcDuties). Wiring duties into
-- the actual order total at checkout/complete is a follow-up (owned elsewhere).
--
-- RLS: org-gated exactly like 0019_rls_tenant_isolation via is_store_member()
-- (+ the standard cartcrft_app grants), like every other tenant table.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── duty_rates — per-store, per-destination import duty ─────────────────────
create table if not exists public.duty_rates (
  id                   uuid        primary key default gen_random_uuid(),
  store_id             uuid        not null references public.stores(id) on delete cascade,
  destination_country  char(2)     not null,                 -- ISO 3166-1 alpha-2 ship-to
  category             text,                                 -- optional product category / HS chapter; NULL = all
  rate_pct             numeric     not null default 0,       -- duty % on declared value
  de_minimis_value     numeric,                              -- declared value at/below which duty is waived; NULL = always
  is_active            boolean     not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table  public.duty_rates is
  'Per-store import duty rates by destination country (DDP / landed cost). Applied cross-border on declared value.';
comment on column public.duty_rates.destination_country is
  'ISO 3166-1 alpha-2 ship-to country. Duty applies only when destination differs from the store origin country.';
comment on column public.duty_rates.category is
  'Optional product category / HS chapter label. NULL = applies to all products in the destination.';
comment on column public.duty_rates.de_minimis_value is
  'Declared value at/below which duty is waived (declaredValue <= threshold ⇒ rate contributes 0). NULL = always apply.';

create index if not exists idx_duty_rates_store_destination
  on public.duty_rates(store_id, destination_country);

-- ── RLS — org-gated, mirrors 0019 tenant isolation ──────────────────────────
alter table public.duty_rates enable row level security;

drop policy if exists duty_rates_isolation on public.duty_rates;
create policy duty_rates_isolation on public.duty_rates
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0019/0031) ──────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.duty_rates to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_duty_rates_updated_at on public.duty_rates;
    create trigger trg_duty_rates_updated_at
      before update on public.duty_rates
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
