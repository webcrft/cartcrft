-- ============================================================================
-- 0039_customer_addresses — saved/multiple customer address book.
--
-- public.customer_addresses ALREADY EXISTS from 0001_commerce (it backs the
-- admin customer-detail view and checkout). It carries:
--   first_name, last_name, company, line1, line2, city, province,
--   province_code, postal_code, country_code, phone,
--   is_default_shipping, is_default_billing, created_at
-- and a customer_id FK. RLS (customer_addresses_all, 0006_rls) gates access via
-- a join to customers.store_id, so the existing rows are already org-isolated.
--
-- This migration upgrades that table into a first-class storefront address book
-- WITHOUT recreating it (so existing rows / checkout reads keep working):
--
--   • store_id   uuid   — denormalised tenant scope so the storefront service
--       can filter directly by (store_id, customer_id) without a customers join,
--       matching the (store_id, customer_id)-scoped, parameterised query style
--       used elsewhere. Backfilled from customers, then NOT NULL + FK.
--   • label      text   — customer-facing nickname ("Home", "Work").
--   • name       text   — single full-name field (checkout shipping_address jsonb
--       uses `name`; first_name/last_name are kept too).
--   • updated_at timestamptz — maintained by the shared set_updated_at trigger.
--
-- Plus:
--   • idx_customer_addresses_store_customer (store_id, customer_id) for the
--       storefront list path.
--   • Partial unique indexes so a customer has AT MOST ONE default shipping and
--       AT MOST ONE default billing address (the service flips these atomically).
--
-- Column additions need no new grants (cartcrft_app already holds DML on the
-- table from the Wave-1 grant set), and RLS is already enabled + policy'd. Style
-- mirrors 0037/0038 (begin/commit, if-not-exists, set_updated_at trigger via the
-- shared helper guarded by a pg_proc check).
-- ============================================================================

begin;

-- ── New columns (idempotent) ────────────────────────────────────────────────
alter table public.customer_addresses
  add column if not exists store_id   uuid,
  add column if not exists label      text,
  add column if not exists name       text,
  add column if not exists updated_at timestamptz not null default now();

comment on column public.customer_addresses.store_id is
  'Denormalised tenant scope (= customers.store_id). Lets the storefront address-book service filter by (store_id, customer_id) without a customers join.';
comment on column public.customer_addresses.label is
  'Customer-facing nickname for the saved address ("Home", "Work").';
comment on column public.customer_addresses.name is
  'Full recipient name. Mirrors the checkout/orders shipping_address jsonb `name` field (first_name/last_name remain available too).';

-- ── Backfill store_id from the owning customer, then lock it down ────────────
update public.customer_addresses a
set store_id = c.store_id
from public.customers c
where a.customer_id = c.id
  and a.store_id is null;

-- Any orphan rows (customer deleted out from under, shouldn't happen due to the
-- ON DELETE CASCADE FK) are removed so the NOT NULL constraint can be applied.
delete from public.customer_addresses where store_id is null;

alter table public.customer_addresses
  alter column store_id set not null;

-- Add the FK only if it is not already present.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'customer_addresses_store_id_fkey'
      and conrelid = 'public.customer_addresses'::regclass
  ) then
    alter table public.customer_addresses
      add constraint customer_addresses_store_id_fkey
      foreign key (store_id) references public.stores(id) on delete cascade;
  end if;
end$$;

-- ── Auto-fill store_id from the owning customer on INSERT ────────────────────
-- The admin customer service (modules/customers/service.ts) inserts addresses
-- WITHOUT a store_id (it predates this column). Rather than couple this address
-- book to that writer, derive store_id from customer_id whenever it is omitted,
-- so every writer satisfies the NOT NULL constraint transparently.
create or replace function public.customer_addresses_fill_store_id()
returns trigger
language plpgsql
as $$
begin
  if new.store_id is null then
    select c.store_id into new.store_id
    from public.customers c
    where c.id = new.customer_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_customer_addresses_fill_store_id on public.customer_addresses;
create trigger trg_customer_addresses_fill_store_id
  before insert on public.customer_addresses
  for each row execute function public.customer_addresses_fill_store_id();

-- ── Indexes ─────────────────────────────────────────────────────────────────
create index if not exists idx_customer_addresses_store_customer
  on public.customer_addresses (store_id, customer_id);

-- At most one default shipping / billing address per customer.
create unique index if not exists uq_customer_addresses_default_shipping
  on public.customer_addresses (customer_id)
  where is_default_shipping;

create unique index if not exists uq_customer_addresses_default_billing
  on public.customer_addresses (customer_id)
  where is_default_billing;

-- ── updated_at maintenance (reuse the shared helper if present) ──────────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_customer_addresses_updated_at on public.customer_addresses;
    create trigger trg_customer_addresses_updated_at
      before update on public.customer_addresses
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
