-- ============================================================================
-- CARTCRFT CLOUD BILLING — QUEUE + DEAD LETTER
-- Ported from webcrft-mono 20260226000021_billing_queue.sql
-- Strips domain_renewal (not a cartcrft concern); adds dead-letter table.
-- ============================================================================

-- ============================================================================
-- 1. BILLING QUEUE (subscription renewal tasks)
-- ============================================================================

create table if not exists public.billing_queue (
  id                uuid        primary key default gen_random_uuid(),
  organization_id   uuid        not null,
  -- task_type: extensible — start with subscription_renewal; more types added per feature.
  task_type         text        not null
    check (task_type in ('subscription_renewal', 'wallet_topup', 'invoice_generation', 'other')),
  subscription_id   uuid        references public.billing_subscriptions(id) on delete cascade,
  -- cycle_key: human-readable idempotency label, e.g. "sub_<id>_2026-07".
  cycle_key         text        not null,
  -- idempotency_key: globally unique — prevents duplicate task creation.
  idempotency_key   text        not null unique,
  -- run_at: when this task should be executed (billingsim compresses this).
  run_at            timestamptz not null,
  status            text        not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'dead')),
  attempt_count     int         not null default 0,
  max_attempts      int         not null default 3,
  last_error        text,
  locked_at         timestamptz,
  locked_by         text,
  processed_at      timestamptz,
  payload           jsonb       not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table  public.billing_queue is
  'Unified queue for billable async work. Workers poll for pending rows ordered by run_at. '
  'Locked rows are claimed by a single worker via UPDATE … WHERE locked_at IS NULL.';
comment on column public.billing_queue.cycle_key is
  'Human-readable key for this billing cycle, e.g. "sub_<id>_2026-07". Used for logging.';
comment on column public.billing_queue.idempotency_key is
  'Globally unique string. INSERT … ON CONFLICT DO NOTHING prevents duplicate tasks.';
comment on column public.billing_queue.locked_by is
  'Identifier of the worker instance that holds the lock (for debugging stuck tasks).';

create index if not exists idx_billing_queue_status_run
  on public.billing_queue(status, run_at)
  where status in ('pending', 'failed');

create index if not exists idx_billing_queue_org
  on public.billing_queue(organization_id, created_at desc);

create index if not exists idx_billing_queue_type
  on public.billing_queue(task_type, status, run_at);

create index if not exists idx_billing_queue_sub
  on public.billing_queue(subscription_id)
  where subscription_id is not null;

-- ============================================================================
-- 2. BILLING DEAD LETTER (tasks that exhausted all retry attempts)
-- ============================================================================

create table if not exists public.billing_dead_letter (
  id                uuid        primary key default gen_random_uuid(),
  -- Original queue row, preserved verbatim for inspection/replay.
  queue_id          uuid        not null,
  organization_id   uuid        not null,
  task_type         text        not null,
  subscription_id   uuid,
  cycle_key         text        not null,
  idempotency_key   text        not null unique,
  run_at            timestamptz not null,
  attempt_count     int         not null,
  last_error        text,
  payload           jsonb       not null default '{}',
  -- Resolution: NULL = unresolved; 'replayed' = re-queued; 'ignored' = written off.
  resolved_at       timestamptz,
  resolved_by       text,
  resolution        text        check (resolution in ('replayed', 'ignored')),
  created_at        timestamptz not null default now()
);

comment on table public.billing_dead_letter is
  'Tasks that failed all max_attempts retries. Preserved for manual inspection and replay. '
  'Move from billing_queue to here when status=dead; never auto-delete.';

create index if not exists idx_billing_dead_letter_org
  on public.billing_dead_letter(organization_id, created_at desc);

create index if not exists idx_billing_dead_letter_unresolved
  on public.billing_dead_letter(created_at desc)
  where resolved_at is null;

create index if not exists idx_billing_dead_letter_type
  on public.billing_dead_letter(task_type, created_at desc);

-- ============================================================================
-- 3. TRIGGERS
-- ============================================================================

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'billing_queue_updated_at') then
    create trigger billing_queue_updated_at
      before update on public.billing_queue
      for each row execute function public.set_updated_at();
  end if;
end $$;
