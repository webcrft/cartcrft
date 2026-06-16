import { Link } from 'react-router-dom'
import {
  CheckCircle,
  ArrowRight,
  ShoppingBag,
  Code2,
  GitBranch,
  DollarSign,
  Layers,
  Plug,
  Globe,
  Database,
  AlertTriangle,
  BookOpen,
} from 'lucide-react'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import ComparisonTable, { type ComparisonRow } from './components/ComparisonTable'
import PricingCalculator from './components/PricingCalculator'
import './Compare.css'

/**
 * Compare page — /compare
 * Narrative content ported verbatim from src/content/marketing/compare.md.
 * Redesigned narrative section: intro block + per-competitor cards + sources.
 * ComparisonTable and PricingCalculator are preserved unchanged.
 */

const PAGE_TITLE = 'How CartCrft compares'
const PAGE_DESCRIPTION =
  'A grounded comparison of CartCrft vs Shopify, Medusa v2, Vendure, Saleor, Swell, and WooCommerce across licensing, pricing, agent-native capabilities, and commerce features.'
const METHODOLOGY =
  "Pricing and feature status verified June 2026 from official pricing pages and documentation. Commerce capabilities are assessed against each platform's documented defaults — plugins and custom integrations are noted where relevant. Verify current figures before making decisions."

const competitors = ['CartCrft', 'Shopify', 'Medusa v2', 'Vendure', 'Saleor', 'Swell', 'WooCommerce']

const rows: ComparisonRow[] = [
  // License and ownership
  {
    category: 'License & ownership',
    feature: 'Core license',
    values: {
      CartCrft: 'MIT',
      Shopify: 'Closed / SaaS',
      'Medusa v2': 'MIT',
      Vendure: 'GPLv3 (core)',
      Saleor: 'BSD-3-Clause',
      Swell: 'Closed / SaaS',
      WooCommerce: 'GPL-2.0+',
    },
    highlight: true,
  },
  {
    category: 'License & ownership',
    feature: 'Self-hostable',
    values: {
      CartCrft: true,
      Shopify: false,
      'Medusa v2': true,
      Vendure: true,
      Saleor: true,
      Swell: false,
      WooCommerce: true,
    },
  },
  {
    category: 'License & ownership',
    feature: 'Source available / open',
    values: {
      CartCrft: true,
      Shopify: false,
      'Medusa v2': true,
      Vendure: true,
      Saleor: true,
      Swell: false,
      WooCommerce: true,
    },
  },

  // Pricing and fees
  {
    category: 'Pricing & fees',
    feature: 'Transaction fee (external gateway)',
    values: {
      CartCrft: '0%',
      Shopify: '0.6%–2% (varies by plan)',
      'Medusa v2': '0%',
      Vendure: '0%',
      Saleor: '0%',
      Swell: '0%',
      WooCommerce: '0%',
    },
    highlight: true,
  },
  {
    category: 'Pricing & fees',
    feature: 'Managed cloud entry price',
    values: {
      CartCrft: 'Flat fee (contact)',
      Shopify: '$29/mo (Basic)',
      'Medusa v2': '$29/mo (Develop)',
      Vendure: 'GA Q4 2026 (design partners)',
      Saleor: '$1,599/mo (Select)',
      Swell: '$29/mo (Starter, billed annually)',
      WooCommerce: 'N/A (self-host only)',
    },
  },
  {
    category: 'Pricing & fees',
    feature: 'GMV / revenue percentage',
    values: {
      CartCrft: '0%',
      Shopify: null,
      'Medusa v2': '0%',
      Vendure: '0% (flat Platform fee)',
      Saleor: '0.4%–0.8% overage above GMV cap',
      Swell: '0.4%–2% overage above revenue ceiling',
      WooCommerce: '0%',
    },
  },

  // Agent-native
  {
    category: 'Agent-native',
    feature: 'MCP server (built-in)',
    values: {
      CartCrft: 'Shipped',
      Shopify: 'Shipped (Storefront MCP, Apr 2026)',
      'Medusa v2': false,
      Vendure: false,
      Saleor: false,
      Swell: false,
      WooCommerce: false,
    },
    highlight: true,
  },
  {
    category: 'Agent-native',
    feature: 'ACP adapter (Agentic Commerce Protocol)',
    values: {
      CartCrft: 'Shipped (test mode)',
      Shopify: 'Via ChatGPT Buy / ACP standard',
      'Medusa v2': false,
      Vendure: false,
      Saleor: false,
      Swell: false,
      WooCommerce: false,
    },
    highlight: true,
  },
  {
    category: 'Agent-native',
    feature: 'UCP adapter (Universal Commerce Protocol)',
    values: {
      CartCrft: 'Shipped (test mode)',
      Shopify: 'Shipped (UCP co-author, NRF 2026)',
      'Medusa v2': false,
      Vendure: false,
      Saleor: false,
      Swell: false,
      WooCommerce: false,
    },
    highlight: true,
  },
  {
    category: 'Agent-native',
    feature: 'Live delegated / agentic payment',
    values: {
      CartCrft: 'In development (Phase H5)',
      Shopify: 'Live (US merchants, Apr 2026)',
      'Medusa v2': false,
      Vendure: false,
      Saleor: false,
      Swell: false,
      WooCommerce: false,
    },
  },
  {
    category: 'Agent-native',
    feature: 'Signed agent mandates (ed25519)',
    values: {
      CartCrft: true,
      Shopify: false,
      'Medusa v2': false,
      Vendure: false,
      Saleor: false,
      Swell: false,
      WooCommerce: false,
    },
    highlight: true,
  },
  {
    category: 'Agent-native',
    feature: 'Semantic / vector search (built-in)',
    values: {
      CartCrft: true,
      Shopify: 'Paid add-on',
      'Medusa v2': false,
      Vendure: false,
      Saleor: false,
      Swell: false,
      WooCommerce: false,
    },
  },

  // API and architecture
  {
    category: 'API & architecture',
    feature: 'REST API',
    values: {
      CartCrft: true,
      Shopify: true,
      'Medusa v2': true,
      Vendure: false,
      Saleor: false,
      Swell: true,
      WooCommerce: true,
    },
  },
  {
    category: 'API & architecture',
    feature: 'GraphQL API',
    values: {
      CartCrft: false,
      Shopify: true,
      'Medusa v2': false,
      Vendure: true,
      Saleor: true,
      Swell: true,
      WooCommerce: 'Plugin',
    },
  },
  {
    category: 'API & architecture',
    feature: 'Fully headless (API-only core)',
    values: {
      CartCrft: true,
      Shopify: true,
      'Medusa v2': true,
      Vendure: true,
      Saleor: true,
      Swell: true,
      WooCommerce: 'Via plugin',
    },
  },
  {
    category: 'API & architecture',
    feature: 'Primary language',
    values: {
      CartCrft: 'TypeScript',
      Shopify: 'Ruby / closed',
      'Medusa v2': 'TypeScript',
      Vendure: 'TypeScript',
      Saleor: 'Python',
      Swell: 'Closed / Node.js',
      WooCommerce: 'PHP',
    },
  },
  {
    category: 'API & architecture',
    feature: 'Postgres-native',
    values: {
      CartCrft: true,
      Shopify: null,
      'Medusa v2': true,
      Vendure: true,
      Saleor: true,
      Swell: null,
      WooCommerce: 'MySQL / MariaDB',
    },
  },

  // Commerce features
  {
    category: 'Commerce features',
    feature: 'Product types (configurable / bundle / digital / subscription / rental)',
    values: {
      CartCrft: 'All 7 types (core)',
      Shopify: 'Simple + digital; bundles via app; subscription via app',
      'Medusa v2': 'Simple + digital; bundles via module; subscription in progress',
      Vendure: 'Configurable + digital; bundles via plugin',
      Saleor: 'Configurable + digital; bundles via plugin',
      Swell: 'Configurable + digital + subscription (core)',
      WooCommerce: 'Simple + variable + virtual; bundles/subscription via paid plugin',
    },
    highlight: true,
  },
  {
    category: 'Commerce features',
    feature: 'Unlimited variants & options (no hard cap)',
    values: {
      CartCrft: true,
      Shopify: 'Capped: 3 options, 100 variants per product',
      'Medusa v2': true,
      Vendure: true,
      Saleor: true,
      Swell: true,
      WooCommerce: true,
    },
  },
  {
    category: 'Commerce features',
    feature: 'Collections & metafields (smart rules + typed metafields)',
    values: {
      CartCrft: true,
      Shopify: true,
      'Medusa v2': 'Collections yes; metafields via module',
      Vendure: 'Collections yes; custom fields via schema extension',
      Saleor: 'Collections yes; attributes yes',
      Swell: true,
      WooCommerce: 'Categories yes; metafields via plugin (ACF)',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Multi-warehouse inventory (per-location levels + audit log)',
    values: {
      CartCrft: true,
      Shopify: 'Locations yes; lot tracking/serial numbers require app',
      'Medusa v2': true,
      Vendure: true,
      Saleor: 'Core module (warehouses)',
      Swell: 'Single warehouse (multi-location via workaround)',
      WooCommerce: 'Plugin (WooCommerce Warehousing)',
    },
    highlight: true,
  },
  {
    category: 'Commerce features',
    feature: 'Lot tracking / FEFO / serial numbers (built-in)',
    values: {
      CartCrft: true,
      Shopify: false,
      'Medusa v2': false,
      Vendure: false,
      Saleor: false,
      Swell: false,
      WooCommerce: false,
    },
    highlight: true,
  },
  {
    category: 'Commerce features',
    feature: 'B2B (companies, credit limits, quotes/RFQ, purchase orders)',
    values: {
      CartCrft: true,
      Shopify: 'Plus only ($2,300+/mo)',
      'Medusa v2': true,
      Vendure: 'Platform tier',
      Saleor: true,
      Swell: true,
      WooCommerce: 'Plugin',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Customer groups & price lists (tiered / wholesale pricing)',
    values: {
      CartCrft: true,
      Shopify: 'Plus only (or third-party app)',
      'Medusa v2': true,
      Vendure: true,
      Saleor: true,
      Swell: true,
      WooCommerce: 'Plugin',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Subscriptions / recurring orders',
    values: {
      CartCrft: true,
      Shopify: 'App/plugin (e.g. Recharge)',
      'Medusa v2': 'In progress',
      Vendure: 'Plugin',
      Saleor: 'App',
      Swell: true,
      WooCommerce: 'Paid plugin (WooCommerce Subscriptions)',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Returns / RMA (refund + exchange + store credit + repair flows)',
    values: {
      CartCrft: true,
      Shopify: 'Basic returns; exchange/RMA via app',
      'Medusa v2': true,
      Vendure: 'Plugin',
      Saleor: true,
      Swell: true,
      WooCommerce: 'Plugin',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Gift cards & store credit wallet',
    values: {
      CartCrft: true,
      Shopify: 'Gift cards yes; store credit via app',
      'Medusa v2': 'Gift cards via plugin',
      Vendure: 'Plugin',
      Saleor: 'Gift cards yes (core)',
      Swell: true,
      WooCommerce: 'Paid plugin',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Digital product delivery (download links, limits, expiry)',
    values: {
      CartCrft: true,
      Shopify: 'Via Digital Downloads app (free)',
      'Medusa v2': true,
      Vendure: 'Plugin',
      Saleor: 'Core (downloadable product type)',
      Swell: true,
      WooCommerce: 'Core (virtual/downloadable products)',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Bookings / rentals (accommodation, vehicles, desks — iCal + OTA channel sync)',
    values: {
      CartCrft: true,
      Shopify: 'App (Sesami / BookThatApp)',
      'Medusa v2': false,
      Vendure: false,
      Saleor: false,
      Swell: false,
      WooCommerce: 'Paid plugin (WooCommerce Bookings)',
    },
    highlight: true,
  },
  {
    category: 'Commerce features',
    feature: 'Multi-currency (FX rates + per-currency price lists)',
    values: {
      CartCrft: 'Base currency + FX conversion + per-currency price lists (storefront currency selector not built-in)',
      Shopify: 'Markets (multi-currency checkout, auto FX)',
      'Medusa v2': 'Price lists per currency; storefront selector requires custom build',
      Vendure: 'Core (channels per currency)',
      Saleor: 'Core (channels + shipping)',
      Swell: true,
      WooCommerce: 'Plugin (WooCommerce Payments / Aelia)',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Tax engine (categories, zones, region rates)',
    values: {
      CartCrft: true,
      Shopify: true,
      'Medusa v2': true,
      Vendure: true,
      Saleor: true,
      Swell: true,
      WooCommerce: true,
    },
  },
  {
    category: 'Commerce features',
    feature: 'Shipping zones & live carrier rates',
    values: {
      CartCrft: 'Zones + static rates + BobGo live rates + collection points',
      Shopify: 'Zones + static + live rates (Basic: no calculated, Advanced+)',
      'Medusa v2': 'Zones + static; live carriers via fulfillment providers',
      Vendure: 'Zones + static; live carriers via plugin',
      Saleor: 'Zones + static; live carriers via shipping app',
      Swell: 'Zones + static + live carrier rates (core)',
      WooCommerce: 'Zones + static; live rates via plugin (ShipStation etc.)',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Abandoned-cart recovery (email + recovery link)',
    values: {
      CartCrft: true,
      Shopify: true,
      'Medusa v2': 'Via custom notification module',
      Vendure: 'Plugin',
      Saleor: 'App',
      Swell: true,
      WooCommerce: 'Plugin (Retainful / WooCommerce built-in partial)',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Wishlists',
    values: {
      CartCrft: true,
      Shopify: 'App/plugin',
      'Medusa v2': false,
      Vendure: false,
      Saleor: 'App',
      Swell: false,
      WooCommerce: 'Plugin',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Product feeds (Google Shopping + Meta/Facebook XML)',
    values: {
      CartCrft: true,
      Shopify: true,
      'Medusa v2': 'Plugin / custom build',
      Vendure: 'Plugin',
      Saleor: 'App (saleor-app-products-feed)',
      Swell: 'Via integration / custom build',
      WooCommerce: 'Plugin (Google Listings & Ads)',
    },
  },
]

// ── Competitor card data ─────────────────────────────────────────────────────

interface CompetitorCardData {
  name: string
  slug: string
  tag: string
  framing: string
  theyWin: string[]
  weWin: string[]
  verdict: string
  Icon: React.ComponentType<{ size?: number; strokeWidth?: number }>
}

const competitorCards: CompetitorCardData[] = [
  {
    name: 'Shopify',
    slug: 'shopify',
    tag: 'SaaS · Closed-source · Scale leader',
    framing:
      'Shopify is the undisputed scale leader and, since January 2026, a genuine agentic commerce player — their Storefront MCP server is live and US merchants can accept purchases through ChatGPT\'s Buy flow (published April 30, 2026). On agent-native distribution, Shopify moves fast.',
    theyWin: [
      'Live delegated / agentic payments (US merchants, Apr 2026) — CartCrft is still in Phase H5',
      'Massive app ecosystem, brand trust, and merchant install base',
      'UCP co-author (NRF 2026) — simultaneous protocol influence',
      'Opinionated hosted experience — less to assemble',
    ],
    weWin: [
      'MIT open source — inspect, fork, self-host, no SaaS lock-in',
      'Zero external-gateway surcharge (Shopify charges 0.6%–2% per plan)',
      'B2B included — Shopify requires Plus at $2,300+/mo',
      'Signed ed25519 agent mandates — Shopify has none',
      'Built-in pgvector semantic search — Shopify charges extra',
      'Bring your own infra, your own data, your own Postgres',
    ],
    verdict: 'If ChatGPT Instant Checkout today is the priority, Shopify leads. If owning your stack matters, CartCrft is the answer.',
    Icon: ShoppingBag,
  },
  {
    name: 'Medusa v2',
    slug: 'medusa',
    tag: 'MIT · TypeScript · Open-source peer',
    framing:
      'Medusa is the closest OSS peer: MIT-licensed, TypeScript, headless-first, 0% GMV fees. Medusa Cloud starts at $29/mo (Develop tier). Medusa has a large community, a plugin ecosystem, and a proven track record. The comparison is honest — this is a close race.',
    theyWin: [
      'Larger existing community and plugin ecosystem',
      'Flexible module system — more surface area for customisation',
      'Medusa Cloud managed hosting already at scale',
      'Established track record in production deployments',
    ],
    weWin: [
      'Agent-native built into core: MCP server, ACP + UCP adapters shipped',
      'Signed ed25519 mandate layer — Medusa has no equivalent',
      'Paystack + Razorpay + Xendit built-in — non-Western markets first-class',
      'Lot tracking / FEFO inventory out of the box',
      'Built-in pgvector semantic search — no custom integration needed',
    ],
    verdict: 'Medusa requires custom work to reach agent-native. CartCrft ships it from day one.',
    Icon: Code2,
  },
  {
    name: 'Vendure',
    slug: 'vendure',
    tag: 'TypeScript · GraphQL-native · GPLv3 core',
    framing:
      'Vendure is TypeScript-first, GraphQL-native, well-architected, and production-proven. The core is GPLv3; commercial features require the Platform tier. Vendure Cloud is in design-partner phase as of June 2026, with GA expected Q4 2026.',
    theyWin: [
      'GraphQL-first API — preferred by teams already on Apollo / Relay stacks',
      'Strongly-typed schema-driven development workflow',
      'Mature plugin system and active community',
      'Commercial Platform tier for enterprise with dedicated support',
    ],
    weWin: [
      'REST/OpenAPI — integrates naturally with agent tooling expecting structured endpoints',
      'MCP server + ACP + UCP adapters shipped now (Vendure has none)',
      'Signed agent mandates — no Vendure equivalent',
      'MIT license — GPLv3 copyleft has implications for proprietary extensions',
      'Managed cloud live — Vendure Cloud still in design-partner phase (Q4 2026 GA)',
    ],
    verdict: 'GraphQL lovers: Vendure is excellent. Agent-native and REST-first: CartCrft is the fit.',
    Icon: GitBranch,
  },
  {
    name: 'Saleor',
    slug: 'saleor',
    tag: 'BSD-3-Clause · GraphQL · Enterprise cloud',
    framing:
      'Saleor is open-source (BSD-3-Clause) and GraphQL-native. The self-hosted core is free and permissively licensed. Saleor Cloud is positioned as an enterprise managed service: the entry Select plan starts at $1,599/mo with a GMV cap and 0.8% overage.',
    theyWin: [
      'Mature GraphQL API and established plugin marketplace',
      'Permissive BSD-3-Clause license on the core',
      'Strong enterprise managed offering for teams that need it',
      'Production-proven at significant scale',
    ],
    weWin: [
      'MCP server + ACP + UCP adapters — Saleor has no agent-native layer',
      'Signed ed25519 agent mandates — unique to CartCrft',
      'TypeScript end-to-end vs. Python backend (easier to hire, one language)',
      'REST/OpenAPI (agent tooling friendly) vs. GraphQL-only',
      'Managed cloud with 0% GMV fee vs. Saleor\'s $1,599/mo entry + 0.8% overage',
    ],
    verdict: 'Saleor Cloud\'s pricing cliff makes self-hosted Saleor the real alternative — and against that, CartCrft adds agent-native at no extra cost.',
    Icon: Layers,
  },
  {
    name: 'Swell',
    slug: 'swell',
    tag: 'Closed-source · SaaS · Revenue-based pricing',
    framing:
      'Swell is a closed-source, cloud-only headless commerce SaaS. The Starter plan is $29/mo billed annually but includes revenue ceilings and 2% overage fees above $50K. You cannot self-host or inspect the source code.',
    theyWin: [
      'Developer-friendly API and clean dashboard experience',
      'Solid built-in subscription support',
      'Managed SaaS — no infrastructure to run',
      'Good multi-storefront / multi-channel support',
    ],
    weWin: [
      'MIT open source — Swell is fully closed, no source visibility',
      'Self-hostable — Swell is cloud-only, no choice',
      '0% transaction rake at any scale — Swell charges 0.4%–2% above revenue ceiling',
      'Full agent-native stack: MCP + ACP + UCP + mandates',
      'Paystack + Razorpay — non-US payment coverage Swell lacks built-in',
    ],
    verdict: 'If managed SaaS with per-revenue pricing is acceptable, Swell is pleasant to use. For open source, self-hosting, zero rake, and agent-native, CartCrft is a different category.',
    Icon: DollarSign,
  },
  {
    name: 'WooCommerce',
    slug: 'woocommerce',
    tag: 'GPL-2.0 · PHP · WordPress-coupled',
    framing:
      'WooCommerce is GPL-licensed, free, self-hosted, and runs on WordPress + MySQL/MariaDB. It has the largest merchant install base of any ecommerce platform and an enormous plugin ecosystem. WooCommerce itself charges 0% transaction fees.',
    theyWin: [
      'Largest merchant install base — unmatched ecosystem breadth',
      'Enormous paid and free plugin marketplace for almost anything',
      '0% transaction fees on the core platform',
      'Deep WordPress CMS integration — content + commerce in one',
    ],
    weWin: [
      'API-first, TypeScript, agent-native by design — WooCommerce is PHP + WordPress-coupled',
      'MCP server + ACP + UCP adapters — WooCommerce has no agent-native layer',
      'Headless-first: no WordPress dependency, clean REST + TS SDK',
      'Postgres-native (pgvector) vs. MySQL / MariaDB — better for vector search and modern tooling',
      'B2B, subscriptions, returns built-in — WooCommerce requires paid plugins',
    ],
    verdict: 'WooCommerce is the right answer for WordPress-native content + commerce. CartCrft is the right answer for API-first, TypeScript, agent-native commerce.',
    Icon: Globe,
  },
]

export default function Compare() {
  useDocumentMeta({ title: PAGE_TITLE, description: PAGE_DESCRIPTION })

  return (
    <SiteLayout>
      <div className="mk-compare">
        {/* ── Page header ─────────────────────────────────────────────────── */}
        <section className="cmp-header">
          <div className="cmp-header-fx" aria-hidden="true">
            <div className="cmp-header-grid cc-grid-bg" />
            <div className="cmp-header-glow" />
          </div>
          <div className="cc-grain" aria-hidden="true" />
          <div className="cmp-header-inner">
            <div className="cmp-eyebrow">
              <span className="ey-b">[</span>
              <span className="ey-dot" aria-hidden="true" />
              feature comparison
              <span className="ey-b">]</span>
            </div>
            <h1>How CartCrft <span className="hl">compares</span></h1>
            <p className="cmp-header-lead">{PAGE_DESCRIPTION}</p>
            <p className="cmp-methodology">{METHODOLOGY}</p>
          </div>
        </section>

        {/* ── Comparison table ─────────────────────────────────────────────── */}
        <section className="cmp-table-section" data-reveal>
          <div className="cmp-table-inner">
            <ComparisonTable
              competitors={competitors}
              rows={rows}
              ourName="CartCrft"
              caption="Figures as of June 2026. Verify with official sources before making purchasing decisions."
            />
          </div>
        </section>

        {/* ── Pricing calculator ───────────────────────────────────────────── */}
        <section className="cmp-calc-section" data-reveal>
          <PricingCalculator />
        </section>

        {/* ── Narrative section ────────────────────────────────────────────── */}
        <section className="cmp-narratives" data-reveal>
          <div className="cmp-narratives-inner">

            {/* Intro block */}
            <div className="cmp-intro">
              <div className="cmp-intro-eyebrow">
                <span className="ey-b">[</span>
                <span className="ey-dot" aria-hidden="true" />
                the honest version
                <span className="ey-b">]</span>
              </div>
              <h2 className="cmp-intro-heading">
                A straight-line comparison —<br />
                <span className="cmp-hl">no strawmen</span>
              </h2>
              <p className="cmp-intro-lead">
                Where competitors lead — Shopify on live agentic payments, Medusa on community scale, Vendure on GraphQL architecture — we say so. The matrix above gives you the data. The cards below give you the reasoning. Every claim is sourced and grounded.
              </p>
            </div>

            {/* Competitor cards grid */}
            <div className="cmp-cards-grid">
              {competitorCards.map((card) => (
                <CompetitorCard key={card.slug} card={card} />
              ))}
            </div>

          </div>
        </section>

        {/* ── Sources & methodology ────────────────────────────────────────── */}
        <section className="cmp-sources" data-reveal>
          <div className="cmp-sources-inner">
            <div className="cmp-sources-header">
              <BookOpen size={14} strokeWidth={1.5} />
              <span>Sources &amp; methodology</span>
            </div>
            <p className="cmp-sources-body">
              <strong>All figures verified June 2026.</strong>{' '}
              Shopify plan pricing and external gateway fees from shopify.com/pricing (Basic $29/mo, external gateway surcharge 0.6%–2% depending on plan).
              Medusa Cloud pricing from medusajs.com/pricing/ (Develop $29/mo, Launch $99/mo, Scale $299/mo, 0% GMV).
              Saleor Cloud pricing from saleor.io/pricing (Select $1,599/mo with GMV cap, 0.8% overage).
              Swell pricing from swell.is/pricing (Starter $29/mo billed annually, revenue ceilings and overage apply).
              Vendure license and Cloud status from vendure.io/pricing (GPLv3 core, Commercial Platform tier, Cloud GA Q4 2026).
              WooCommerce from wordpress.org/plugins/woocommerce (GPL-2.0+, self-hosted, 0% WC transaction fees).
              Shopify agentic commerce (MCP, ACP, UCP) from shopify.com/blog/how-agentic-commerce-works (published April 30, 2026).
              CartCrft ACP/UCP status from internal docs (docs/acp.md, docs/ucp.md): test mode shipped, live delegated payment in development (roadmap Phase H5).
            </p>
            <p className="cmp-sources-caveat">
              Commerce capabilities are assessed against each platform's documented defaults — plugins and custom integrations are noted where relevant.
              Verify all figures directly with each vendor before making purchasing decisions.
            </p>
          </div>
        </section>

        {/* ── CTA band ────────────────────────────────────────────────────── */}
        <section className="cmp-cta" data-reveal>
          <div className="cmp-cta-inner">
            <h2>Ready to try CartCrft?</h2>
            <p>Get a store running and MCP-connected in under 10 minutes.</p>
            <div className="cmp-cta-actions">
              <Link to="/quickstart" className="cc-btn cc-btn--lg cc-btn--on-dark cc-btn--primary">Get started free</Link>
              <Link to="/pricing" className="cc-btn cc-btn--lg cc-btn--on-dark cc-btn--ghost">See pricing</Link>
            </div>
          </div>
        </section>
      </div>
    </SiteLayout>
  )
}

// ── Competitor card component ────────────────────────────────────────────────

function CompetitorCard({ card }: { card: CompetitorCardData }) {
  const { name, tag, framing, theyWin, weWin, verdict, Icon } = card

  return (
    <article className="cmp-card">
      {/* Card header */}
      <div className="cmp-card-header">
        <div className="cmp-card-icon" aria-hidden="true">
          <Icon size={17} strokeWidth={1.6} />
        </div>
        <div className="cmp-card-title-block">
          <h3 className="cmp-card-name">{name}</h3>
          <span className="cmp-card-tag">{tag}</span>
        </div>
      </div>

      {/* Framing paragraph */}
      <p className="cmp-card-framing">{framing}</p>

      {/* Two-column win/lose */}
      <div className="cmp-card-splits">
        {/* They win */}
        <div className="cmp-card-col cmp-card-col--them">
          <div className="cmp-col-label">
            <AlertTriangle size={11} strokeWidth={2} aria-hidden="true" />
            <span>Where {name} wins</span>
          </div>
          <ul className="cmp-points">
            {theyWin.map((pt, i) => (
              <li key={i} className="cmp-point cmp-point--them">
                <ArrowRight size={12} strokeWidth={2} className="cmp-pt-icon" aria-hidden="true" />
                <span>{pt}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="cmp-card-divider" aria-hidden="true" />

        {/* We win */}
        <div className="cmp-card-col cmp-card-col--us">
          <div className="cmp-col-label">
            <CheckCircle size={11} strokeWidth={2} aria-hidden="true" />
            <span>Where CartCrft wins</span>
          </div>
          <ul className="cmp-points">
            {weWin.map((pt, i) => (
              <li key={i} className="cmp-point cmp-point--us">
                <CheckCircle size={12} strokeWidth={2} className="cmp-pt-icon" aria-hidden="true" />
                <span>{pt}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Verdict line */}
      <div className="cmp-card-verdict">
        <Database size={11} strokeWidth={2} aria-hidden="true" />
        <span>{verdict}</span>
      </div>
    </article>
  )
}
