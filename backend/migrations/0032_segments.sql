-- ============================================================================
-- 0032_segments — Customer segmentation (RFM-style merchant-defined segments).
--
-- A single store-scoped table, `customer_segments`, holding a named segment and
-- its `rules` JSONB definition. Membership is COMPUTED ON DEMAND from the rules
-- against the live customers/orders data (no materialized membership table in
-- v1), so segments always reflect current customer state.
--
-- Rule shape (documented + validated in src/modules/segments/types.ts):
--   {
--     "match": "all" | "any",            -- AND vs OR across conditions
--     "conditions": [
--       { "field": "total_spent",        "op": ">=", "value": 100 },
--       { "field": "order_count",        "op": ">=", "value": 2 },
--       { "field": "last_order_days_ago","op": "<=", "value": 30 },
--       { "field": "has_tag",            "op": "=",  "value": "vip" },
--       { "field": "email_domain",       "op": "=",  "value": "acme.com" }
--     ]
--   }
--
-- The service maps each `field` to a HARDCODED parameterized SQL fragment — the
-- raw rule text is never concatenated into SQL — so a malicious `value` can only
-- ever be a bound parameter, never executed.
--
-- RLS: org-gated exactly like 0019_rls_tenant_isolation via is_store_member()
-- (+ the standard cartcrft_app grants), like every other tenant table.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── customer_segments — one named, rule-defined segment per row ─────────────
create table if not exists public.customer_segments (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id) on delete cascade,
  name        text        not null,
  description text,
  rules       jsonb       not null default '{"match":"all","conditions":[]}',
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (store_id, name),
  check (octet_length(name) between 1 and 200),
  check (octet_length(rules::text) <= 65536)
);

comment on table public.customer_segments is
  'Merchant-defined customer segment. rules (jsonb) is an allow-listed condition set evaluated on demand against customers/orders; membership is not materialized in v1.';
comment on column public.customer_segments.rules is
  'Segment rule definition: { match: "all"|"any", conditions: [{ field, op, value }] }. Each field maps to a hardcoded parameterized SQL fragment in the service.';

create index if not exists idx_customer_segments_store
  on public.customer_segments (store_id);
create index if not exists idx_customer_segments_store_active
  on public.customer_segments (store_id, is_active);

-- ── RLS — org-gated, mirrors 0019 tenant isolation ──────────────────────────
alter table public.customer_segments enable row level security;

drop policy if exists customer_segments_isolation on public.customer_segments;
create policy customer_segments_isolation on public.customer_segments
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0019/0028/0031) ─────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.customer_segments to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_customer_segments_updated_at on public.customer_segments;
    create trigger trg_customer_segments_updated_at
      before update on public.customer_segments
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
