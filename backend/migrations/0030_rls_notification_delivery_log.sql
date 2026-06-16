-- ============================================================================
-- 0030_rls_notification_delivery_log — Add RLS to notification_delivery_log
--
-- 0010_notification_delivery_log.sql created this table with a store_id column
-- but omitted ENABLE ROW LEVEL SECURITY and the accompanying policies.  It is
-- the one tenant-scoped delivery-log table that slipped through the isolation
-- audit.
--
-- Policy mirrors payment_provider_webhook_log (the closest sibling: append-only,
-- direct store_id column, no join required):
--   • SELECT: is_store_member(store_id) — tenanted read gate via 0019 definition
--   • INSERT: authenticated connection only (app.user_id is set) — the app layer
--     validates store ownership before inserting; the DB gate ensures no unauthenticated
--     write can land.
--   • No UPDATE / DELETE policies: table is append-only (retention handled by
--     the trigger in 0010).
--
-- Grants: 0014_rls_enforce.sql sets DEFAULT PRIVILEGES so tables created after
-- it automatically inherit SELECT/INSERT/UPDATE/DELETE to cartcrft_app.  No
-- explicit GRANT is needed here (mirrors the approach in 0015+).
-- ============================================================================

begin;

alter table public.notification_delivery_log enable row level security;

-- ---- notification_delivery_log (append-only) --------------------------------
create policy notification_delivery_log_select on public.notification_delivery_log for select
  using (public.is_store_member(store_id));

create policy notification_delivery_log_insert on public.notification_delivery_log for insert
  with check (nullif(current_setting('app.user_id', true), '') is not null);

commit;
