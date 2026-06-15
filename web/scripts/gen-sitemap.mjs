/**
 * gen-sitemap.mjs — generates web/public/sitemap.xml
 *
 * Derives URL list from:
 *   - hardcoded marketing + legal routes (/, /compare, /pricing, /legal/*)
 *   - the /docs index
 *   - every docs slug from src/content/docs/** /*.md
 *     (mirrors the OSS slug logic in src/site/docs/index.tsx:
 *      excludes index/README files and cloud/* docs for OSS builds)
 *
 * Usage:
 *   node scripts/gen-sitemap.mjs
 *   node scripts/gen-sitemap.mjs --cloud   # include cloud/* docs
 *
 * Run this after adding new docs pages or marketing routes.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const DOCS_DIR = join(REPO_ROOT, 'src/content/docs')
const OUT_FILE = join(REPO_ROOT, 'public/sitemap.xml')

const BASE_URL = 'https://cartcrft.dev'
const INCLUDE_CLOUD = process.argv.includes('--cloud')

// ── 1. Static marketing + docs-home routes ─────────────────────────────────

const STATIC_ROUTES = [
  { path: '/',               priority: '1.0', changefreq: 'weekly'  },
  { path: '/compare',        priority: '0.8', changefreq: 'monthly' },
  { path: '/pricing',        priority: '0.8', changefreq: 'monthly' },
  { path: '/docs',           priority: '0.9', changefreq: 'weekly'  },
  { path: '/legal/terms',    priority: '0.3', changefreq: 'yearly'  },
  { path: '/legal/privacy',  priority: '0.3', changefreq: 'yearly'  },
  { path: '/legal/popia',    priority: '0.3', changefreq: 'yearly'  },
  { path: '/legal/gdpr',     priority: '0.3', changefreq: 'yearly'  },
]

// ── 2. Doc slugs (mirrors src/site/docs/index.tsx logic) ───────────────────

/** Recursively collect all .md files under dir, returning paths relative to dir. */
function collectMd(dir, base = dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const results = []
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      results.push(...collectMd(full, base))
    } else if (e.isFile() && e.name.endsWith('.md')) {
      results.push(relative(base, full))
    }
  }
  return results
}

function slugFromRelPath(relPath) {
  // "cloud/overview.md" → "cloud/overview"
  return relPath.replace(/\.md$/, '').replace(/\\/g, '/')
}

const docSlugs = collectMd(DOCS_DIR)
  .map(slugFromRelPath)
  .filter((slug) => {
    const base = slug.split('/').pop() ?? slug
    if (base === 'index' || base === 'README') return false
    if (!INCLUDE_CLOUD && slug.startsWith('cloud/')) return false
    return true
  })

const docRoutes = docSlugs.map((slug) => ({
  path: `/${slug}`,
  priority: slug.includes('/') ? '0.5' : '0.7',
  changefreq: 'monthly',
}))

// ── 3. Build XML ────────────────────────────────────────────────────────────

const today = new Date().toISOString().split('T')[0]

const allUrls = [...STATIC_ROUTES, ...docRoutes]

const urlEntries = allUrls
  .map(({ path, priority, changefreq }) => {
    const loc = `${BASE_URL}${path}`
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${today}</lastmod>`,
      `    <changefreq>${changefreq}</changefreq>`,
      `    <priority>${priority}</priority>`,
      '  </url>',
    ].join('\n')
  })
  .join('\n')

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>
`

writeFileSync(OUT_FILE, xml, 'utf-8')

const count = allUrls.length
console.log(`✓ Wrote ${OUT_FILE} (${count} URLs, cloud=${INCLUDE_CLOUD})`)
