-- ============================================================================
-- 0014_RLS_ENFORCE — Activate runtime RLS enforcement via a restricted app role
--
-- Problem (verified 2026-06-13):
--   The application connects as neondb_owner which has rolbypassrls=TRUE.
--   FORCE ROW LEVEL SECURITY is NOT honoured by roles with rolbypassrls=TRUE
--   (confirmed on PG 17 — FORCE RLS only overrides the table-owner bypass, not
--   the rolbypassrls attribute). The ~120 policies in 0006_rls.sql + 0007_booking
--   are therefore silently skipped on every connection.
--
-- Solution:
--   Create a cartcrft_app role with NOLOGIN + NOBYPASSRLS and grant it the
--   minimum permissions needed to access all commerce tables. The application
--   pool still connects as neondb_owner (no connection-string change), but
--   pool.ts wraps every withTx block with:
--
--     SET LOCAL ROLE cartcrft_app
--     SELECT set_config('app.user_id', <userId>, true)
--     SELECT set_config('app.org_id',  <orgId>,  true)
--
--   Within the transaction the effective role is cartcrft_app (NOBYPASSRLS),
--   so the policies in 0006/0007 evaluate correctly. At COMMIT/ROLLBACK the
--   role reverts to neondb_owner automatically (LOCAL scope).
--
-- Grant strategy:
--   GRANT USAGE ON SCHEMA public → cartcrft_app
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
--   DEFAULT PRIVILEGES ensure tables created by future migrations are also
--   accessible.
--
-- Note on existing policies:
--   is_store_member(p_store_id) already checks:
--     1. current_setting('app.user_id', true) is non-empty
--     2. the target store exists and is_active = true
--   No policy changes are required. The GUC is set by pool.ts/withTx using
--   AsyncLocalStorage to carry the auth context from the HTTP request.
--
-- Test harness:
--   ctx.ts creates a per-run test schema (test_<runid>), runs migrations (which
--   rewrite "public." to "<schema>." so the DDL lands in the test schema), then
--   also grants cartcrft_app on the test schema tables. Fixture inserts via
--   ctx.pool.query() run as neondb_owner (BYPASSRLS) — intentional: fixture
--   setup is not app code and must not be blocked by RLS.
--
-- Rollback: simply drop the role or revoke the grants. RLS stays enabled on
--   the tables (0006_rls.sql already enabled it); removing this migration only
--   removes the enforcement mechanism, reverting to the pre-H1.1 app-layer
--   posture.
-- ============================================================================

begin;

-- ---- Create the restricted application role --------------------------------
-- NOLOGIN: cannot connect directly (neondb_owner connects and then SETs ROLE)
-- NOBYPASSRLS: policies are enforced when acting as this role
-- NOINHERIT: does not inherit neondb_owner's BYPASSRLS attribute
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    create role cartcrft_app nologin nobypassrls noinherit;
  end if;
end;
$$;

-- ---- Allow the connecting role to SET ROLE cartcrft_app in transactions ----
-- This GRANT makes cartcrft_app a "member" of the application's connecting role
-- (neondb_owner on Neon, the DB owner locally) so SET LOCAL ROLE cartcrft_app
-- succeeds. CURRENT_USER keeps the migration portable across environments.
grant cartcrft_app to current_user;

-- ---- Schema access ---------------------------------------------------------
grant usage on schema public to cartcrft_app;

-- ---- Table permissions on all existing tables ------------------------------
grant select, insert, update, delete
  on all tables in schema public
  to cartcrft_app;

-- ---- Sequence permissions --------------------------------------------------
grant usage, select
  on all sequences in schema public
  to cartcrft_app;

-- ---- Default privileges for future migrations ------------------------------
-- Ensures tables and sequences created after this migration (in 0015+, test
-- schema setup, cloud billing migrations) are automatically accessible to
-- cartcrft_app without additional GRANT statements.
alter default privileges in schema public
  grant select, insert, update, delete on tables to cartcrft_app;

alter default privileges in schema public
  grant usage, select on sequences to cartcrft_app;

-- ---- Record this migration -------------------------------------------------
-- (schema_migrations tracking happens in the migration runner itself, not here)

commit;
