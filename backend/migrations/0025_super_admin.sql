-- ============================================================================
-- 0025_super_admin — Hardened SUPER-ADMIN portal (WebCrft operator god-mode)
--
-- Phase 1 of 4 (backend only).  This migration provisions the platform-operator
-- identity, session, and audit tables that back the /superadmin/* API.
--
-- Security posture:
--   * super_admins are a DISTINCT principal class from org users and customers.
--     They authenticate against their own table with argon2 password hashes,
--     optional TOTP (RFC6238) MFA, failed-attempt lockout, and short-lived
--     sessions.  Their JWTs carry a distinct audience (cartcrft-superadmin) so
--     an org/customer JWT can NEVER pass super-admin auth and vice-versa.
--   * NO default super-admin is seeded here (deliberate — avoids a shipped
--     credential).  Use backend/src/scripts/create-super-admin.ts to mint the
--     first operator from env/args.
--   * super_admin_audit_log is APPEND-ONLY.  A BEFORE UPDATE/DELETE trigger
--     raises an exception so the operator's own trail cannot be rewritten,
--     even by the owner role.  (RLS would be bypassed by neondb_owner; a
--     trigger is not.)
--
-- These tables are platform-global (not tenant-scoped).  They are intentionally
-- NOT placed behind tenant RLS: the super-admin sees everything.  Access is
-- gated entirely at the application layer (requireSuperAdmin) and every read is
-- written to super_admin_audit_log.
-- ============================================================================

begin;

-- ── super_admins ────────────────────────────────────────────────────────────
create table if not exists public.super_admins (
  id              uuid        primary key default gen_random_uuid(),
  email           text        not null,
  password_hash   text        not null,                 -- argon2id
  totp_secret_enc text,                                 -- AES-256-GCM via lib/secrets (nullable; MFA scaffold)
  is_active       boolean     not null default true,
  last_login_at   timestamptz,
  failed_attempts int         not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table  public.super_admins is 'WebCrft platform operators (god-mode). Distinct principal class from org users / customers.';
comment on column public.super_admins.totp_secret_enc is 'AES-256-GCM encrypted TOTP secret (lib/secrets). When set, login requires a valid RFC6238 code.';
comment on column public.super_admins.failed_attempts is 'Consecutive failed login attempts; reset on success. Drives lockout.';
comment on column public.super_admins.locked_until is 'When set and in the future, login is refused regardless of credentials.';

-- Case-insensitive unique email (operators may type any case).
create unique index if not exists ux_super_admins_email_lower
  on public.super_admins (lower(email));

-- ── super_admin_sessions ────────────────────────────────────────────────────
-- One row per issued refresh session.  The access JWT is short-lived (15-30m);
-- this row is the server-side revocation handle (logout / refresh).
create table if not exists public.super_admin_sessions (
  id              uuid        primary key default gen_random_uuid(),
  super_admin_id  uuid        not null references public.super_admins(id) on delete cascade,
  token_hash      text        not null,                 -- sha256 of the opaque session token (never store raw)
  expires_at      timestamptz not null,                 -- SHORT — 30 min
  ip              text,
  user_agent      text,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);

comment on table  public.super_admin_sessions is 'Server-side super-admin session handles. token_hash = sha256(opaque token). Short TTL; revocable.';

create index if not exists idx_super_admin_sessions_admin
  on public.super_admin_sessions (super_admin_id);
create unique index if not exists ux_super_admin_sessions_token_hash
  on public.super_admin_sessions (token_hash);
create index if not exists idx_super_admin_sessions_expires
  on public.super_admin_sessions (expires_at);

-- ── super_admin_audit_log (APPEND-ONLY) ─────────────────────────────────────
create table if not exists public.super_admin_audit_log (
  id              uuid        primary key default gen_random_uuid(),
  super_admin_id  uuid        references public.super_admins(id) on delete set null,
  action          text        not null,                 -- e.g. 'login', 'orgs.list', 'store.takedown'
  target_type     text,                                 -- e.g. 'org','store','customer','session'
  target_id       text,                                 -- uuid or other identifier as text
  ip              text,
  user_agent      text,
  data            jsonb       not null default '{}',
  created_at      timestamptz not null default now()
);

comment on table public.super_admin_audit_log is 'APPEND-ONLY audit trail of every super-admin action (who/what/target/ip). UPDATE/DELETE blocked by trigger.';

create index if not exists idx_super_admin_audit_admin_created
  on public.super_admin_audit_log (super_admin_id, created_at desc);
create index if not exists idx_super_admin_audit_created
  on public.super_admin_audit_log (created_at desc);
create index if not exists idx_super_admin_audit_action
  on public.super_admin_audit_log (action, created_at desc);

-- ── Append-only enforcement ─────────────────────────────────────────────────
-- A BEFORE UPDATE OR DELETE trigger raises, so even the owner role (which
-- bypasses RLS) cannot mutate or remove an audit row.  INSERT is unaffected.
create or replace function public.super_admin_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'super_admin_audit_log is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
  return null;
end;
$$;

drop trigger if exists trg_super_admin_audit_log_immutable on public.super_admin_audit_log;
create trigger trg_super_admin_audit_log_immutable
  before update or delete on public.super_admin_audit_log
  for each row execute function public.super_admin_audit_log_immutable();

-- Also block TRUNCATE (statement-level; row triggers do not fire on TRUNCATE).
drop trigger if exists trg_super_admin_audit_log_no_truncate on public.super_admin_audit_log;
create trigger trg_super_admin_audit_log_no_truncate
  before truncate on public.super_admin_audit_log
  for each statement execute function public.super_admin_audit_log_immutable();

-- updated_at maintenance for super_admins (reuse the standard helper if present).
do $$
begin
  if exists (
    select 1 from pg_proc where proname = 'set_updated_at'
  ) then
    drop trigger if exists trg_super_admins_updated_at on public.super_admins;
    create trigger trg_super_admins_updated_at
      before update on public.super_admins
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
