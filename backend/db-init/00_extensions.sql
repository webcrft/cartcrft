-- Database initialization: enable required extensions.
-- This script runs once when the Postgres container is first created
-- (via /docker-entrypoint-initdb.d/).  It is safe to run again (IF NOT EXISTS).

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_bytes() / gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector semantic search (pre-installed in pgvector image)
