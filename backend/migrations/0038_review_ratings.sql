-- ============================================================================
-- 0038_review_ratings — Cached aggregate ratings for product reviews.
--
-- product_reviews already carries a moderation `status`
-- (pending|approved|rejected|spam, default 'pending') from 0001_commerce, so no
-- status column is added here. This migration adds the missing moderation-queue
-- index on (product_id, status) and two cached aggregate columns on `products`
-- that reflect APPROVED reviews only:
--
--   products.avg_rating   — numeric(3,2), mean rating of approved reviews (0 when none)
--   products.review_count — int, number of approved reviews
--
-- These are denormalised caches recomputed in the service layer
-- (moderateReview / deleteReview) from the approved-review set. They let the
-- product read path surface ratings without a per-request aggregate scan.
--
-- The existing aggregates are backfilled from current approved reviews below.
--
-- Style mirrors 0036/0037 (begin/commit, if-not-exists, cartcrft_app grants
-- already cover the products/product_reviews tables via earlier migrations —
-- column additions need no new grants).
-- ============================================================================

begin;

-- ── Moderation-queue index: list reviews for a product by status ────────────
create index if not exists idx_product_reviews_product_status
  on public.product_reviews(product_id, status);

-- ── Cached aggregates on products (approved reviews only) ───────────────────
alter table public.products
  add column if not exists avg_rating   numeric(3,2) not null default 0,
  add column if not exists review_count int          not null default 0;

comment on column public.products.avg_rating
  is 'Cached mean rating of APPROVED product_reviews (0 when none). Recomputed in the catalog service on moderation/delete.';
comment on column public.products.review_count
  is 'Cached count of APPROVED product_reviews. Recomputed in the catalog service on moderation/delete.';

-- ── Backfill from existing approved reviews ─────────────────────────────────
update public.products p
set avg_rating = coalesce(agg.avg_rating, 0),
    review_count = coalesce(agg.review_count, 0)
from (
  select product_id,
         round(avg(rating)::numeric, 2) as avg_rating,
         count(*)::int                  as review_count
  from public.product_reviews
  where status = 'approved'
  group by product_id
) agg
where agg.product_id = p.id;

commit;
