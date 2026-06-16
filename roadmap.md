# Cartcrft Roadmap

> The open-source, agent-native, headless commerce backend. TypeScript end-to-end.
> A WebCrft project. This file is the destination map; `tasks.md` is the work queue.

Last updated: 2026-06-13 (post-build hardening)

---

## Where we are

The full feature build (Waves 0–6) is **code-complete and the test suites are green** —
backend ~830 tests / 45 suites, cloud billing 174, SDK 7; all five workspace packages
typecheck and build; the Docker compose stack boots and seeds. The webcrft-mono commerce
system has been extracted and removed (branch `remove-commerce`).

A verified fan-out review (2026-06-13, 53 confirmed findings, 0 refuted) then established the
honest truth: **green tests masked real gaps.** Several advertised features are fully built
but never wired into the running process, the multi-tenant isolation story is weaker than it
looks, and a handful of prod-only bugs are invisible to the current tests. The product is a
strong, broad foundation — but **not yet production-safe**. That gap is now the roadmap.

## The shift: from "built" to "production-safe"

The remaining work is no longer feature breadth — it's **wiring, hardening, and honesty**:

1. **Make built features actually run.** Live payments, cloud billing migration + scheduling,
   outbound webhooks, notifications, analytics — all exist as code with zero production callers.
2. **Make multi-tenancy trustworthy.** RLS is currently inert at runtime; isolation rests on
   app-layer checks alone. Decide and enforce one coherent posture, with tests proving it.
3. **Close the prod-only bugs** the test harness can't see (auth-secret encryption mismatch,
   cloud-mode boot).
4. **Honor the contracts we set ourselves** — zod-as-OpenAPI-source, money-as-strings, the
   unified error envelope — so the generated SDK and docs are trustworthy.
5. **Make the admin reachable.** It builds but has dead-ends (no store creation, broken pages,
   no auth-expiry handling) and zero tests.
6. **Tell the truth in docs.** Drop or qualify "shipped" claims for test-mode-only / stubbed
   paths (live agentic payments, OTA push, GA4).

## Honest feature status (what actually runs today)

| Area | Status | Note |
|---|---|---|
| Catalog, carts, checkout (test mode), orders, inventory, tax, shipping, discounts, wallet, customers/auth, B2B CRUD, subscriptions CRUD, returns, digital, reviews/wishlists, feeds | **Working** | Core commerce is real and tested. |
| **Live payment capture** | **Broken** | Session creation is a 501 stub; provider clients are dead code. |
| **Cloud billing (Paystack USD→ZAR)** | **Built, not running** | Migrations never applied; worker/scheduler never started. |
| Outbound webhooks, notifications (email/SMS), analytics/GA4 | **Built, not wired** | Defined; zero production callers; analytics has no table. |
| Multi-tenant isolation | **App-layer only** | RLS defined but bypassed at runtime. |
| MCP / semantic search / ACP / UCP / mandates | **Working (test-mode payments)** | Agent browse+buy works; live agentic card payment returns 501. |
| Bookings + iCal | **Working** | Live OTA channel push is NOT_IMPLEMENTED. |
| Admin dashboard | **Builds, unproven** | Dead-ends + zero tests; never run in a browser. |

## Hardening phases (the path to production)

Detailed, agent-executable tasks live in `tasks.md`. Phase summary:

- **Phase H0 — Blockers.** Live payment wiring; cloud-mode bootstrap (migrations + worker +
  scheduler); auth-secret encryption fix. Nothing ships until these are closed.
- **Phase H1 — Security.** Tenant-isolation posture (enforce RLS *or* prove app-layer with an
  IDOR sweep); CORS + security headers; MCP key handling; timing-safe super-admin; refund
  idempotency.
- **Phase H2 — Wire the built-but-dead.** Outbound webhooks + notification mailer; analytics
  table + sink + GA4 purchase; subscription billing scheduler + FX refresh; worker locks; B2B
  credit enforcement.
- **Phase H3 — Contracts.** Register zod as Fastify route schemas (fixes OpenAPI + SDK typing);
  money-as-strings everywhere; uniform error envelope; returns-exchange + dunning completion.
- **Phase H4 — Admin.** Store-creation / API-key / digital UIs; fix broken pages; 401 handling;
  surface load errors; pagination; a smoke test suite.
- **Phase H5 — Deliberate gaps (optional, larger).** Live ACP/UCP delegated payments; OTA live
  push + scheduled iCal pull; x402 experiment.
- **Phase H6 — Docs & polish.** README/docs accuracy; bcrypt/argon2; JWT iss/aud; remaining
  test gaps; misc cleanups.

## Definition of "production-ready" (exit criteria)

- A real card payment completes end-to-end via a live provider session (H0).
- Cloud billing migrates, charges, and renews from the booted worker under simulated time (H0).
- A documented, test-enforced tenant-isolation guarantee (H1).
- Every feature the README marks "shipped" is reachable at runtime or explicitly qualified (H2/H6).
- Generated OpenAPI carries request bodies; the SDK is fully typed (H3).
- Admin can create a store and survives token expiry; has a passing smoke suite (H4).

## Unchanged principles

Agent-native first; BYO keys / 0% take rate; DX as the retention moat; MIT core with a thin
cloud layer under its own license; self-hosting never requires `cloud/`. Stack stays Node 22 +
Fastify 5 + zod + `pg` (plain SQL) + Vitest, pnpm workspaces, React 19 admin.
