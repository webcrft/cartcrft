---
title: "Agent-Native Commerce"
description: "Cartcrft is designed from the data model up for agent-driven commerce. This doc"
# TODO(docs-agent): refine title, description, sidebar label, and ordering
---

# Agent-Native Commerce

Cartcrft is designed from the data model up for agent-driven commerce. This doc
covers the four agent surfaces: the MCP server, semantic search, the ACP adapter,
and the mandate / trust layer.

---

## MCP server

Every Cartcrft store exposes a Model Context Protocol (MCP) server. Any
MCP-capable agent — Claude Desktop, Claude Code, a custom LLM agent — can
browse and buy from the store using the tools described in
[mcp/README.md](../mcp/README.md).

### Transports

**HTTP/SSE (recommended for production)**

```
POST/GET/DELETE https://<host>/mcp/<storeId>
Authorization: Bearer <cc_pub_ or cc_prv_>
```

**stdio (local dev / Claude Desktop)**

```bash
pnpm mcp:stdio
# requires DATABASE_URL, CARTCRFT_STORE_ID, CARTCRFT_API_KEY in .env
```

### Tool catalog

| Tool | Scope | Description |
|------|-------|-------------|
| `search_products` | `commerce:read` | Hybrid semantic + full-text search |
| `get_product` | `commerce:read` | Fetch a product by UUID with all variants |
| `create_cart` | `commerce:read` | Create an empty cart |
| `add_to_cart` | `commerce:write` | Add a variant (increments qty on duplicate) |
| `get_cart` | `commerce:read` | Cart with lines and unit prices |
| `start_checkout` | `commerce:write` | Convert cart → checkout; calculates tax + shipping |
| `update_checkout` | `commerce:write` | Apply discount code, update addresses |
| `complete_checkout` | `commerce:write` | Place order (test mode needs no payment credentials) |
| `get_order_status` | `commerce:read` | Order with financial + fulfillment status |

Full connection instructions and a 9-step scripted purchase walkthrough (with
verified tool-call transcripts) are in
[quickstart-mcp.md](./quickstart-mcp.md).

---

## Semantic search

The `/search` endpoint is designed for natural-language agent queries.

```bash
curl -s \
  -H "Authorization: Bearer <cc_pub_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/search?q=warm+merino+hoodie+for+hiking&limit=5"
```

### Ranking

When a BYO LLM key is configured (see [byo-keys.md](./byo-keys.md)):

1. Query embedding computed via the store's LLM provider.
2. Vector candidates: top-N by pgvector cosine similarity (`<=>` operator).
3. Full-text candidates: top-N by Postgres `websearch_to_tsquery ts_rank_cd`.
4. Both lists merged via **Reciprocal Rank Fusion** (RRF, k=60).
5. Filters applied in SQL before ranking: `price_min`, `price_max`,
   `collection_id`, `in_stock`.

Without a LLM key, step 1–2 are skipped and the result is full-text only.

### Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | Search query (natural language or keyword) |
| `limit` | int 1–100 | Max results (default 10) |
| `price_min` | decimal string | Minimum variant price |
| `price_max` | decimal string | Maximum variant price |
| `collection_id` | UUID | Restrict to a collection |
| `in_stock` | boolean | Only return products with available inventory |

### Example agent search

```bash
# Find in-stock wool clothing under $100
curl -s \
  -H "Authorization: Bearer <cc_pub_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/search?q=wool+knitwear&in_stock=true&price_max=100&limit=5" \
  | jq '.results[] | {title, relevance_score}'
```

---

## ACP adapter

The Agentic Commerce Protocol (ACP) adapter provides a versioned, isolated API
surface for agentic checkout flows. Spec churn never touches core commerce
modules.

Full documentation including field mapping and known divergences:
[acp.md](./acp.md)

Quick reference:

| Endpoint | Description |
|----------|-------------|
| `GET /acp/:storeId/feed` | Paginated product feed in ACP shape |
| `POST /acp/:storeId/checkout_sessions` | Create agentic checkout session |
| `GET /acp/:storeId/checkout_sessions/:id` | Get session |
| `POST /acp/:storeId/checkout_sessions/:id` | Update buyer info / fulfillment |
| `POST /acp/:storeId/checkout_sessions/:id/complete` | Complete (test mode) |

The adapter is date-versioned. An explicit version path (`/acp/v2026-04/...`)
and an unversioned alias (`/acp/...`) are both mounted. The `ACP-Version: 2026-04`
header is returned on all responses.

---

## Agent registry

Agents are registered per store. Each agent gets an ed25519 keypair on creation
— the private key is returned once and never stored.

### Register an agent

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Shopping Assistant",
    "agent_type": "mcp",
    "scopes": ["commerce:read", "commerce:write"],
    "spend_limit": "500.00",
    "spend_window": "24h"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/agents"
```

Response includes `private_key_pem` — save it. It is not stored and cannot be
retrieved.

### Agent attribution

When an agent makes API requests it should include attribution headers:

```
X-Cartcrft-Agent:     <agent-id>
X-Cartcrft-Signature: <ed25519 signature>
X-Cartcrft-Timestamp: <unix timestamp>
```

The signature covers `METHOD + path + sha256(body) + timestamp`. The server
validates the signature and enforces a 5-minute replay window. Agent context is
attached to the request and used for spend limit enforcement and audit logging.

### Agent fields

| Field | Type | Description |
|-------|------|-------------|
| `agent_type` | enum | `webhook`, `internal`, `mcp`, `scheduled`, `event_driven` |
| `scopes` | string[] | e.g. `["commerce:read", "commerce:write"]` |
| `spend_limit` | decimal string | Max spend per `spend_window` (e.g. `"500.00"`) |
| `spend_window` | string | Duration: `"24h"`, `"7d"`, etc. |
| `public_key` | hex string | DER-encoded ed25519 public key (stored; verify against) |

---

## Mandates — intent → cart → payment chain

Mandates are verifiable consent records that form a chain: intent → cart →
payment. Each mandate is ed25519-signed by the agent and stored in the
`mandates` table. The chain is verified before checkout completion when an
agent context is present.

### Mandate types

| Type | When created | Parent |
|------|-------------|--------|
| `intent` | Agent expresses purchase intent | none |
| `cart` | Cart created under an intent | intent mandate |
| `payment` | Payment authorised | cart mandate |

### Create a mandate

```bash
# 1. Create an intent mandate
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "mandate_type": "intent",
    "scopes": ["commerce:read", "commerce:write"],
    "payload": { "intent": "buy merino hoodie", "max_price": "100.00" },
    "expires_at": "2026-06-13T00:00:00Z"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/agents/<AGENT_ID>/mandates"

# 2. Create a cart mandate (parent = intent mandate)
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "mandate_type": "cart",
    "parent_mandate_id": "<intent-mandate-id>",
    "scopes": ["commerce:write"],
    "payload": { "cart_id": "<cart-id>" }
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/agents/<AGENT_ID>/mandates"
```

### Verify a mandate chain

```bash
curl -s \
  -H "Authorization: Bearer <cc_prv_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/agents/<AGENT_ID>/mandates/<MANDATE_ID>/verify"
```

Returns `{ valid: true, chain: [...] }` or `{ valid: false, reason: "..." }`.
Verification checks: ed25519 signature, parent chain integrity, expiry, scope
consistency, spend limit.

### Spend limits

The `spend_limit` and `spend_window` on an agent are enforced during checkout
completion when the agent context is present. If the order total would exceed
the remaining spend budget in the current window, the request is rejected with
`MANDATE_CHAIN_INVALID`.

### Audit log

All agent actions are recorded append-only in `agent_audit_log`:

```bash
# All actions for a specific agent
curl -s \
  -H "Authorization: Bearer <cc_prv_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/agents/<AGENT_ID>/audit-log"

# All agent actions for the store
curl -s \
  -H "Authorization: Bearer <cc_prv_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/agents/audit-log"
```

---

## Per-store mandate enforcement flag

The `agents_require_mandate` boolean on a store controls whether agent-attributed
checkout completions must present a valid mandate chain.

| Value | Behaviour |
|-------|-----------|
| `false` (default) | If a payment mandate exists for the checkout, the chain is verified. If none exists, only spend limits are enforced. |
| `true` | A valid payment mandate chain (intent → cart → payment) is required for every agent-attributed checkout. Absence returns `MANDATE_REQUIRED`. |

### Enable via the stores API

```bash
curl -s -X PUT \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{ "agents_require_mandate": true }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>"
```

### Checkout error codes

When agent-attributed checkout completion fails, the route returns HTTP 402:

| Code | Cause |
|------|-------|
| `MANDATE_SPEND_LIMIT_EXCEEDED` | The agent's cumulative spend within `spend_window` would exceed `spend_limit`. |
| `MANDATE_REQUIRED` | `agents_require_mandate=true` and no valid payment mandate was found for the checkout, **or** a mandate exists but its chain is invalid. |

---

## Further reading

- MCP client config + all 9 tools: [mcp/README.md](../mcp/README.md)
- 9-step scripted purchase: [quickstart-mcp.md](./quickstart-mcp.md)
- ACP spec pin + field mapping: [acp.md](./acp.md)
- Configuring LLM key: [byo-keys.md](./byo-keys.md)
