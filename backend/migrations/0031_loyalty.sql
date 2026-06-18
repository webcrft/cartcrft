-- ============================================================================
-- 0031_loyalty — Native loyalty / points program (earn + redeem).
--
-- A store-scoped points program with three tables:
--
--   loyalty_config   — one row per store. Controls the earn rate
--                      (points_per_currency_unit) and the redemption value
--                      (redeem_value_per_point, e.g. 0.01 ⇒ 100 pts = $1.00).
--                      Auto-created on first read with sensible defaults.
--
--   loyalty_accounts — one wallet per (store, customer). balance_points is the
--                      spendable balance; lifetime_points is the cumulative
--                      earned total (never decremented), useful for tiers.
--
--   loyalty_ledger   — append-only audit trail. Every earn/redeem/adjust/expire
--                      writes one row carrying the signed `points` delta and the
--                      resulting `balance_after`, mirroring the wallet ledger
--                      invariant (UPDATE balance + INSERT ledger in one tx).
--
-- Idempotency:
--   Earn-on-order is idempotent per order via a partial UNIQUE index on
--   (store_id, customer_id, order_id) WHERE entry_type='earn', so replaying an
--   order-completion hook can never double-credit points.
--
-- Money / points typing:
--   points are integers (bigint). Monetary config values are numeric. The
--   redeem endpoint returns points × redeem_value_per_point as the monetary
--   value the caller (checkout) applies as store credit / discount later.
--
-- RLS: org-gated exactly like 0019_rls_tenant_isolation via is_store_member()
-- (+ the standard cartcrft_app grants), like every other tenant table.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── loyalty_config — earn rate + redemption value (one row per store) ────────
create table if not exists public.loyalty_config (
  store_id                  uuid        primary key references public.stores(id) on delete cascade,
  points_per_currency_unit  numeric     not null default 1,    -- points earned per 1.00 spent
  redeem_value_per_point    numeric     not null default 0.01, -- monetary value of 1 point
  is_active                 boolean     not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

comment on table  public.loyalty_config is
  'Per-store loyalty program settings. One row per store; auto-created with defaults on first read.';
comment on column public.loyalty_config.points_per_currency_unit is
  'Points earned per 1.00 of order total (e.g. 1 ⇒ 1 point per currency unit).';
comment on column public.loyalty_config.redeem_value_per_point is
  'Monetary value of a single point on redemption (e.g. 0.01 ⇒ 100 points = 1.00 of store credit).';

-- ── loyalty_accounts — per-customer points wallet ───────────────────────────
create table if not exists public.loyalty_accounts (
  id               uuid        primary key default gen_random_uuid(),
  store_id         uuid        not null references public.stores(id) on delete cascade,
  customer_id      uuid        not null references public.customers(id) on delete cascade,
  balance_points   bigint      not null default 0,
  lifetime_points  bigint      not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (store_id, customer_id)
);

comment on table  public.loyalty_accounts is
  'Per-(store, customer) points wallet. balance_points is spendable; lifetime_points is the cumulative earned total (never decremented).';

create index if not exists idx_loyalty_accounts_store_customer
  on public.loyalty_accounts (store_id, customer_id);

-- ── loyalty_ledger — append-only points audit trail ─────────────────────────
create table if not exists public.loyalty_ledger (
  id             uuid        primary key default gen_random_uuid(),
  store_id       uuid        not null references public.stores(id) on delete cascade,
  customer_id    uuid        not null references public.customers(id) on delete cascade,
  account_id     uuid        not null references public.loyalty_accounts(id) on delete cascade,
  entry_type     text        not null check (entry_type in ('earn', 'redeem', 'adjust', 'expire')),
  points         bigint      not null,         -- signed delta: +earn / -redeem
  balance_after  bigint      not null,
  reason         text,
  order_id       uuid,                          -- set for earn-on-order entries
  created_at     timestamptz not null default now()
);

comment on table  public.loyalty_ledger is
  'Append-only loyalty points ledger. Each row carries the signed points delta and the resulting balance_after.';
comment on column public.loyalty_ledger.points is
  'Signed points delta for this entry (positive for earn/adjust-up, negative for redeem/expire).';

create index if not exists idx_loyalty_ledger_store_customer
  on public.loyalty_ledger (store_id, customer_id, created_at desc);

-- Idempotency for earn-on-order: at most one 'earn' ledger row per order per
-- (store, customer) — so replaying the order-completion hook cannot double-earn.
create unique index if not exists ux_loyalty_ledger_earn_order
  on public.loyalty_ledger (store_id, customer_id, order_id)
  where entry_type = 'earn' and order_id is not null;

-- ── RLS — org-gated, mirrors 0019 tenant isolation ──────────────────────────
alter table public.loyalty_config   enable row level security;
alter table public.loyalty_accounts enable row level security;
alter table public.loyalty_ledger   enable row level security;

drop policy if exists loyalty_config_isolation on public.loyalty_config;
create policy loyalty_config_isolation on public.loyalty_config
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

drop policy if exists loyalty_accounts_isolation on public.loyalty_accounts;
create policy loyalty_accounts_isolation on public.loyalty_accounts
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

drop policy if exists loyalty_ledger_isolation on public.loyalty_ledger;
create policy loyalty_ledger_isolation on public.loyalty_ledger
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0019/0028) ──────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.loyalty_config   to cartcrft_app;
    grant select, insert, update, delete on public.loyalty_accounts to cartcrft_app;
    grant select, insert, update, delete on public.loyalty_ledger   to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_loyalty_config_updated_at on public.loyalty_config;
    create trigger trg_loyalty_config_updated_at
      before update on public.loyalty_config
      for each row execute function public.set_updated_at();

    drop trigger if exists trg_loyalty_accounts_updated_at on public.loyalty_accounts;
    create trigger trg_loyalty_accounts_updated_at
      before update on public.loyalty_accounts
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
