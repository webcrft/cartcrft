-- 0021_hnsw_vector_index
--
-- Replace the global IVFFlat vector index (0011_search.sql) with an HNSW index.
--
-- WHY HNSW:
--   IVFFlat (lists=100, probes=1) has two problems at scale:
--     1. Low recall for small per-store catalogs: IVFFlat partitions the vector
--        space into `lists` Voronoi cells; with probes=1 only 1 cell is searched.
--        For stores with < ~1000 products the quantisation boundaries are close
--        to random → recall degrades badly.
--     2. Global index: a single index covers all stores; there is no per-store
--        locality. A query for store A searches the entire embedding space and
--        then filters — unnecessary work.
--
-- HNSW advantages:
--   - No `lists` tuning — works well across a wide range of dataset sizes.
--   - Higher recall at same or better query latency for the typical catalog size
--     (hundreds to tens of thousands of vectors per store).
--   - `ef_search` is a query-time parameter, not an index-time commitment.
--
-- Per-store partial indexes:
--   The store_id column on products lets us create a partial index
--   (WHERE store_id = '<uuid>') for each store. At scale this is the best
--   approach — each store's index is small and recall is near-perfect.
--   However, partial HNSW indexes must be created dynamically as stores are
--   added. For now we create a single global HNSW index (replacing IVFFlat)
--   which is a significant improvement. Per-store index creation is logged in
--   tasks.md Discovered for follow-up.
--
-- Guard: wrapped in a DO-block identical to 0011, so the migration applies
-- cleanly when pgvector is absent (the index is simply not created; search
-- falls back to sequential scan).

begin;

do $$
begin
  if exists (
    select 1 from pg_extension where extname = 'vector'
  ) then
    -- Drop the old IVFFlat index if it exists.
    -- IF EXISTS is not supported in older Postgres for DROP INDEX; use
    -- a DO-block query approach to check first.
    if exists (
      select 1
      from pg_indexes
      where schemaname = 'public'
        and tablename  = 'products'
        and indexname  = 'idx_products_embedding_cosine'
    ) then
      execute 'DROP INDEX public.idx_products_embedding_cosine';
      raise notice 'Dropped old IVFFlat index idx_products_embedding_cosine';
    end if;

    -- Create HNSW index for cosine distance.
    -- m=16 (default): max neighbors per node — good balance of build time vs recall.
    -- ef_construction=64 (default): beam width during index build.
    -- Both can be tuned at query time via SET hnsw.ef_search = N;
    execute $idx$
      CREATE INDEX IF NOT EXISTS idx_products_embedding_hnsw_cosine
        ON public.products
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    $idx$;
    raise notice 'Created HNSW index idx_products_embedding_hnsw_cosine';

  else
    raise notice 'pgvector extension not available — HNSW index creation skipped';
  end if;

exception
  when others then
    raise notice 'HNSW index creation failed (non-fatal): %', sqlerrm;
end;
$$;

-- Update the comment on stores.metadata to note the HNSW upgrade.
comment on column public.stores.metadata is
  'Per-store key-value store. Well-known keys:
   llm_provider: { "api_key": "<AES-256-GCM-enc|plaintext>",
                   "model": "text-embedding-3-small",
                   "base_url": "https://api.openai.com/v1" }
     — BYO LLM key for semantic catalog search (T3.2).
       api_key encrypted via AUTH_SECRETS_KEY when set.
   Vector search index: HNSW (cosine, m=16, ef_construction=64) as of 0021.
   Per-store partial indexes are a planned follow-up (see tasks.md Discovered).';

commit;
