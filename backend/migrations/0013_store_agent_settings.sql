-- 0013_store_agent_settings.sql
-- Per-store agent mandate settings.
--
-- agents_require_mandate: when true, agent-attributed checkout completions
-- REQUIRE a valid payment mandate chain for the checkout. When false (default),
-- spend limits are enforced if a mandate exists, but a mandate is not required.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS agents_require_mandate boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN stores.agents_require_mandate IS
  'When true, agent-attributed checkout completions require a valid payment mandate chain.';
