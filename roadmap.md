# Cartcrft Roadmap

> The open-source, agent-native, headless commerce backend with a fair BYO-keys cloud.
> A Webcrft Systems project. This file is the destination map; `tasks.md` is the work queue.

Last updated: 2026-06-12 (TypeScript pivot)

---

## North star

Rip the proven ecommerce system out of `~/code/exo/webcrft-mono` (battle-tested Go + Postgres implementation),
rebuild it **better, in TypeScript end-to-end** — frontend AND backend — as a standalone, fully open-source,
headless commerce platform, agent-native from the data model up, with a **thin cloud layer for billing** on top.
GitLab-style: one monorepo, everything source-open, cloud under its own license.

- **Lead with agent-native** — MCP tools by default, ACP/UCP adapters, signed mandates. The category nobody owns.
- **Trust with fair pricing** — BYO keys (payments, LLM, search), 0% take rate, flat legible cloud fee.
- **Retain with DX** — one command to a running agent-ready store, end-to-end TypeScript types from DB to SDK,
  great docs, real test suite.
- **Headless as possible** — the core renders nothing. REST API + webhooks + SDKs + agent surfaces only.
  Admin dashboard is a separate SPA speaking the same public API. Storefronts are the user's problem (or an agent's).

The Go source is the **functional spec**: its schema, endpoint surface, atomicity guarantees, webhook
semantics, and test suites define parity. We port behavior, not syntax.

## Licensing & repo shape (GitLab model)

Neutral workspace root; the backend is the product, every app/package is a sibling
(user-confirmed 2026-06-12; standard for OSS backend products à la Medusa/Supabase).

```
cartcrft/                      ← monorepo, fully source-open, pnpm workspaces
├── LICENSE                    ← MIT (everything except cloud/)
├── README.md                  ← OSS readme: pitch, quickstart, architecture
├── roadmap.md / tasks.md      ← this planning pair
├── assets/                    ← logo + brand svg
├── package.json               ← workspace root (shared scripts only, private)
├── pnpm-workspace.yaml        ← packages: backend, admin, sdk, cloud/billing
├── backend/                   ← TypeScript headless commerce core (MIT)
│   ├── src/
│   │   ├── main.ts            ← single entrypoint: `serve` (default) | `worker` | `migrate`
│   │   ├── config/            ← env config (same var names as webcrft .env)
│   │   ├── db/                ← pg pool, migration runner, sql helpers
│   │   ├── http/              ← Fastify app, route registration, auth middleware
│   │   ├── modules/           ← commerce domains (catalog, cart, checkout, orders, payments, ...)
│   │   ├── agent/             ← MCP server, ACP/UCP adapters, mandates (the differentiator)
│   │   ├── providers/         ← payment/shipping/email/llm provider clients (BYO keys)
│   │   └── webhooks/          ← inbound webhook router + per-provider signature verifiers
│   ├── migrations/            ← plain SQL, numbered, ported from webcrft + agent-native additions
│   └── tests/                 ← vitest suites (suite-per-domain, mirrors webcrft tests/suites)
├── admin/                     ← React 19 + Vite admin dashboard SPA (MIT) — the only UI we ship
├── mcp/                       ← MCP usage docs + conformance examples + client configs (MIT)
├── sdk/                       ← @cartcrft/sdk (generated from OpenAPI) + storefront.js (MIT)
├── cloud/                     ← thin cloud layer (Cartcrft Cloud License — source-visible, not MIT)
│   ├── LICENSE
│   └── billing/               ← tenants, plans, Paystack, USD→ZAR fx, wallet, invoices, billingsim
└── docs/                      ← markdown docs, OpenAPI spec, protocol conformance notes
```

- Core principle: **self-hosting Cartcrft requires nothing from `cloud/`**. The cloud layer is only
  metering + billing + tenant provisioning for cartcrft.com. If core needs a hook, the hook is MIT and
  generic; only the billing consumer of the hook lives in `cloud/`.
- `cloud/LICENSE`: source-available (view/modify for development), production use only by Webcrft Systems —
  same shape as GitLab EE / Elastic-style cloud dirs.

## Stack decisions (settled — TypeScript everywhere)

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript end-to-end** (backend + frontend + SDK + cloud) | One language, one type system DB→API→SDK→admin; aligns with Medusa/Vendure ecosystem and hireable talent; user decision 2026-06-12. |
| Runtime / pkg mgr | Node 22 LTS, ESM, pnpm workspaces | Modern defaults; workspaces give the GitLab-style monorepo. |
| HTTP framework | **Fastify 5** + zod (`fastify-type-provider-zod`) | Fast, mature; zod schemas double as validation AND OpenAPI source → generated SDK. |
| Validation | zod everywhere (route schemas, config, provider payloads) | Single schema language; JSON-Schema export for agents. |
| DB access | `pg` (node-postgres) pool + **plain SQL** (no ORM) | The Go source is raw SQL with careful transactions/`ON CONFLICT` atomicity — porting SQL verbatim preserves correctness; ORMs would re-introduce risk. |
| Migrations | Plain numbered `.sql` files + tiny built-in runner (`schema_migrations` table) | Webcrft's SQL migrations port nearly unchanged. |
| Auth/crypto | `jose` (JWT), `node:crypto` AES-256-GCM (provider secrets), bcrypt/argon2 for customer passwords | Mirrors source semantics (AUTH_SECRETS_KEY encryption, JWT). |
| API | REST, date-versioned OpenAPI 3.1 generated from zod route schemas | Self-describing for agents; SDK generated, never hand-drifted. |
| Tests | **Vitest** suites mirroring webcrft's `tests/suites/*` + a runner script (`pnpm suite <name>`) | Keep the suite-per-concern model (commerce, checkout, idempotency, concurrency, money precision, IDOR, billing...). |
| Simulated time | Injectable `Clock` service + `BILLING_SIM_ENABLED` / `BILLING_SIM_DAY_SECONDS` (port of webcrft `billingsim`: day = N seconds, cycle = 30 days) | Whole billing lifecycle testable in seconds, in CI. |
| Jobs/cron | `worker` process mode (same entrypoint), interval-based schedulers; Redis optional (cache/rate-limit/locks) with in-memory fallback | OSS self-host needs only Postgres; Redis is an optimization. |
| MCP | Official `@modelcontextprotocol/sdk` (TS) — HTTP/SSE + stdio | First-class in TS; this is the hero feature. |
| Payments | Provider interface; clients ported from Go (Stripe PaymentIntents, Paystack, Razorpay, Xendit, custom-webhook) | BYO keys; same webhook verification semantics. |
| Search | Postgres full-text by default; pgvector embeddings when a BYO LLM key is configured | Semantic catalog without mandatory extra infra. |
| Admin | React 19 + Vite SPA in `admin/` (current scaffold) | Headless core; admin is just an API client. |
| Dev env | `.env` copied from webcrft-mono `.env.dev` (same var names) | Direct reuse of dev DATABASE_URL, JWT, Paystack, SES keys. |
| Multi-tenancy | org → stores, RLS, same as source | Proven; keep. |
| Cloud billing | Paystack; **bill in USD, charge in ZAR** via fx tables with immutable per-invoice rate snapshots | Mirrors webcrft's real internal billing. |

## What we port (feature parity with webcrft-mono commerce)

Source of truth (read-only): `/Users/pc/code/exo/webcrft-mono` —
`backend/internal/handlers/commerce*.go`, `backend/internal/commerce/checkout/complete.go`,
`backend/internal/payments/{stripe,paystack,razorpay,xendit}`, `backend/internal/webhooks/`,
`backend/internal/shipping/bobgo`, `backend/migrations/20260407000033_commerce.sql` (+ booking, rls, auth, api keys,
exchange_rates), `backend/internal/billingsim/`, `backend/tests/suites/*`, `public/commerce.js`,
`src/pages/admin/commerce.jsx`, `src/pages/admin/commerce-auth.jsx`.

Everything below exists in the source and must reach parity in Cartcrft:

1. **Stores & tenancy** — orgs, stores, multi-store, takedown/restore, RLS, store settings, i18n locales, translation tables.
2. **Catalog** — products (simple/bundle/configurable/digital/service/subscription/rental), options/values, variants
   (no variant/option caps), media (image/video/3D), collections (manual + smart rules), tags, metafields, SEO fields.
3. **Pricing** — variant prices, compare-at/cost, price lists (retail/wholesale/VIP/staff), per-currency lists,
   multi-currency with USD-based `exchange_rates` table + refresh job.
4. **Inventory** — warehouses, levels (on-hand/committed/incoming), adjustments audit, lots/expiry (FEFO), serial numbers,
   reorder points, suppliers.
5. **Carts & checkout** — carts/lines with price snapshots, checkout sessions (address/shipping/tax/discount resolution),
   atomic complete (price re-validation, `next_order_number()`, inventory decrement, discount burn — one transaction),
   abandoned cart capture + recovery tokens.
6. **Orders** — order/lines/adjustments/events, financial + fulfillment status machines, cancel, notes, test-mode orders.
7. **Payments** — provider abstraction (BYO keys): Stripe (PaymentIntent), Paystack, Razorpay, Xendit, custom-webhook
   provider; payment/attempt/refund records with idempotency uniques; capture/refund flows; dev/live credential modes;
   AES-256-GCM secret encryption; inbound webhook router (path + subdomain routing, per-provider signature verification,
   replay protection, GA4 server-side purchase events behind an interface).
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
    (GTIN/MPN/category), integration definitions registry, tracking pixels, notification providers
    (webhook/email/sms/whatsapp), outbound webhooks + delivery logs.
19. **Analytics** — ecommerce overview/products/funnel/revenue endpoints; standard event names.
20. **Platform API keys** — `cc_pub_` (read, embeddable) / `cc_prv_` (write/admin) key scheme.

## What we add (the "better" — agent-native layer)

21. **MCP server (ship by default, ship loud)** — browse/search/cart/checkout/order-status as MCP tools; per-store
    config; the hero feature. "Buyable in ChatGPT in 10 minutes."
22. **Semantic catalog** — pgvector embeddings (BYO LLM key; pg full-text fallback), `/search` designed for long
    natural-language agent queries; GEO-ready structured attributes.
23. **ACP adapter** — agentic checkout sessions, product feed at ACP spec, delegate payment/auth. Date-versioned,
    isolated under `backend/src/agent/acp/` so spec churn never touches core.
24. **UCP adapter** — catalog + checkout conformance for Google surfaces (after ACP).
25. **Trust layer** — `agents` (principal, scopes, spend limits) + `mandates` (intent/cart/payment, signed,
    audit-logged); AP2-style verifiable consent chain. First-class endpoints.
26. **Self-describing API** — OpenAPI date-versioned, machine-readable error envelope, idempotency keys on all
    mutating storefront endpoints.

## Cloud layer (thin, `cloud/`, own license)

27. **Tenant provisioning** — orgs/instances, quotas (commerce orders/mo metering like webcrft tiers).
28. **Billing** — port webcrft's internal billing shape: plans/tiers, subscription lifecycle (upgrade/cancel/renew,
    proration, billing-day change, grace period, auto-downgrade, dead-letter queue), wallet + top-ups, vouchers,
    invoices, refund records.
29. **Paystack rails** — card connect, charges, 3DS, webhooks. **Price book in USD; charges executed in ZAR** using
    `exchange_rates` fx tables (USD base) with rate snapshots stored on every invoice/charge for auditability.
30. **billingsim** — simulated time: configurable billing-day duration (`BILLING_SIM_DAY_SECONDS`), cycle = 30
    sim-days; entire billing lifecycle testable in seconds, in CI.
31. **Transparent cost dashboard** — what goes to whom (Paystack at cost, infra flat fee). Never % of GMV.

## Testing (first-class)

- Vitest with a suite-per-concern layout in `backend/tests/suites/` mirroring webcrft:
  `pnpm suite <name>` runs one suite; `pnpm test` runs all; `backend/tests/TESTS.md` is the index,
  RESULTS.md tracks pass state.
- Integration suites boot the real Fastify app against the dev Postgres (isolated schema per run), hit real HTTP.
- Suites at parity: commerce CRUD, checkout, idempotency, concurrency, money precision, cart IDOR, cross-org
  isolation, payments per provider (mocked provider HTTP), tax, returns, customer auth, feeds, validation, pentest-style.
- New suites: mcp (tool conformance), acp, mandates, semantic search, billing lifecycle under simulated time
  (subscribe → renew → fail → grace → downgrade with `BILLING_SIM_DAY_SECONDS=1`), fx (USD→ZAR snapshot assertions).
- Unit tests colocated `*.test.ts` (money math, proration, fx, signature verifiers) — run in the `unit` suite.

## Phases

- **Phase 0 — Skeleton**: monorepo layout ✅, licenses ✅, README ✅, logo, pnpm workspaces, TS backend skeleton
  (Fastify, config, pg pool, migration runner, healthz), vitest harness.
- **Phase 1 — Schema + core commerce**: port migrations (improved: pgvector, agents/mandates, `cc_` keys),
  stores/API keys, catalog, carts/checkout/orders, payments + webhook router — with suites.
- **Phase 2 — Full parity**: inventory, shipping, tax, discounts, wallet, customers+auth, B2B, subscriptions,
  returns, digital, reviews/wishlists, feeds/integrations, analytics.
- **Phase 3 — Agent layer**: MCP server + semantic catalog + mandates + ACP adapter. Hero demo.
- **Phase 4 — Cloud**: billing port (Paystack USD→ZAR, wallet, proration, grace, dead-letter), billingsim, quotas.
- **Phase 5 — SDK/admin/docs**: OpenAPI → @cartcrft/sdk, storefront.js, admin dashboard parity, docs,
  docker compose + seed, UCP, bookings/OTA.

## Open items

- Domains: cartcrft.dev / cartcrft.com availability check before launch.
- Cloud license exact text — drafted; legal review before launch.
- Embedding model default (BYO key first; no-key pg full-text fallback ships).
- ACP/UCP spec versions to pin at first conformance pass.
