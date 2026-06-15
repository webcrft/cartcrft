import { useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  ShoppingBag,
  Zap,
  Code2,
  Server,
  BookOpen,
  Search,
} from 'lucide-react'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import DocsLayout from './DocsLayout'
import DocSearch from './DocSearch'
import './DocsHome.css'

interface CategoryCard {
  icon: React.ReactNode
  title: string
  description: string
  href: string
  links: Array<{ label: string; href: string }>
}

const CATEGORIES: CategoryCard[] = [
  {
    icon: <BookOpen size={22} aria-hidden="true" />,
    title: 'Getting started',
    description:
      'Up and running in under 5 minutes — local dev, first API calls, and an AI agent buying from your store.',
    href: '/quickstart',
    links: [
      { label: 'Quickstart', href: '/quickstart' },
      { label: 'Agent quickstart (MCP)', href: '/quickstart-mcp' },
    ],
  },
  {
    icon: <ShoppingBag size={22} aria-hidden="true" />,
    title: 'Commerce',
    description:
      'Everything you need to run a store — products, inventory, orders, payments, shipping, tax, and more.',
    href: '/commerce',
    links: [
      { label: 'Products & catalog', href: '/commerce/products' },
      { label: 'Orders & checkout', href: '/commerce/orders-checkout' },
      { label: 'Payments', href: '/commerce/payments' },
      { label: 'Shipping', href: '/commerce/shipping' },
      { label: 'Discounts', href: '/commerce/discounts' },
      { label: 'View all commerce docs →', href: '/commerce' },
    ],
  },
  {
    icon: <Zap size={22} aria-hidden="true" />,
    title: 'Selling channels & agents',
    description:
      'Let AI agents browse and buy, publish to Google Shopping, and accept payments via shareable links.',
    href: '/agent-native',
    links: [
      { label: 'Agent-native (MCP)', href: '/agent-native' },
      { label: 'Checkout links', href: '/checkout-links' },
      { label: 'ACP adapter', href: '/acp' },
      { label: 'UCP adapter', href: '/ucp' },
      { label: 'OAuth apps', href: '/oauth-apps' },
    ],
  },
  {
    icon: <Code2 size={22} aria-hidden="true" />,
    title: 'API & SDK',
    description:
      'Auth, error envelope, pagination, money encoding, and the full endpoint table.',
    href: '/api-overview',
    links: [
      { label: 'API overview', href: '/api-overview' },
      { label: 'All endpoints', href: '/parity-endpoints' },
      { label: 'BYO keys (payments + LLM)', href: '/byo-keys' },
    ],
  },
  {
    icon: <Server size={22} aria-hidden="true" />,
    title: 'Operations',
    description:
      'Self-host with Docker, compare cloud vs self-host, and explore the test harness.',
    href: '/self-host',
    links: [
      { label: 'Self-hosting', href: '/self-host' },
      { label: 'Cloud vs self-host', href: '/cloud-vs-selfhost' },
      { label: 'Security', href: '/security' },
      { label: 'Testing', href: '/testing' },
    ],
  },
]

export default function DocsHome() {
  const articleRef = useRef<HTMLElement | null>(null)

  useDocumentMeta({
    title: 'Documentation · Cartcrft',
    description:
      'Cartcrft documentation — commerce, agent-native selling, API reference, and operations.',
  })

  return (
    <SiteLayout>
      <DocsLayout slug="" articleRef={articleRef}>
        <article className="docs-article docs-home" ref={articleRef}>
          {/* ── Hero ── */}
          <header className="docs-home-hero">
            <p className="cc-eyebrow">
              <span aria-hidden="true">// </span>documentation
            </p>
            <h1 className="docs-home-title">
              Welcome to Cartcrft docs
            </h1>
            <p className="docs-home-lead">
              An open-source, agent-native headless commerce backend. Whether
              you&#39;re a merchant setting up your first store or a developer
              building agent-powered buying flows — start here.
            </p>

            {/* Prominent search */}
            <div className="docs-home-search-wrap" aria-label="Search documentation">
              <DocSearch variant="hero" />
            </div>
          </header>

          {/* ── Category cards ── */}
          <section className="docs-home-categories" aria-label="Documentation sections">
            {CATEGORIES.map((cat) => (
              <div className="docs-home-card" key={cat.title}>
                <div className="docs-home-card-icon">{cat.icon}</div>
                <div className="docs-home-card-body">
                  <h2 className="docs-home-card-title">
                    <Link to={cat.href}>{cat.title}</Link>
                  </h2>
                  <p className="docs-home-card-desc">{cat.description}</p>
                  <ul className="docs-home-card-links">
                    {cat.links.map((link) => (
                      <li key={link.href}>
                        <Link to={link.href}>{link.label}</Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </section>

          {/* ── Quick picks for merchants ── */}
          <section className="docs-home-quickpicks">
            <h2 className="docs-home-qp-heading">
              <Search size={16} aria-hidden="true" />
              Common tasks
            </h2>
            <div className="docs-home-qp-grid">
              {[
                { label: 'Add your first product', href: '/commerce/products' },
                { label: 'Set up a payment provider', href: '/commerce/payments' },
                { label: 'Create a discount code', href: '/commerce/discounts' },
                { label: 'Configure shipping zones', href: '/commerce/shipping' },
                { label: 'Generate a checkout link', href: '/checkout-links' },
                { label: 'Connect an AI agent', href: '/agent-native' },
                { label: 'Set up customer accounts', href: '/identity' },
                { label: 'Deploy with Docker', href: '/self-host' },
              ].map((item) => (
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
