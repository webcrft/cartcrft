-- ============================================================================
-- 0046_return_store_credit — auto-issue store credit on return resolution.
--
-- Wave-20: when a return is resolved with return_type = 'store_credit' and a
-- positive credit amount, the service auto-issues that amount to the customer's
-- store-credit wallet INSIDE the same transaction that records the resolution
-- (so a failure rolls back both). The issuance must be IDEMPOTENT — retrying
-- the 'resolved' transition must not double-credit.
--
-- The idempotency marker lives on the return itself: a single timestamp column
-- set when (and only when) the credit is issued. The service guards the issue
-- on `store_credit_issued_at IS NULL` via a conditional UPDATE that returns the
-- row only on the first transition, mirroring the SQL-level idempotency guard
-- already used for return labels (0040: COALESCE on return_label_url).
--
-- The table ALREADY EXISTS from 0001_commerce and is RLS-scoped per store
-- (return_requests_all, 0006_rls), so the new column inherits that tenant
-- isolation with no extra policy or grant work — cartcrft_app already holds DML
-- on the table from the Wave-1 grant set, and column additions need no new
-- grants. Style mirrors 0040 (begin/commit, add column if not exists, comment).
-- ============================================================================

begin;

alter table public.return_requests
  add column if not exists store_credit_issued_at timestamptz;

comment on column public.return_requests.store_credit_issued_at is
  'Timestamp the resolution auto-issued store credit to the customer wallet. NULL until issued; presence makes store-credit issuance on resolution idempotent (no double-credit on retry).';

commit;
