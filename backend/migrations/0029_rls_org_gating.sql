-- ============================================================================
-- 0029_rls_org_gating — Tighten RLS on org-level tables to require org match
--
-- P1-8: The existing policies on org_email_providers, org_email_templates,
-- api_keys, and stores (INSERT) check only that app.user_id is set (i.e. an
-- authenticated request) but NOT that the org matches the calling user's org.
-- A bug in the application layer that sets the wrong app.org_id GUC could let
-- one org read or write another's rows.
--
-- This migration drops the old policies and recreates them to ALSO require
--   organization_id::text = current_setting('app.org_id', true)
--
-- The owner role (BYPASSRLS) is unaffected — all super-admin / migration paths
-- continue to work without changes.
--
-- Idempotent: uses DROP POLICY IF EXISTS before CREATE POLICY.
-- ============================================================================

begin;

-- ── org_email_providers ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS org_email_providers_all ON public.org_email_providers;

CREATE POLICY org_email_providers_all ON public.org_email_providers
  USING (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id::text = nullif(current_setting('app.org_id', true), '')
  )
  WITH CHECK (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id::text = nullif(current_setting('app.org_id', true), '')
  );

-- ── org_email_templates ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS org_email_templates_all ON public.org_email_templates;

CREATE POLICY org_email_templates_all ON public.org_email_templates
  USING (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id::text = nullif(current_setting('app.org_id', true), '')
  )
  WITH CHECK (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id::text = nullif(current_setting('app.org_id', true), '')
  );

-- ── api_keys ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS api_keys_all ON public.api_keys;

CREATE POLICY api_keys_all ON public.api_keys
  USING (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id::text = nullif(current_setting('app.org_id', true), '')
  )
  WITH CHECK (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id::text = nullif(current_setting('app.org_id', true), '')
  );

-- ── stores (INSERT WITH CHECK) ────────────────────────────────────────────────
-- The INSERT policy for stores must also verify that the org the caller is
-- inserting into matches their session's org_id.
DROP POLICY IF EXISTS stores_insert ON public.stores;

CREATE POLICY stores_insert ON public.stores FOR INSERT
  WITH CHECK (
    nullif(current_setting('app.user_id', true), '') IS NOT NULL
    AND organization_id::text = nullif(current_setting('app.org_id', true), '')
  );

commit;
