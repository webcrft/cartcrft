-- ============================================================================
-- CARTCRFT CLOUD BILLING — CORE TABLES
-- Ported from webcrft-mono 20260218000008_billing.sql
-- Rebranded: webcrft → cartcrft; stripped non-billing platform tables
-- (sites, LLM models, org_emails, quota_usage/limits, billing_addons,
--  billing_org_addons — those are platform concerns not billing core).
-- Added: USD→ZAR fx snapshot columns on invoices and charge records.
-- ============================================================================

-- set_updated_at() is expected to already exist (created by backend migrations).
-- If running in a non-public schema (e.g. test scratch schemas), create a local copy.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = current_schema() and p.proname = 'set_updated_at'
  ) then
    execute format(
      $fn$
        create or replace function %I.set_updated_at()
        returns trigger language plpgsql as $body$
        begin new.updated_at = now(); return new; end;
        $body$;
      $fn$,
      current_schema()
    );
  end if;
end;
$$;

-- ============================================================================
-- 1. BILLING TIERS (base plans)
-- Cartcrft commerce-focused tier set (replaces webcrft website-builder tiers).
-- ============================================================================

create table if not exists public.billing_tiers (
  id                  uuid        primary key default gen_random_uuid(),
  name                text        not null unique,
  slug                text        not null unique,
  description         text,
  -- Price stored in USD cents (e.g. 2900 = $29.00).
  -- Actual charge is converted to ZAR at time of billing; snapshot stored on invoice.
  price_usd_cents     integer     not null default 0,
  currency            char(3)     not null default 'USD',
  interval            text        not null default 'monthly'
    check (interval in ('monthly', 'annual')),
  paystack_plan_code  text        unique,
  features            jsonb       not null default '{}',
  -- Commerce-specific quotas embedded in features.
  -- e.g. {"commerce_orders_monthly": 500, "commerce_stores": 1, "api_requests_monthly": 10000}
  is_active           boolean     not null default true,
  sort_order          integer     not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table  public.billing_tiers is
  'Base pricing tiers. price_usd_cents in USD cents (0 = free). '
  'Actual charges execute in ZAR via fx conversion at billing time; snapshots stored on invoice.';
comment on column public.billing_tiers.price_usd_cents is
  'Plan price in USD cents. Converted to ZAR at each billing cycle using live exchange_rates.';

insert into public.billing_tiers
  (name, slug, description, price_usd_cents, sort_order, features)
values
  ('Free',    'free',    'Open-source self-host, no cloud metering',
   0,    1, '{"commerce_stores": 1, "commerce_orders_monthly": 100, "api_requests_monthly": 5000}'::jsonb),
  -- Nano: sub-$4k-GMV entry tier (C-10e). 1 store, 200 orders/mo cap,
  -- community support only, 0% rake + BYO keys. Closes the Shopify gap at <$4k GMV.
  ('Cloud Nano', 'nano', 'Sub-$4k-GMV entry tier: 1 store, 200 orders/mo, community support, 0% rake',
   1900, 2, '{"commerce_stores": 1, "commerce_orders_monthly": 200, "api_requests_monthly": 10000, "team_seats": 1, "support": "community"}'::jsonb),
  ('Starter', 'starter', 'Small store, cloud-hosted, metered',
   2900, 3, '{"commerce_stores": 1, "commerce_orders_monthly": 500,  "api_requests_monthly": 25000}'::jsonb),
  ('Growth',  'growth',  'Growing store with higher quotas',
   7900, 4, '{"commerce_stores": 3, "commerce_orders_monthly": 2000, "api_requests_monthly": 100000}'::jsonb),
  ('Scale',   'scale',   'High-volume, priority support',
   19900, 5, '{"commerce_stores": 10,"commerce_orders_monthly": -1,  "api_requests_monthly": -1}'::jsonb)
on conflict (slug) do nothing;

-- ============================================================================
-- 2. BILLING AUTHORIZATIONS (Paystack card tokens per org)
-- ============================================================================

create table if not exists public.billing_authorizations (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null,
  paystack_authorization_code text        not null unique,
  paystack_customer_code      text        not null,
  email                       text        not null,
  card_type                   text,
  last4                       text,
  exp_month                   text,
  exp_year                    text,
  bank                        text,
  brand                       text,
  reusable                    boolean     not null default false,
  is_default                  boolean     not null default false,
  is_active                   boolean     not null default true,
  deleted_at                  timestamptz,
  delete_reason               text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.billing_authorizations is
  'Paystack card authorizations for recurring charges. One default per org enforced by trigger.';

create index if not exists idx_billing_auth_org
  on public.billing_authorizations(organization_id);
create index if not exists idx_billing_auth_default
  on public.billing_authorizations(organization_id)
  where is_default = true and is_active = true and deleted_at is null;
create unique index if not exists uq_billing_auth_single_default
  on public.billing_authorizations(organization_id)
  where is_default = true and is_active = true and deleted_at is null;

-- ============================================================================
-- 3. BILLING SUBSCRIPTIONS (links an org to a base tier)
-- ============================================================================

do $$ begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'subscription_status'
      and n.nspname = current_schema()
  ) then
    create type public.subscription_status as enum ('active', 'past_due', 'cancelled');
  end if;
end $$;

create table if not exists public.billing_subscriptions (
  id                          uuid                       primary key default gen_random_uuid(),
  organization_id             uuid                       not null,
  tier_id                     uuid                       not null references public.billing_tiers(id) on delete restrict,
  authorization_id            uuid                       references public.billing_authorizations(id) on delete set null,
  status                      public.subscription_status not null default 'active',
  paystack_subscription_code  text                       unique,
  paystack_email_token        text,
  current_period_start        timestamptz,
  current_period_end          timestamptz,
  billing_day                 smallint                   check (billing_day between 1 and 28),
  cancel_at_period_end        boolean                    not null default false,
  cancelled_at                timestamptz,
  failed_payment_count        integer                    not null default 0,
  last_payment_failed_at      timestamptz,
  outstanding_amount_cents    integer                    not null default 0,
  -- Grace period: days after period_end before auto-downgrade triggers.
  grace_period_days           smallint                   not null default 7,
  downgraded_at               timestamptz,
  downgrade_reason            text,
  metadata                    jsonb                      not null default '{}',
  created_at                  timestamptz                not null default now(),
  updated_at                  timestamptz                not null default now()
);

comment on table  public.billing_subscriptions is
  'Links an org to a billing tier. Free-tier orgs get an active subscription with no Paystack code.';
comment on column public.billing_subscriptions.failed_payment_count is
  'Consecutive failed charge attempts. Reset to 0 on successful payment. At 3 the cron auto-downgrades.';
comment on column public.billing_subscriptions.billing_day is
  'Preferred day-of-month for renewal (1–28). NULL = use sign-up day. Changing triggers proration.';
comment on column public.billing_subscriptions.grace_period_days is
  'Calendar days after period_end before auto-downgrade. Default 7.';
comment on column public.billing_subscriptions.downgrade_reason is
  'Why the subscription was auto-downgraded (e.g. "3_failed_payments", "grace_period_expired").';

create index if not exists idx_billing_sub_org    on public.billing_subscriptions(organization_id);
create index if not exists idx_billing_sub_status on public.billing_subscriptions(status);
create index if not exists idx_billing_sub_period on public.billing_subscriptions(current_period_end)
  where status = 'active';

-- ============================================================================
-- 4. BILLING INVOICES
-- FX snapshot: every invoice records the USD price, ZAR converted amount,
-- the exchange rate used, and when the rate was fetched. Immutable after issuance.
-- ============================================================================

do $$ begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'invoice_status'
      and n.nspname = current_schema()
  ) then
    create type public.invoice_status as enum ('issued', 'paid', 'overdue', 'void');
  end if;
end $$;

create table if not exists public.billing_invoices (
  id                    uuid             primary key default gen_random_uuid(),
  organization_id       uuid             not null,
  subscription_id       uuid             references public.billing_subscriptions(id) on delete set null,
  invoice_number        text             not null unique,
  status                public.invoice_status not null default 'issued',

  -- Line totals in ZAR cents (what Paystack actually charges).
  subtotal_cents        integer          not null default 0,
  tax_cents             integer          not null default 0,
  total_cents           integer          not null default 0,

  -- USD→ZAR FX snapshot (immutable once set at invoice creation).
  -- usd_amount: total price in USD (numeric for precision).
  usd_amount            numeric(15,2)    not null default 0,
  -- fx_rate: USD/ZAR rate used for this invoice (e.g. 18.523400).
  fx_rate               numeric(12,6)    not null default 1,
  -- zar_amount: usd_amount * fx_rate, the actual charged amount in ZAR (numeric for precision).
  zar_amount            numeric(15,2)    not null default 0,
  -- fx_fetched_at: when the rate was retrieved from exchange_rates table.
  fx_fetched_at         timestamptz,

  due_at                timestamptz,
  paid_at               timestamptz,
  pdf_content           bytea,
  recipient_email       text,
  recipient_name        text,
  -- Snapshot of org billing details at invoice time (immutable).
  business_snapshot     jsonb            not null default '{}',
  email_sent_count      integer          not null default 0,
  email_last_sent_at    timestamptz,
  created_at            timestamptz      not null default now(),
  updated_at            timestamptz      not null default now()
);

comment on table  public.billing_invoices is
  'One invoice per billing cycle per subscription. FX snapshot columns are immutable after issuance.';
comment on column public.billing_invoices.usd_amount   is 'Invoice total in USD at time of issuance.';
comment on column public.billing_invoices.fx_rate      is 'USD/ZAR exchange rate used; immutable after issuance.';
comment on column public.billing_invoices.zar_amount   is 'Invoice total in ZAR = usd_amount × fx_rate; immutable after issuance.';
comment on column public.billing_invoices.fx_fetched_at is 'Timestamp when the fx_rate was fetched from exchange_rates.';
comment on column public.billing_invoices.total_cents  is 'Total in ZAR cents (= zar_amount * 100, rounded).';

create index if not exists idx_billing_invoices_org    on public.billing_invoices(organization_id, created_at desc);
create index if not exists idx_billing_invoices_status on public.billing_invoices(organization_id, status);
create index if not exists idx_billing_invoices_sub    on public.billing_invoices(subscription_id) where subscription_id is not null;

-- ============================================================================
-- 5. BILLING INVOICE ITEMS (line items)
-- ============================================================================

create table if not exists public.billing_invoice_items (
  id                  uuid        primary key default gen_random_uuid(),
  invoice_id          uuid        not null references public.billing_invoices(id) on delete cascade,
  description         text        not null,
  quantity            integer     not null default 1,
  unit_amount_cents   integer     not null default 0,
  line_total_cents    integer     not null default 0,
  -- Per-line FX snapshot for overage lines (may differ from header rate if
  -- computed at different time; typically matches invoice header).
  usd_amount          numeric(15,2) not null default 0,
  fx_rate             numeric(12,6) not null default 1,
  zar_amount          numeric(15,2) not null default 0,
  fx_fetched_at       timestamptz,
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now()
);

comment on table public.billing_invoice_items is 'Line items on a billing invoice.';
comment on column public.billing_invoice_items.usd_amount is 'Line total in USD.';
comment on column public.billing_invoice_items.fx_rate    is 'FX rate used for this line.';
comment on column public.billing_invoice_items.zar_amount is 'Line total in ZAR = usd_amount × fx_rate.';

create index if not exists idx_billing_invoice_items_invoice on public.billing_invoice_items(invoice_id);

-- ============================================================================
-- 6. BILLING TRANSACTIONS (payment charge records)
-- FX snapshot on every charge row — immutable once the charge is recorded.
-- ============================================================================

do $$ begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'transaction_status'
      and n.nspname = current_schema()
  ) then
    create type public.transaction_status as enum ('success', 'failed', 'pending');
  end if;
end $$;

create table if not exists public.billing_transactions (
  id                    uuid                      primary key default gen_random_uuid(),
  organization_id       uuid                      not null,
  subscription_id       uuid                      references public.billing_subscriptions(id) on delete set null,
  invoice_id            uuid                      references public.billing_invoices(id) on delete set null,
  authorization_id      uuid                      references public.billing_authorizations(id) on delete set null,
  paystack_reference    text                      not null unique,
  -- ZAR cents actually charged to Paystack.
  amount_cents          integer                   not null,
  currency              char(3)                   not null default 'ZAR',
  status                public.transaction_status not null default 'pending',
  charge_type           text                      not null default 'subscription'
    check (charge_type in ('subscription', 'wallet_topup', 'card_authorization', 'outstanding', 'other')),

  -- USD→ZAR FX snapshot (immutable once recorded).
  usd_amount            numeric(15,2) not null default 0,
  fx_rate               numeric(12,6) not null default 1,
  zar_amount            numeric(15,2) not null default 0,
  fx_fetched_at         timestamptz,

  gateway_response      text,
  paid_at               timestamptz,
  metadata              jsonb        not null default '{}',
  created_at            timestamptz  not null default now(),
  updated_at            timestamptz  not null default now()
);

comment on table  public.billing_transactions is
  'Payment records from Paystack. FX snapshot is immutable once the charge is recorded.';
comment on column public.billing_transactions.usd_amount  is 'Charge amount in USD at time of charge.';
comment on column public.billing_transactions.fx_rate     is 'USD/ZAR rate used; immutable.';
comment on column public.billing_transactions.zar_amount  is 'Charge amount in ZAR = usd_amount × fx_rate; immutable.';

create index if not exists idx_billing_txn_org         on public.billing_transactions(organization_id);
create index if not exists idx_billing_txn_ref         on public.billing_transactions(paystack_reference);
create index if not exists idx_billing_txn_charge_type on public.billing_transactions(charge_type);
create index if not exists idx_billing_txn_invoice     on public.billing_transactions(invoice_id) where invoice_id is not null;
create index if not exists idx_billing_txn_status      on public.billing_transactions(status, created_at desc);

-- ============================================================================
-- 7. BILLING PAYMENT ATTEMPTS (audit trail of every charge attempt)
-- ============================================================================

create table if not exists public.billing_payment_attempts (
  id                  uuid                      primary key default gen_random_uuid(),
  organization_id     uuid                      not null,
  subscription_id     uuid                      references public.billing_subscriptions(id) on delete set null,
  invoice_id          uuid                      references public.billing_invoices(id) on delete set null,
  transaction_id      uuid                      references public.billing_transactions(id) on delete set null,
  authorization_id    uuid                      references public.billing_authorizations(id) on delete set null,
  source              text                      not null default 'unknown',
  provider            text                      not null default 'paystack',
  provider_reference  text                      not null,
  status              public.transaction_status not null,
  charge_type         text                      not null default 'subscription',
  amount_cents        integer                   not null default 0,
  currency            char(3)                   not null default 'ZAR',

  -- FX snapshot at attempt time.
  usd_amount          numeric(15,2) not null default 0,
  fx_rate             numeric(12,6) not null default 1,
  zar_amount          numeric(15,2) not null default 0,
  fx_fetched_at       timestamptz,

  failure_reason      text,
  metadata            jsonb        not null default '{}',
  attempted_at        timestamptz  not null default now(),
  created_at          timestamptz  not null default now()
);

comment on table public.billing_payment_attempts is
  'Full audit trail of every charge attempt (success and failure). Immutable append-only.';

create index if not exists idx_billing_payment_attempts_org_created
  on public.billing_payment_attempts(organization_id, created_at desc);
create index if not exists idx_billing_payment_attempts_org_status
  on public.billing_payment_attempts(organization_id, status, created_at desc);
create unique index if not exists uq_billing_payment_attempts_dedupe
  on public.billing_payment_attempts(provider, source, provider_reference, status);

-- ============================================================================
-- 8. BILLING WALLET (org credit balance for overages and top-ups)
-- ============================================================================

create table if not exists public.billing_wallets (
  id                          uuid        primary key default gen_random_uuid(),
  organization_id             uuid        not null unique,
  -- Balance in ZAR cents.
  balance_cents               integer     not null default 0,
  -- Auto top-up configuration.
  auto_topup_enabled          boolean     not null default false,
  -- Minimum topup amount: R10 = 1000 cents.
  auto_topup_amount_cents     integer     not null default 0
    check (auto_topup_amount_cents = 0 or auto_topup_amount_cents >= 1000),
  -- Trigger threshold: topup fires when balance < this value.
  auto_topup_threshold_cents  integer     not null default 0,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table  public.billing_wallets is 'Credit wallet per org. Balance in ZAR cents. Used for overage charges.';
comment on column public.billing_wallets.auto_topup_amount_cents    is 'Amount to top up in ZAR cents (min 1000 = R10 when enabled).';
comment on column public.billing_wallets.auto_topup_threshold_cents is 'Balance level that triggers automatic top-up.';

create index if not exists idx_billing_wallets_org on public.billing_wallets(organization_id);

-- ============================================================================
-- 9. BILLING WALLET LEDGER (append-only credit/debit log)
-- ============================================================================

create table if not exists public.billing_wallet_ledger (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  wallet_id           uuid        not null references public.billing_wallets(id) on delete cascade,
  -- 'credit' = funds added; 'debit' = funds consumed.
  entry_type          text        not null check (entry_type in ('credit', 'debit')),
  amount_cents        integer     not null check (amount_cents > 0),
  balance_after_cents integer     not null,
  description         text        not null,
  -- Reference to the transaction that caused this entry (nullable for manual credits).
  transaction_id      uuid        references public.billing_transactions(id) on delete set null,
  invoice_id          uuid        references public.billing_invoices(id) on delete set null,
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now()
);

comment on table public.billing_wallet_ledger is
  'Append-only ledger for wallet credits and debits. balance_after_cents is a running total snapshot.';

create index if not exists idx_billing_wallet_ledger_org    on public.billing_wallet_ledger(organization_id, created_at desc);
create index if not exists idx_billing_wallet_ledger_wallet on public.billing_wallet_ledger(wallet_id, created_at desc);

-- ============================================================================
-- 10. BILLING VOUCHERS
-- ============================================================================

create table if not exists public.billing_vouchers (
  id                  uuid        primary key default gen_random_uuid(),
  code                text        not null unique,
  description         text,
  -- discount_type: 'percent' (off invoice), 'fixed_usd' (USD credit), 'free_months'.
  discount_type       text        not null
    check (discount_type in ('percent', 'fixed_usd', 'free_months')),
  discount_value      numeric(15,2) not null,
  -- max_redemptions: NULL = unlimited.
  max_redemptions     integer,
  redemption_count    integer     not null default 0,
  valid_from          timestamptz,
  valid_until         timestamptz,
  -- tier_restriction: NULL = valid on any tier.
  tier_restriction    text,
  is_active           boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.billing_vouchers is
  'Discount vouchers. discount_type=percent: percentage off; fixed_usd: USD credit applied to invoice; free_months: N months free.';

create index if not exists idx_billing_vouchers_code   on public.billing_vouchers(code) where is_active = true;
create index if not exists idx_billing_vouchers_active on public.billing_vouchers(is_active, valid_until);

-- ============================================================================
-- 11. BILLING VOUCHER REDEMPTIONS
-- ============================================================================

create table if not exists public.billing_voucher_redemptions (
  id                  uuid        primary key default gen_random_uuid(),
  voucher_id          uuid        not null references public.billing_vouchers(id) on delete restrict,
  organization_id     uuid        not null,
  subscription_id     uuid        references public.billing_subscriptions(id) on delete set null,
  invoice_id          uuid        references public.billing_invoices(id) on delete set null,
  -- Amount actually discounted in USD.
  discount_applied_usd numeric(15,2) not null default 0,
  redeemed_at         timestamptz not null default now(),
  created_at          timestamptz not null default now()
);

comment on table public.billing_voucher_redemptions is
  'Records each use of a voucher. One row per redemption. discount_applied_usd in USD.';

-- At most one redemption per org per voucher (prevent double-dipping).
create unique index if not exists uq_billing_voucher_redemption_org
  on public.billing_voucher_redemptions(voucher_id, organization_id);

create index if not exists idx_billing_voucher_redemptions_org
  on public.billing_voucher_redemptions(organization_id);
create index if not exists idx_billing_voucher_redemptions_voucher
  on public.billing_voucher_redemptions(voucher_id);

-- ============================================================================
-- 12. BILLING REFUNDS
-- ============================================================================

create table if not exists public.billing_refunds (
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null,
  transaction_id      uuid        not null references public.billing_transactions(id) on delete restrict,
  invoice_id          uuid        references public.billing_invoices(id) on delete set null,
  -- Refund amount in ZAR cents.
  amount_cents        integer     not null check (amount_cents > 0),
  reason              text,
  paystack_reference  text        unique,
  status              text        not null default 'pending'
    check (status in ('pending', 'processed', 'failed')),

  -- FX snapshot at time of original charge (not current rate).
  usd_amount          numeric(15,2) not null default 0,
  fx_rate             numeric(12,6) not null default 1,
  zar_amount          numeric(15,2) not null default 0,
  fx_fetched_at       timestamptz,

  processed_at        timestamptz,
  metadata            jsonb       not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table  public.billing_refunds is 'Refund records tied to original transactions.';
comment on column public.billing_refunds.usd_amount  is 'USD amount of the original charge being refunded.';
comment on column public.billing_refunds.fx_rate     is 'Original charge fx_rate (copied from transaction).';
comment on column public.billing_refunds.zar_amount  is 'ZAR amount of the original charge being refunded.';

create index if not exists idx_billing_refunds_org         on public.billing_refunds(organization_id);
create index if not exists idx_billing_refunds_transaction on public.billing_refunds(transaction_id);
create index if not exists idx_billing_refunds_status      on public.billing_refunds(status) where status = 'pending';

-- ============================================================================
-- 13. TRIGGERS
-- ============================================================================

-- updated_at maintenance
create or replace function public.billing_unset_other_default_auths()
returns trigger
language plpgsql
as $$
begin
  if new.is_default = true then
    update public.billing_authorizations
       set is_default = false
     where organization_id = new.organization_id
       and id != new.id
       and is_active = true
       and deleted_at is null
       and is_default = true;
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_auth_default_toggle'
      and n.nspname = current_schema()
  ) then
    create trigger billing_auth_default_toggle
      after insert or update of is_default on public.billing_authorizations
      for each row execute function public.billing_unset_other_default_auths();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_tiers_updated_at' and n.nspname = current_schema()
  ) then
    create trigger billing_tiers_updated_at
      before update on public.billing_tiers
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_authorizations_updated_at' and n.nspname = current_schema()
  ) then
    create trigger billing_authorizations_updated_at
      before update on public.billing_authorizations
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_subscriptions_updated_at' and n.nspname = current_schema()
  ) then
    create trigger billing_subscriptions_updated_at
      before update on public.billing_subscriptions
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_transactions_updated_at' and n.nspname = current_schema()
  ) then
    create trigger billing_transactions_updated_at
      before update on public.billing_transactions
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_invoices_updated_at' and n.nspname = current_schema()
  ) then
    create trigger billing_invoices_updated_at
      before update on public.billing_invoices
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_wallets_updated_at' and n.nspname = current_schema()
  ) then
    create trigger billing_wallets_updated_at
      before update on public.billing_wallets
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_vouchers_updated_at' and n.nspname = current_schema()
  ) then
    create trigger billing_vouchers_updated_at
      before update on public.billing_vouchers
      for each row execute function public.set_updated_at();
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where t.tgname = 'billing_refunds_updated_at' and n.nspname = current_schema()
  ) then
    create trigger billing_refunds_updated_at
      before update on public.billing_refunds
      for each row execute function public.set_updated_at();
  end if;
end $$;
