-- ============================================================================
-- 0012_AGENTS_EXT — extend agents + mandates for AP2-style trust layer (T3.3)
--
-- Adds to agents:
--   public_key  TEXT  — hex-encoded DER ed25519 public key
--   scopes      TEXT[] — agent-level default scopes
--   spend_limit NUMERIC(15,2) — per-window spend ceiling
--   spend_window TEXT — window duration string e.g. '24h', '7d'
--
-- Adds to mandates:
--   mandate_type TEXT — 'intent'|'cart'|'payment'
--   payload      JSONB — AP2 mandate payload
--   parent_mandate_id UUID FK(mandates) — chain linkage
--   signature    TEXT — hex-encoded ed25519 signature over canonical JSON
--   signing_key  TEXT — hex-encoded DER public key at signing time
--   expires_at   TIMESTAMPTZ — shorthand alias for valid_until (populated together)
-- ============================================================================

begin;

-- ── agents additions ──────────────────────────────────────────────────────────

alter table public.agents
  add column if not exists public_key   text,
  add column if not exists scopes       text[]       not null default '{}',
  add column if not exists spend_limit  numeric(15,2),
  add column if not exists spend_window text;          -- e.g. '24h', '7d', '30d'

comment on column public.agents.public_key   is 'Hex-encoded DER-format ed25519 public key used to verify agent-signed mandates and request signatures.';
comment on column public.agents.scopes       is 'Default permission scopes for this agent (e.g. {orders:read, checkout:write}).';
comment on column public.agents.spend_limit  is 'Maximum spend (in store currency) within spend_window. NULL = unlimited.';
comment on column public.agents.spend_window is 'Rolling window for spend enforcement, e.g. ''24h'', ''7d'', ''30d''. NULL = unlimited.';

-- ── mandates additions ────────────────────────────────────────────────────────

alter table public.mandates
  add column if not exists mandate_type      text
    check (mandate_type in ('intent', 'cart', 'payment')),
  add column if not exists payload           jsonb not null default '{}',
  add column if not exists parent_mandate_id uuid  references public.mandates(id) on delete set null,
  add column if not exists signature         text,
  add column if not exists signing_key       text,
  add column if not exists expires_at        timestamptz;

comment on column public.mandates.mandate_type      is 'AP2 mandate type: intent (natural-language scope), cart (cart_id + max_total), payment (checkout_id + amount).';
comment on column public.mandates.payload           is 'AP2-shaped mandate payload; shape depends on mandate_type.';
comment on column public.mandates.parent_mandate_id is 'Parent mandate UUID for AP2 chain: payment→cart→intent. NULL for intent roots.';
comment on column public.mandates.signature         is 'Hex-encoded ed25519 signature over the canonical JSON envelope of this mandate.';
comment on column public.mandates.signing_key       is 'Hex-encoded DER ed25519 public key used to produce the signature (snapshot at signing time).';
comment on column public.mandates.expires_at        is 'Expiry timestamp; mirrors valid_until. Set together on mandate creation.';

-- Index for chain lookups
create index if not exists idx_mandates_parent
  on public.mandates(parent_mandate_id)
  where parent_mandate_id is not null;

-- Index for type+active queries
create index if not exists idx_mandates_type_active
  on public.mandates(agent_id, mandate_type, is_active)
  where is_active and revoked_at is null;

commit;
