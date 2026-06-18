-- ============================================================================
-- 0048_abandoned_checkout — Abandoned-CHECKOUT recovery tracking.
--
-- Wave-22: distinct from abandoned-CART recovery (0xxx abandoned_carts). A
-- checkout that was STARTED (checkouts.status = 'pending') but never completed
-- (not 'completed'/'abandoned') and has a contact email is a recovery target.
-- A background worker scans for stale pending checkouts and sends ONE recovery
-- email per checkout linking the shopper back to resume payment.
--
-- This migration only ADDS idempotency/tracking columns to the existing
-- public.checkouts table (defined in 0001_commerce). No new table, no new RLS
-- policy: checkouts is already RLS-scoped (is_store_member via the 0019 tenant
-- isolation) and the worker reads it on the owner/BYPASSRLS path exactly like
-- the abandoned-cart recovery worker. Column-add style mirrors 0043_tax_exempt.
--
--   recovery_notified_at  — set to now() when the single recovery email is sent;
--                           IS NULL ⇒ not yet notified (idempotency guard).
--   recovery_email_count  — number of recovery emails sent for this checkout.
-- ============================================================================

begin;

alter table public.checkouts
  add column if not exists recovery_notified_at timestamptz,
  add column if not exists recovery_email_count int not null default 0;

comment on column public.checkouts.recovery_notified_at is
  'When the abandoned-checkout recovery email was sent. NULL ⇒ not yet notified (idempotency guard — the worker sends exactly once per checkout).';
comment on column public.checkouts.recovery_email_count is
  'Count of abandoned-checkout recovery emails sent for this checkout.';

-- Worker scan: pending checkouts older than a threshold that have not been
-- notified. Partial index keeps the scan cheap as completed/notified rows grow.
create index if not exists idx_checkouts_recovery_pending
  on public.checkouts (store_id, updated_at)
  where status = 'pending' and recovery_notified_at is null;

commit;
