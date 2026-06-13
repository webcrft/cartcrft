-- 0015_refund_idempotency_key.sql
-- Add client-supplied Idempotency-Key support to the refunds table.
--
-- The existing uq_refunds_payment_provider_reference index handles provider
-- webhook dedup (Stripe charge.refunded / Paystack refund.processed).  This
-- migration adds a separate idempotency_key column for API-client dedup:
-- a POST .../refunds with Idempotency-Key header will store the key here and
-- ON CONFLICT return the original refund rather than inserting a duplicate.
--
-- Scope: per-payment idempotency (store the key scoped to payment_id so the
-- same key can legally appear for different payments across different stores).

alter table public.refunds
  add column if not exists idempotency_key text;

-- Partial unique index: enforces uniqueness only when the key is present,
-- scoped to the payment so the same client key can be reused across payments.
create unique index if not exists uq_refunds_payment_idempotency_key
  on public.refunds(payment_id, idempotency_key)
  where idempotency_key is not null;
