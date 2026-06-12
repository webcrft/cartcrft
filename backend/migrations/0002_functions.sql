-- ============================================================================
-- 0002_FUNCTIONS — per-store sequence number generators
--
-- Ported from webcrft-mono: 20260407000042_platform_additions.sql
-- Only the commerce sequence functions are needed in cartcrft;
-- the platform_additions file also contains profiles, organisations, billing,
-- chat and sites logic — all stripped.
--
-- next_order_number()   — atomically increments stores.order_sequence
-- next_booking_number() — atomically increments stores.booking_sequence
-- purge_expired_integration_oauth_states() — maintenance helper
--
-- Both generators use UPDATE…RETURNING for single-round-trip atomicity
-- (no SELECT first, no advisory locks needed).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- next_order_number(p_store_id uuid) → text
-- ---------------------------------------------------------------------------
-- Increments the per-store order_sequence and returns a formatted order
-- number such as "#0001". The lpad width grows automatically once 4 digits
-- are exhausted (lpad never truncates).
-- ---------------------------------------------------------------------------
create or replace function public.next_order_number(p_store_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  seq bigint;
begin
  update public.stores
     set order_sequence = order_sequence + 1
   where id = p_store_id
  returning order_sequence into seq;

  if seq is null then
    raise exception 'store not found: %', p_store_id;
  end if;

  return '#' || lpad(seq::text, 4, '0');
end;
$$;

comment on function public.next_order_number(uuid) is
  'Atomically increments stores.order_sequence for p_store_id and returns '
  'a formatted order number like "#0042". The width grows beyond 4 digits '
  'automatically. Raises an exception if the store does not exist.';

-- ---------------------------------------------------------------------------
-- next_booking_number(p_store_id uuid) → text
-- ---------------------------------------------------------------------------
-- Identical pattern to next_order_number but uses booking_sequence and
-- returns "B0001" prefix instead of "#".
-- ---------------------------------------------------------------------------
create or replace function public.next_booking_number(p_store_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  seq bigint;
begin
  update public.stores
     set booking_sequence = booking_sequence + 1
   where id = p_store_id
  returning booking_sequence into seq;

  if seq is null then
    raise exception 'store not found: %', p_store_id;
  end if;

  return 'B' || lpad(seq::text, 4, '0');
end;
$$;

comment on function public.next_booking_number(uuid) is
  'Atomically increments stores.booking_sequence for p_store_id and returns '
  'a formatted booking reference like "B0001". The width grows beyond 4 '
  'digits automatically. Raises an exception if the store does not exist.';

-- ---------------------------------------------------------------------------
-- purge_expired_integration_oauth_states() → void
-- ---------------------------------------------------------------------------
-- Deletes expired, unused OAuth state records. Call from a maintenance cron
-- (e.g. pg_cron every hour) or schedule via the app worker.
-- ---------------------------------------------------------------------------
create or replace function public.purge_expired_integration_oauth_states()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.store_integration_oauth_states
   where expires_at < now()
     and used_at is null;
end;
$$;

comment on function public.purge_expired_integration_oauth_states() is
  'Deletes integration OAuth state rows that have expired without being '
  'consumed. Safe to call frequently — does nothing when nothing is expired.';

commit;
