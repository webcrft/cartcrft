-- 0023_analytics_partition — Convert analytics_events to RANGE partitioning by month
--
-- WHY PARTITION:
--   analytics_events grows unbounded as event volume scales. Month-level range
--   partitions enable:
--     - Fast partition pruning: queries with `occurred_at BETWEEN $start AND $end`
--       only scan relevant month partitions.
--     - Cheap bulk retention: DROP TABLE on an old partition is near-instant vs
--       DELETE on a large unpartitioned table.
--     - Index locality: each partition's btree is smaller → better cache hit.
--
-- STRATEGY — new-table + copy + rename swap (safe for live tables):
--   PostgreSQL has no `ALTER TABLE ... PARTITION BY` for live tables.
--   The approach (all within one DO-block):
--     1. Create analytics_events_partitioned PARTITION BY RANGE (occurred_at).
--     2. Create DEFAULT partition + current month + next month partitions.
--     3. Copy existing rows into the new table (INSERT INTO ... SELECT).
--     4. Drop old indexes from the original table (name collision prevention).
--     5. Create indexes on the new partitioned parent.
--     6. Apply RLS policies + FK constraints on new table.
--     7. Rename analytics_events → analytics_events_old (archive).
--     8. Rename analytics_events_partitioned → analytics_events (live).
--   The old table stays as analytics_events_old for a safe rollback window.
--
--   PK note: partitioned tables require the partition key (occurred_at) in any
--   PRIMARY KEY / UNIQUE constraint. We change the PK to (id, occurred_at).
--   Since `id` is gen_random_uuid() it is still globally unique.
--
--   FK references: analytics_events has two nullable FK columns (order_id,
--   customer_id) with ON DELETE SET NULL. FKs on a partitioned table parent
--   are fully supported in PG12+.
--
--   Idempotency: if analytics_events is already a partitioned table
--   (relkind = 'p') the DO-block body is skipped.
--
-- MAINTENANCE FUNCTION: public.create_analytics_month_partition(year, month)
--   Creates the partition for the given month if it does not already exist.
--   Idempotent. The app worker should call this at the start of each month
--   (or proactively for the next month) to ensure inserts never land in the
--   DEFAULT partition.
--
--   Example (worker / pg_cron):
--     SELECT public.create_analytics_month_partition(
--       date_part('year',  now() + '1 month'::interval)::int,
--       date_part('month', now() + '1 month'::interval)::int
--     );
--
-- COMPATIBILITY:
--   The analytics query routes (analytics/routes.ts) query the parent table
--   `analytics_events` unchanged — Postgres routes queries through the parent
--   to partitions transparently. No route changes required.
--   refresh_analytics_daily_rollup() and purge_analytics_events() (from 0020)
--   also query the parent and continue to work unchanged.

-- ── Maintenance function (top-level for schema-rewrite compatibility) ─────────
--
-- Created unconditionally (CREATE OR REPLACE) — safe to run whether or not the
-- partitioned table exists yet. Targets the analytics_events parent table by
-- name so it works after the rename swap below.

create or replace function public.create_analytics_month_partition(
  p_year  int,
  p_month int
)
returns text
language plpgsql
as $$
declare
  v_name  text;
  v_start text;
  v_end   text;
begin
  v_name  := format('analytics_events_%s_%s',
                    lpad(p_year::text,  4, '0'),
                    lpad(p_month::text, 2, '0'));
  v_start := format('%s-%s-01',
                    lpad(p_year::text,  4, '0'),
                    lpad(p_month::text, 2, '0'));
  v_end   := to_char(
               (to_date(v_start, 'YYYY-MM-DD') + interval '1 month'),
               'YYYY-MM-DD'
             );

  if exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = v_name
      and n.nspname = (select nspname from pg_namespace
                       where oid = (select relnamespace from pg_class
                                    where relname = 'analytics_events' limit 1))
  ) then
    return v_name || ' (already exists)';
  end if;

  execute format(
    $ddl$CREATE TABLE public.%I
           PARTITION OF public.analytics_events
           FOR VALUES FROM (%L) TO (%L)$ddl$,
    v_name, v_start, v_end
  );

  raise notice 'create_analytics_month_partition: created %', v_name;
  return v_name;
end;
$$;

comment on function public.create_analytics_month_partition(int, int) is
  'Create a monthly analytics_events partition for the given year/month if it '
  'does not already exist. Idempotent — returns the partition name. '
  'Call proactively each month (worker cron or pg_cron): '
  '  SELECT create_analytics_month_partition( '
  '    date_part(''year'',  now() + ''1 month''::interval)::int, '
  '    date_part(''month'', now() + ''1 month''::interval)::int);';

-- ── Main partitioning DO-block ────────────────────────────────────────────────

do $$
declare
  v_relkind   char;
  v_cur_year  int;
  v_cur_month int;
  v_nxt_year  int;
  v_nxt_month int;
  v_cur_start text;
  v_cur_end   text;
  v_nxt_start text;
  v_nxt_end   text;
  v_cur_name  text;
  v_nxt_name  text;
begin
  -- ── Guard: skip if analytics_events is already partitioned ───────────────
  select relkind into v_relkind
  from pg_class
  where relname = 'analytics_events'
    and relnamespace = (select oid from pg_namespace where nspname = current_schema());

  if v_relkind = 'p' then
    raise notice '0023: analytics_events already partitioned — skipping';
    return;
  end if;

  if v_relkind is null then
    raise notice '0023: analytics_events table not found — skipping';
    return;
  end if;

  -- ── Step 1: Create the new partitioned table ──────────────────────────────
  -- PK includes occurred_at because partitioned tables require the partition
  -- key in any PRIMARY KEY / UNIQUE constraint.
  execute $sql$
    CREATE TABLE public.analytics_events_partitioned (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      site_id     uuid        NOT NULL,
      session_id  uuid        NOT NULL DEFAULT gen_random_uuid(),
      event_type  text        NOT NULL DEFAULT 'ecommerce',
      event_name  text        NOT NULL,
      properties  jsonb       NOT NULL DEFAULT '{}',
      order_id    uuid,
      customer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      timestamp   timestamptz NOT NULL DEFAULT now(),
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at)
  $sql$;

  raise notice '0023: created analytics_events_partitioned';

  -- ── Step 2a: DEFAULT partition ────────────────────────────────────────────
  execute $sql$
    CREATE TABLE public.analytics_events_default
      PARTITION OF public.analytics_events_partitioned
      DEFAULT
  $sql$;

  raise notice '0023: created analytics_events_default partition';

  -- ── Step 2b: Current month + next month partitions ────────────────────────
  v_cur_year  := date_part('year',  now())::int;
  v_cur_month := date_part('month', now())::int;
  v_cur_name  := format('analytics_events_%s_%s',
                        lpad(v_cur_year::text, 4, '0'),
                        lpad(v_cur_month::text, 2, '0'));
  v_cur_start := format('%s-%s-01',
                        lpad(v_cur_year::text, 4, '0'),
                        lpad(v_cur_month::text, 2, '0'));
  v_cur_end   := to_char(
                   to_date(v_cur_start, 'YYYY-MM-DD') + interval '1 month',
                   'YYYY-MM-DD'
                 );

  v_nxt_year  := date_part('year',  to_date(v_cur_start, 'YYYY-MM-DD') + interval '1 month')::int;
  v_nxt_month := date_part('month', to_date(v_cur_start, 'YYYY-MM-DD') + interval '1 month')::int;
  v_nxt_name  := format('analytics_events_%s_%s',
                        lpad(v_nxt_year::text, 4, '0'),
                        lpad(v_nxt_month::text, 2, '0'));
  v_nxt_start := v_cur_end;
  v_nxt_end   := to_char(
                   to_date(v_nxt_start, 'YYYY-MM-DD') + interval '1 month',
                   'YYYY-MM-DD'
                 );

  execute format(
    $ddl$CREATE TABLE public.%I
           PARTITION OF public.analytics_events_partitioned
           FOR VALUES FROM (%L) TO (%L)$ddl$,
    v_cur_name, v_cur_start, v_cur_end
  );
  raise notice '0023: created current-month partition %', v_cur_name;

  execute format(
    $ddl$CREATE TABLE public.%I
           PARTITION OF public.analytics_events_partitioned
           FOR VALUES FROM (%L) TO (%L)$ddl$,
    v_nxt_name, v_nxt_start, v_nxt_end
  );
  raise notice '0023: created next-month partition %', v_nxt_name;

  -- ── Step 3: Copy existing rows ────────────────────────────────────────────
  execute $sql$
    INSERT INTO public.analytics_events_partitioned
      (id, site_id, session_id, event_type, event_name, properties,
       order_id, customer_id, occurred_at, timestamp, created_at)
    SELECT
      id, site_id, session_id, event_type, event_name, properties,
      order_id, customer_id, occurred_at, timestamp, created_at
    FROM public.analytics_events
  $sql$;

  raise notice '0023: copied existing rows';

  -- ── Step 4: Drop old indexes (name-collision prevention) ──────────────────
  -- Index names are schema-global — drop from the old table before recreating
  -- on the new one to avoid "already exists" errors.
  execute 'DROP INDEX IF EXISTS public.idx_analytics_events_site_type_ts';
  execute 'DROP INDEX IF EXISTS public.idx_analytics_events_site_name_ts';
  execute 'DROP INDEX IF EXISTS public.idx_analytics_events_occurred_at';

  raise notice '0023: dropped old indexes from analytics_events';

  -- ── Step 5: Create indexes on the new partitioned parent ──────────────────
  -- Indexes on the parent propagate to all current and future child partitions.
  execute $sql$
    CREATE INDEX idx_analytics_events_site_type_ts
      ON public.analytics_events_partitioned (site_id, event_type, timestamp)
  $sql$;

  execute $sql$
    CREATE INDEX idx_analytics_events_site_name_ts
      ON public.analytics_events_partitioned (site_id, event_name, timestamp)
  $sql$;

  execute $sql$
    CREATE INDEX idx_analytics_events_occurred_at
      ON public.analytics_events_partitioned (occurred_at)
  $sql$;

  raise notice '0023: created indexes on partitioned parent';

  -- ── Step 6: RLS on the new table ─────────────────────────────────────────
  execute $sql$
    ALTER TABLE public.analytics_events_partitioned ENABLE ROW LEVEL SECURITY
  $sql$;

  execute $sql$
    CREATE POLICY analytics_events_select ON public.analytics_events_partitioned
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1
          FROM public.stores s
          WHERE s.id = analytics_events_partitioned.site_id
            AND s.organization_id::text = current_setting('app.org_id', true)
        )
      )
  $sql$;

  execute $sql$
    CREATE POLICY analytics_events_insert ON public.analytics_events_partitioned
      FOR INSERT
      WITH CHECK (true)
  $sql$;

  raise notice '0023: applied RLS on partitioned table';

  -- ── Step 7: FK constraints on new table ──────────────────────────────────
  execute $sql$
    ALTER TABLE public.analytics_events_partitioned
      ADD CONSTRAINT analytics_events_order_id_fkey
        FOREIGN KEY (order_id)    REFERENCES public.orders(id)    ON DELETE SET NULL,
      ADD CONSTRAINT analytics_events_customer_id_fkey
        FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL
  $sql$;

  raise notice '0023: added FK constraints';

  -- ── Step 8: Grant cartcrft_app on new table ───────────────────────────────
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    execute $sql$
      GRANT SELECT, INSERT, UPDATE, DELETE
        ON public.analytics_events_partitioned TO cartcrft_app
    $sql$;
  end if;

  -- ── Step 9: Atomic rename swap ────────────────────────────────────────────
  execute 'ALTER TABLE public.analytics_events RENAME TO analytics_events_old';
  execute 'ALTER TABLE public.analytics_events_partitioned RENAME TO analytics_events';

  raise notice '0023: rename swap complete — analytics_events is now partitioned';

  -- Archive read access.
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    execute 'GRANT SELECT ON public.analytics_events_old TO cartcrft_app';
  end if;

end;
$$;

-- ── Table comment ─────────────────────────────────────────────────────────────

comment on table public.analytics_events is
  'Ecommerce analytics events — RANGE-partitioned by occurred_at (monthly). '
  'site_id = store_id (no sites table in Cartcrft). '
  'Standard event names: product_viewed, add_to_cart, remove_from_cart, '
  'checkout_started, order_completed, order_refunded. '
  'Partitions: analytics_events_YYYY_MM (monthly) + analytics_events_default. '
  'Maintenance: call create_analytics_month_partition(year, month) at the start '
  'of each new month so the correct partition exists before inserts arrive. '
  'Archive: analytics_events_old (unpartitioned; safe to DROP after validation).';

-- ── Grant function execute to cartcrft_app ────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'cartcrft_app') then
    execute 'GRANT EXECUTE ON FUNCTION public.create_analytics_month_partition(int, int) TO cartcrft_app';
  end if;
end;
$$;
