# @cartcrft/web

Marketing site and documentation hub for Cartcrft. Built with [Astro](https://astro.build/) + [Starlight](https://starlight.astro.build/).

## Stack

- **Astro 5** — static output (`output: 'static'`)
- **@astrojs/starlight** — docs site (routes under `/docs/*`)
- **Node 22**

## Dev

```bash
# from repo root
pnpm --filter @cartcrft/web dev
# or from web/
pnpm dev          # http://localhost:4321
```

## Build

```bash
# from repo root
pnpm build:web
# or from web/
pnpm build        # outputs to web/dist/
```

## Preview

```bash
pnpm --filter @cartcrft/web preview
```

## Routes

| Route              | Source                              | Owner                |
|--------------------|-------------------------------------|----------------------|
| `/`                | `src/pages/index.astro`             | landing-agent        |
| `/compare`         | `src/pages/compare.astro`           | comparison-agent     |
| `/pricing`         | `src/pages/pricing.astro`           | pricing-agent        |
| `/legal/terms`     | `src/pages/legal/terms.astro`       | legal-agent          |
| `/legal/privacy`   | `src/pages/legal/privacy.astro`     | legal-agent          |
| `/legal/popia`     | `src/pages/legal/popia.astro`       | legal-agent          |
| `/legal/gdpr`      | `src/pages/legal/gdpr.astro`        | legal-agent          |
| `/docs/**`         | Starlight / `src/content/docs/*.md` | docs-agent           |

## Docs wiring

`/docs/**` routes are served by Starlight. The markdown source lives in `web/src/content/docs/` — these are **copies** of `docs/*.md` at the repo root (copied at scaffold time; the docs-agent will maintain them going forward).

To sync from repo root docs:
```bash
cp ../docs/*.md src/content/docs/
```

Starlight requires `title:` frontmatter in every doc. A minimal frontmatter block was prepended to each file at scaffold time (marked `# TODO(docs-agent): refine`). The docs-agent should replace these with correct titles, descriptions, sidebar labels, and ordering.

## Reusable components

| Component         | File                                        | Key props                                        |
|-------------------|---------------------------------------------|--------------------------------------------------|
| `Hero`            | `src/components/Hero.astro`                 | `headline`, `subheadline`, `ctaPrimary`, `ctaSecondary`, `badge` |
| `FeatureGrid`     | `src/components/FeatureGrid.astro`          | `features[]`, `columns`, `heading`, `subheading` |
| `ComparisonTable` | `src/components/ComparisonTable.astro`      | `competitors[]`, `rows[]`, `ourName`, `caption`  |
| `PricingCard`     | `src/components/PricingCard.astro`          | `name`, `price`, `features[]`, `cta`, `highlighted` |

Layouts:
- `MarketingLayout` — shared shell for `/`, `/compare`, `/pricing`, `/legal/*` (header + footer)
- `LegalLayout` — extends MarketingLayout with legal breadcrumb + sidebar nav
- Docs pages use Starlight's own layout (configured in `astro.config.mjs`)

## Deploy

### Build

```bash
# OSS build (no cloud billing/account pages bundled)
pnpm --filter @cartcrft/web build

# Cloud build (includes cloud pages in the JS bundle)
PUBLIC_CARTCRFT_CLOUD=1 pnpm --filter @cartcrft/web build
```

Output lands in `web/dist/`. Set `PUBLIC_API_URL` before building so the dashboard SPA knows where the backend lives:

```bash
PUBLIC_API_URL=https://api.yourstore.com PUBLIC_CARTCRFT_CLOUD=1 pnpm --filter @cartcrft/web build
```

### SPA fallback — critical for /dashboard/* deep links

The dashboard is a React SPA mounted at `/dashboard`. Serving `/dashboard/products` directly (e.g. on page refresh or a bookmarked URL) must return the `dashboard/index.html` shell, not a 404. Each host has its own mechanism:

**Netlify / Cloudflare Pages**

A `_redirects` file in `web/dist/` (or `web/public/`) handles this:

```
/dashboard/*  /dashboard/index.html  200
```

This file is committed at `web/public/_redirects` and copied to `web/dist/` automatically during the Astro build (Astro copies everything in `public/` verbatim).

**Bunny CDN (Pull Zone)**

Bunny does not honour `_redirects` files. Instead configure these Pull Zone settings:

1. **Error pages** → set the 404 page to `/dashboard/index.html` — this causes any unknown `/dashboard/*` path to serve the SPA shell.
2. **Alternatively**, use a Bunny Edge Rule: `If URL path starts with /dashboard/ → Rewrite URL to /dashboard/index.html` with a 200 response (not a redirect).

**Cloudflare Pages (alternative)**

Add a `_redirects` file (already committed in `web/public/`). Cloudflare Pages automatically processes it.

**Nginx / self-host**

```nginx
location /dashboard/ {
    try_files $uri $uri/ /dashboard/index.html;
}
```

### Cloudflare Pages

1. Connect the repo in the Cloudflare Pages dashboard.
2. Build command: `pnpm build:web`
3. Output directory: `web/dist`
4. Environment variables: `PUBLIC_API_URL`, optionally `PUBLIC_CARTCRFT_CLOUD=1`
5. The `web/public/_redirects` file is included in the build output and handles SPA routing automatically.

### Netlify

1. Build command: `pnpm build:web`
2. Publish directory: `web/dist`
3. Environment variables: `PUBLIC_API_URL`, optionally `PUBLIC_CARTCRFT_CLOUD=1`
4. The `web/public/_redirects` file handles SPA routing automatically.

### Bunny CDN (primary host)

1. Upload `web/dist/` to your Bunny Storage Zone (or use the Bunny CDN deploy action).
2. Point a Pull Zone at the storage zone.
3. Add an Edge Rule: `If URL path starts with /dashboard/ → Rewrite URL to /dashboard/index.html` (200, not 301/302).
4. Enable "Perma-Cache" and configure Cache-Control headers.
5. Set `Cache-Control: no-store` on `_astro/*.js` entries that include the API URL (or use runtime env injection — see below).
