-- ============================================================================
-- 0044_back_in_stock — Back-in-stock notification subscriptions.
--
-- Wave-18.2: a shopper subscribes to an OUT-OF-STOCK variant and is notified
-- (email) when it is restocked. One store-scoped table:
--
--   back_in_stock_subscriptions — one subscriber's interest in one variant.
--     A subscriber is EITHER a logged-in customer (customer_id) OR an anonymous
--     storefront visitor who supplied an email (email) — exactly one of the two
--     must be present (CHECK). status walks active → notified (or → cancelled).
--     last_known_on_hand captures the variant's total on-hand at subscribe time
--     so the worker can detect the <=0 → >0 restock transition.
--
-- Restock detection (service.processRestocks):
--   The worker scans ACTIVE subscriptions whose variant's TOTAL on-hand across
--   warehouses transitioned from <=0 (its last_known_on_hand snapshot) to >0
--   (current). For each it sends ONE notification, sets status='notified' and
--   notified_at. notified/cancelled rows are never re-notified — re-subscribing
--   is required for a future restock cycle. last_known_on_hand is refreshed on
--   every tick so a fresh subscribe while in-stock never spuriously fires.
--
-- Dedup:
--   unique(store_id, variant_id, COALESCE(customer_id::text, email)) — a repeat
--   subscribe for the same (variant, subscriber) is a no-op (subscribe uses
--   ON CONFLICT DO UPDATE to re-activate / refresh, never inserting a 2nd row).
--
-- RLS: org-gated exactly like 0033/0037/0042 via is_store_member(store_id)
-- (+ the standard cartcrft_app grants). The worker uses the BYPASSRLS owner
-- connection (getPool) since it has no per-request tenant context.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── back_in_stock_subscriptions — one subscriber ↔ one variant ──────────────
create table if not exists public.back_in_stock_subscriptions (
  id                 uuid        primary key default gen_random_uuid(),
  store_id           uuid        not null references public.stores(id)           on delete cascade,
  variant_id         uuid        not null references public.product_variants(id) on delete cascade,
  -- Subscriber identity: EITHER a logged-in customer OR an anonymous email.
  customer_id        uuid        references public.customers(id) on delete cascade,
  email              text,
  status             text        not null default 'active'
                       check (status in ('active', 'notified', 'cancelled')),
  -- Total on-hand observed at subscribe / last tick. <=0 means out of stock;
  -- the worker fires when it transitions to >0.
  last_known_on_hand int,
  notified_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Require a subscriber identity: customer_id OR email (at least one).
  constraint back_in_stock_subscriptions_subscriber_chk
    check (customer_id is not null or email is not null)
);

comment on table  public.back_in_stock_subscriptions is
  'Back-in-stock notification subscriptions. A shopper (customer_id or anonymous email) subscribes to an out-of-stock variant; the worker notifies once on the <=0 → >0 restock transition.';
comment on column public.back_in_stock_subscriptions.last_known_on_hand is
  'Total on-hand across warehouses at subscribe / last tick. <=0 = out of stock; transition to >0 fires a notification.';
comment on column public.back_in_stock_subscriptions.status is
  'active → notified (sent once) | cancelled (unsubscribed). notified/cancelled rows are never re-notified.';

create index if not exists idx_back_in_stock_subscriptions_store
  on public.back_in_stock_subscriptions (store_id);
-- Worker scans active subscriptions by variant.
create index if not exists idx_back_in_stock_subscriptions_active
  on public.back_in_stock_subscriptions (variant_id)
  where status = 'active';
-- Customer-scoped list path.
create index if not exists idx_back_in_stock_subscriptions_customer
  on public.back_in_stock_subscriptions (store_id, customer_id)
  where customer_id is not null;

-- Dedup: at most one row per (store, variant, subscriber). COALESCE folds the
-- customer/email identity into a single key so a repeat subscribe upserts.
create unique index if not exists uq_back_in_stock_subscriptions_dedup
  on public.back_in_stock_subscriptions
     (store_id, variant_id, (coalesce(customer_id::text, email)));

-- ── RLS — org-gated, mirrors 0033/0037/0042 tenant isolation ────────────────
alter table public.back_in_stock_subscriptions enable row level security;

drop policy if exists back_in_stock_subscriptions_isolation on public.back_in_stock_subscriptions;
create policy back_in_stock_subscriptions_isolation on public.back_in_stock_subscriptions
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0033/0037/0042) ─────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.back_in_stock_subscriptions to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_back_in_stock_subscriptions_updated_at on public.back_in_stock_subscriptions;
    create trigger trg_back_in_stock_subscriptions_updated_at
      before update on public.back_in_stock_subscriptions
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
