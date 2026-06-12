# Cartcrft Roadmap

> The open-source, agent-native, headless commerce backend with a fair BYO-keys cloud.
> A Webcrft Systems project. This file is the destination map; `tasks.md` is the work queue.

Last updated: 2026-06-12

---

## North star

Rip the proven ecommerce system out of `~/code/exo/webcrft-mono` (Go backend + Postgres),
rebuild it **better** as a standalone, fully open-source, headless commerce platform —
agent-native from the data model up — with a **thin cloud layer for billing** on top,
GitLab-style: one monorepo, everything open, cloud under its own license.

- **Lead with agent-native** — MCP tools by default, ACP/UCP adapters, signed mandates. The category nobody owns.
- **Trust with fair pricing** — BYO keys (payments, LLM, search), 0% take rate, flat legible cloud fee.
- **Retain with DX** — one command to a running agent-ready store, generated TS SDK, great docs, real test suite.
- **Headless as possible** — the core renders nothing. REST API + webhooks + SDKs + agent surfaces only.
  Admin dashboard is a separate SPA speaking the same public API. Storefronts are the user's problem (or an agent's).

## Licensing & repo shape (GitLab model)

```
cartcrft/                      ← monorepo, fully source-open
├── LICENSE                    ← MIT (everything except cloud/)
├── README.md                  ← OSS readme: pitch, quickstart, architecture
├── roadmap.md / tasks.md      ← this planning pair
├── backend/                   ← Go headless commerce core (MIT)
│   ├── cmd/server/            ← single binary: `serve` | `worker`
│   ├── internal/              ← commerce, payments, webhooks, shipping, auth, agent
│   ├── migrations/            ← Postgres schema (numbered, idempotent up)
│   └── tests/                 ← suite harness: `go run . -suite <name>`
├── mcp/                       ← MCP server spec + conformance examples (MIT)
├── sdk/                       ← @cartcrft/sdk (TS, generated from OpenAPI) + storefront.js (MIT)
├── admin/                     ← React/Vite admin dashboard SPA (MIT) — the only UI we ship
├── cloud/                     ← thin cloud layer (Cartcrft Cloud License — source-visible, not MIT)
│   ├── LICENSE
│   └── billing/               ← tenants, plans, Paystack, USD→ZAR fx, wallet, invoices
└── docs/                      ← markdown docs, OpenAPI spec, protocol conformance notes
```

- Core principle: **self-hosting Cartcrft requires nothing from `cloud/`**. The cloud layer is
  only metering + billing + tenant provisioning for cartcrft.com. If core needs a hook, the hook
  is MIT and generic; only the billing consumer of the hook lives in `cloud/`.
- `cloud/LICENSE`: source-available (view/modify for development), production use only by
  Webcrft Systems — same shape as GitLab EE / Elastic-style cloud dirs.

## Stack decisions (settled)

| Decision | Choice | Why |
|---|---|---|
| Backend language | **Go** (port from webcrft-mono) | We're ripping a battle-tested Go system; keeps `.env` conventions and lets us reuse migrations, handlers, webhook router, tests nearly wholesale. The blueprint's TS leaning is satisfied at the SDK layer instead. |
| DB | Postgres (+ pgvector for semantic catalog) | Same as source; pgvector adds agent retrieval without new infra. |
| API | REST + date-versioned OpenAPI + JSON Schema | Generated TS SDK; agents need self-describing endpoints. |
| Dev env | `.env` copied from webcrft-mono `.env.dev` (same keys/conventions) | Direct reuse of dev DATABASE_URL, JWT, Paystack, SES, etc. |
| Multi-tenancy | org → stores, RLS, same as source | Proven; keep. |
| Admin | React 19 + Vite SPA in `admin/` (current scaffold) | Headless core; admin is just an API client. |
| Cloud billing | Paystack; **bill in USD, charge in ZAR** via fx tables | Mirrors webcrft's real internal billing. |
| Billing testability | `billingsim`-style simulated time (configurable day duration) | Port `backend/internal/billingsim` pattern; whole billing suite runs in seconds. |

## What we port (feature parity with webcrft-mono commerce)

Source inventory lives in webcrft-mono; key source paths:
`backend/internal/handlers/commerce*.go`, `backend/internal/commerce/checkout/complete.go`,
`backend/internal/payments/{stripe,paystack,razorpay,xendit}`, `backend/internal/webhooks/`,
`backend/internal/shipping/bobgo`, `backend/migrations/20260407000033_commerce.sql` (+ booking, rls, auth),
`backend/tests/suites/commerce*.go`, `public/commerce.js`, `src/pages/admin/commerce.jsx`.

Everything below exists in the source and must reach parity in Cartcrft:

1. **Stores & tenancy** — orgs, stores, multi-store, takedown/restore, RLS, store settings, i18n locales, translation tables.
2. **Catalog** — products (simple/bundle/configurable/digital/service/subscription/rental), options/values, variants
   (no variant/option caps), media (image/video/3D), collections (manual + smart rules), tags, metafields, SEO fields.
3. **Pricing** — price sets per variant, compare-at/cost, price lists (retail/wholesale/VIP/staff), per-currency lists,
   multi-currency with USD-based `exchange_rates` table + refresh cron.
4. **Inventory** — warehouses, levels (on-hand/committed/incoming), adjustments audit, lots/expiry (FEFO), serial numbers,
   reorder points, suppliers.
5. **Carts & checkout** — carts/lines with price snapshots, checkout sessions (address/shipping/tax/discount resolution),
   atomic `CompleteByID` (price re-validation, order numbering, inventory decrement, discount burn — all in one tx),
   abandoned cart capture + recovery tokens.
6. **Orders** — order/lines/adjustments/events, financial + fulfillment status machines, cancel, notes, test-mode orders.
7. **Payments** — provider abstraction (BYO keys): Stripe (PaymentIntent), Paystack, Razorpay, Xendit, custom-webhook
   provider; payment/attempt/refund records with idempotency uniques; capture/refund flows; dev/live credential modes;
   AES-256-GCM secret encryption; inbound webhook router (subdomain + path routing, signature verification per provider,
   replay protection, GA4 server-side purchase events).
8. **Shipping & fulfillment** — zones/regions/rates, live rates (BobGo), collection points (PUDO), shipments + tracking
   events + carrier push webhook, split fulfillment orders across warehouses.
9. **Tax** — categories, zones/regions, rates (inclusive/exclusive), webhook tax provider.
10. **Discounts & wallet** — codes (percentage/fixed/free-shipping/BOGO/buy-x-get-y), automatic discounts, usage limits,
    once-per-customer atomicity, store credits + ledgers, gift cards + transactions.
11. **Customers & auth** — customers/addresses/tags/groups, per-store customer auth (register/login/sessions/password
    reset/email verify/magic link/invites, Google/Microsoft/Discord OAuth PKCE), audit + email logs, block/unblock.
12. **B2B** — companies, credit limits, net terms, quotes/RFQ lifecycle, purchase orders, customer groups + group pricing.
13. **Subscriptions** — plans (interval/trial), subscriptions (pause/resume/cancel/bill), items, generated orders.
14. **Returns/RMA** — return requests/lines/events, refund/exchange/store-credit/repair types, restock.
15. **Digital products** — files, tokenized download links with limits/expiry.
16. **Reviews & wishlists** — moderated reviews with verified-purchase flag, wishlists + share tokens.
17. **Bookings** — resources/availability/price rules, bookings → orders, cancellation policies, OTA channels
    (Airbnb/Booking.com/… via iCal 2-way sync + push jobs), messaging, check-in tokens, damage claims. *(port last)*
18. **Feeds & integrations** — Google Shopping XML / Facebook Catalog feeds, merchant feed configs, product feed data
    (GTIN/MPN/category), 50+ integration definitions, tracking pixels, notification providers (webhook/email/sms/whatsapp),
    outbound webhooks + delivery logs.
19. **Analytics** — ecommerce overview/products/funnel/revenue endpoints; standard event names.
20. **Platform API keys** — `cc_pub_` (read, embeddable) / `cc_prv_` (write/admin) key scheme.

## What we add (the "better" — agent-native layer)

21. **MCP server (ship by default, ship loud)** — browse/search/cart/checkout/order-status as MCP tools; per-store
    config; this is the hero feature. "Buyable in ChatGPT in 10 minutes."
22. **Semantic catalog** — pgvector embeddings on products (BYO LLM key for embedding generation, pg fallback),
    `/search` designed for long natural-language agent queries; GEO-ready structured attributes.
23. **ACP adapter** — agentic checkout sessions, product feed at ACP spec, delegate payment/auth. Date-versioned,
    isolated under `internal/agent/acp` so spec churn never touches core.
24. **UCP adapter** — catalog + checkout conformance for Google surfaces (after ACP).
25. **Trust layer** — `agents` (principal, scopes, spend limits) + `mandates` (intent/cart/payment, signed, audit-logged);
    AP2-style verifiable consent chain. First-class endpoints.
26. **Self-describing API** — OpenAPI date-versioned, machine-readable error semantics, idempotency keys on all mutating
    storefront endpoints.

## Cloud layer (thin, `cloud/`, own license)

27. **Tenant provisioning** — orgs/instances, quotas (commerce orders/mo metering like webcrft tiers).
28. **Billing** — port webcrft's internal billing shape: plans/tiers, subscription lifecycle (upgrade/cancel/renew,
    proration, billing-day change, grace period, auto-downgrade, dead-letter queue), wallet + top-ups, vouchers,
    invoices (PDF), refund records.
29. **Paystack rails** — card connect, charges, 3DS, webhooks. **Price book in USD; charges executed in ZAR** using
    `exchange_rates` fx tables (USD base) with rate snapshots stored on every invoice/charge for auditability.
30. **billingsim** — simulated time: configurable billing-day duration (`BILLING_SIM_DAY_SECONDS`), cycle = 30 sim-days;
    the entire billing lifecycle testable in seconds, in CI.
31. **Transparent cost dashboard** — what goes to whom (Paystack at cost, infra flat fee). Never % of GMV.

## Testing (first-class, ports webcrft's harness)

- `backend/tests/` harness: `go run . -suite <name>`, shared ctx/helpers, RESULTS.md tracking.
- Suites to port/adapt: commerce CRUD, checkout, idempotency, concurrency, money precision, cart IDOR, cross-org
  isolation, payments per provider, tax, returns, auth, feeds, validation + pentest-style suites.
- New suites: mcp (tool conformance), acp (spec conformance), mandates, semantic search, billing (simulated time:
  full subscribe→renew→grace→downgrade lifecycle under `BILLING_SIM_DAY_SECONDS=2`), fx (USD→ZAR snapshots).
- Unit tests inline (`go test ./...`) folded into the `unit` suite.

## Phases

- **Phase 0 — Skeleton (today)**: monorepo layout, licenses, README, go.mod, config/db packages, migration runner,
  CI script, `.env` wired (done — copied from webcrft-mono).
- **Phase 1 — Schema + core commerce**: port migrations (improved: pgvector, agents/mandates tables, `cc_` key scheme),
  stores/catalog/carts/checkout/orders/payments/webhook router + tests.
- **Phase 2 — Full parity**: inventory, shipping, tax, discounts, wallet, customers+auth, B2B, subscriptions, returns,
  digital, reviews/wishlists, feeds/integrations, analytics.
- **Phase 3 — Agent layer**: MCP server + semantic catalog + ACP adapter + mandates. Hero demo.
- **Phase 4 — Cloud**: billing port (Paystack USD→ZAR, wallet, proration, grace), billingsim, tenant quotas.
- **Phase 5 — SDK/admin/docs**: TS SDK from OpenAPI, storefront.js, admin dashboard parity, docs site, UCP, bookings/OTA.

## Open items

- Domains: cartcrft.dev / cartcrft.com availability check before launch.
- Cloud license exact text (GitLab EE-style) — drafted in Phase 0, legal review before launch.
- Embedding model default (BYO key first; ship a no-key pg full-text fallback).
- ACP/UCP spec versions to pin at first conformance pass.
