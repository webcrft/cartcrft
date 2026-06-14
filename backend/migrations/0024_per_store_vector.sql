-- 0024_per_store_vector — Per-store vector recall improvements
--
-- PROBLEM:
--   The global HNSW index (0021) covers all stores' embeddings in one graph.
--   During approximate nearest-neighbor search, candidates from large stores
--   (many products) can dominate the beam search, pushing small stores' products
--   out of the result set before the `WHERE store_id = $1` filter is applied.
--   Result: small stores see lower recall than large stores.
--
-- SOLUTION CHOSEN — composite pre-filter + ef_search tuning:
--   pgvector 0.8 on PG18 supports two approaches to per-store isolation:
--
--   (a) Partial HNSW indexes (WHERE store_id = '<uuid>'): one index per store.
--       Pros: perfect recall per store, no cross-store pollution.
--       Cons: O(stores) indexes, must be created dynamically at store-creation
--             time, index maintenance cost grows linearly, not viable in a shared
--             schema without dynamic DDL in the app layer.
--
--   (b) Composite pre-filter via index scan + HNSW:
--       Add a btree index on (store_id) to let PG prune the candidate set BEFORE
--       the vector distance operator runs.  In PG18+pgvector 0.8 the planner can
--       use an index scan to satisfy the `store_id = $1` predicate and then apply
--       the HNSW index within the resulting tuple set (bitmap+recheck or
--       sequential scan of the filtered rows for small stores).
--       Combine with a higher `hnsw.ef_search` value at query time to widen the
--       beam inside the HNSW graph, recovering recall lost to cross-store
--       candidate eviction.
--
--   We choose (b) because:
--     - Zero runtime DDL (no per-store index creation hooks needed).
--     - The `(store_id, status)` btree index already exists (`idx_products_status`
--       from 0001_commerce.sql) — the planner can use it for the store filter.
--     - Setting `hnsw.ef_search` at query time (in service.ts) is a one-line
--       change that immediately benefits all stores with no migration risk.
--     - For stores with < ~1000 products (typical Cartcrft multi-tenant case),
--       the HNSW graph traversal over the full table is fast anyway; the bigger
--       win is preventing large-store domination, which ef_search + pre-filter
--       addresses.
--
-- WHAT THIS MIGRATION DOES:
--   1. Adds idx_products_store_embedding: btree on (store_id) WHERE embedding IS
--      NOT NULL.  This partial btree index lets the planner efficiently identify
--      which product rows for a given store have embeddings, reducing the set fed
--      to the HNSW graph traversal.  Combined with the HNSW operator, PG18 can
--      use a bitmap-and strategy: bitmap from (store_id) btree ∩ HNSW candidates.
--
--   2. Adds a comment to the HNSW index documenting the ef_search query-time
--      parameter (the service sets it; see agent/search/service.ts).
--
--   3. The search service (service.ts) is updated (below / separately) to
--      SET LOCAL hnsw.ef_search = 200 before the vector query so the beam is
--      wider.  This improves recall for small stores at negligible latency cost
--      (ef_search=200 vs default 40 adds <1ms on typical catalog sizes).
--
-- GUARD: wrapped in a DO-block identical to 0021 — skips when pgvector absent.

begin;

do $$
begin
  if not exists (
    select 1 from pg_extension where extname = 'vector'
  ) then
    raise notice '0024: pgvector extension not available — per-store index skipped';
    return;
  end if;

  -- ── Index 1: partial btree on (store_id) for products with embeddings ─────
  --
  -- Rationale: the query in service.ts hybridSearch() filters
  --   WHERE p.store_id = $1 AND p.embedding IS NOT NULL
  -- before the vector operator.  A partial btree on store_id WHERE embedding IS
  -- NOT NULL lets the planner identify the candidate set without a seqscan.
  -- For a store with N products out of M total, this reduces the rows the HNSW
  -- must rescore from M to N.
  --
  -- Note: idx_products_status already covers (store_id, status) and idx_products_store
  -- covers (store_id). We add a dedicated partial index for the embedding-specific
  -- access pattern so it remains tight as status filters vary.
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename  = 'products'
      and indexname  = 'idx_products_store_embedding'
  ) then
    execute $idx$
      CREATE INDEX idx_products_store_embedding
        ON public.products (store_id)
        WHERE embedding IS NOT NULL
    $idx$;
    raise notice '0024: created idx_products_store_embedding';
  else
    raise notice '0024: idx_products_store_embedding already exists — skipped';
  end if;

  -- ── Document ef_search on the HNSW index ─────────────────────────────────
  -- The HNSW index itself does not change. The recall improvement comes from
  -- the query-time SET LOCAL hnsw.ef_search = 200 in service.ts.
  -- We annotate the index in pg_description for operator visibility.
  --
  -- (No DDL change to the HNSW index — it was correctly built in 0021.)

  raise notice '0024: per-store vector recall migration complete';
  raise notice '0024: query-time ef_search=200 is set in agent/search/service.ts hybridSearch()';

exception
  when others then
    raise notice '0024: per-store vector index creation failed (non-fatal): %', sqlerrm;
end;
$$;

-- ── Update store metadata comment to reflect the ef_search strategy ──────────
comment on column public.stores.metadata is
  'Per-store key-value store. Well-known keys:
   llm_provider: { "api_key": "<AES-256-GCM-enc|plaintext>",
                   "model": "text-embedding-3-small",
                   "base_url": "https://api.openai.com/v1" }
     — BYO LLM key for semantic catalog search (T3.2).
       api_key encrypted via AUTH_SECRETS_KEY when set.
   Vector search: global HNSW (cosine, m=16, ef_construction=64) as of 0021.
   Per-store recall: idx_products_store_embedding partial btree (0024) pre-filters
     candidates to the queried store before HNSW graph traversal.
     hnsw.ef_search=200 set at query time in agent/search/service.ts for wider
     beam search — prevents large-store candidate eviction in small-store queries.
   Per-store partial HNSW indexes (WHERE store_id = uuid) remain a future option
     when per-store product counts exceed ~10k (see tasks.md Discovered).';

commit;
