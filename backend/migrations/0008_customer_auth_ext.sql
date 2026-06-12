-- ============================================================================
-- 0008_CUSTOMER_AUTH_EXT — extend customer auth to match Go source schema
--
-- Adds columns/tables that 0003_customer_auth.sql omitted or named differently.
-- All ALTER TABLE statements use ADD COLUMN IF NOT EXISTS for idempotency.
-- ============================================================================

begin;

-- ============================================================================
-- 1. STORES — add missing per-provider OAuth + branding auth columns
-- ============================================================================

alter table public.stores
  add column if not exists auth_email_password_enabled    boolean not null default true,
  add column if not exists auth_google_enabled            boolean not null default false,
  add column if not exists auth_google_client_id          text,
  add column if not exists auth_google_client_secret_enc  text,
  add column if not exists auth_microsoft_enabled         boolean not null default false,
  add column if not exists auth_ms_client_id              text,
  add column if not exists auth_ms_client_secret_enc      text,
  add column if not exists auth_discord_enabled           boolean not null default false,
  add column if not exists auth_discord_client_id         text,
  add column if not exists auth_discord_client_secret_enc text,
  add column if not exists auth_allow_self_registration   boolean not null default true,
  add column if not exists auth_require_email_verification boolean not null default false,
  add column if not exists auth_jwt_expiry_mins           int     not null default 60,
  add column if not exists auth_session_duration_days     int     not null default 30,
  add column if not exists auth_logo_url                  text,
  add column if not exists auth_brand_color               text,
  add column if not exists auth_redirect_url              text,
  add column if not exists auth_email_templates           jsonb;

-- ============================================================================
-- 2. CUSTOMERS — add profile + security + OAuth identity columns
-- ============================================================================

alter table public.customers
  add column if not exists display_name          text,
  add column if not exists avatar_url            text,
  add column if not exists is_admin              boolean     not null default false,
  add column if not exists is_active             boolean     not null default true,
  add column if not exists is_blocked            boolean     not null default false,
  add column if not exists blocked_reason        text,
  add column if not exists sign_in_count         int         not null default 0,
  add column if not exists last_sign_in_at       timestamptz,
  add column if not exists failed_login_attempts int         not null default 0,
  add column if not exists locked_until          timestamptz,
  add column if not exists google_id             text,
  add column if not exists microsoft_id          text,
  add column if not exists discord_id            text;

create unique index if not exists ux_customers_google_id
  on public.customers(store_id, google_id)
  where google_id is not null;

create unique index if not exists ux_customers_microsoft_id
  on public.customers(store_id, microsoft_id)
  where microsoft_id is not null;

create unique index if not exists ux_customers_discord_id
  on public.customers(store_id, discord_id)
  where discord_id is not null;

-- ============================================================================
-- 3. CUSTOMER_SESSIONS — add session-family + revocation columns
-- ============================================================================

alter table public.customer_sessions
  add column if not exists family_id    uuid,
  add column if not exists revoked_at   timestamptz,
  add column if not exists replaced_by  uuid references public.customer_sessions(id);

-- Back-fill family_id for existing rows (give each row its own family)
update public.customer_sessions set family_id = id where family_id is null;

create index if not exists idx_customer_sessions_family
  on public.customer_sessions(family_id);

-- ============================================================================
-- 4. NEW TABLE: customer_audit_log
-- ============================================================================

create table if not exists public.customer_audit_log (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id) on delete cascade,
  customer_id uuid        references public.customers(id) on delete set null,
  event       text        not null,
  ip_address  inet,
  user_agent  text,
  data        jsonb       not null default '{}',
  created_at  timestamptz not null default now()
);

create index if not exists idx_customer_audit_log_store
  on public.customer_audit_log(store_id, created_at desc);
create index if not exists idx_customer_audit_log_customer
  on public.customer_audit_log(customer_id, created_at desc)
  where customer_id is not null;

-- ============================================================================
-- 5. NEW TABLE: customer_email_log
-- ============================================================================

create table if not exists public.customer_email_log (
  id            uuid        primary key default gen_random_uuid(),
  store_id      uuid        not null references public.stores(id) on delete cascade,
  to_email      text        not null,
  subject       text        not null,
  template_name text,
  status        text        not null default 'pending'
                  check (status in ('pending','sent','failed')),
  error         text,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_customer_email_log_store
  on public.customer_email_log(store_id, created_at desc);

-- ============================================================================
-- 6. NEW TABLE: customer_invitations
-- ============================================================================

create table if not exists public.customer_invitations (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id) on delete cascade,
  email       text        not null,
  token_hash  text        not null,
  expires_at  timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  unique(store_id, email)
);

create index if not exists idx_customer_invitations_store
  on public.customer_invitations(store_id);

-- ============================================================================
-- 7. NEW TABLE: customer_magic_links
-- ============================================================================

create table if not exists public.customer_magic_links (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id) on delete cascade,
  customer_id uuid        references public.customers(id) on delete cascade,
  token_hash  text        not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip_address  inet,
  created_at  timestamptz not null default now()
);

create index if not exists idx_customer_magic_links_store
  on public.customer_magic_links(store_id, expires_at)
  where used_at is null;

-- ============================================================================
-- 8. RLS — enable + policies for new tables
-- ============================================================================

alter table public.customer_audit_log   enable row level security;
alter table public.customer_email_log   enable row level security;
alter table public.customer_invitations enable row level security;
alter table public.customer_magic_links enable row level security;

-- customer_audit_log
create policy customer_audit_log_select on public.customer_audit_log
  for select using (public.is_store_member(store_id));
create policy customer_audit_log_insert on public.customer_audit_log
  for insert with check (public.is_store_member(store_id));
create policy customer_audit_log_update on public.customer_audit_log
  for update using (public.is_store_member(store_id));
create policy customer_audit_log_delete on public.customer_audit_log
  for delete using (public.is_store_member(store_id));

-- customer_email_log
create policy customer_email_log_select on public.customer_email_log
  for select using (public.is_store_member(store_id));
create policy customer_email_log_insert on public.customer_email_log
  for insert with check (public.is_store_member(store_id));
create policy customer_email_log_update on public.customer_email_log
  for update using (public.is_store_member(store_id));
create policy customer_email_log_delete on public.customer_email_log
  for delete using (public.is_store_member(store_id));

-- customer_invitations
create policy customer_invitations_select on public.customer_invitations
  for select using (public.is_store_member(store_id));
create policy customer_invitations_insert on public.customer_invitations
  for insert with check (public.is_store_member(store_id));
create policy customer_invitations_update on public.customer_invitations
  for update using (public.is_store_member(store_id));
create policy customer_invitations_delete on public.customer_invitations
  for delete using (public.is_store_member(store_id));

-- customer_magic_links
create policy customer_magic_links_select on public.customer_magic_links
  for select using (public.is_store_member(store_id));
create policy customer_magic_links_insert on public.customer_magic_links
  for insert with check (public.is_store_member(store_id));
create policy customer_magic_links_update on public.customer_magic_links
  for update using (public.is_store_member(store_id));
create policy customer_magic_links_delete on public.customer_magic_links
  for delete using (public.is_store_member(store_id));

commit;
