import { Suspense, lazy } from 'react'
import type { SiteRoute } from '../types'

// Lazy-load the markdown renderer so react-markdown + highlight.js + the docs
// chrome land in their own chunk — the marketing landing never ships them.
const DocPage = lazy(() => import('./DocPage'))
const DocsHome = lazy(() => import('./DocsHome'))

/**
 * Docs module — replaces the prior Astro Starlight site. Markdown lives in
 * src/content/docs/**\/*.md and is loaded at build time via Vite's glob import.
 * This file owns:
 *   - parsing frontmatter + body out of each .md
 *   - the slug → doc map (docMap) and the route list (docRoutes)
 *   - the flat docList used to build the MiniSearch index
 *
 * Sidebar structure is a hardcoded config (SIDEBAR in DocsLayout) that mirrors
 * the old Starlight astro.config.mjs sidebar exactly.
 */

const CLOUD = import.meta.env.PUBLIC_CARTCRFT_CLOUD === '1'

export interface Doc {
  /** Route-relative slug, no leading slash: e.g. "quickstart", "cloud/overview". */
  slug: string
  /** Full route path: "/" + slug. */
  path: string
  title: string
  description: string
  /** Markdown body with frontmatter stripped. */
  body: string
}

/** Parse a simple `---\n…\n---` frontmatter block. Only top-level scalar keys
 *  are read (title, description); nested/indented lines (e.g. Starlight's
 *  `sidebar:` block) are ignored. Returns the parsed fields + remaining body. */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) return { data: {}, body: raw }

  const block = match[1] ?? ''
  const body = raw.slice(match[0].length)
  const data: Record<string, string> = {}

  for (const line of block.split(/\r?\n/)) {
    // Skip blank lines, comments, and indented (nested) keys.
    if (!line.trim() || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#')) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    // Strip surrounding single or double quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (value) data[key] = value
  }

  return { data, body }
}

/** file path relative to content/docs, no extension → slug.
 *  "../../content/docs/cloud/overview.md" → "cloud/overview". */
function slugFromPath(filePath: string): string {
  const after = filePath.split('/content/docs/')[1] ?? filePath
  return after.replace(/\.md$/, '')
}

const files = import.meta.glob('../../content/docs/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const allDocs: Doc[] = []

for (const [filePath, raw] of Object.entries(files)) {
  const slug = slugFromPath(filePath)
  const base = slug.split('/').pop() ?? slug

  // Exclude index/README — they are not generated as pages.
  if (base === 'index' || base === 'README') continue
  // OSS builds ship zero cloud surface.
  if (!CLOUD && slug.startsWith('cloud/')) continue

  const { data, body } = parseFrontmatter(raw)
  allDocs.push({
    slug,
    path: `/${slug}`,
    title: data.title ?? slug,
    description: data.description ?? '',
    body,
  })
}

/** slug → Doc. */
export const docMap: Record<string, Doc> = Object.fromEntries(
  allDocs.map((d) => [d.slug, d]),
)

/** Flat list (stable order) used to build the search index. */
export const docList: Doc[] = allDocs

/** Routes contributed to SiteApp. Each doc page + the /docs homepage. */
export const docRoutes: SiteRoute[] = [
  ...allDocs.map((doc) => ({
    path: doc.path,
    element: (
      <Suspense fallback={<div style={{ minHeight: '60vh' }} aria-hidden="true" />}>
        <DocPage slug={doc.slug} />
      </Suspense>
    ),
  })),
  {
    path: '/docs',
    element: (
      <Suspense fallback={<div style={{ minHeight: '60vh' }} aria-hidden="true" />}>
        <DocsHome />
      </Suspense>
    ),
  },
]

