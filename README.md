<p align="center">
  <img src="assets/logo.svg" width="112" alt="CartCrft" />
</p>

<h1 align="center">CartCrft</h1>

<p align="center">
  <strong>The open-source, agent-native headless commerce backend.</strong><br />
  <sub>Every store ships an MCP server out of the box. TypeScript end-to-end. MIT-licensed.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-b5ff2e?style=flat-square&labelColor=16170f" alt="MIT License" /></a>
  <a href="docs/agent-native.md"><img src="https://img.shields.io/badge/agent--native-MCP%20%2B%20ACP%20%2B%20UCP-b5ff2e?style=flat-square&labelColor=16170f" alt="Agent-native" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x-57e0ff?style=flat-square&labelColor=16170f" alt="TypeScript" /></a>
  <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-16-57e0ff?style=flat-square&labelColor=16170f" alt="PostgreSQL 16" /></a>
  <a href="docs/contributing.md"><img src="https://img.shields.io/badge/PRs-welcome-b5ff2e?style=flat-square&labelColor=16170f" alt="PRs welcome" /></a>
</p>

<p align="center">
  <a href="docs/quickstart.md">Quickstart</a> ·
  <a href="docs/quickstart-mcp.md">Buy with an agent</a> ·
  <a href="docs/agent-native.md">Agent-native</a> ·
  <a href="docs/self-host.md">Self-host</a> ·
  <a href="docs">Docs</a>
</p>

---

CartCrft is an open-source headless commerce backend built for the agentic era.
Every store ships with an **MCP server** that lets any AI agent — Claude, GPT, or
your own — browse, search, and complete purchases out of the box: no plugins, no
middleware, no proprietary agent layer.

Under that agent surface sits a complete ecommerce engine — products, inventory,
orders, payments (Stripe / Paystack / Razorpay / Xendit), B2B, subscriptions,
returns, digital products, and bookings. Fully headless, TypeScript end-to-end,
and MIT-licensed outside the optional cloud billing layer.

---

## Screenshots

<p align="center">
  <img src="docs/screenshots/dashboard-overview.png" width="720" alt="CartCrft admin dashboard — Overview" />
</p>
<p align="center"><em>Admin dashboard — multi-store switcher, full catalog and sales nav.</em></p>

<p align="center">
  <img src="docs/screenshots/dashboard-products.png" width="720" alt="CartCrft dashboard — Products" />
</p>
<p align="center"><em>Product catalog — manage products, variants, collections, and inventory.</em></p>

<p align="center">
  <img src="docs/screenshots/dashboard-orders.png" width="720" alt="CartCrft dashboard — Orders" />
</p>
<p align="center"><em>Orders dashboard — financial and fulfillment status at a glance.</em></p>

<p align="center">
  <img src="docs/screenshots/checkout.png" width="720" alt="CartCrft hosted checkout — branded payment page" />
</p>
<p align="center"><em>Hosted checkout link — branded payment page, no storefront code required.</em></p>

<p align="center">
  <img src="docs/screenshots/landing.png" width="720" alt="CartCrft marketing landing page" />
</p>
<p align="center"><em>Marketing site — Agentic Terminal theme.</em></p>

---

## Features

### Standard commerce
- **Catalog** — products (simple, bundle, configurable, digital, service, subscription, rental), options, variants, media, collections (manual + smart), tags, metafields, SEO, i18n translations, CSV import/export
- **Inventory** — warehouses, stock levels, FEFO lot tracking, serial numbers, reorder points, suppliers
- **Orders & checkout** — carts with price snapshots, checkout sessions, atomic `CompleteByID` (price re-validation + inventory decrement + discount burn in one transaction), abandoned-cart recovery, wishlists
- **Payments** — Stripe, Paystack, Razorpay, Xendit; BYO keys; AES-256-GCM secret encryption; live provider refunds; inbound webhook router with replay protection; GA4 server-side purchase events
- **Shipping** — zones, rates, live rates (BobGo), collection points (PUDO/click-and-collect), shipments, tracking events, fulfillment orders
- **Tax** — categories, zones, rates (inclusive/exclusive static tables)
- **Discounts** — code-based (%, fixed, free-shipping, BOGO, buy-X-get-Y) and automatic discounts; usage limits; once-per-customer atomicity
- **B2B** — companies, credit limits, net terms, quotes/RFQ lifecycle, purchase orders, customer group pricing
- **Subscriptions** — plans (interval/trial), lifecycle (pause/resume/cancel/bill), automatic renewal scheduler
- **Returns / RMA** — refund, exchange, store credit, repair resolution; optional restock
- **Wallet** — gift card issuance and redemption; per-customer store credit ledger
- **Digital products** — time-limited, download-count-limited token delivery
- **Bookings & rentals** — resources, availability calendars, price rules, iCal export, OTA channel linkage

### Agent-native
- **MCP server** — every store is browsable and purchasable via MCP from any MCP-capable agent (Claude Desktop, Claude Code, custom agents)
- **Signed agent mandates** — verifiable consent chain: intent → cart → payment, ed25519-signed and audit-logged
- **Semantic search** — pgvector hybrid search with BYO OpenAI-compatible embeddings key; full-text fallback with no key required
- **ACP adapter** — Agentic Commerce Protocol checkout sessions + product feed, date-versioned isolation
- **UCP adapter** — Universal Commerce Protocol (Google surfaces / NRF 2026-01 baseline), catalog entities + checkout
- **Spend limits** — per-agent spending caps with configurable time windows

### Platform
- **OAuth apps** — third-party app authorization flows
- **Checkout links** — shareable pre-filled payment URLs (`/pay/:token`), embeddable as iframes; no storefront required
- **Customer auth** — register, login, sessions, password reset, email verification, magic links, Google/Microsoft/Discord OAuth PKCE
- **Platform API keys** — `cc_pub_` (read) and `cc_prv_` (write/admin) key scheme
- **Generated TS SDK** — `@cartcrft/sdk`, auto-generated from OpenAPI 3.1
- **Outbound webhooks** — signed event delivery on order/payment/shipment transitions; transactional email via AWS SES

---

## Quickstart

```bash
git clone https://github.com/webcrft/cartcrft
cd cartcrft
pnpm install
```

```bash
# Start Postgres 16 + pgvector (or use your own)
docker run -d --name cartcrft-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cartcrft \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

```bash
# Configure (minimum required)
cat > .env << 'EOF'
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cartcrft
JWT_SECRET=change-me-in-production
APP_ENV=development
EOF
```

```bash
pnpm migrate   # apply all 30 SQL migrations
pnpm seed      # create the Crft Goods demo store; prints cc_pub_ / cc_prv_ keys
pnpm dev       # Fastify on :3000
```

```bash
curl http://localhost:3000/healthz
# {"status":"ok","version":"0.0.0","db":"ok"}
```

**Buy with an AI agent in 10 minutes** — see [quickstart-mcp.md](./docs/quickstart-mcp.md).

**Run the full stack with Docker** — `docker compose up` (see [self-host.md](./docs/self-host.md)).

**Capture screenshots** — `pnpm screenshots` (requires a running dev server).

---

## Architecture

CartCrft is fully headless. The backend exposes:

- **REST API** — date-versioned OpenAPI 3.1, machine-readable error semantics, idempotency keys on all mutating storefront endpoints
- **Webhooks** — outbound signed event delivery + inbound payment webhook router
- **MCP server** — agent-native tool surface, enabled by default on every store
- **Generated TS SDK** — `@cartcrft/sdk`, auto-generated from `openapi.json`

The admin dashboard is a React SPA at `/dashboard` speaking the same public API with a `cc_prv_` key. Storefronts are your problem — or an agent's.

Self-hosting requires nothing from `cloud/`. The cloud layer is metering + billing + tenant provisioning for cartcrft.com only.

**Security** — multi-tenant isolation at two layers: (1) app-layer auth middleware verifies org ownership on every request; (2) PostgreSQL RLS enforced via `SET LOCAL ROLE cartcrft_app` (NOBYPASSRLS) inside every database transaction.

### Monorepo layout

```
cartcrft/
├── LICENSE                    # MIT (everything except cloud/)
├── README.md
├── roadmap.md                 # planning doc
├── assets/                    # logo + brand
├── package.json               # pnpm workspace root
├── backend/                   # TypeScript headless commerce core (MIT)
│   ├── src/                   # Fastify + zod + pg; entrypoints: serve | worker | migrate
│   ├── migrations/            # 30 Postgres SQL migration files (0001–0030)
│   └── tests/                 # vitest test suites
├── mcp/                       # MCP docs + conformance examples (MIT)
├── sdk/                       # @cartcrft/sdk (generated from OpenAPI) (MIT)
├── web/                       # Vite + React 19 app: marketing site + docs + admin dashboard
│   └── src/
│       ├── site/              # marketing pages + docs (react-router SPA)
│       └── dashboard/         # admin SPA at /dashboard
└── cloud/                     # Cloud billing layer (CartCrft Cloud License — not MIT)
    ├── LICENSE
    └── billing/               # plans, Paystack, USD→ZAR fx, wallet, billing sim
```

---

## Documentation

Full docs are at **[/docs](./docs)** (served by the web app) or browse the markdown source:

| Doc | What it covers |
|-----|----------------|
| [docs/quickstart.md](./docs/quickstart.md) | Local dev: prereqs, install, migrate, seed, first API calls |
| [docs/quickstart-mcp.md](./docs/quickstart-mcp.md) | Agent flow: buy from a store with an AI agent in 10 minutes |
| [docs/commerce.md](./docs/commerce.md) | Commerce engine overview — catalog, inventory, orders, payments, B2B, subscriptions, bookings |
| [docs/api-overview.md](./docs/api-overview.md) | Auth, error envelope, idempotency, pagination, money encoding |
| [docs/byo-keys.md](./docs/byo-keys.md) | Payment providers, LLM key for semantic search, secret encryption |
| [docs/agent-native.md](./docs/agent-native.md) | MCP, semantic search, ACP adapter, agent registry, mandates |
| [docs/acp.md](./docs/acp.md) | Agentic Commerce Protocol adapter — spec pin, endpoints, field mapping |
| [docs/ucp.md](./docs/ucp.md) | Universal Commerce Protocol adapter — catalog entities + checkout |
| [docs/checkout-links.md](./docs/checkout-links.md) | Shareable pre-filled payment links, iframe embed mode |
| [docs/self-host.md](./docs/self-host.md) | Docker Compose, environment variables, production checklist |
| [docs/cloud-vs-selfhost.md](./docs/cloud-vs-selfhost.md) | MIT core vs cloud license, feature comparison |
| [docs/security.md](./docs/security.md) | Tenant isolation, RLS, IDOR sweep, auth secrets |
| [docs/contributing.md](./docs/contributing.md) | Monorepo layout, pnpm commands, migration rules |
| [docs/testing.md](./docs/testing.md) | Test harness, writing suites, billing simulation |
| [docs/parity-endpoints.md](./docs/parity-endpoints.md) | Full endpoint table with auth tiers |

---

## Contributing

We welcome contributions. See [docs/contributing.md](./docs/contributing.md) for
the development workflow, monorepo commands, and migration rules.

```bash
pnpm install        # install all workspace deps
pnpm dev            # backend on :3000, web on :5173
pnpm test           # run all vitest suites
pnpm migrate        # apply pending migrations
pnpm --filter @cartcrft/web exec tsc --noEmit   # type-check the web app
```

Issues, bug reports, and pull requests are all welcome. See [roadmap.md](./roadmap.md)
for what's being built and why.

---

## License

Everything outside `cloud/` is **MIT** — see [LICENSE](./LICENSE).

The `cloud/` directory is source-available under the
[CartCrft Cloud License v1.0](./cloud/LICENSE): free to view, modify, and use for
development and testing; production and commercial use of `cloud/` code requires a
written agreement with Webcrft Systems (Pty) Ltd. **Self-hosting CartCrft does not require
`cloud/` at all.**

---

<p align="center">
  <img src="assets/logo.svg" width="32" alt="" /><br />
  <sub>Built with care by <a href="https://webcrft.io">WebCrft</a> · <strong>Webcrft Systems (Pty) Ltd</strong></sub>
</p>
