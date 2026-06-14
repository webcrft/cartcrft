-- ============================================================================
-- 0019_rls_tenant_isolation — close the tenant-isolation hole in is_store_member
--
-- Problem (post-unification audit):
--   The 0006 definition of is_store_member(store_id) returned TRUE for ANY
--   authenticated principal against ANY active store — it only checked that
--   app.user_id was set and the store existed.  It NEVER compared the store's
--   organization to the requesting principal's org.  Net effect: RLS enforced
--   "is authenticated", NOT "belongs to your tenant".  An org-B principal whose
--   request reached withTx (cartcrft_app role) could read/write org-A rows at
--   the DB layer; only the app-layer middleware stood between tenants.
--
-- Fix:
--   Replace is_store_member() so the predicate is GUC-first and org-gated:
--     1. app.user_id must be non-empty   (authenticated connection)
--     2. app.org_id  must be non-empty   (org context present)
--     3. the store's organization_id must equal app.org_id
--   This mirrors the correct template already used in
--   0016_analytics_events.sql:60-64 (stores.organization_id::text =
--   current_setting('app.org_id', true)).
--
-- Performance:
--   The audit warned a `language sql` rewrite measured 5-15x slower and the
--   per-row plpgsql is a scalability tax.  We keep plpgsql (so it stays STABLE
--   and inlinable into the EXISTS sub-plans the policies already use) but make
--   the predicate GUC-first: the cheap GUC checks short-circuit BEFORE the
--   single-row indexed lookup on stores(id) (PK) — so a denied tenant pays only
--   two current_setting() reads, and the org comparison folds into the same
--   indexed probe that already verified existence.
--
-- BYPASSRLS service roles (neondb_owner / local DB owner) are unaffected —
-- migrations, workers, cron, and test fixtures still bypass policies entirely.
-- ============================================================================

begin;

create or replace function public.is_store_member(p_store_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id text;
  v_org_id  text;
begin
  -- (1) Authenticated connection — app.user_id must be set by the app.
  v_user_id := nullif(current_setting('app.user_id', true), '');
  if v_user_id is null then
    return false;
  end if;

  -- (2) Org context — app.org_id must be set.  Without it we cannot prove
  --     tenant ownership, so deny (fail closed).
  v_org_id := nullif(current_setting('app.org_id', true), '');
  if v_org_id is null then
    return false;
  end if;

  -- (3) Tenant ownership — the store must exist, be active, AND its owning
  --     organization must match the request's org GUC.  The PK lookup on
  --     stores(id) makes this a single indexed probe; the org equality folds
  --     into the same row, so cross-tenant access is denied at the DB layer.
  return exists (
    select 1
    from public.stores s
    where s.id = p_store_id
      and s.is_active = true
      and s.organization_id::text = v_org_id
  );
end;
$$;

comment on function public.is_store_member(uuid) is
  'Returns TRUE only when the connection is authenticated (app.user_id set), '
  'an org context is present (app.org_id set), and the target store exists, is '
  'active, and is owned by that org (stores.organization_id = app.org_id). '
  'Tenant-isolation gate — replaces the 0006 definition that ignored org '
  'ownership. Mirrors the org check in 0016_analytics_events.sql.';

commit;
