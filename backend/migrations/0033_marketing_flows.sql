-- ============================================================================
-- 0033_marketing_flows — Event-triggered marketing drip sequences (email/SMS).
--
-- A self-contained automation engine (Klaviyo / Shopify-Email style) with two
-- store-scoped tables:
--
--   marketing_flows      — a named, event-triggered sequence. `trigger_event`
--                          decides WHAT enrolls a customer (a new order, a new
--                          customer, or a newly-abandoned cart). `steps` is an
--                          ORDERED jsonb array of actions, each with a
--                          delay_seconds (relative to the previous step / enroll
--                          time), an action ("email" | "sms"), an optional
--                          subject (email only), and a body. is_active gates
--                          both trigger discovery and run processing.
--
--   marketing_flow_runs  — one enrollment of a (flow, customer) for a specific
--                          trigger_ref (e.g. the order id / cart id). It tracks
--                          current_step, status, and next_run_at (when the
--                          current step is due). The worker selects due active
--                          runs (FOR UPDATE SKIP LOCKED), executes the step,
--                          and advances. A run completes after its last step.
--
-- Idempotent enrollment:
--   unique(flow_id, trigger_ref) — enrolling the same trigger entity into the
--   same flow twice is a no-op (enrollFlow uses ON CONFLICT DO NOTHING). This is
--   the correctness safety net for trigger polling: re-scanning the same window
--   can never double-enroll a customer.
--
-- Retry policy:
--   On a send failure the worker records last_error and increments an attempt
--   counter (attempts); after MAX_FLOW_SEND_ATTEMPTS it marks the run failed.
--
-- Time:
--   delay_seconds are integers; next_run_at is a timestamptz computed by the
--   service from the injected Clock (now + delay). No floats.
--
-- RLS: org-gated exactly like 0019_rls_tenant_isolation via is_store_member()
-- (+ the standard cartcrft_app grants), like every other tenant table.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── marketing_flows — a named event-triggered drip sequence ─────────────────
create table if not exists public.marketing_flows (
  id            uuid        primary key default gen_random_uuid(),
  store_id      uuid        not null references public.stores(id) on delete cascade,
  name          text        not null,
  trigger_event text        not null
                  check (trigger_event in ('order_created', 'customer_created', 'abandoned_cart')),
  is_active     boolean     not null default true,
  -- Ordered array of { delay_seconds:int, action:'email'|'sms', subject:text|null, body:text }.
  -- Shape is validated in the service layer; the column cap guards against abuse.
  steps         jsonb       not null default '[]',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (octet_length(name) between 1 and 200),
  check (octet_length(steps::text) <= 131072)
);

comment on table  public.marketing_flows is
  'Event-triggered marketing drip sequence. trigger_event selects the enrolling entity; steps is an ordered jsonb array of delayed email/sms actions.';
comment on column public.marketing_flows.steps is
  'Ordered array: [{ delay_seconds:int>=0, action:"email"|"sms", subject:text|null, body:text }]. Validated by src/modules/marketing/service.ts.';

create index if not exists idx_marketing_flows_store
  on public.marketing_flows (store_id);
-- Trigger discovery filters by (store, trigger_event, is_active).
create index if not exists idx_marketing_flows_trigger
  on public.marketing_flows (store_id, trigger_event)
  where is_active = true;

-- ── marketing_flow_runs — one (flow, customer, trigger_ref) enrollment ──────
create table if not exists public.marketing_flow_runs (
  id            uuid        primary key default gen_random_uuid(),
  store_id      uuid        not null references public.stores(id) on delete cascade,
  flow_id       uuid        not null references public.marketing_flows(id) on delete cascade,
  customer_id   uuid        references public.customers(id) on delete set null,
  -- The triggering entity id (order id / cart id / customer id). Combined with
  -- flow_id it makes enrollment idempotent.
  trigger_ref   text        not null,
  current_step  int         not null default 0,
  status        text        not null default 'active'
                  check (status in ('active', 'completed', 'cancelled', 'failed')),
  next_run_at   timestamptz,
  attempts      int         not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Idempotent enrollment: at most one run per (flow, trigger_ref).
  unique (flow_id, trigger_ref)
);

comment on table  public.marketing_flow_runs is
  'A single enrollment of a customer into a marketing flow for one trigger_ref. The worker advances current_step on next_run_at and completes after the last step.';
comment on column public.marketing_flow_runs.trigger_ref is
  'Id of the entity that triggered enrollment (order/cart/customer id). unique(flow_id, trigger_ref) guarantees idempotent enrollment.';

-- Worker tick selects active runs that are due: (status, next_run_at).
create index if not exists idx_marketing_flow_runs_due
  on public.marketing_flow_runs (next_run_at)
  where status = 'active';
create index if not exists idx_marketing_flow_runs_store
  on public.marketing_flow_runs (store_id);
create index if not exists idx_marketing_flow_runs_flow
  on public.marketing_flow_runs (flow_id);

-- ── RLS — org-gated, mirrors 0019 tenant isolation ──────────────────────────
alter table public.marketing_flows     enable row level security;
alter table public.marketing_flow_runs enable row level security;

drop policy if exists marketing_flows_isolation on public.marketing_flows;
create policy marketing_flows_isolation on public.marketing_flows
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

drop policy if exists marketing_flow_runs_isolation on public.marketing_flow_runs;
create policy marketing_flow_runs_isolation on public.marketing_flow_runs
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0019/0028/0031/0032) ────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.marketing_flows     to cartcrft_app;
    grant select, insert, update, delete on public.marketing_flow_runs to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_marketing_flows_updated_at on public.marketing_flows;
    create trigger trg_marketing_flows_updated_at
      before update on public.marketing_flows
      for each row execute function public.set_updated_at();

    drop trigger if exists trg_marketing_flow_runs_updated_at on public.marketing_flow_runs;
    create trigger trg_marketing_flow_runs_updated_at
      before update on public.marketing_flow_runs
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
