-- ============================================================================
-- 0003_CUSTOMER_AUTH — storefront customer authentication
--
-- Ported from webcrft-mono: 20260407000041_commerce_auth.sql
-- Cartcrft adaptations:
--   • No sites table → strip all "alter table public.sites…" blocks
--   • No public.profiles table → strip section 14/15 (profiles.tokens_invalidated_at)
--   • No public.organizations table → strip section 16 (orgs early_access flag)
--   • org_email_providers / org_email_templates: organization_id becomes
--     plain uuid (no FK to organizations)
--   • check_allowed_origins() function → KEEP (used by stores)
--   • sites_allowed_origins_valid constraint → STRIP (no sites)
--   • stores_auth_allowed_origins_valid constraint → KEEP
--   • Rebrand: all "cartcrft" where function/constraint comments mention product
-- ============================================================================

begin;

-- ============================================================================
-- 1. STORES — customer-auth columns
-- ============================================================================

alter table public.stores
  add column if not exists auth_enabled                boolean     not null default false,
  add column if not exists auth_allowed_origins        text[]      not null default '{}',
  add column if not exists auth_jwt_secret             text,
  add column if not exists auth_token_expiry_seconds   int         not null default 3600,
  add column if not exists auth_refresh_expiry_seconds int         not null default 2592000,
  add column if not exists auth_magic_link_enabled     boolean     not null default false,
  add column if not exists auth_otp_enabled            boolean     not null default false,
  add column if not exists auth_social_providers       jsonb       not null default '{}',
  add column if not exists auth_require_email_verify   boolean     not null default true,
  add column if not exists auth_max_sessions           int         not null default 5;

comment on column public.stores.auth_enabled                is 'Enable the built-in storefront customer auth system for this store.';
comment on column public.stores.auth_allowed_origins        is 'CORS / allowed-origins list for customer auth token exchange.';
comment on column public.stores.auth_jwt_secret             is 'Per-store JWT secret (AES-256-GCM encrypted at rest when AUTH_SECRETS_KEY is set).';
comment on column public.stores.auth_token_expiry_seconds   is 'Access-token TTL in seconds (default 1 h).';
comment on column public.stores.auth_refresh_expiry_seconds is 'Refresh-token TTL in seconds (default 30 d).';
comment on column public.stores.auth_magic_link_enabled     is 'Enable passwordless magic-link login.';
comment on column public.stores.auth_otp_enabled            is 'Enable SMS / email OTP login.';
comment on column public.stores.auth_social_providers       is 'OAuth social provider configs keyed by provider slug.';
comment on column public.stores.auth_require_email_verify   is 'Require email verification before a new customer can log in.';
comment on column public.stores.auth_max_sessions           is 'Maximum concurrent refresh-token sessions per customer.';

-- ============================================================================
-- 2. CUSTOMERS — auth columns
-- ============================================================================

alter table public.customers
  add column if not exists email_verified      boolean     not null default false,
  add column if not exists email_verified_at   timestamptz,
  add column if not exists password_hash       text,
  add column if not exists auth_provider       text        not null default 'email'
                             check (auth_provider in ('email','google','facebook','apple','sms','magic_link','custom')),
  add column if not exists social_id           text,
  add column if not exists tokens_invalidated_at timestamptz;

comment on column public.customers.email_verified       is 'True once the customer has clicked the verification link.';
comment on column public.customers.email_verified_at    is 'Timestamp of first successful email verification.';
comment on column public.customers.password_hash        is 'bcrypt password hash (cost 12). NULL for social/magic-link-only accounts.';
comment on column public.customers.auth_provider        is 'Primary authentication method used at registration.';
comment on column public.customers.social_id            is 'Provider-specific unique ID for social auth accounts.';
comment on column public.customers.tokens_invalidated_at is 'All refresh tokens issued before this timestamp are considered revoked.';

-- Unique social login index
create unique index if not exists ux_customers_social_id
  on public.customers(store_id, auth_provider, social_id)
  where social_id is not null;

-- ============================================================================
-- 3. CUSTOMER SESSIONS (refresh-token store)
-- ============================================================================

create table public.customer_sessions (
  id                  uuid        primary key default gen_random_uuid(),
  store_id            uuid        not null references public.stores(id)    on delete cascade,
  customer_id         uuid        not null references public.customers(id) on delete cascade,
  refresh_token_hash  text        not null unique,   -- SHA-256 of the opaque refresh token
  access_jti          text,                          -- last issued access-token JTI for revocation
  expires_at          timestamptz not null,
  last_used_at        timestamptz not null default now(),
  ip_address          inet,
  user_agent          text,
  is_revoked          boolean     not null default false,
  device_id           text,
  created_at          timestamptz not null default now()
);
comment on table public.customer_sessions is
  'Active refresh-token sessions per customer. '
  'Max sessions per customer enforced in application layer (stores.auth_max_sessions).';
create index idx_customer_sessions_customer on public.customer_sessions(customer_id, expires_at);
create index idx_customer_sessions_store    on public.customer_sessions(store_id);
create index idx_customer_sessions_active   on public.customer_sessions(store_id, customer_id)
  where not is_revoked;

-- ============================================================================
-- 4. EMAIL VERIFICATION TOKENS
-- ============================================================================

create table public.customer_email_verifications (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id)    on delete cascade,
  customer_id uuid        not null references public.customers(id) on delete cascade,
  token_hash  text        not null,   -- SHA-256 of the raw token delivered via email
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique(store_id, customer_id, token_hash)
);
comment on table public.customer_email_verifications is
  'One-time email-verification tokens. Expire 24 hours after issuance.';
create index idx_email_verifications_customer on public.customer_email_verifications(customer_id);
create index idx_email_verifications_expires  on public.customer_email_verifications(expires_at)
  where used_at is null;

-- ============================================================================
-- 5. PASSWORD RESET TOKENS
-- ============================================================================

create table public.customer_password_resets (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id)    on delete cascade,
  customer_id uuid        not null references public.customers(id) on delete cascade,
  token_hash  text        not null,   -- SHA-256 of the raw reset token
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip_address  inet,
  created_at  timestamptz not null default now(),
  unique(store_id, customer_id, token_hash)
);
comment on table public.customer_password_resets is
  'One-time password-reset tokens. Expire 1 hour after issuance.';
create index idx_password_resets_customer on public.customer_password_resets(customer_id);
create index idx_password_resets_expires  on public.customer_password_resets(expires_at)
  where used_at is null;

-- ============================================================================
-- 6. MAGIC LINK / OTP TOKENS
-- ============================================================================

create table public.customer_auth_tokens (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id)    on delete cascade,
  customer_id uuid        references public.customers(id)          on delete cascade,
  email       text        not null,   -- supplied at request time (customer may not exist yet)
  token_hash  text        not null,
  token_type  text        not null default 'magic_link'
                check (token_type in ('magic_link','otp')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip_address  inet,
  created_at  timestamptz not null default now()
);
comment on table public.customer_auth_tokens is
  'Short-lived magic-link and OTP tokens. '
  'Customer row may not yet exist (self-registration via magic link).';
create index idx_auth_tokens_store   on public.customer_auth_tokens(store_id, email);
create index idx_auth_tokens_expires on public.customer_auth_tokens(expires_at)
  where used_at is null;

-- ============================================================================
-- 7. ORGANISATION EMAIL PROVIDERS
--    (email infrastructure per organisation — no FK to organizations table)
-- ============================================================================

create table public.org_email_providers (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null unique,  -- plain uuid; no FK
  provider        text        not null default 'smtp'
                    check (provider in ('smtp','sendgrid','resend','mailgun','postmark','ses','custom')),
  from_name       text        not null default 'Cartcrft',
  from_email      text        not null,
  reply_to        text,
  config          jsonb       not null default '{}',   -- AES-encrypted credentials inside
  is_active       boolean     not null default false,
  verified_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table  public.org_email_providers                is 'Per-organisation transactional email provider. Each org has at most one record (unique on organization_id).';
comment on column public.org_email_providers.organization_id is 'Owning organisation. Plain UUID — no FK to a platform organisations table.';
comment on column public.org_email_providers.config          is 'Encrypted provider credentials: API key, SMTP password, etc.';

create trigger org_email_providers_updated_at
  before update on public.org_email_providers
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 8. ORGANISATION EMAIL TEMPLATES
-- ============================================================================

create table public.org_email_templates (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null,   -- plain uuid; no FK
  event           text        not null
                    check (event in (
                      'order.created','order.cancelled',
                      'order.shipped','order.delivered',
                      'payment.failed','payment.captured',
                      'customer.welcome','customer.email_verify',
                      'customer.password_reset','customer.magic_link',
                      'quote.sent','quote.accepted',
                      'return.created','return.approved','return.resolved',
                      'subscription.trial_ending','subscription.cancelled',
                      'gift_card.issued','store_credit.issued',
                      'cart.abandoned','booking.confirmed','booking.reminder','booking.cancelled'
                    )),
  locale          text        not null default 'en',
  subject         text        not null,
  html_body       text        not null,
  text_body       text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(organization_id, event, locale)
);
comment on table  public.org_email_templates                is 'Per-organisation transactional email templates by event type and locale.';
comment on column public.org_email_templates.organization_id is 'Owning organisation. Plain UUID — no FK.';

create index idx_org_email_templates_org on public.org_email_templates(organization_id);

create trigger org_email_templates_updated_at
  before update on public.org_email_templates
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 9. ALLOWED-ORIGINS VALIDATOR
-- ============================================================================

-- Validates that an allowed_origins text[] contains only well-formed https://
-- or http://localhost/127.0.0.1 origins, or a single wildcard '*'.
create or replace function public.check_allowed_origins(origins text[])
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  origin text;
begin
  if origins = '{}'::text[] then
    return true;
  end if;
  -- Allow ['*'] as explicit wildcard
  if origins = array['*'] then
    return true;
  end if;
  foreach origin in array origins loop
    if not (
         origin ~* '^https://[a-z0-9][a-z0-9.\-]*(:[0-9]{1,5})?$'
      or origin ~* '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$'
    ) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

comment on function public.check_allowed_origins(text[]) is
  'Returns true when every element is a valid https:// origin (or localhost/127.x.x.x for dev), '
  'or the array is empty / a single wildcard [''*'']. Used in CHECK constraints.';

-- Add constraint to stores.auth_allowed_origins
alter table public.stores
  add constraint stores_auth_allowed_origins_valid
    check (public.check_allowed_origins(auth_allowed_origins));

-- ============================================================================
-- 10. MAINTENANCE HELPERS
-- ============================================================================

-- Purge expired, unused customer auth tokens
create or replace function public.purge_expired_customer_auth_tokens()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.customer_auth_tokens
   where expires_at < now() and used_at is null;

  delete from public.customer_email_verifications
   where expires_at < now() and used_at is null;

  delete from public.customer_password_resets
   where expires_at < now() and used_at is null;
end;
$$;

comment on function public.purge_expired_customer_auth_tokens() is
  'Deletes expired, unconsumed customer auth tokens. '
  'Safe to run on a schedule (pg_cron) or from an app maintenance worker.';

commit;
