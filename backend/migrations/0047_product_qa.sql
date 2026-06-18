-- ============================================================================
-- 0047_product_qa — Product Q&A (customer questions + merchant answers).
--
-- Wave-21.1: a shopper asks a question on a product; the merchant answers it;
-- answered/published questions are listed publicly on the product page. One
-- store-scoped table:
--
--   product_questions — one customer question (and its optional merchant answer).
--     The asker is EITHER a logged-in customer (customer_id) OR an anonymous
--     storefront visitor who supplied a display name (asker_name). status walks
--     pending → published (answered + approved) | rejected (hidden). is_public
--     lets a merchant keep an answered question out of the public list without
--     rejecting it.
--
-- Public listing (service.listQuestions, PUBLIC mode) returns only rows with
-- status='published' AND is_public — analogous to product_reviews moderation
-- (0038): nothing is publicly visible until the merchant acts.
--
-- RLS: org-gated exactly like 0033/0037/0042/0044 via is_store_member(store_id)
-- (+ the standard cartcrft_app grants). All storefront reads/writes flow through
-- the per-request tenant connection, so the same policy covers public reads.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- ── product_questions — one question ↔ one product ──────────────────────────
create table if not exists public.product_questions (
  id          uuid        primary key default gen_random_uuid(),
  store_id    uuid        not null references public.stores(id)   on delete cascade,
  product_id  uuid        not null references public.products(id) on delete cascade,
  -- Asker identity: EITHER a logged-in customer OR an anonymous display name.
  customer_id uuid        references public.customers(id) on delete set null,
  asker_name  text,
  question    text        not null,
  status      text        not null default 'pending'
                check (status in ('pending', 'published', 'rejected')),
  answer      text,
  answered_by text,
  answered_at timestamptz,
  -- A merchant can keep an answered question private without rejecting it.
  is_public   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table  public.product_questions is
  'Product Q&A. A shopper (customer_id or anonymous asker_name) asks a question on a product; the merchant answers it. Only status=published AND is_public rows are listed publicly.';
comment on column public.product_questions.status is
  'pending (awaiting merchant) → published (answered + visible) | rejected (hidden). Answering sets published unless explicitly rejected.';
comment on column public.product_questions.is_public is
  'When false an answered question is excluded from the public list without being rejected.';

create index if not exists idx_product_questions_store
  on public.product_questions (store_id);
-- Public product page list: published+public questions for one product.
create index if not exists idx_product_questions_product
  on public.product_questions (store_id, product_id);
-- Admin moderation queue: pending questions for a store.
create index if not exists idx_product_questions_status
  on public.product_questions (store_id, status);

-- ── RLS — org-gated, mirrors 0033/0037/0042/0044 tenant isolation ───────────
alter table public.product_questions enable row level security;

drop policy if exists product_questions_isolation on public.product_questions;
create policy product_questions_isolation on public.product_questions
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

-- ── Grants for the restricted app role (mirrors 0033/0037/0042/0044) ────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    grant select, insert, update, delete on public.product_questions to cartcrft_app;
  end if;
end$$;

-- ── updated_at maintenance (reuse the standard helper if present) ───────────
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists trg_product_questions_updated_at on public.product_questions;
    create trigger trg_product_questions_updated_at
      before update on public.product_questions
      for each row execute function public.set_updated_at();
  end if;
end$$;

commit;
