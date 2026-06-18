-- ============================================================================
-- 0042_b2b_catalog_gating — B2B per-company CATALOG GATING.
--
-- Wave-17: a B2B company can be restricted to a SUBSET of the catalog and/or
-- carry an assigned price list. Gating is OPT-IN and only ever engages when a
-- *company context* is present on a request — the non-B2B (no-company) catalog
-- path stays byte-identical.
--
-- Two pieces:
--
--   1. public.company_catalog_access — rows enumerate the products/collections
--      a company MAY see (access_type 'allow'). The model is allow-list, but
--      *opt-in*: if a company has NO rows here, it sees the FULL catalog (no
--      restriction). Once it has at least one 'allow' row, it sees ONLY the
--      directly-allowed products plus every product belonging to an allowed
--      collection. Each row references EITHER a product_id OR a collection_id
--      (never both, never neither — enforced by a CHECK).
--
--   2. Price-list assignment ALREADY EXISTS: public.companies.price_list_id
--      (0001_commerce) FKs public.price_lists(id). We REUSE that column rather
--      than adding a parallel link table — no schema change to companies is
--      needed for pricing. (Documented here for the migration record.)
--
-- company_catalog_access is a per-store tenant table: it carries store_id and
-- is RLS-gated by public.is_store_member(store_id), mirroring 0031/0035 (+ the
-- standard cartcrft_app grants). Style mirrors 0031/0035 (create-if-not-exists,
-- enable RLS, isolation policy, grants).
-- ============================================================================

begin;

create table if not exists public.company_catalog_access (
  id            uuid        primary key default gen_random_uuid(),
  store_id      uuid        not null references public.stores(id)      on delete cascade,
  company_id    uuid        not null references public.companies(id)   on delete cascade,
  access_type   text        not null default 'allow' check (access_type in ('allow')),
  product_id    uuid        references public.products(id)             on delete cascade,
  collection_id uuid        references public.collections(id)          on delete cascade,
  created_at    timestamptz not null default now(),
  -- exactly one of product_id / collection_id must be set
  constraint company_catalog_access_target_chk
    check ((product_id is not null) <> (collection_id is not null))
);

comment on table public.company_catalog_access is
  'B2B per-company catalog allow-list. Each row grants a company visibility of ONE product or ONE collection. '
  'OPT-IN: a company with ZERO rows sees the FULL catalog; once it has rows it sees ONLY allowed products '
  '(directly, or via an allowed collection). Gating engages only when a company context is present on a request.';
comment on column public.company_catalog_access.access_type is
  'Access semantics. Currently only ''allow'' (allow-list). Reserved for a future ''deny'' override.';
comment on column public.company_catalog_access.product_id is
  'Directly-allowed product. Mutually exclusive with collection_id (CHECK).';
comment on column public.company_catalog_access.collection_id is
  'Allowed collection — every product in it is visible to the company. Mutually exclusive with product_id (CHECK).';

create index if not exists idx_company_catalog_access_company
  on public.company_catalog_access (store_id, company_id);

-- Dedup: at most one allow row per (company, product) and per (company, collection).
create unique index if not exists uq_company_catalog_access_product
  on public.company_catalog_access (company_id, product_id)
  where product_id is not null;

create unique index if not exists uq_company_catalog_access_collection
  on public.company_catalog_access (company_id, collection_id)
  where collection_id is not null;

-- ── RLS — org-gated, mirrors 0031/0035 tenant isolation ─────────────────────
alter table public.company_catalog_access enable row level security;

drop policy if exists company_catalog_access_isolation on public.company_catalog_access;
create policy company_catalog_access_isolation on public.company_catalog_access
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0031/0035) ──────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.company_catalog_access to cartcrft_app;
  end if;
end$$;

commit;
