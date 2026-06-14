-- ============================================================================
-- 0026_platform_accounts — Real platform-account login for the org dashboard
--   (P3 / audit item 1).
--
-- Replaces the previous dashboard trust model (a cc_prv_ commerce:admin key or
-- a hand-pasted JWT held in the browser's localStorage) with a real
-- email + password platform account that issues a SHORT-LIVED access JWT
-- (held only in browser memory) backed by an httpOnly refresh-session cookie.
--
-- Two principal-scoped tables:
--   * platform_users    — the human accounts that own/administer an org.
--                         argon2id password hashes, owner|admin|member roles,
--                         optional OAuth identity, failed-attempt lockout.
--   * platform_sessions — server-side refresh-session handles. token_hash =
--                         sha256(opaque refresh token); the raw token lives
--                         ONLY in the httpOnly cookie. Rotated on refresh,
--                         revoked on logout. The access JWT is short-lived and
--                         stateless (verified by the existing org middleware).
--
-- org_id is a PLAIN uuid (Cartcrft has no `organizations` table — the org is an
-- identifier shared by a tenant's stores via stores.organization_id, exactly
-- like 0019/0025). A platform_user's org_id is the value that lands in the
-- access JWT's `org` claim, so every existing /commerce route keeps working.
--
-- RLS posture (mirrors 0019 tenant isolation):
--   * platform_users / platform_sessions get RLS enabled and an org-gated
--     policy keyed on current_setting('app.org_id') — so the authenticated
--     team-management endpoints (/account/users), which run under the org
--     context the access JWT carries, can only see their own org's rows at the
--     DB layer (defense-in-depth behind the app-layer role checks).
--   * The pre-auth flows (register / login / refresh) run as the owner role
--     (BYPASSRLS) via getPool() WITHOUT setRequestCtx — there is no org context
--     yet — exactly like the super-admin auth layer.
-- ============================================================================

begin;

-- ── platform_users ──────────────────────────────────────────────────────────
create table if not exists public.platform_users (
  id              uuid        primary key default gen_random_uuid(),
  org_id          uuid        not null,                  -- plain uuid; == access-JWT `org` claim
  email           text        not null,
  password_hash   text,                                  -- argon2id (nullable for OAuth-only accounts)
  role            text        not null default 'member'
                    check (role in ('owner', 'admin', 'member')),
  -- OAuth identity (optional — for social/SSO login alongside password)
  oauth_provider  text,                                  -- e.g. 'google', 'github'
  oauth_subject   text,                                  -- provider's stable subject id
  is_active       boolean     not null default true,
  last_login_at   timestamptz,
  failed_attempts int         not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table  public.platform_users is 'Dashboard platform accounts (org owners/admins/members). argon2id password auth + optional OAuth. The org_id is the `org` claim minted into the dashboard access JWT.';
comment on column public.platform_users.org_id is 'Plain uuid tenant identifier — matches stores.organization_id and the access-JWT org claim. No organizations table exists (see 0019).';
comment on column public.platform_users.role is 'owner|admin|member. owner/admin may manage the team; the first user created for an org is owner.';
comment on column public.platform_users.failed_attempts is 'Consecutive failed login attempts; reset on success. Drives lockout.';
comment on column public.platform_users.locked_until is 'When set and in the future, login is refused regardless of credentials.';

-- Email is unique PER ORG (the same address may own accounts in different orgs),
-- case-insensitive (users type any case).
create unique index if not exists ux_platform_users_org_email_lower
  on public.platform_users (org_id, lower(email));

create index if not exists idx_platform_users_org
  on public.platform_users (org_id);

-- OAuth identity is globally unique when present.
create unique index if not exists ux_platform_users_oauth
  on public.platform_users (oauth_provider, oauth_subject)
  where oauth_provider is not null and oauth_subject is not null;

-- ── platform_sessions ───────────────────────────────────────────────────────
-- One row per issued refresh session. The access JWT is short-lived (15-30m);
-- this row is the server-side revocation handle for the httpOnly refresh cookie.
create table if not exists public.platform_sessions (
  id               uuid        primary key default gen_random_uuid(),
  platform_user_id uuid        not null references public.platform_users(id) on delete cascade,
  token_hash       text        not null,                 -- sha256 of the opaque refresh token (never store raw)
  expires_at       timestamptz not null,                 -- refresh lifetime (days)
  ip               text,
  user_agent       text,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz
);

comment on table  public.platform_sessions is 'Server-side refresh-session handles for dashboard accounts. token_hash = sha256(opaque refresh token held in the httpOnly cookie). Rotated on /account/refresh, revoked on /account/logout.';

create index if not exists idx_platform_sessions_user
  on public.platform_sessions (platform_user_id);
create unique index if not exists ux_platform_sessions_token_hash
  on public.platform_sessions (token_hash);
create index if not exists idx_platform_sessions_expires
  on public.platform_sessions (expires_at);

-- ── RLS — org-gated, mirrors 0019 ───────────────────────────────────────────
-- Enabled so the authenticated team-management endpoints (which run under the
-- access JWT's org context via withTx → SET LOCAL ROLE cartcrft_app) can only
-- touch their own org's rows at the DB layer. The pre-auth flows run as the
-- owner role (BYPASSRLS) and are unaffected.
alter table public.platform_users    enable row level security;
alter table public.platform_sessions enable row level security;

-- platform_users: a row is visible only when app.org_id matches its org_id.
drop policy if exists platform_users_org_isolation on public.platform_users;
create policy platform_users_org_isolation on public.platform_users
  using (
    nullif(current_setting('app.org_id', true), '') is not null
    and org_id::text = current_setting('app.org_id', true)
  )
  with check (
    nullif(current_setting('app.org_id', true), '') is not null
    and org_id::text = current_setting('app.org_id', true)
  );

-- platform_sessions: gated through the owning user's org.
drop policy if exists platform_sessions_org_isolation on public.platform_sessions;
create policy platform_sessions_org_isolation on public.platform_sessions
  using (
    nullif(current_setting('app.org_id', true), '') is not null
    and exists (
      select 1 from public.platform_users u
      where u.id = platform_sessions.platform_user_id
        and u.org_id::text = current_setting('app.org_id', true)
    )
  )
  with check (
    nullif(current_setting('app.org_id', true), '') is not null
    and exists (
      select 1 from public.platform_users u
      where u.id = platform_sessions.platform_user_id
        and u.org_id::text = current_setting('app.org_id', true)
    )
  );

-- ── Grants for the restricted app role (mirrors 0014) ───────────────────────
-- 0014 sets DEFAULT PRIVILEGES on the public schema for cartcrft_app, which
-- already covers tables created by later migrations. We grant explicitly too so
-- the test-schema harness (which copies DDL but not default-privilege state in
-- every path) and any environment missing the default-priv grant still work.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.platform_users    to cartcrft_app;
    grant select, insert, update, delete on public.platform_sessions to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_platform_users_updated_at on public.platform_users;
    create trigger trg_platform_users_updated_at
      before update on public.platform_users
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
