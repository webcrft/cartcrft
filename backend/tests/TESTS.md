# Test Suite Index

Run any suite: `pnpm suite <name>` from the repo root (or `backend/` dir).

Check off a suite when it passes end-to-end; leave unchecked if new,
flaky, or failing. Run state is tracked in `RESULTS.md`.

Suite files live in `backend/tests/suites/<name>.test.ts`.
Shared infrastructure: `backend/tests/shared/ctx.ts` (schema-isolated test
context), `backend/tests/shared/helpers.ts` (HTTP + fixture helpers).

---

## Wave 0 — Skeleton

- [x] `smoke` — Server boots; `GET /healthz` responds 200; migration runner is
  idempotent on the test schema (run twice, second run is no-op); 404 route
  returns the `{ error: { code, message } }` envelope.

---

## Wave 2 — Core commerce (after Wave 1 migrations land)

### Stores & API keys
- [ ] `stores` — Store CRUD (create/get/list/update/delete), org scoping,
  handle uniqueness, takedown/restore. Port: `commerce.go` stores subset +
  `platform_apikeys.go`.
- [ ] `apikeys` — `cc_pub_` / `cc_prv_` key issue/verify (hash at rest), scope
  enforcement (read/write/admin), expiry, revocation, tamper detection.

### Catalog
- [ ] `catalog` — Products (simple/bundle/configurable/digital/service/
  subscription/rental), options/values, variants (no caps), media, bundle
  items, collections (manual + smart rules), translations, metafields.
  Port: `commerce_validation.go`.
- [ ] `catalog-validation` — Pins 400-rejection contract for every catalog
  CREATE handler: product price (non-numeric/negative/zero), variant price,
  tax_rate range, discount value, address country_code, bundle item quantity,
  cart line quantity.

### Carts, checkout, orders
- [x] `checkout/checkout` — Cart → checkout → complete (atomic): price re-validation,
  `next_order_number()`, inventory decrement, discount burn, cart→converted.
  Cart CRUD + lines (price snapshot), checkout create/get/update, abandoned-
  cart capture. Port: `commerce_checkout.go`. 21/21 ✓ T2.3 2026-06-12
- [x] `checkout/idempotency` — Second POST to `/checkouts/{id}/complete` after success
  must not create a second order. Cart cannot be reused after conversion.
  Port: `commerce_idempotency.go`. 5/5 ✓ T2.3 2026-06-12
- [x] `checkout/concurrency` — Single-unit variant: two parallel checkouts, only one
  succeeds (FOR UPDATE serialization). Once-per-customer discount race → only 1 usage.
  Port: `commerce_concurrent.go` + extras. 3/3 ✓ T2.3 2026-06-12
- [x] `checkout/money` — Money precision: round2, toCents/fromCents, currency exponents.
  Tax apportionment last-line absorbs rounding remainder. Price re-validation at complete time.
  Port: `commerce_money_precision.go`. 8/8 ✓ T2.3 2026-06-12
- [x] `checkout/cart-idor` — Same-org cart cross-line IDOR: pairing cart-A id with
  cart-B line id is rejected. Cross-store IDOR blocked. Port: `commerce_cart_idor.go`. 9/9 ✓ T2.3 2026-06-12

### Payments & webhooks
- [ ] `payments` — Payment create/capture/list; refund (+lines, restock flag);
  provider clients (Stripe/Paystack/Razorpay/Xendit) via mocked HTTP.
  Port: `commerce_payments.go`.
- [ ] `gateways` — `payment_gateway_instances` CRUD + AES-256-GCM round-trip.
  Port: `commerce_payment_gateways.go` (undici MockAgent).
- [ ] `webhooks` — Signed fixture payloads for all four providers; replay
  rejection (event-id dedup); `recordPaymentSuccess` auto-completes pending
  checkout; duplicate delivery is idempotent. Port: `commerce_payment_dev.go`.

### Inventory, shipping, tax
- [ ] `inventory` — Warehouses, levels set/adjust (+audit), lots (FEFO),
  serials (bulk create/status), suppliers. Port: inventory parts of
  `commerce_extended.go`.
- [ ] `shipping` — Zones/regions/rates, `shipping-rates/available` (static +
  BobGo mocked), collection points, shipments + lines + tracking events.
  Port: `commerce_shipping.go`.
- [ ] `tax` — Categories/zones/regions/rates + computation (inclusive/
  exclusive). End-to-end tax application during cart→checkout→order.
  Port: `commerce_tax.go`.

### Discounts, wallet, gift cards
- [ ] `discounts` — Codes CRUD + validate (all five types incl. BOGO/
  buy-x-get-y), automatic discounts, usage limits + once-per-customer.
  Port: discount parts of `commerce_customers.go` + `commerce_gaps.go`.
- [ ] `wallet` — Store credits issue/adjust + append-only ledger with
  `balance_after`. Port: `commerce_wallet.go`.
- [ ] `giftcards` — Gift card CRUD/lookup/disable + transactions; ledger
  invariants; concurrent redemption. Port: gift-card parts.

### Customers & auth
- [ ] `customer-auth` — Register/login (lockout), sessions (hashed tokens),
  refresh, logout, password reset, email verify, magic links, invites,
  OAuth PKCE (Google/Microsoft/Discord); audit log + email log.
  Port: `commerce_auth.go`.
- [ ] `cross-org` — IDOR / cross-tenant authz: every commerce endpoint scoped
  to org-A's storeID is hit with org-B's JWT — must be denied. Port:
  `commerce_cross_org.go`.

### B2B, subscriptions, returns, digital, reviews
- [ ] `b2b` — Companies (credit limits, net terms, PO numbers), quotes
  lifecycle (draft→sent→accepted→order), purchase orders, customer groups +
  group price lists. Port: `commerce_b2b.go`.
- [ ] `subscriptions` — Plans + subscriptions (pause/resume/cancel/bill);
  Clock-injectable so billingsim-compatible. Port: `commerce_subscriptions.go`.
- [ ] `returns` — Return requests/lines/events, refund/exchange/store-credit/
  repair types, restock. Port: `commerce_returns.go`.
- [ ] `digital` — Digital files + tokenized download links (max downloads,
  expiry). Port: `commerce_gaps.go` digital subset.
- [ ] `reviews-wishlists` — Moderated reviews (verified-purchase flag),
  wishlists + share tokens. Port: `commerce_gaps.go` review/wishlist subset.

### Feeds, integrations, analytics
- [ ] `feeds` — Google Shopping XML + Facebook Catalog feeds; merchant feed
  configs. Port: `commerce_feeds.go`.
- [ ] `notifications` — Notification providers CRUD + dispatch (`order.created`
  → webhook sink). Port: `commerce_notifications.go`.
- [ ] `integrations` — Store integrations CRUD (Zapier/Mailchimp), tracking
  pixels, outbound webhook delivery + delivery log. Port:
  `commerce_integrations.go`.

---

## Wave 3 — Agent-native layer

- [ ] `mcp` — MCP server: `initialize`, `tools/list`, call each tool
  (`search_products`, `create_cart`, `add_to_cart`, `start_checkout`,
  `complete_checkout`, `get_order_status`) against a seeded store.
- [ ] `acp` — ACP adapter: product feed at ACP shape, agentic checkout session
  create/update/complete mapped to core checkout service.
- [ ] `mandates` — Agent CRUD, mandate create/verify (ed25519 chain),
  intent→cart→payment chain validity, tamper detection, spend ceiling breach,
  expiry. Port: new (no webcrft analog).

---

## Wave 4 — Cloud billing (after Wave 1)

- [ ] `billing` — Full lifecycle with `BILLING_SIM_DAY_SECONDS=1`: subscribe →
  2 renewals → failed charge → grace → auto-downgrade. Port: `billing.go`.
- [ ] `billing-math` — Pure math: `calcOverageCost`, `shouldAutoTopup`,
  `walletCoversOverage`, proration, billing-day bounds. Port: `billing_math.go`.
- [ ] `billing-wallet` — Wallet balance, top-up, deduction, ledger, cross-org
  isolation. Port: `billing_wallet.go`.
- [ ] `billing-holes` — Mid-cycle proration on subscribe, subscribe-to-current
  400, free→paid lifecycle. Port: `billing_holes.go`.
- [ ] `fx` — USD→ZAR snapshot assertions: rate change between invoices leaves
  old snapshots untouched. New (no webcrft analog).

---

## Unit (colocated — runs with `pnpm test`)

- [ ] `unit` — Money math (numeric string safety, no float), proration helpers,
  AES-256-GCM secrets round-trip, webhook signature verifiers (Stripe/Paystack/
  Razorpay/Xendit with fixture payloads).

---

## Environment flags

| Env var | Used by |
|---------|---------|
| `DATABASE_URL` | All integration suites — required |
| `JWT_SECRET` | Suites that mint JWTs (Wave 2+) |
| `PAYSTACK_SECRET_KEY` | `webhooks`, `billing` (provider HTTP) |
| `STRIPE_SECRET_KEY` | `gateways`, `webhooks` |
| `BILLING_SIM_DAY_SECONDS` | `billing` (accelerated cron) |
| `VITEST_LOG=1` | Enables Fastify + pg log output during tests |
