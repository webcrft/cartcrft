-- ============================================================================
-- 0028_checkout_links — Shareable checkout / payment links (Stripe-Link-style)
--
-- A merchant (or an agent) creates a checkout_link that encodes a prefilled
-- cart snapshot. Anyone with the public token (cl_<random>) opens a
-- cartcrft-hosted checkout page, reviews the cart, and pays via the store's
-- configured provider. The link is then marked 'completed' when its checkout
-- completes (driven by the existing webhook finalisation path).
--
-- Snapshot semantics:
--   line_items is a jsonb array captured AT CREATION time. Each element is
--   { "variant_id": uuid, "qty": int, "unit_price": "decimal-string" }.
--   The unit_price is snapshotted so the displayed totals are stable; the
--   actual order still re-fetches live variant prices at completion (see
--   checkout/complete.ts invariant 2) — the snapshot is for display + audit.
--
-- Public exposure:
--   `token` is the ONLY public identifier (cl_<random>, unguessable). The
--   public resolve / start-payment endpoints look the row up by token and
--   NEVER trust a caller-supplied store_id — store scoping is derived from the
--   row, so there is no cross-store data leak. The merchant create/list/void
--   endpoints are storeAuthWrite + RLS org-gated like every other tenant table.
--
-- RLS: org-gated exactly like 0019_rls_tenant_isolation via is_store_member()
-- (+ the standard cartcrft_app grants). The public endpoints run WITHOUT a
-- request context (no setRequestCtx) on the owner/BYPASSRLS read path — the
-- token is the capability — exactly like the recovery + oauth-server flows.
-- ============================================================================

begin;

-- ── status enum ──────────────────────────────────────────────────────────────
-- The existence check is scoped to the schema this DDL targets (current_schema)
-- so the test harness — which rewrites `public.` → the per-run test schema —
-- creates its own copy of the type instead of being short-circuited by the
-- type already existing in another schema.
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'checkout_link_status'
      and n.nspname = current_schema()
  ) then
    create type public.checkout_link_status as enum ('open', 'completed', 'expired', 'void');
  end if;
end$$;

-- ── table ────────────────────────────────────────────────────────────────────
create table if not exists public.checkout_links (
  id                    uuid        primary key default gen_random_uuid(),
  store_id              uuid        not null references public.stores(id) on delete cascade,
  token                 text        not null,                      -- public id: cl_<random>
  line_items            jsonb       not null default '[]',         -- snapshot: [{variant_id, qty, unit_price}]
  currency              char(3)     not null,
  customer_email        text,
  success_url           text,
  cancel_url            text,
  status                public.checkout_link_status not null default 'open',
  expires_at            timestamptz,
  completed_checkout_id uuid        references public.checkouts(id) on delete set null,
  created_by            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table  public.checkout_links is
  'Shareable checkout/payment links. token (cl_<random>) is the only public identifier; '
  'line_items is a price snapshot captured at creation. RLS org-gated like 0019.';
comment on column public.checkout_links.token is
  'Public, unguessable capability token (cl_<random>). The hosted /pay/<token> page resolves the link by this token alone — store scoping is derived from the row, never from caller input.';
comment on column public.checkout_links.line_items is
  'Snapshot array [{variant_id, qty, unit_price}] taken at creation. Display/audit only — order completion re-fetches live prices.';
comment on column public.checkout_links.completed_checkout_id is
  'The checkout created when the link was paid. Set when status transitions to completed.';

create unique index if not exists ux_checkout_links_token on public.checkout_links (token);
create index if not exists idx_checkout_links_store on public.checkout_links (store_id, created_at desc);
create index if not exists idx_checkout_links_status on public.checkout_links (store_id, status);

-- ── RLS — org-gated, mirrors 0019 tenant isolation ──────────────────────────
alter table public.checkout_links enable row level security;

drop policy if exists checkout_links_isolation on public.checkout_links;
create policy checkout_links_isolation on public.checkout_links
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0019/0027) ──────────────────
-- (Default privileges from 0014 already cover this for fresh DBs; we re-grant
-- explicitly so the migration is self-contained and idempotent.)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.checkout_links to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_checkout_links_updated_at on public.checkout_links;
    create trigger trg_checkout_links_updated_at
      before update on public.checkout_links
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
