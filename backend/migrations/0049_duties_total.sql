-- ============================================================================
-- 0049_duties_total — fold import duties / landed-cost into the live order total.
--
-- Wave-24: import duties (0036_duties + lib/tax.ts calcDuties) move from
-- preview-only to an actual order total component. A new money column,
-- duties_total, is added to BOTH public.checkouts and public.orders so the
-- cross-border duty amount is stored alongside subtotal/tax_total/shipping_total
-- and folded into total at checkout-create/update and order completion.
--
-- The column is numeric(15,2) NOT NULL DEFAULT 0 (mirroring the existing money
-- columns at 0001_commerce), so EXISTING rows and the DOMESTIC / non-cross-border
-- path are byte-identical: duties_total stays 0 unless the destination country
-- differs from the store origin AND a matching duty rate exists. total is
-- unchanged whenever duties_total = 0 (total = subtotal − discount + shipping +
-- tax + 0).
--
-- Both tables ALREADY EXIST from 0001_commerce and are RLS-scoped per store
-- (0006_rls), so these defaulted columns inherit that tenant isolation with no
-- new policy or grant work; column additions need no new grants and cartcrft_app
-- already holds DML on both tables from the Wave-1 grant set. Style mirrors
-- 0043_tax_exempt / 0046_return_store_credit (begin/commit, add-if-not-exists,
-- comment).
-- ============================================================================

begin;

alter table public.checkouts
  add column if not exists duties_total numeric(15,2) not null default 0;

comment on column public.checkouts.duties_total is
  'Wave-24: import duty (DDP / landed cost) for cross-border orders, folded into total. '
  'Default 0 keeps the domestic / non-cross-border path byte-identical.';

alter table public.orders
  add column if not exists duties_total numeric(15,2) not null default 0;

comment on column public.orders.duties_total is
  'Wave-24: import duty (DDP / landed cost) copied from the checkout at completion and included in total. '
  'Default 0 keeps the domestic / non-cross-border path byte-identical.';

commit;
