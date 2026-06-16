import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import { docMap } from './index'
import DocSearch from './DocSearch'
import './DocsLayout.css'

const CLOUD = import.meta.env.PUBLIC_CARTCRFT_CLOUD === '1'

/* ── Sidebar config — mirrors the old Starlight astro.config.mjs sidebar ──
 * Items reference slugs; labels are resolved from each doc's frontmatter title
 * (falling back to a literal if a doc is missing). Groups may nest a subgroup. */
interface SidebarLeaf {
  slug: string
}
interface SidebarSubGroup {
  label: string
  items: SidebarLeaf[]
}
interface SidebarGroup {
  label: string
  /** Cloud groups are dropped entirely in OSS builds. */
  cloudOnly?: boolean
  items: Array<SidebarLeaf | SidebarSubGroup>
}

const SIDEBAR: SidebarGroup[] = [
  {
    label: 'Getting Started',
    items: [{ slug: 'quickstart' }, { slug: 'quickstart-mcp' }],
  },
  {
    label: 'Run your store',
    items: [
      { slug: 'guides/getting-started' },
      { slug: 'guides/add-a-product' },
      { slug: 'guides/fulfill-an-order' },
      { slug: 'guides/discounts' },
      { slug: 'guides/customers' },
      { slug: 'guides/build-your-storefront' },
      { slug: 'guides/go-live' },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { slug: 'commerce' },
      {
        label: 'Catalog & products',
        items: [
          { slug: 'commerce/products' },
          { slug: 'commerce/inventory' },
          { slug: 'commerce/digital-products' },
          { slug: 'commerce/bookings' },
        ],
      },
      {
        label: 'Selling',
        items: [
          { slug: 'commerce/orders-checkout' },
          { slug: 'commerce/payments' },
          { slug: 'commerce/discounts' },
          { slug: 'commerce/shipping' },
          { slug: 'commerce/tax' },
        ],
      },
      {
        label: 'Customers & loyalty',
        items: [
          { slug: 'commerce/customers' },
          { slug: 'identity' },
          { slug: 'commerce/wallet' },
          { slug: 'commerce/subscriptions' },
          { slug: 'commerce/returns' },
          { slug: 'commerce/b2b' },
        ],
      },
    ],
  },
  {
    label: 'Selling channels & agents',
    items: [
      { slug: 'agent-native' },
      { label: 'Protocols', items: [{ slug: 'acp' }, { slug: 'ucp' }] },
      { slug: 'oauth-apps' },
      { slug: 'checkout-links' },
    ],
  },
  {
    label: 'API & SDK',
    items: [
      { slug: 'api-overview' },
      { slug: 'parity-endpoints' },
      { slug: 'byo-keys' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { slug: 'self-host' },
      { slug: 'cloud-vs-selfhost' },
      { slug: 'security' },
      { slug: 'testing' },
    ],
  },
  {
    label: 'Project',
    items: [{ slug: 'contributing' }],
  },
  {
    label: 'Cloud',
    cloudOnly: true,
    items: [
      { slug: 'cloud/overview' },
      { slug: 'cloud/billing' },
      { slug: 'cloud/quotas' },
      { slug: 'cloud/onboarding' },
    ],
  },
]

function isSubGroup(item: SidebarLeaf | SidebarSubGroup): item is SidebarSubGroup {
  return 'items' in item
}

function labelFor(slug: string): string {
  return docMap[slug]?.title ?? slug
}

/** A single sidebar link; highlights when it matches the current route. */
function NavLink({ slug, activeSlug }: { slug: string; activeSlug: string }) {
  // Skip links to docs that don't exist in this build (e.g. cloud in OSS).
  if (!docMap[slug]) return null
  const active = slug === activeSlug
  return (
    <li>
      <Link
        to={`/${slug}`}
        className={`docs-nav-link${active ? ' is-active' : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        {labelFor(slug)}
      </Link>
    </li>
  )
}

function Sidebar({ activeSlug }: { activeSlug: string }) {
  const homeActive = activeSlug === ''
  return (
    <nav className="docs-sidebar-nav" aria-label="Documentation">
      <DocSearch />
      {/* Docs home link — always visible */}
      <div className="docs-nav-home">
        <Link
          to="/docs"
          className={`docs-nav-link docs-nav-home-link${homeActive ? ' is-active' : ''}`}
          aria-current={homeActive ? 'page' : undefined}
        >
          <span aria-hidden="true">⌂ </span>Docs home
        </Link>
      </div>
      {SIDEBAR.filter((g) => !(g.cloudOnly && !CLOUD)).map((group) => (
        <div className="docs-nav-group" key={group.label}>
          <p className="docs-nav-group-title">{group.label}</p>
          <ul>
            {group.items.map((item) =>
              isSubGroup(item) ? (
                <li className="docs-nav-subgroup" key={item.label}>
                  <p className="docs-nav-subgroup-title">{item.label}</p>
                  <ul>
                    {item.items.map((leaf) => (
                      <NavLink key={leaf.slug} slug={leaf.slug} activeSlug={activeSlug} />
                    ))}
                  </ul>
                </li>
              ) : (
                <NavLink key={item.slug} slug={item.slug} activeSlug={activeSlug} />
              ),
            )}
          </ul>
        </div>
      ))}
    </nav>
  )
}

/* ── Table of contents — scans the rendered article for h2/h3 headings ── */
interface TocEntry {
  id: string
  text: string
  level: number
}

function useToc(articleRef: RefObject<HTMLElement | null>, slug: string): TocEntry[] {
  const [entries, setEntries] = useState<TocEntry[]>([])

  useEffect(() => {
    const el = articleRef.current
    if (!el) return
    const headings = Array.from(el.querySelectorAll<HTMLHeadingElement>('h2, h3'))
    setEntries(
      headings
        .filter((h) => h.id)
        .map((h) => ({
          id: h.id,
          text: h.textContent ?? '',
          level: h.tagName === 'H3' ? 3 : 2,
        })),
    )
    // Re-scan when the rendered doc changes.
  }, [articleRef, slug])

  return entries
}

function Toc({ entries }: { entries: TocEntry[] }) {
  const [activeId, setActiveId] = useState<string>('')

  useEffect(() => {
    if (!entries.length) return
    const observer = new IntersectionObserver(
      (obsEntries) => {
        const visible = obsEntries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      { rootMargin: '0px 0px -70% 0px', threshold: 0 },
    )
    for (const entry of entries) {
      const el = document.getElementById(entry.id)
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [entries])

  if (entries.length < 2) return null

  return (
    <aside className="docs-toc" aria-label="On this page">
      <p className="docs-toc-title">
        <span className="docs-toc-slash" aria-hidden="true">//</span>
        on this page
      </p>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className={entry.level === 3 ? 'docs-toc-sub' : ''}>
            <a
              href={`#${entry.id}`}
              className={`docs-toc-link${activeId === entry.id ? ' is-active' : ''}`}
            >
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  )
}

/**
 * DocsLayout — the three-column shell rendered between SiteLayout's header and
 * footer: collapsible sidebar (left), article (centre), TOC (right rail).
 *  - `slug` selects the active sidebar item.
 *  - `articleRef` is attached to the caller's <article> so the TOC can scan it.
 */
export default function DocsLayout({
  slug,
  articleRef,
  children,
}: {
  slug: string
  articleRef: RefObject<HTMLElement | null>
  children: ReactNode
}) {
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const toc = useToc(articleRef, slug)

  // Close the mobile drawer on route change.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = ''
      }
    }
    return undefined
  }, [drawerOpen])

  return (
    <div className="docs-shell">
      <button
        className="docs-menu-toggle"
        aria-label="Open documentation menu"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
      >
        <Menu size={18} aria-hidden="true" />
        <span>Menu</span>
      </button>

      <aside className={`docs-sidebar${drawerOpen ? ' is-open' : ''}`}>
        <div className="docs-sidebar-header">
          <span className="docs-sidebar-eyebrow">Documentation</span>
          <button
            className="docs-drawer-close"
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <Sidebar activeSlug={slug} />
      </aside>

      {drawerOpen && (
        <div
          className="docs-backdrop"
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <div className="docs-main">{children}</div>

      <Toc entries={toc} />
    </div>
  )
}
