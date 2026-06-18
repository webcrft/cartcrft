-- ============================================================================
-- 0040_return_labels — prepaid RETURN shipping-label fields on return_requests.
--
-- Wave-14: returns can carry a prepaid return shipping label purchased via the
-- Shippo aggregator (the parcel ships FROM the customer TO the store warehouse).
-- The label is a property of the return itself (one label per RMA), so rather
-- than introduce a separate table we extend public.return_requests in place.
-- The table ALREADY EXISTS from 0001_commerce and is RLS-scoped per store
-- (return_requests_all, 0006_rls), so the new columns inherit that tenant
-- isolation with no extra policy or grant work — cartcrft_app already holds DML
-- on the table from the Wave-1 grant set, and column additions need no new
-- grants.
--
-- New nullable columns (NULL until a label is purchased):
--   return_label_url         text        — Shippo label_url (PDF download)
--   return_tracking_number   text        — carrier tracking number
--   return_carrier           text        — carrier/provider name (e.g. "USPS")
--   return_label_purchased_at timestamptz — when the label was purchased
--
-- The service-layer purchase is IDEMPOTENT: once return_label_url is set the
-- existing label is returned rather than buying again.
--
-- Style mirrors 0038/0039 (begin/commit, add column if not exists, column
-- comments).
-- ============================================================================

begin;

alter table public.return_requests
  add column if not exists return_label_url          text,
  add column if not exists return_tracking_number    text,
  add column if not exists return_carrier            text,
  add column if not exists return_label_purchased_at timestamptz;

comment on column public.return_requests.return_label_url is
  'Prepaid return shipping-label URL (Shippo label_url PDF). NULL until purchased; presence makes label generation idempotent.';
comment on column public.return_requests.return_tracking_number is
  'Carrier tracking number for the prepaid return label.';
comment on column public.return_requests.return_carrier is
  'Carrier/provider name for the prepaid return label (e.g. "USPS").';
comment on column public.return_requests.return_label_purchased_at is
  'Timestamp the prepaid return label was purchased via the shipping provider.';

commit;
