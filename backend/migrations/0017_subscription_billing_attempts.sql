-- 0017_subscription_billing_attempts — Subscription billing attempt log + RLS
--
-- Records every attempt (success or failure) to bill a subscription.
-- Used by the dunning system to track how many times billing has been tried
-- and to transition subscriptions toward past_due status.
--
-- Design notes:
--  - attempt_number is 1-based within a subscription's lifetime.
--  - status: 'success' | 'failed'
--  - error_message is populated on failures; NULL on success.
--  - store_id is denormalized for RLS filtering without a join.
--  - occurred_at mirrors the timestamp column naming convention used elsewhere.
--  - RLS policy joins via subscription_id → subscriptions.store_id (like
--    subscription_items/subscription_orders) so the policy stays correct even
--    if a subscription is transferred between stores in future.

-- ── Table ─────────────────────────────────────────────────────────────────────

create table if not exists public.subscription_billing_attempts (
  id               uuid        primary key default gen_random_uuid(),
  store_id         uuid        not null references public.stores(id)         on delete cascade,
  subscription_id  uuid        not null references public.subscriptions(id)  on delete cascade,
  attempt_number   int         not null default 1 check (attempt_number >= 1),
  status           text        not null check (status in ('success', 'failed')),
  error_message    text,
  occurred_at      timestamptz not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary lookup: all attempts for a subscription (dunning threshold check).
create index if not exists idx_billing_attempts_sub
  on public.subscription_billing_attempts (subscription_id, occurred_at);

-- Secondary: store-scoped queries for admin reporting.
create index if not exists idx_billing_attempts_store
  on public.subscription_billing_attempts (store_id, occurred_at);

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.subscription_billing_attempts enable row level security;

-- Store members (org owners / staff) can read their own store's attempts.
create policy billing_attempts_select on public.subscription_billing_attempts
  for select
  using (exists (
    select 1
    from public.subscriptions s
    where s.id = subscription_billing_attempts.subscription_id
      and public.is_store_member(s.store_id)
  ));

-- Allow insert for the cartcrft_app role and the neondb_owner / BYPASSRLS path.
-- Writes go via getPool() (fire-and-forget from the scheduler / service) —
-- the store_id app-layer check in service.ts is the tenant gate.
-- Mirrors the analytics_events insert policy posture.
create policy billing_attempts_insert on public.subscription_billing_attempts
  for insert
  with check (true);

comment on table public.subscription_billing_attempts is
  'Log of every subscription billing attempt (success or failure). Used by the dunning system: after 3 consecutive failed attempts the subscription transitions to past_due.';
