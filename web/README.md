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

Static build targets `web/dist/`. The repo uses **Bunny CDN** (see `.env` `SUPER_BUNNY_*`) for CDN delivery. Compatible with Cloudflare Pages and Netlify as alternatives.

For Bunny CDN:
- Upload `web/dist/` to your Bunny Storage Zone
- Point a Pull Zone at the storage zone
- Enable "Perma-Cache" and set Cache-Control headers as appropriate

For Cloudflare Pages: connect the repo, set build command `pnpm build:web`, output directory `web/dist`.
