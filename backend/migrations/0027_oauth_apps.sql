-- ============================================================================
-- 0027_oauth_apps — OAuth2 authorization-server / app platform
--
-- cartcrft becomes an OAuth2 authorization server so third-party products can
-- integrate via "Connect with Cartcrft". An org (merchant) registers apps; an
-- external app redirects merchants/users through a consent flow and receives
-- scoped tokens that call the existing /commerce API.
--
-- Four tables (all org-gated by RLS, mirroring 0019 tenant isolation):
--
--   * oauth_apps                — registered third-party apps owned by an org.
--                                 client_id is public (cc_app_…); the secret is
--                                 argon2-hashed (null for public/PKCE clients).
--   * oauth_authorization_codes — single-use, short-TTL auth codes. The raw code
--                                 is sha256-hashed at rest; PKCE challenge stored.
--   * oauth_refresh_tokens      — rotating refresh tokens (sha256 at rest) with
--                                 reuse-detection via rotated_from chains.
--   * oauth_grants              — remembered consent (unique per app+subject+org)
--                                 so re-auth can skip the consent screen.
--
-- The "organization_id" on the grant/code/token tables is the RESOURCE org being
-- granted access (the merchant whose /commerce data the token reaches). The
-- "subject" is the platform_user (or principal) that granted the consent.
--
-- Like every other tenant table, RLS is org-gated on current_setting('app.org_id')
-- and the restricted cartcrft_app role gets the standard CRUD grants (0014/0019).
-- The authorization-server endpoints (/oauth/*) run pre-auth or as the owner
-- role (BYPASSRLS) for cross-org code/token lookups — exactly like the platform
-- account auth layer in 0026 — so those flows are unaffected by the policies.
-- ============================================================================

begin;

-- ── oauth_apps ───────────────────────────────────────────────────────────────
create table if not exists public.oauth_apps (
  id                 uuid        primary key default gen_random_uuid(),
  organization_id    uuid        not null,                 -- the OWNING org (app developer)
  name               text        not null,
  description        text,
  client_id          text        not null,                 -- public id, random cc_app_…
  client_secret_hash text,                                 -- argon2id; null for public/PKCE clients
  client_type        text        not null default 'confidential'
                       check (client_type in ('confidential', 'public')),
  redirect_uris      text[]      not null default '{}',    -- exact-match allow-list
  allowed_scopes     text[]      not null default '{}',
  logo_url           text,
  homepage_url       text,
  status             text        not null default 'active'
                       check (status in ('active', 'suspended')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table  public.oauth_apps is 'Third-party OAuth2 apps registered by an org. client_id is public (cc_app_…); client_secret_hash is argon2id (null for public/PKCE clients). redirect_uris is an exact-match allow-list.';
comment on column public.oauth_apps.organization_id is 'The org that OWNS/developed the app (RLS gate). Distinct from the resource org granted at consent time.';
comment on column public.oauth_apps.client_type is 'confidential (has a secret) or public (PKCE-only, S256 required).';

create unique index if not exists ux_oauth_apps_client_id on public.oauth_apps (client_id);
create index if not exists idx_oauth_apps_org on public.oauth_apps (organization_id);

-- ── oauth_authorization_codes ───────────────────────────────────────────────
-- The raw code is never stored: code_hash = sha256(raw code). Single-use
-- (consumed_at) + short-lived (expires_at, ~60s–10min).
create table if not exists public.oauth_authorization_codes (
  code_hash             text        primary key,           -- sha256(raw code)
  app_id                uuid        not null references public.oauth_apps(id) on delete cascade,
  organization_id       uuid        not null,              -- the RESOURCE org being granted
  subject               text        not null,              -- platform_user id (or principal) granting
  scopes                text[]      not null default '{}',
  redirect_uri          text        not null,
  code_challenge        text,                              -- PKCE challenge (required for public clients)
  code_challenge_method text        check (code_challenge_method in ('S256', 'plain')),
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  created_at            timestamptz not null default now()
);

comment on table public.oauth_authorization_codes is 'Single-use OAuth2 authorization codes. code_hash = sha256(raw code). Short TTL + consumed_at make them one-time. PKCE challenge stored for verification at /oauth/token.';

create index if not exists idx_oauth_codes_app on public.oauth_authorization_codes (app_id);
create index if not exists idx_oauth_codes_expires on public.oauth_authorization_codes (expires_at);

-- ── oauth_refresh_tokens ────────────────────────────────────────────────────
-- token_hash = sha256(raw refresh token). Rotated on use; rotated_from chains
-- the lineage so reuse of a consumed token can revoke the whole family.
create table if not exists public.oauth_refresh_tokens (
  token_hash      text        primary key,                 -- sha256(raw refresh token)
  app_id          uuid        not null references public.oauth_apps(id) on delete cascade,
  organization_id uuid        not null,                    -- the RESOURCE org
  subject         text        not null,
  scopes          text[]      not null default '{}',
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  rotated_from    text,                                    -- token_hash this rotated from (reuse-detection chain)
  created_at      timestamptz not null default now()
);

comment on table public.oauth_refresh_tokens is 'Rotating OAuth2 refresh tokens. token_hash = sha256(raw token). rotated_from links the rotation lineage so presenting an already-rotated token revokes the entire family (reuse-detection).';

create index if not exists idx_oauth_refresh_app on public.oauth_refresh_tokens (app_id);
create index if not exists idx_oauth_refresh_subject on public.oauth_refresh_tokens (organization_id, subject);
create index if not exists idx_oauth_refresh_rotated_from on public.oauth_refresh_tokens (rotated_from);

-- ── oauth_grants (remembered consent) ───────────────────────────────────────
create table if not exists public.oauth_grants (
  id              uuid        primary key default gen_random_uuid(),
  app_id          uuid        not null references public.oauth_apps(id) on delete cascade,
  subject         text        not null,                    -- platform_user id granting consent
  organization_id uuid        not null,                    -- the RESOURCE org
  scopes          text[]      not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.oauth_grants is 'Remembered consent. unique(app_id, subject, organization_id) so re-authorization can skip the consent screen when the requested scopes are already covered.';

create unique index if not exists ux_oauth_grants_app_subject_org
  on public.oauth_grants (app_id, subject, organization_id);

-- ── RLS — org-gated, mirrors 0019/0026 ──────────────────────────────────────
-- Enabled so the authenticated app-management endpoints (run under the access
-- JWT's org context via withTx → SET LOCAL ROLE cartcrft_app) only ever touch
-- their own org's rows. The /oauth authorization-server endpoints run pre-auth
-- or as the owner role (BYPASSRLS) without setRequestCtx — exactly like 0026 —
-- so cross-org code/token lookups there are unaffected.
alter table public.oauth_apps                enable row level security;
alter table public.oauth_authorization_codes enable row level security;
alter table public.oauth_refresh_tokens      enable row level security;
alter table public.oauth_grants              enable row level security;

-- oauth_apps: visible only when app.org_id matches the OWNING org.
drop policy if exists oauth_apps_org_isolation on public.oauth_apps;
create policy oauth_apps_org_isolation on public.oauth_apps
  using (
    nullif(current_setting('app.org_id', true), '') is not null
    and organization_id::text = current_setting('app.org_id', true)
  )
  with check (
    nullif(current_setting('app.org_id', true), '') is not null
    and organization_id::text = current_setting('app.org_id', true)
  );

-- codes / refresh tokens / grants: gated on the RESOURCE org being granted.
drop policy if exists oauth_codes_org_isolation on public.oauth_authorization_codes;
create policy oauth_codes_org_isolation on public.oauth_authorization_codes
  using (
    nullif(current_setting('app.org_id', true), '') is not null
    and organization_id::text = current_setting('app.org_id', true)
  )
  with check (
    nullif(current_setting('app.org_id', true), '') is not null
    and organization_id::text = current_setting('app.org_id', true)
  );

drop policy if exists oauth_refresh_org_isolation on public.oauth_refresh_tokens;
create policy oauth_refresh_org_isolation on public.oauth_refresh_tokens
  using (
    nullif(current_setting('app.org_id', true), '') is not null
    and organization_id::text = current_setting('app.org_id', true)
  )
  with check (
    nullif(current_setting('app.org_id', true), '') is not null
    and organization_id::text = current_setting('app.org_id', true)
  );

drop policy if exists oauth_grants_org_isolation on public.oauth_grants;
create policy oauth_grants_org_isolation on public.oauth_grants
  using (
    nullif(current_setting('app.org_id', true), '') is not null
    and organization_id::text = current_setting('app.org_id', true)
  )
  with check (
    nullif(current_setting('app.org_id', true), '') is not null
    and organization_id::text = current_setting('app.org_id', true)
  );

-- ── Grants for the restricted app role (mirrors 0019/0026) ──────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.oauth_apps                to cartcrft_app;
    grant select, insert, update, delete on public.oauth_authorization_codes to cartcrft_app;
    grant select, insert, update, delete on public.oauth_refresh_tokens      to cartcrft_app;
    grant select, insert, update, delete on public.oauth_grants              to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_oauth_apps_updated_at on public.oauth_apps;
    create trigger trg_oauth_apps_updated_at
      before update on public.oauth_apps
      for each row execute function public.set_updated_at();

    drop trigger if exists trg_oauth_grants_updated_at on public.oauth_grants;
    create trigger trg_oauth_grants_updated_at
      before update on public.oauth_grants
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
