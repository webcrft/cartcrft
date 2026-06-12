-- ============================================================================
-- 0008_PAYMENT_GATEWAYS — platform-level payment gateway credentials
--
-- Ported from webcrft-mono: 20260407000042_platform_additions.sql (lines 583-611)
-- Stores AES-256-GCM encrypted gateway credentials.
-- Super-admin only access — deny-all RLS policy.
-- ============================================================================

begin;

create table if not exists public.payment_gateway_instances (
  id                           uuid        primary key default gen_random_uuid(),
  name                         text        not null unique,
  type                         text        not null
                                 check (type in ('paystack','stripe','razorpay','xendit','flutterwave')),
  secret_key_enc               text        not null,
  public_key_enc               text        not null default '',
  webhook_secret_enc           text,
  webhook_secret_secondary_enc text,
  is_active                    boolean     not null default true,
  -- dev/test credentials (optional — NULL means no dev credentials configured)
  dev_secret_key_enc           text,
  dev_public_key_enc           text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

comment on table public.payment_gateway_instances is
  'Platform-level payment gateway credentials. secret_key_enc and public_key_enc '
  'are AES-256-GCM encrypted using AUTH_SECRETS_KEY. '
  'Super-admin access only.';

comment on column public.payment_gateway_instances.webhook_secret_secondary_enc is
  'AES-256-GCM encrypted secondary webhook signing secret. '
  'Used by Stripe thin-payload webhook endpoints.';

create trigger payment_gateway_instances_updated_at
  before update on public.payment_gateway_instances
  for each row execute function public.set_updated_at();

-- Deny-all RLS: table is managed exclusively by server-side code
-- using the service role (no direct client access).
alter table public.payment_gateway_instances enable row level security;

create policy payment_gateway_instances_deny_all
  on public.payment_gateway_instances
  as restrictive
  for all
  using (false);

commit;
