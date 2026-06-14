-- ============================================================================
-- 0022_agent_surface_connections — agent-surface onboarding (B7)
--
-- Stores a store's connection to an external "agent surface" — the channels
-- where AI shopping agents discover & transact products:
--   - google_merchant : Google AI shopping via Merchant Center (Content API
--                        for Shopping). Discoverable in Google's Shopping Graph.
--   - chatgpt_acp      : ChatGPT / OpenAI agentic commerce via ACP feed
--                        registration (points the surface at /acp/:storeId/feed).
--   - (future surfaces append to the surface check constraint)
--
-- Lifecycle (status):
--   disconnected → pending → connected → error
--   - pending     : OAuth/credential handshake started, not yet confirmed
--   - connected   : credentials stored, surface reachable, feed submittable
--   - error       : last submission/handshake failed (see config.last_error)
--
-- Security:
--   credentials_enc holds the AES-256-GCM-encrypted OAuth tokens / API
--   credentials (lib/secrets.encodeSecretValue with AUTH_SECRETS_KEY). Never
--   plaintext in prod.
--
-- RLS: org-gated like 0016/0019 — a store member (matching app.org_id to the
--   store's organization_id) may read/write only their own store's rows.
--   Service roles (neondb_owner / BYPASSRLS) — migrations, workers, the
--   feed-submission pipeline running under withTx with request ctx — evaluate
--   the policy via is_store_member(store_id), the same template the rest of the
--   tenant tables use.
-- ============================================================================

begin;

create table if not exists public.agent_surface_connections (
  id                  uuid        primary key default gen_random_uuid(),
  store_id            uuid        not null references public.stores(id) on delete cascade,
  surface             text        not null
                        check (surface in ('google_merchant', 'chatgpt_acp')),
  status              text        not null default 'disconnected'
                        check (status in ('disconnected', 'pending', 'connected', 'error')),
  -- External account identifier on the surface
  --   google_merchant : Merchant Center account id (merchantId)
  --   chatgpt_acp      : OpenAI merchant/seller id (or feed registration id)
  external_account_id text,
  -- AES-256-GCM encrypted credential blob (OAuth refresh token / API key JSON)
  credentials_enc     text,
  -- Surface-specific config + bookkeeping (feed_url, last_error, last_feed_*)
  config              jsonb       not null default '{}',
  last_sync_at        timestamptz,
  created_at          timestamptz not null default now(),

  -- One connection per (store, surface).
  constraint agent_surface_connections_store_surface_uniq
    unique (store_id, surface)
);

-- Primary access pattern: list/lookup all connections for a store.
create index if not exists idx_agent_surface_connections_store
  on public.agent_surface_connections (store_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.agent_surface_connections enable row level security;

-- Store members (org owners / staff in the matching org) get full access to
-- their own store's connections. is_store_member() is GUC-first + org-gated
-- (see 0019). The feed-submission pipeline runs under withTx with request ctx
-- so it evaluates this same policy.
create policy agent_surface_connections_all on public.agent_surface_connections
  for all
  using (public.is_store_member(store_id))
  with check (public.is_store_member(store_id));

comment on table public.agent_surface_connections is
  'Per-store connection to an external agent-shopping surface (Google Merchant '
  'Center / ChatGPT ACP). credentials_enc is AES-GCM via lib/secrets. config '
  'carries feed_url, last_error, last_feed_item_count, last_feed_submission_id.';

commit;
