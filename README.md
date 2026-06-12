<p align="center">
  <img src="assets/logo.svg" width="96" alt="Cartcrft logo" />
</p>

# Cartcrft

**The open-source, agent-native, headless commerce backend. TypeScript end-to-end.**

> The Supabase of commerce, built for the agentic era.

---

## Why Cartcrft?

Agents are the new buyers. AI assistants, autonomous shopping agents, and LLM-powered
storefronts already browse, compare, and purchase on behalf of humans — but every major
commerce platform treats agent access as a bolt-on: a webhook here, a plugin there. The
result is brittle, incomplete, and expensive.

Cartcrft is designed from the data model up for agent-native commerce:

- **MCP server by default** — your store is browsable and purchasable via MCP in minutes,
  not months. Buyable in ChatGPT, Claude, or any MCP-capable agent in ~10 minutes.
- **ACP / UCP adapters** — first-class support for the emerging agentic commerce protocols,
  isolated so spec churn never touches your core data.
- **Signed agent mandates** — verifiable consent chain: agent intent → cart → payment,
  ed25519-signed and audit-logged. Trust, not just access.
- **BYO keys** — your Stripe, Paystack, Razorpay, or Xendit credentials; your OpenAI or
  Anthropic key for semantic search. Zero percent take rate. Flat cloud fee if you use ours.
- **Fully headless** — the core renders nothing. REST API + webhooks + generated TS SDK +
  agent surfaces. Admin dashboard is a separate SPA speaking the same public API.

---

## Features

| Domain | What ships | Status |
|---|---|---|
| **Catalog** | Products (simple / bundle / configurable / digital / service / subscription / rental), options, variants — no variant or option caps — media, collections (manual + smart rules), tags, metafields, SEO, i18n | shipped |
| **Inventory** | Warehouses, stock levels, adjustment audit, lots + expiry (FEFO), serial numbers, reorder points, suppliers | shipped |
| **Carts & Checkout** | Carts with price snapshots, checkout sessions, atomic `CompleteByID` (price re-validation, inventory decrement, discount burn — all in one transaction), abandoned cart recovery | shipped |
| **Orders** | Order lifecycle, financial + fulfillment state machines, cancel, notes, test-mode orders | shipped |
| **Payments** | Provider abstraction, BYO keys: **Stripe** (PaymentIntent), **Paystack**, **Razorpay**, **Xendit**, custom webhook provider. AES-256-GCM secret encryption. Inbound webhook router with replay protection | shipped |
| **Shipping** | Zones / regions / rates, live rates (BobGo), collection points (PUDO), shipments + tracking events, split fulfillment | shipped |
| **Tax** | Categories, zones, rates (inclusive / exclusive), webhook tax provider | shipped |
| **Discounts** | Codes (percentage / fixed / free-shipping / BOGO / buy-X-get-Y), automatic discounts, usage limits, once-per-customer atomicity | shipped |
| **B2B** | Companies, credit limits, net terms, quotes / RFQ lifecycle, purchase orders, customer group pricing | shipped |
| **Subscriptions** | Plans (interval / trial), subscription lifecycle (pause / resume / cancel / bill), generated orders | shipped |
| **Returns / RMA** | Return requests, refund / exchange / store-credit / repair flows, restock | shipped |
| **Gift cards & store credit** | Gift card transactions, store credit ledger | shipped |
| **Customer auth** | Register / login / sessions / password reset / email verify / magic link / invites, Google / Microsoft / Discord OAuth PKCE | shipped |
| **Feeds** | Google Shopping XML, Facebook Catalog feeds | shipped |
| **MCP server** | `search_products`, `get_product`, `create_cart`, `add_to_cart`, `complete_checkout`, `get_order_status` and more, per-store config, `cc_pub_` auth | shipped |
| **Semantic search** | pgvector embeddings, BYO LLM key (OpenAI / Anthropic), pg full-text fallback, natural-language `/search` endpoint | shipped |
| **Signed agent mandates** | Agent registry (scopes, spend limits), mandate chain (intent → cart → payment), ed25519 signatures, audit log | shipped |
| **ACP adapter** | Agentic checkout sessions + product feed at ACP spec, date-versioned isolation | shipped |
| **Platform API keys** | `cc_pub_` (read / storefront) and `cc_prv_` (write / admin) key scheme | shipped |

---

## Architecture

Cartcrft is fully headless. The backend exposes:

- **REST API** — date-versioned OpenAPI 3.1, machine-readable error semantics, idempotency
  keys on all mutating storefront endpoints.
- **Webhooks** — outbound event delivery + inbound payment provider webhook router.
- **MCP server** — agent-native tool surface, ships by default on every store.
- **Generated TS SDK** — `@cartcrft/sdk`, auto-generated from OpenAPI.

The admin dashboard (`admin/`) is a React SPA that speaks the same public API with a
`cc_prv_` key. Storefronts are your problem — or an agent's.

Self-hosting requires nothing from `cloud/`. The cloud layer (`cloud/`) is metering +
billing + tenant provisioning for cartcrft.com only.

---

## Monorepo layout

```
cartcrft/
├── LICENSE                    # MIT (everything except cloud/)
├── README.md
├── roadmap.md / tasks.md      # planning pair
├── assets/                    # logo + brand
├── package.json               # pnpm workspace root
├── backend/                   # TypeScript headless commerce core (MIT)
│   ├── src/                   # one entrypoint: serve | worker | migrate (Fastify + zod + pg)
│   ├── migrations/            # Postgres schema (plain SQL, numbered — 12 migration files)
│   └── tests/                 # vitest suites: pnpm suite <name>
├── mcp/                       # MCP usage docs + conformance examples (MIT)
├── sdk/                       # @cartcrft/sdk (TS, generated from OpenAPI) (MIT) — in development
├── admin/                     # React 19 + Vite admin dashboard SPA (MIT)
├── cloud/                     # thin cloud layer (Cartcrft Cloud License — source-visible, not MIT)
│   ├── LICENSE
│   └── billing/               # tenants, plans, Paystack, USD→ZAR fx, wallet, invoices — in development
└── docs/                      # markdown docs, OpenAPI spec, protocol conformance
```

---

## Quickstart

```bash
git clone https://github.com/webcrftsystems/cartcrft
cd cartcrft
pnpm install

# Start a Postgres instance with pgvector (or use your own):
docker run -d --name cartcrft-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cartcrft -p 5432:5432 pgvector/pgvector:pg16

# Configure (minimum):
echo "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cartcrft
JWT_SECRET=change-me
APP_ENV=development" > .env

pnpm migrate   # applies all 12 SQL migrations
pnpm seed      # creates demo store + 12 products; prints cc_pub_ / cc_prv_ keys
pnpm dev       # Fastify on :3000
```

```bash
curl http://localhost:3000/healthz
# {"status":"ok","version":"0.0.0","db":"ok"}
```

**Buy with an AI agent in 10 minutes** — follow [docs/quickstart-mcp.md](./docs/quickstart-mcp.md).

Full local-dev guide (prereqs, env vars, first API calls): [docs/quickstart.md](./docs/quickstart.md).

Docker Compose (`docker compose up`) is coming in T5.5.

---

## Documentation

| Doc | What it covers |
|-----|----------------|
| [docs/quickstart.md](./docs/quickstart.md) | Local dev: prereqs, install, migrate, seed, first API calls |
| [docs/quickstart-mcp.md](./docs/quickstart-mcp.md) | Agent flow: buy with an AI agent in 10 minutes |
| [docs/api-overview.md](./docs/api-overview.md) | Auth, error envelope, idempotency, pagination, money encoding |
| [docs/byo-keys.md](./docs/byo-keys.md) | Payment providers, LLM key for semantic search, secret encryption |
| [docs/agent-native.md](./docs/agent-native.md) | MCP, semantic search, ACP adapter, agent registry, mandates |
| [docs/cloud-vs-selfhost.md](./docs/cloud-vs-selfhost.md) | MIT core vs cloud/ license, self-host completeness |
| [docs/contributing.md](./docs/contributing.md) | Monorepo layout, pnpm commands, migration rules |
| [docs/testing.md](./docs/testing.md) | Test harness, writing suites, billingsim |
| [docs/parity-endpoints.md](./docs/parity-endpoints.md) | Full endpoint table with auth tiers |
| [docs/acp.md](./docs/acp.md) | ACP adapter spec, field mapping, divergences |
| [mcp/README.md](./mcp/README.md) | MCP tools reference, client config examples |

---

## License

Everything outside `cloud/` is **MIT** — see [LICENSE](./LICENSE).

The `cloud/` directory is source-available under the
[Cartcrft Cloud License v1.0](./cloud/LICENSE): free to view, modify, and use for
development/testing; production and commercial use of `cloud/` code requires a written
agreement with Webcrft Systems. Self-hosting Cartcrft does not require `cloud/` at all.

---

## A Webcrft Systems project

Built with care by [Webcrft Systems](https://webcrft.com).
Contributions welcome — see [roadmap.md](./roadmap.md) for what's being built and why.
