-- ============================================================================
-- 0045_draft_orders — Draft orders / invoicing.
--
-- Wave-19: a merchant builds a DRAFT order (line items + computed/echoed
-- totals) WITHOUT touching inventory, optionally sends the customer an invoice
-- (a shareable payment link emailed to them), then CONVERTS the draft into a
-- real order via the existing orders pipeline.
--
--   draft_orders — one merchant-authored draft per row.
--     line_items jsonb is a snapshot of [{variant_id, title, quantity, price}].
--     subtotal/discount_total/tax_total/shipping_total/total are numeric(15,2)
--     decimals (string in the API, matching orders). status walks
--     draft → invoice_sent → converted, or → cancelled. invoice_url holds the
--     shareable payment link once an invoice is sent; converted_order_id points
--     at the real order created on conversion.
--
-- RLS: org-gated exactly like 0033/0037/0042/0044 via is_store_member(store_id)
-- (+ the standard cartcrft_app grants + updated_at trigger).
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── draft_orders — a merchant-authored draft order / invoice ────────────────
create table if not exists public.draft_orders (
  id                 uuid          primary key default gen_random_uuid(),
  store_id           uuid          not null references public.stores(id)    on delete cascade,
  -- Recipient: an existing customer and/or a free-form email (either may be set;
  -- the invoice is emailed to email, falling back to the customer's email).
  customer_id        uuid          references public.customers(id) on delete set null,
  email              text,
  currency           text          not null,
  -- Snapshot of [{variant_id, title, quantity, price}] captured at draft time.
  line_items         jsonb         not null default '[]'::jsonb,
  subtotal           numeric(15,2) not null default 0,
  discount_total     numeric(15,2) not null default 0,
  tax_total          numeric(15,2) not null default 0,
  shipping_total     numeric(15,2) not null default 0,
  total              numeric(15,2) not null default 0,
  note               text,
  status             text          not null default 'draft'
                       check (status in ('draft', 'invoice_sent', 'converted', 'cancelled')),
  -- Shareable payment-link URL once an invoice has been sent.
  invoice_url        text,
  -- The real order created when the draft is converted.
  converted_order_id uuid          references public.orders(id) on delete set null,
  created_at         timestamptz   not null default now(),
  updated_at         timestamptz   not null default now()
);

comment on table  public.draft_orders is
  'Merchant-authored draft orders / invoices. A draft holds a line-item snapshot + computed totals WITHOUT reserving inventory; it can be invoiced (shareable payment link emailed) and converted into a real order.';
comment on column public.draft_orders.line_items is
  'Snapshot of [{variant_id, title, quantity, price}] captured at draft time.';
comment on column public.draft_orders.status is
  'draft → invoice_sent → converted | cancelled. Only draft/invoice_sent drafts can be converted.';
comment on column public.draft_orders.invoice_url is
  'Shareable payment-link URL emailed to the customer once an invoice is sent.';
comment on column public.draft_orders.converted_order_id is
  'The real order created when the draft was converted.';

create index if not exists idx_draft_orders_store
  on public.draft_orders (store_id, created_at desc);
create index if not exists idx_draft_orders_status
  on public.draft_orders (store_id, status);

-- ── RLS — org-gated, mirrors 0033/0037/0042/0044 tenant isolation ───────────
alter table public.draft_orders enable row level security;

drop policy if exists draft_orders_isolation on public.draft_orders;
create policy draft_orders_isolation on public.draft_orders
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0033/0037/0042/0044) ────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.draft_orders to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_draft_orders_updated_at on public.draft_orders;
    create trigger trg_draft_orders_updated_at
      before update on public.draft_orders
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
