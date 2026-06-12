-- ============================================================================
-- 0011_SEARCH — semantic catalog search indexes + GIN full-text index
--
-- Adds:
--   • GIN full-text index on products (title + description) for websearch_to_tsquery
--   • IVFFlat index on products.embedding for fast ANN search (pgvector)
--     Guard-blocked: only created when pgvector extension is available.
--   • COMMENT on stores.metadata documenting llm_provider JSON shape
--
-- pgvector IVFFlat notes:
--   ivfflat with lists=100 is appropriate for up to ~1M vectors per store;
--   revisit with HNSW for larger catalogs.
--   This index is a PERFORMANCE optimisation — search works (slower) without it.
-- ============================================================================

begin;

-- Full-text GIN index on product title + description.
-- Using a functional index on to_tsvector avoids a stored column.
create index if not exists idx_products_fts
  on public.products
  using gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')));

-- pgvector cosine-distance index.
-- Wrapped in DO-block: if pgvector is not installed the index is skipped
-- without aborting the migration — vectors stay scannable via seq-scan.
do $$
begin
  if exists (
    select 1 from pg_extension where extname = 'vector'
  ) then
    execute $idx$
      create index if not exists idx_products_embedding_cosine
        on public.products
        using ivfflat (embedding vector_cosine_ops)
        with (lists = 100)
    $idx$;
  end if;
exception
  when others then
    raise notice 'pgvector index creation skipped: %', sqlerrm;
end;
$$;

-- Document the llm_provider key shape in stores.metadata.
comment on column public.stores.metadata is
  'Per-store key-value store. Well-known keys:
   llm_provider: { "api_key": "<AES-256-GCM-enc|plaintext>",
                   "model": "text-embedding-3-small",
                   "base_url": "https://api.openai.com/v1" }
     — BYO LLM key for semantic catalog search (T3.2).
       api_key encrypted via AUTH_SECRETS_KEY when set.';

commit;
