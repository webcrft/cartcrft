-- ============================================================================
-- 0041_giftcard_tender — gift-card / store-credit applied as a PAYMENT TENDER
-- at checkout.
--
-- Wave-15: a gift card or store credit pays part (or all) of a checkout's bill.
-- It is a TENDER, not a discount: it never changes subtotal/tax/discount/total.
-- The intended tender is recorded on the checkout when the customer applies a
-- code/credit (no money moves at apply time); the actual debit + ledger write +
-- order payment row happen ATOMICALLY inside the checkout-completion transaction.
--
-- Storage model: a single nullable jsonb column on public.checkouts holding the
-- list of applied tenders. NULL (the default) means "no tender applied", which
-- keeps the existing non-tender completion path byte-identical — the completion
-- code only engages the new branch when applied_tenders is a non-empty array.
--
-- Shape (array of objects):
--   [{ "kind": "gift_card",   "gift_card_id": "<uuid>", "amount": "12.34", "code": "ABC" },
--    { "kind": "store_credit", "store_credit_id": "<uuid>", "amount": "5.00", "currency": "ZAR" }]
--
-- `amount` is the INTENDED cap to apply (already capped at the checkout total at
-- apply time); the completion transaction re-locks the wallet row, re-validates
-- the live balance, and debits min(live_balance, remaining_order_total). The
-- stored amount is therefore advisory — the authoritative debit is recomputed
-- under the FOR UPDATE lock so a balance that dropped between apply and complete
-- can never over-debit.
--
-- public.checkouts ALREADY EXISTS from 0001_commerce and is RLS-scoped per store
-- (checkouts policies, 0006_rls), so this nullable column inherits that tenant
-- isolation with no new policy or grant work; column additions need no new grants
-- and cartcrft_app already holds DML on the table from the Wave-1 grant set.
-- ============================================================================

alter table public.checkouts
  add column if not exists applied_tenders jsonb;

comment on column public.checkouts.applied_tenders is
  'Wave-15: applied gift-card / store-credit tenders to redeem at completion. '
  'NULL or empty = no tender (non-tender completion path is unchanged). '
  'Each element: { kind: gift_card|store_credit, gift_card_id|store_credit_id, amount, code?, currency? }.';
