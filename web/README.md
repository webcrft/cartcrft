# @cartcrft/web

The entire Cartcrft web frontend — marketing site, documentation, merchant
dashboard, and super-admin console — as a **single Vite + React SPA**.

## Stack

- **Vite 6** — one client-rendered SPA (no SSR/static gen)
- **React 19** + **react-router-dom 6**
- **Tailwind CSS v4** (`@tailwindcss/vite`) — scoped to the dashboard/superadmin
  zones via `#dashboard-root` / `#superadmin-root`
- **react-markdown** + **rehype-highlight** + **MiniSearch** — the docs system
- **Node 22**

## Architecture — the zone router

`src/main.tsx` mounts `src/Root.tsx`, which selects ONE sub-app by URL prefix at
load time (each keeps its own `<BrowserRouter>`, so crossing zones is a normal
full-page navigation):

| URL prefix      | Zone                       | Source                  |
|-----------------|----------------------------|-------------------------|
| `/dashboard*`   | merchant admin SPA         | `src/dashboard/`        |
| `/superadmin*`  | operator console SPA       | `src/superadmin/`       |
| everything else | marketing + docs (`SiteApp`) | `src/site/`           |

Each zone is a lazy import, so its CSS/JS (and theme) only load for that zone.

### Site zone (`src/site/`)

- `SiteLayout.tsx` — shared header/footer chrome + scroll-reveal observer.
- `marketing/` — `Landing`, `Compare`, `Pricing`, `legal/*`, and the
  `Hero`/`FeatureGrid`/`ComparisonTable`/`PricingCard` components. Exports
  `marketingRoutes`.
- `docs/` — loads `src/content/docs/**/*.md` via `import.meta.glob`, renders with
  `react-markdown` (GFM + slug + syntax highlight), with a Starlight-parity
  sidebar, right-rail TOC, and a MiniSearch ⌘K modal. Exports `docRoutes`
  (lazy-loaded so the marketing landing never ships the markdown bundle).

## Dev / build / preview

```bash
pnpm --filter @cartcrft/web dev       # http://localhost:4321
pnpm --filter @cartcrft/web build     # → web/dist/
pnpm --filter @cartcrft/web preview
pnpm --filter @cartcrft/web typecheck # tsc --noEmit
pnpm --filter @cartcrft/web test      # vitest smoke suites (site + dashboard + superadmin)
```

### Cloud vs OSS build

`PUBLIC_CARTCRFT_CLOUD=1` enables managed-cloud surfaces (billing/account pages,
cloud docs + nav). Unset = OSS build with no cloud surface. Set `PUBLIC_API_URL`
to point the SPA at the backend:

```bash
PUBLIC_API_URL=https://api.yourstore.com PUBLIC_CARTCRFT_CLOUD=1 \
  pnpm --filter @cartcrft/web build
```

`PUBLIC_*` vars are read from the repo-root `.env` in dev (`envDir` in
`vite.config.ts`); only `VITE_`/`PUBLIC_`-prefixed vars are exposed to the
client — repo-root secrets are never bundled.

## Deploy — SPA fallback is mandatory

The whole site is client-rendered, so **every** path must serve the single
`index.html` shell; the zone router then mounts the right sub-app. A catch-all
rewrite is committed at `web/public/_redirects` (copied into `dist/` by Vite):

```
/*  /index.html  200
```

**Netlify / Cloudflare Pages** — honour `_redirects` automatically. Build:
`pnpm --filter @cartcrft/web build`, publish dir `web/dist`, env `PUBLIC_API_URL`
(+ optional `PUBLIC_CARTCRFT_CLOUD=1`).

**Nginx / self-host**

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

**Bunny CDN / hosts without `_redirects`** — set the Pull Zone 404 page to
`/index.html`, or add an Edge Rule: any path → rewrite to `/index.html` (200,
not a redirect).

> Note: SEO is client-rendered (this is a client-only SPA by design). Crawlers
> that execute JS still see the content; pre-render the marketing routes if
> first-paint SEO becomes a priority.
