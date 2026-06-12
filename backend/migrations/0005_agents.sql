-- ============================================================================
-- 0005_AGENTS — agent-native tables (new, no webcrft source)
--
-- Cartcrft is "agent-native from the data model up". These tables represent
-- autonomous agents that act on behalf of stores, the mandates (scoped
-- capabilities) they are granted, and a full audit trail.
--
-- Design principles:
--   • Agents belong to a store (or optionally an org)
--   • Mandates are capability grants with optional expiry and rate limits
--   • agent_audit_log is append-only (no UPDATE/DELETE via RLS)
--   • All money columns use numeric(15,2)
--   • RLS applied in 0006_rls.sql
-- ============================================================================

begin;

-- ============================================================================
-- 1. AGENTS
-- ============================================================================

create table public.agents (
  id              uuid        primary key default gen_random_uuid(),
  store_id        uuid        not null references public.stores(id) on delete cascade,
  name            text        not null,
  slug            text        not null,
  description     text,
  -- Agent type drives how the agent is invoked
  agent_type      text        not null default 'webhook'
                    check (agent_type in (
                      'webhook',          -- POSTed to an external URL
                      'internal',         -- runs inside the cartcrft worker pool
                      'mcp',              -- exposed as an MCP tool
                      'scheduled',        -- cron-triggered
                      'event_driven'      -- fires on domain events
                    )),
  -- Auth & transport
  endpoint_url    text,                   -- for webhook / MCP agents
  auth_type       text        not null default 'bearer'
                    check (auth_type in ('bearer','hmac','api_key','none')),
  auth_secret     text,                   -- AES-256-GCM ciphertext when at rest
  -- Invocation settings
  timeout_ms      int         not null default 30000,
  max_retries     int         not null default 3,
  retry_backoff_ms int        not null default 1000,
  -- Scheduling (for scheduled / event_driven agents)
  cron_expression text,                   -- standard 5-field cron, e.g. '0 * * * *'
  event_triggers  text[]      not null default '{}',   -- domain event names
  -- Status
  status          text        not null default 'active'
                    check (status in ('active','paused','error','disabled')),
  last_invoked_at timestamptz,
  last_error      text,
  -- Metadata
  config          jsonb       not null default '{}',
  metadata        jsonb       not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique(store_id, slug)
);

comment on table  public.agents                  is 'Autonomous agents registered for a store. Can be webhook-based, MCP tools, scheduled jobs, or event-driven processors.';
comment on column public.agents.agent_type       is 'Invocation model: webhook=outbound POST, internal=worker thread, mcp=MCP protocol, scheduled=cron, event_driven=domain event subscriber.';
comment on column public.agents.auth_secret      is 'AES-256-GCM ciphertext of the shared secret used to authenticate outbound requests to the agent.';
comment on column public.agents.cron_expression  is '5-field cron expression for scheduled agents (evaluated in UTC).';
comment on column public.agents.event_triggers   is 'Domain event names that trigger event_driven agents, e.g. {order.created, payment.captured}.';

create index idx_agents_store  on public.agents(store_id);
create index idx_agents_status on public.agents(store_id, status);
create index idx_agents_type   on public.agents(store_id, agent_type);

create trigger agents_updated_at
  before update on public.agents
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 2. MANDATES
-- ============================================================================
-- A mandate is a scoped capability grant given to an agent.
-- Unlike a simple API key (which grants access), a mandate is a named,
-- auditable permission with optional constraints (rate limit, expiry,
-- restricted to a resource type/ID, etc.).

create table public.mandates (
  id              uuid        primary key default gen_random_uuid(),
  agent_id        uuid        not null references public.agents(id) on delete cascade,
  store_id        uuid        not null references public.stores(id) on delete cascade,
  name            text        not null,
  -- What the agent is allowed to do
  scopes          text[]      not null default '{}'
                    check (array_length(scopes, 1) > 0),
  -- Resource-level restriction (optional)
  resource_type   text,                   -- e.g. 'order', 'product', 'customer'
  resource_ids    uuid[]      not null default '{}',   -- empty = all resources of type
  -- Rate limiting
  rate_limit_rpm  int,                    -- max requests per minute; null = unlimited
  -- Validity
  valid_from      timestamptz not null default now(),
  valid_until     timestamptz,
  -- Status
  is_active       boolean     not null default true,
  revoked_at      timestamptz,
  revoke_reason   text,
  -- Metadata
  metadata        jsonb       not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- An agent may hold at most one active mandate per name per store
  unique(agent_id, store_id, name)
);

comment on table  public.mandates               is 'Scoped capability grants for agents. Each mandate names what an agent can do, for which resource types, and for how long.';
comment on column public.mandates.scopes        is 'Permission scopes granted by this mandate, e.g. {orders:read, fulfillment:write, inventory:adjust}.';
comment on column public.mandates.resource_type is 'Optional resource type restriction, e.g. "order" means the mandate is only valid for order-related actions.';
comment on column public.mandates.resource_ids  is 'Specific resource UUIDs the mandate is restricted to. Empty array means all resources of resource_type.';
comment on column public.mandates.rate_limit_rpm is 'Max invocations per minute across all scopes. NULL = unlimited.';
comment on column public.mandates.valid_until   is 'Expiry timestamp. NULL = never expires. Expired mandates are treated as revoked.';

create index idx_mandates_agent   on public.mandates(agent_id);
create index idx_mandates_store   on public.mandates(store_id);
create index idx_mandates_active  on public.mandates(agent_id, is_active)
  where is_active and revoked_at is null;

create trigger mandates_updated_at
  before update on public.mandates
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 3. AGENT AUDIT LOG
-- ============================================================================
-- Append-only record of every action an agent took under a mandate.
-- Rows are never updated or deleted (enforced by RLS in 0006_rls.sql).

create table public.agent_audit_log (
  id              uuid        primary key default gen_random_uuid(),
  agent_id        uuid        not null references public.agents(id)   on delete cascade,
  mandate_id      uuid        references public.mandates(id)          on delete set null,
  store_id        uuid        not null references public.stores(id)   on delete cascade,
  -- What happened
  action          text        not null,           -- e.g. 'order.fulfillment.created', 'product.updated'
  resource_type   text,                           -- e.g. 'order', 'product', 'customer'
  resource_id     uuid,                           -- affected resource UUID
  -- Request / response snapshot
  request_payload jsonb       not null default '{}',
  response_payload jsonb      not null default '{}',
  -- Outcome
  status          text        not null default 'success'
                    check (status in ('success','failure','partial','timeout','rate_limited','unauthorized')),
  error_message   text,
  duration_ms     int,
  -- Context
  ip_address      inet,
  correlation_id  text,       -- trace/correlation ID for distributed tracing
  -- Timestamp (no updated_at — append-only)
  created_at      timestamptz not null default now()
);

comment on table  public.agent_audit_log                 is 'Append-only audit trail for every agent invocation. Never updated or deleted. Retained indefinitely by default; purge policy set per deployment.';
comment on column public.agent_audit_log.action          is 'Dotted namespace of the action taken, e.g. orders.fulfillment.created, products.price.updated.';
comment on column public.agent_audit_log.request_payload is 'Snapshot of the data sent with the action (sensitive fields should be redacted by the agent before logging).';
comment on column public.agent_audit_log.correlation_id  is 'Distributed trace ID for correlating agent actions across microservices.';

create index idx_agent_audit_log_agent     on public.agent_audit_log(agent_id,    created_at desc);
create index idx_agent_audit_log_store     on public.agent_audit_log(store_id,    created_at desc);
create index idx_agent_audit_log_mandate   on public.agent_audit_log(mandate_id)
  where mandate_id is not null;
create index idx_agent_audit_log_resource  on public.agent_audit_log(resource_type, resource_id)
  where resource_id is not null;
create index idx_agent_audit_log_status    on public.agent_audit_log(store_id, status)
  where status != 'success';
create index idx_agent_audit_log_action    on public.agent_audit_log(store_id, action, created_at desc);

commit;
