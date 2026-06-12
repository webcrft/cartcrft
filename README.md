# Cartcrft

**The open-source, agent-native, headless commerce backend.**

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
| **Catalog** | Products (simple / bundle / configurable / digital / service / subscription / rental), options, variants — no variant or option caps — media, collections (manual + smart rules), tags, metafields, SEO, i18n | in development |
| **Inventory** | Warehouses, stock levels, adjustment audit, lots + expiry (FEFO), serial numbers, reorder points, suppliers | in development |
| **Carts & Checkout** | Carts with price snapshots, checkout sessions, atomic `CompleteByID` (price re-validation, inventory decrement, discount burn — all in one transaction), abandoned cart recovery | in development |
| **Orders** | Order lifecycle, financial + fulfillment state machines, cancel, notes, test-mode orders | in development |
| **Payments** | Provider abstraction, BYO keys: **Stripe** (PaymentIntent), **Paystack**, **Razorpay**, **Xendit**, custom webhook provider. AES-256-GCM secret encryption. Inbound webhook router with replay protection | in development |
| **Shipping** | Zones / regions / rates, live rates (BobGo), collection points (PUDO), shipments + tracking events, split fulfillment | in development |
| **Tax** | Categories, zones, rates (inclusive / exclusive), webhook tax provider | in development |
| **Discounts** | Codes (percentage / fixed / free-shipping / BOGO / buy-X-get-Y), automatic discounts, usage limits, once-per-customer atomicity | in development |
| **B2B** | Companies, credit limits, net terms, quotes / RFQ lifecycle, purchase orders, customer group pricing | in development |
| **Subscriptions** | Plans (interval / trial), subscription lifecycle (pause / resume / cancel / bill), generated orders | in development |
| **Returns / RMA** | Return requests, refund / exchange / store-credit / repair flows, restock | in development |
| **Gift cards & store credit** | Gift card transactions, store credit ledger | in development |
| **Customer auth** | Register / login / sessions / password reset / email verify / magic link / invites, Google / Microsoft / Discord OAuth PKCE | in development |
| **Feeds** | Google Shopping XML, Facebook Catalog feeds | in development |
| **MCP server** | `search_products`, `get_product`, `create_cart`, `add_to_cart`, `complete_checkout`, `get_order_status` and more, per-store config, `cc_pub_` auth | in development |
| **Semantic search** | pgvector embeddings, BYO LLM key (OpenAI / Anthropic), pg full-text fallback, natural-language `/search` endpoint | in development |
| **Signed agent mandates** | Agent registry (scopes, spend limits), mandate chain (intent → cart → payment), ed25519 signatures, audit log | in development |
| **ACP adapter** | Agentic checkout sessions + product feed at ACP spec, date-versioned isolation | in development |
| **Platform API keys** | `cc_pub_` (read / storefront) and `cc_prv_` (write / admin) key scheme | in development |

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
├── backend/                   # Go headless commerce core (MIT) — in development
│   ├── cmd/server/            # single binary: serve | worker
│   ├── internal/              # commerce, payments, webhooks, shipping, auth, agent
│   ├── migrations/            # Postgres schema (numbered, idempotent up)
│   └── tests/                 # suite harness: go run . -suite <name>
├── mcp/                       # MCP server spec + conformance examples (MIT) — in development
├── sdk/                       # @cartcrft/sdk (TS, generated from OpenAPI) (MIT) — in development
├── admin/                     # React 19 + Vite admin dashboard SPA (MIT)
├── cloud/                     # thin cloud layer (Cartcrft Cloud License — source-visible, not MIT)
│   ├── LICENSE
│   └── billing/               # tenants, plans, Paystack, USD→ZAR fx, wallet, invoices — in development
└── docs/                      # markdown docs, OpenAPI spec, protocol conformance — in development
```

---

## Quickstart

Coming soon: `docker compose up`

Full quickstart (postgres + pgvector + server + worker) is in development. Track progress
in [roadmap.md](./roadmap.md).

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
