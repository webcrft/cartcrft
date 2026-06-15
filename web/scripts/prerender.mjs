/**
 * prerender.mjs — post-build prerender for SEO
 *
 * Run AFTER `vite build`. Starts a `vite preview` server, then uses
 * Playwright (from the e2e workspace) to visit each static public route and
 * write the fully-rendered HTML to dist/<route>/index.html.
 *
 * Crawlers get real HTML; users still get the SPA (the <script> tags stay,
 * React re-mounts and takes over normally — i.e. islands/SSR-like hydration).
 *
 * Routes prerendered (marketing + docs; NOT /dashboard or /superadmin):
 *   - / → dist/index.html  (overwrites the SPA shell)
 *   - /compare, /pricing, /docs, /legal/*, /quickstart, … etc.
 *
 * Usage:
 *   node scripts/prerender.mjs            # OSS routes only
 *   node scripts/prerender.mjs --cloud    # also include cloud/* doc routes
 *
 * The npm script `build:seo` runs both in sequence:
 *   vite build && node scripts/prerender.mjs
 *
 * Playwright must be available. This script shells out to the e2e workspace's
 * @playwright/test package so no extra dep is needed in the web package.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(__dirname, '..')
const DIST_DIR = join(WEB_ROOT, 'dist')
const DOCS_DIR = join(WEB_ROOT, 'src/content/docs')

const INCLUDE_CLOUD = process.argv.includes('--cloud')
const PREVIEW_PORT = 4322  // Use a different port from dev (4321) to avoid conflicts
const BASE_URL = `http://localhost:${PREVIEW_PORT}`

// ── Route list (mirrors gen-sitemap.mjs) ────────────────────────────────────

const STATIC_ROUTES = ['/', '/compare', '/pricing', '/docs',
  '/legal/terms', '/legal/privacy', '/legal/popia', '/legal/gdpr']

function collectMd(dir, base = dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const results = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) results.push(...collectMd(full, base))
    else if (e.isFile() && e.name.endsWith('.md')) {
      const rel = full.slice(base.length + 1).replace(/\\/g, '/')
      results.push(rel)
    }
  }
  return results
}

function docSlugs() {
  return collectMd(DOCS_DIR)
    .map((p) => p.replace(/\.md$/, ''))
    .filter((s) => {
      const base = s.split('/').pop() ?? s
      if (base === 'index' || base === 'README') return false
      if (!INCLUDE_CLOUD && s.startsWith('cloud/')) return false
      return true
    })
}

const ALL_ROUTES = [...STATIC_ROUTES, ...docSlugs().map((s) => `/${s}`)]

// ── Start vite preview server ────────────────────────────────────────────────

function startPreviewServer() {
  console.log(`Starting vite preview on port ${PREVIEW_PORT}…`)
  // node_modules/.bin/vite is a shell wrapper — use shell: true so the OS executes it
  const proc = spawn(
    'node_modules/.bin/vite',
    ['preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: WEB_ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: true }
  )
  proc.stdout.on('data', (d) => process.stdout.write(d))
  proc.stderr.on('data', (d) => process.stderr.write(d))
  return proc
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (r.ok || r.status === 404) return  // SPA returns 200 for all routes
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`)
}

// ── Playwright setup ─────────────────────────────────────────────────────────

const E2E_PW = join(WEB_ROOT, '../e2e/node_modules/@playwright/test/index.js')
if (!existsSync(E2E_PW)) {
  console.error(`Playwright not found at ${E2E_PW}. Run pnpm install in e2e/ first.`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const { chromium } = require(E2E_PW)

// ── Write prerendered HTML ───────────────────────────────────────────────────

function writeRouteHtml(route, html) {
  if (route === '/') {
    // Overwrite the root SPA shell
    writeFileSync(join(DIST_DIR, 'index.html'), html, 'utf-8')
    return
  }
  // Nested: dist/compare/index.html, dist/quickstart/index.html, etc.
  const dir = join(DIST_DIR, route.slice(1))  // strip leading /
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html, 'utf-8')
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(DIST_DIR)) {
    console.error('dist/ not found. Run `vite build` first.')
    process.exit(1)
  }

  const server = startPreviewServer()

  try {
    await waitForServer(`${BASE_URL}/`)
    console.log('Preview server ready.\n')

    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ javaScriptEnabled: true })
    const page = await context.newPage()

    let ok = 0, fail = 0

    for (const route of ALL_ROUTES) {
      const url = `${BASE_URL}${route}`
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })

        // Wait for React to render: look for <main> or an <h1> or any real content
        // The SPA shell has an empty <div id="root"> until React mounts.
        await page.waitForFunction(
          () => {
            const root = document.getElementById('root')
            return root && root.children.length > 0
          },
          { timeout: 15_000 }
        ).catch(() => {
          // Some routes may not have a #root child immediately — best effort
        })

        const html = await page.content()
        writeRouteHtml(route, html)
        console.log(`  ✓ ${route}`)
        ok++
      } catch (err) {
        console.error(`  ✗ ${route}: ${err.message}`)
        fail++
      }
    }

    await browser.close()
    console.log(`\nPrerender done: ${ok} routes OK, ${fail} failed.`)

    // Verify root route has real content
    const rootHtml = readFileSync(join(DIST_DIR, 'index.html'), 'utf-8')
    const hasContent = rootHtml.includes('</div>') && rootHtml.length > 5000
    const hasScript = rootHtml.includes('<script')
    console.log(`Root index.html: ${rootHtml.length} bytes, hasContent=${hasContent}, hasScript=${hasScript}`)

    if (!hasContent) {
      console.warn('WARNING: Root HTML may not have rendered content. Check the SPA is building correctly.')
    }

    if (fail > 0) process.exit(1)
  } finally {
    server.kill()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
