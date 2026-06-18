-- ============================================================================
-- 0037_inventory_low_alerts — reorder-point low-stock alert idempotency state.
--
-- The inventory low-stock worker (inventory/worker.ts) polls inventory_levels
-- for tracked variants whose quantity_on_hand has dropped to/below reorder_point
-- (reorder_point > 0) and emits an `inventory.low` notification event. To avoid
-- re-alerting every tick while stock stays low, it records the last alert per
-- (variant, warehouse) here.
--
-- Alerting rule (service.detectLowStock):
--   Fire an alert only on a NEW transition into low — i.e. no prior alert row,
--   OR the prior alert's last_on_hand was ABOVE the reorder_point (recovered,
--   then dropped again), OR a cooldown (24h) has elapsed since last_alerted_at.
--   When stock recovers above reorder_point, last_on_hand is updated so the next
--   drop re-alerts.
--
-- This is a SEPARATE store-scoped table (cleaner than a column on
-- inventory_levels — avoids touching that table's writers). store_id scopes
-- every query; the worker uses the BYPASSRLS owner connection (getPool) since it
-- has no per-request tenant context.
--
-- RLS: org-gated exactly like 0019_rls_tenant_isolation / 0035_threepl via
-- is_store_member() (+ the standard cartcrft_app grants).
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── inventory_low_alerts — per-(variant, warehouse) last-alert state ─────────
create table if not exists public.inventory_low_alerts (
  id               uuid        primary key default gen_random_uuid(),
  store_id         uuid        not null references public.stores(id)            on delete cascade,
  variant_id       uuid        not null references public.product_variants(id)  on delete cascade,
  warehouse_id     uuid        not null references public.warehouses(id)        on delete cascade,
  -- When we last fired an inventory.low event for this (variant, warehouse).
  last_alerted_at  timestamptz,
  -- The quantity_on_hand observed at the last evaluation. Used to detect a
  -- recovery-then-drop transition (last_on_hand > reorder_point ⇒ re-alert).
  last_on_hand     int,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (variant_id, warehouse_id)
);

comment on table  public.inventory_low_alerts is
  'Per-(variant, warehouse) low-stock alert state for the inventory.low worker. Makes alerting idempotent: re-alert only on a new transition into low (or after a cooldown).';
comment on column public.inventory_low_alerts.last_on_hand is
  'quantity_on_hand at the last evaluation. last_on_hand > reorder_point means stock recovered, so the next drop re-alerts.';

create index if not exists idx_inventory_low_alerts_store
  on public.inventory_low_alerts (store_id);

-- ── RLS — org-gated, mirrors 0019 / 0035 ────────────────────────────────────
alter table public.inventory_low_alerts enable row level security;

drop policy if exists inventory_low_alerts_isolation on public.inventory_low_alerts;
create policy inventory_low_alerts_isolation on public.inventory_low_alerts
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0019/0035) ───────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.inventory_low_alerts to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ────────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_inventory_low_alerts_updated_at on public.inventory_low_alerts;
    create trigger trg_inventory_low_alerts_updated_at
      before update on public.inventory_low_alerts
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
