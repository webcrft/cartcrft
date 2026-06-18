-- ============================================================================
-- 0043_tax_exempt — TAX-EXEMPT customers / companies.
--
-- Wave-18.1: a customer (or the B2B company they check out under) can be flagged
-- tax-exempt. When the flag is set, the checkout tax engine is SKIPPED and the
-- order's tax_total is 0 with no tax_lines. The exemption is OPT-IN per row and
-- defaults to false, so the non-exempt tax path is byte-identical — the new
-- branch only engages when tax_exempt is true.
--
-- Storage model: a boolean flag plus an optional free-text reference (the
-- certificate / resale number on file). Two columns on each of:
--   public.customers — tax_exempt + tax_exempt_ref
--   public.companies — tax_exempt + tax_exempt_ref
--
-- public.customers ALREADY carries tax_exempt (and tax_exempt_code) from
-- 0001_commerce, so the customers additions are idempotent (add-if-not-exists);
-- we add tax_exempt_ref as the certificate reference companion. public.companies
-- gains both columns (it had only tax_number).
--
-- Both tables ALREADY EXIST from 0001_commerce and are RLS-scoped per store
-- (0006_rls), so these nullable/defaulted columns inherit that tenant isolation
-- with no new policy or grant work; column additions need no new grants and
-- cartcrft_app already holds DML on both tables from the Wave-1 grant set.
-- ============================================================================

begin;

alter table public.customers
  add column if not exists tax_exempt     boolean not null default false,
  add column if not exists tax_exempt_ref text;

comment on column public.customers.tax_exempt is
  'Wave-18.1: when true, checkout computes ZERO tax for this customer (tax engine skipped). '
  'Default false keeps the non-exempt tax path byte-identical.';
comment on column public.customers.tax_exempt_ref is
  'Wave-18.1: optional exemption certificate / resale reference on file.';

alter table public.companies
  add column if not exists tax_exempt     boolean not null default false,
  add column if not exists tax_exempt_ref text;

comment on column public.companies.tax_exempt is
  'Wave-18.1: when true, any checkout under this company computes ZERO tax (tax engine skipped). '
  'Default false keeps the non-exempt tax path byte-identical.';
comment on column public.companies.tax_exempt_ref is
  'Wave-18.1: optional exemption certificate / resale reference on file.';

commit;
