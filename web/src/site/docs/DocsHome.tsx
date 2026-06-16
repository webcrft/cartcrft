import { useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  BookOpen,
  ShoppingBag,
  Zap,
  Code2,
  Server,
  Cpu,
  Globe,
  ArrowRight,
  Terminal,
} from 'lucide-react'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import DocsLayout from './DocsLayout'
import DocSearch from './DocSearch'
import './DocsHome.css'

interface CategoryCard {
  icon: React.ReactNode
  label: string
  title: string
  description: string
  href: string
  links: Array<{ label: string; href: string }>
  accent?: 'brand' | 'cyan'
}

/* Links map to real slugs in SIDEBAR / docMap. */
const CATEGORIES: CategoryCard[] = [
  {
    icon: <BookOpen size={20} aria-hidden="true" />,
    label: '01 / getting-started',
    title: 'Getting Started',
    description:
      'Up and running in under five minutes — local dev, first API calls, and an AI agent buying from your store.',
    href: '/quickstart',
    accent: 'brand',
    links: [
      { label: 'Quickstart', href: '/quickstart' },
      { label: 'Agent quickstart (MCP)', href: '/quickstart-mcp' },
    ],
  },
  {
    icon: <Globe size={20} aria-hidden="true" />,
    label: '02 / run-your-store',
    title: 'Run Your Store',
    description:
      'Step-by-step guides: products, orders, fulfilment, discounts, customers, and launch checklist.',
    href: '/guides/getting-started',
    links: [
      { label: 'Set up your store', href: '/guides/getting-started' },
      { label: 'Add a product', href: '/guides/add-a-product' },
      { label: 'Fulfil an order', href: '/guides/fulfill-an-order' },
      { label: 'Build your storefront', href: '/guides/build-your-storefront' },
      { label: 'Go-live checklist', href: '/guides/go-live' },
    ],
  },
  {
    icon: <ShoppingBag size={20} aria-hidden="true" />,
    label: '03 / commerce',
    title: 'Commerce',
    description:
      'Products, inventory, orders, payments, shipping, tax, customers, subscriptions, B2B, and returns.',
    href: '/commerce',
    links: [
      { label: 'Products & catalog', href: '/commerce/products' },
      { label: 'Orders & checkout', href: '/commerce/orders-checkout' },
      { label: 'Payments', href: '/commerce/payments' },
      { label: 'Shipping', href: '/commerce/shipping' },
      { label: 'Discounts', href: '/commerce/discounts' },
    ],
  },
  {
    icon: <Zap size={20} aria-hidden="true" />,
    label: '04 / selling-channels',
    title: 'Selling Channels & Agents',
    description:
      'Let AI agents browse and buy via MCP, publish to Google Shopping, and send shareable checkout links.',
    href: '/agent-native',
    accent: 'cyan',
    links: [
      { label: 'Agent-native (MCP)', href: '/agent-native' },
      { label: 'Checkout links', href: '/checkout-links' },
      { label: 'ACP adapter', href: '/acp' },
      { label: 'UCP adapter', href: '/ucp' },
      { label: 'OAuth apps', href: '/oauth-apps' },
    ],
  },
  {
    icon: <Code2 size={20} aria-hidden="true" />,
    label: '05 / api-and-sdk',
    title: 'API & SDK',
    description:
      'Auth, error envelope, pagination, money encoding, BYO payment and LLM keys, and the full endpoint index.',
    href: '/api-overview',
    links: [
      { label: 'API overview', href: '/api-overview' },
      { label: 'All endpoints', href: '/parity-endpoints' },
      { label: 'BYO keys', href: '/byo-keys' },
    ],
  },
  {
    icon: <Server size={20} aria-hidden="true" />,
    label: '06 / operations',
    title: 'Operations',
    description:
      'Self-host with Docker, compare cloud vs self-host, security hardening, and the test harness.',
    href: '/self-host',
    links: [
      { label: 'Self-hosting', href: '/self-host' },
      { label: 'Cloud vs self-host', href: '/cloud-vs-selfhost' },
      { label: 'Security', href: '/security' },
      { label: 'Testing', href: '/testing' },
    ],
  },
]

const QUICK_TASKS = [
  { label: 'Add your first product', href: '/guides/add-a-product' },
  { label: 'Set up a payment provider', href: '/commerce/payments' },
  { label: 'Create a discount code', href: '/commerce/discounts' },
  { label: 'Configure shipping zones', href: '/commerce/shipping' },
  { label: 'Generate a checkout link', href: '/checkout-links' },
  { label: 'Connect an AI agent', href: '/agent-native' },
  { label: 'Build a storefront', href: '/guides/build-your-storefront' },
  { label: 'Deploy with Docker', href: '/self-host' },
]

export default function DocsHome() {
  const articleRef = useRef<HTMLElement | null>(null)

  useDocumentMeta({
    title: 'Documentation · Cartcrft',
    description:
      'Cartcrft documentation — commerce, agent-native selling, API reference, and operations.',
  })

  return (
    <SiteLayout noFooter>
      <DocsLayout slug="" articleRef={articleRef}>
        <article className="docs-article docs-home" ref={articleRef}>

          {/* ── Hero ───────────────────────────────────────────────────── */}
          <header className="docs-home-hero">
            <p className="cc-eyebrow">
              <Terminal size={12} aria-hidden="true" />
              documentation
            </p>
            <h1 className="docs-home-title">
              Cartcrft<br />
              <span className="docs-home-title-accent">Documentation</span>
            </h1>
            <p className="docs-home-lead">
              Open-source, agent-native headless commerce backend. Whether
              you&rsquo;re a merchant configuring your first store or a developer
              wiring up AI buying flows &mdash; start here.
            </p>

            <div className="docs-home-search-wrap" aria-label="Search documentation">
              <DocSearch variant="hero" />
            </div>

            <div className="docs-home-hero-ctas">
              <Link to="/quickstart" className="cc-btn cc-btn--primary cc-btn--lg">
                Quickstart <ArrowRight size={15} aria-hidden="true" />
              </Link>
              <Link to="/api-overview" className="cc-btn cc-btn--ghost cc-btn--lg">
                API reference
              </Link>
            </div>
          </header>

          {/* ── Category cards ─────────────────────────────────────────── */}
          <section className="docs-home-categories" aria-label="Documentation sections">
            {CATEGORIES.map((cat) => (
              <div
                className={`docs-home-card${cat.accent === 'cyan' ? ' docs-home-card--cyan' : ''}`}
                key={cat.title}
              >
                <div className="docs-home-card-top">
                  <span className="docs-home-card-icon">{cat.icon}</span>
                  <span className="docs-home-card-label">{cat.label}</span>
                </div>
                <h2 className="docs-home-card-title">
                  <Link to={cat.href}>{cat.title}</Link>
                </h2>
                <p className="docs-home-card-desc">{cat.description}</p>
                <ul className="docs-home-card-links">
                  {cat.links.map((link) => (
                    <li key={link.href}>
                      <Link to={link.href}>
                        <span className="docs-home-link-arrow" aria-hidden="true">→</span>
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          {/* ── Agent-native callout ────────────────────────────────────── */}
          <div className="docs-home-agent-callout">
            <Cpu size={18} aria-hidden="true" className="docs-home-callout-icon" />
            <div>
              <strong>Cartcrft is headless — bring your own frontend.</strong>{' '}
              Your storefront calls the REST API directly using a{' '}
              <code>cc_pub_</code> key. Or skip the frontend entirely and expose
              your store to AI agents via MCP.{' '}
              <Link to="/guides/build-your-storefront">
                Build your storefront guide &rarr;
              </Link>
            </div>
          </div>

          {/* ── Common tasks ───────────────────────────────────────────── */}
          <section className="docs-home-quickpicks">
            <p className="docs-home-qp-heading">
              <span aria-hidden="true">// </span>common tasks
            </p>
            <div className="docs-home-qp-grid">
              {QUICK_TASKS.map((item) => (
                <Link key={item.href} to={item.href} className="docs-home-qp-item">
                  {item.label}
                </Link>
              ))}
            </div>
          </section>

        </article>
      </DocsLayout>
    </SiteLayout>
  )
}
