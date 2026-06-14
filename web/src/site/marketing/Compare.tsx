import { Link } from 'react-router-dom'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import ComparisonTable, { type ComparisonRow } from './components/ComparisonTable'
import './Compare.css'

/**
 * Compare page — /compare
 * Narrative content ported verbatim from src/content/marketing/compare.md.
 * The .md-prose CSS styles a flat h2 + p sibling sequence into cards, so the
 * markdown is rendered as a flat sequence of <h2>/<p> elements (no wrappers).
 *
 * Competitor table data stays as structured data (rendered by ComparisonTable).
 */

// Frontmatter (from compare.md)
const PAGE_TITLE = 'How Cartcrft compares'
const PAGE_DESCRIPTION =
  'A grounded comparison of Cartcrft vs Shopify, Medusa v2, Vendure, Saleor, Swell, and WooCommerce across licensing, pricing, agent-native capabilities, and commerce features.'
const METHODOLOGY =
  "Pricing and feature status verified June 2026 from official pricing pages and documentation. Commerce capabilities are assessed against each platform's documented defaults — plugins and custom integrations are noted where relevant. Verify current figures before making decisions."

const competitors = ['Cartcrft', 'Shopify', 'Medusa v2', 'Vendure', 'Saleor', 'Swell', 'WooCommerce']

const rows: ComparisonRow[] = [
  // License and ownership
  {
    category: 'License & ownership',
    feature: 'Core license',
    values: {
      Cartcrft: 'MIT',
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
      Cartcrft: true,
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
      Cartcrft: true,
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
      Cartcrft: '0%',
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
      Cartcrft: 'Flat fee (contact)',
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
      Cartcrft: '0%',
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
      Cartcrft: 'Shipped',
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
      Cartcrft: 'Shipped (test mode)',
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
      Cartcrft: 'Shipped (test mode)',
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
      Cartcrft: 'In development (Phase H5)',
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
      Cartcrft: true,
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
      Cartcrft: true,
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
      Cartcrft: true,
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
      Cartcrft: false,
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
      Cartcrft: true,
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
      Cartcrft: 'TypeScript',
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
      Cartcrft: true,
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
    feature: 'B2B (companies, credit, quotes)',
    values: {
      Cartcrft: true,
      Shopify: 'Shopify Plus only ($2,300+/mo)',
      'Medusa v2': true,
      Vendure: 'Platform tier',
      Saleor: true,
      Swell: true,
      WooCommerce: 'Plugin',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Subscriptions',
    values: {
      Cartcrft: true,
      Shopify: 'App/plugin',
      'Medusa v2': 'In progress',
      Vendure: 'Plugin',
      Saleor: 'App',
      Swell: true,
      WooCommerce: 'Paid plugin',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Returns / RMA',
    values: {
      Cartcrft: true,
      Shopify: true,
      'Medusa v2': true,
      Vendure: 'Plugin',
      Saleor: true,
      Swell: true,
      WooCommerce: 'Plugin',
    },
  },
  {
    category: 'Commerce features',
    feature: 'Multi-payment providers (BYO)',
    values: {
      Cartcrft: 'Stripe, Paystack, Razorpay, Xendit',
      Shopify: 'Limited (surcharge if not Shopify Payments)',
      'Medusa v2': true,
      Vendure: true,
      Saleor: true,
      Swell: true,
      WooCommerce: true,
    },
  },
]

export default function Compare() {
  useDocumentMeta({ title: PAGE_TITLE, description: PAGE_DESCRIPTION })

  return (
    <SiteLayout>
      <div className="mk-compare">
        {/* Page header — from content collection frontmatter */}
        <section className="page-header">
          <div className="page-header-inner">
            <div className="page-label">Feature comparison</div>
            <h1>{PAGE_TITLE}</h1>
            <p>{PAGE_DESCRIPTION}</p>
            <p className="methodology">{METHODOLOGY}</p>
          </div>
        </section>

        {/* Comparison table (structured data — component-rendered) */}
        <section className="table-section" data-reveal>
          <div className="table-section-inner">
            <ComparisonTable
              competitors={competitors}
              rows={rows}
              ourName="Cartcrft"
              caption="Figures as of June 2026. Verify with official sources before making purchasing decisions."
            />
          </div>
        </section>

        {/* Narrative sections — ported verbatim from compare.md */}
        <section className="narratives" data-reveal>
          <div className="narratives-inner">
            <div className="md-prose">
              {/* Introduction (heading hidden by CSS) */}
              <h2>Introduction</h2>
              <p>
                A straight-line comparison of licensing, pricing, agent-native capabilities, and commerce features across the major open-source and SaaS headless commerce platforms. We aim to be fair — this is not a strawman. Where competitors lead (Shopify on live agentic payments, for example), we say so.
              </p>

              <h2>Cartcrft vs Shopify</h2>
              <p>
                Shopify is the undisputed scale leader and, since January 2026, a genuine agentic commerce player — their Storefront MCP server is live and US merchants can accept purchases through ChatGPT's Buy flow (published April 30, 2026). On agent-native, Shopify moves fast and has distribution.
              </p>
              <p>
                The trade-offs: Shopify is closed-source and SaaS-only. External payment gateways incur a 0.6%–2% transaction surcharge per plan (as of June 2026), on top of your gateway's own fees. B2B features require Shopify Plus ($2,300+/mo). You cannot self-host, inspect the code, or bring your own infrastructure. Cartcrft's live agentic payments are still in development — if ChatGPT Instant Checkout today matters to you, Shopify is ahead. If owning your stack matters, Cartcrft is the answer.
              </p>

              <h2>Cartcrft vs Medusa v2</h2>
              <p>
                Medusa is the closest OSS peer: MIT-licensed, TypeScript, headless-first, 0% GMV fees. Medusa Cloud starts at $29/mo (Develop tier, as of June 2026). Medusa has a large community, a plugin ecosystem, and a proven track record.
              </p>
              <p>
                Where Cartcrft differs: agent-native is built into the core. Medusa has no MCP server, no ACP/UCP adapters, and no signed mandate layer — these would require custom integrations. Cartcrft also ships 4 payment providers (including Paystack and Razorpay for non-Western markets), lot tracking/FEFO inventory, and built-in pgvector semantic search. Medusa's module system gives more flexibility at the cost of more assembly.
              </p>

              <h2>Cartcrft vs Vendure</h2>
              <p>
                Vendure is a TypeScript-first, GraphQL-native headless platform — well-architected and production-proven. The core is GPLv3; commercial features (storefront, enterprise plugins, dedicated support) require the commercial Platform tier. Vendure Cloud is in design-partner phase as of June 2026 (GA expected Q4 2026).
              </p>
              <p>
                If your team prefers GraphQL over REST, Vendure is a strong option. Cartcrft is REST/OpenAPI with a generated TS SDK, which integrates naturally with agent tooling that expects structured REST endpoints. Neither platform has live agentic payments yet, but Cartcrft ships ACP/UCP adapters out of the box.
              </p>

              <h2>Cartcrft vs Saleor</h2>
              <p>
                Saleor is open-source (BSD-3-Clause) and GraphQL-native. The self-hosted core is free and permissively licensed. Saleor Cloud, however, is positioned as an enterprise managed service: the entry Select plan starts at $1,599/mo (June 2026) with a GMV cap and 0.8% overage fee. For teams that want managed hosting, the cost cliff is steep.
              </p>
              <p>
                Cartcrft and Saleor overlap on headless-first, open-source credentials. Cartcrft adds agent-native (MCP/ACP/UCP/mandates), REST API, TypeScript end-to-end, and built-in pgvector search. Saleor offers a mature GraphQL API and an established plugin marketplace.
              </p>

              <h2>Cartcrft vs Swell</h2>
              <p>
                Swell is a closed-source, cloud-only headless commerce SaaS. The Starter plan is $29/mo (billed annually, as of June 2026) but includes revenue ceilings and overage fees (2% above $50K for Starter). You cannot self-host or inspect the source code.
              </p>
              <p>
                Swell has a developer-friendly API and solid subscription support. If managed SaaS with per-revenue pricing is acceptable, Swell competes at the low end. If you want open source, self-hosting, zero transaction rake, and agent-native capabilities, Cartcrft is the different-category choice.
              </p>

              <h2>Cartcrft vs WooCommerce</h2>
              <p>
                WooCommerce is GPL-licensed, free, self-hosted, and runs on WordPress + MySQL/MariaDB. It has the largest merchant install base of any ecommerce platform and an enormous plugin ecosystem. WooCommerce itself charges 0% transaction fees.
              </p>
              <p>
                WooCommerce is PHP-first, WordPress-coupled, and not designed for headless or agent-native use cases. Advanced features (subscriptions, B2B, headless) require paid plugins. There is no MCP server, no ACP/UCP, no pgvector. Cartcrft is a different category: API-first, TypeScript, agent-native by design.
              </p>

              <h2>Sources</h2>
              <p>
                <strong>Sources and dates (all verified June 2026):</strong>{' '}
                Shopify plan pricing and external gateway fees from shopify.com/pricing (Basic $29/mo, external gateway surcharge 0.6%–2% depending on plan);
                Medusa Cloud pricing from medusajs.com/pricing/ (Develop $29/mo, Launch $99/mo, Scale $299/mo, 0% GMV);
                Saleor Cloud pricing from saleor.io/pricing (Select $1,599/mo with GMV cap, 0.8% overage);
                Swell pricing from swell.is/pricing (Starter $29/mo billed annually, revenue ceilings and overage apply);
                Vendure license and Cloud status from vendure.io/pricing (GPLv3 core, Commercial Platform tier, Cloud GA Q4 2026);
                WooCommerce from wordpress.org/plugins/woocommerce (GPL-2.0+, self-hosted, 0% WC transaction fees);
                Shopify agentic commerce (MCP, ACP, UCP) from shopify.com/blog/how-agentic-commerce-works (published April 30, 2026).
                Cartcrft ACP/UCP status from internal docs (docs/acp.md, docs/ucp.md): test mode shipped, live delegated payment in development (roadmap Phase H5).
                Verify all figures directly with each vendor before making purchasing decisions.
              </p>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="compare-cta" data-reveal>
          <div className="compare-cta-inner">
            <h2>Ready to try Cartcrft?</h2>
            <p>Get a store running and MCP-connected in under 10 minutes.</p>
            <div className="compare-cta-actions">
              <Link to="/quickstart" className="btn-primary">Get started free</Link>
              <Link to="/pricing" className="btn-secondary">See pricing</Link>
            </div>
          </div>
        </section>
      </div>
    </SiteLayout>
  )
}
