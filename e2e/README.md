# @cartcrft/e2e

Playwright end-to-end tests and screenshot pipeline for Cartcrft.

## Screenshot pipeline

Produces retina-quality (2× DPI, 1512 × 982 viewport, dark colour scheme) PNG
captures of every major surface and saves them to `docs/screenshots/`.

### Prerequisites

Both dev servers must be running before you capture:

```sh
# Terminal 1 — backend API
pnpm dev          # starts backend on http://localhost:8080

# Terminal 2 — web / marketing + dashboard SPA
pnpm dev:web      # starts Vite / Astro on http://localhost:4321
```

### One-command capture (from repo root)

Seeds the demo database then captures all screenshots:

```sh
pnpm screenshots
```

This runs:
1. `pnpm --filter backend exec tsx src/scripts/seed-demo.ts` — seeds demo org, store, products, and orders.
2. `pnpm --filter @cartcrft/e2e run screenshots` — runs the Playwright screenshot project.

### Screenshots-only (no re-seed)

If the database is already seeded:

```sh
pnpm --filter @cartcrft/e2e run screenshots
```

### Output

| File | Surface |
|---|---|
| `docs/screenshots/landing.png` | Marketing landing — hero + stats band |
| `docs/screenshots/pricing.png` | Pricing page |
| `docs/screenshots/compare.png` | Comparison page |
| `docs/screenshots/docs.png` | Docs index |
| `docs/screenshots/dashboard-overview.png` | Admin dashboard — overview metrics |
| `docs/screenshots/dashboard-products.png` | Admin dashboard — product catalog |
| `docs/screenshots/dashboard-orders.png` | Admin dashboard — orders list |
| `docs/screenshots/superadmin-analytics.png` | Operator console — system analytics |
| `docs/screenshots/checkout.png` | Hosted checkout link page |

### Quality settings

Configured in `playwright.config.ts` under the `screenshots` project:

- `deviceScaleFactor: 2` — retina pixel density; crisp on HiDPI displays and in Retina-aware Markdown renderers.
- `viewport: { width: 1512, height: 982 }` — standard 16:10 MacBook Pro resolution.
- `colorScheme: 'dark'` — matches the Agentic Terminal design system.
- Scrollbars are hidden via injected CSS before every capture.
- Each page waits for `networkidle` **and** a content-specific sentinel selector (an actual data element, never a "Loading…" spinner) before firing the shutter. A short settle delay allows reveal animations to complete.

## E2E tests

```sh
# Run the full spec suite
pnpm test

# Run a specific spec
pnpm exec playwright test tests/dashboard.spec.ts
```
