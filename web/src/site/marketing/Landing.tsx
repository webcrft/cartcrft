import { Link } from 'react-router-dom'
import {
  Plug,
  Handshake,
  Globe,
  ShieldCheck,
  Search,
  Store,
  Package,
  ShoppingCart,
  CreditCard,
  Building2,
  RotateCcw,
  Lock,
  Braces,
  Zap,
  Container,
  CheckCircle,
  FileBadge,
  KeyRound,
  Server,
} from 'lucide-react'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import Hero from './components/Hero'
import FeatureGrid, { type FeatureItem } from './components/FeatureGrid'
import './Landing.css'

/**
 * Landing page — /
 * Grounded marketing copy. Claims match README + docs. See docs/agent-native.md,
 * docs/acp.md, docs/ucp.md, and roadmap.md for honest feature status.
 */

// ── Agent-native features ─────────────────────────────────────────────────────
const agentFeatures: FeatureItem[] = [
  {
    Icon: Plug,
    title: 'MCP server — shipped',
    description: 'Every store exposes a Model Context Protocol server by default. Any MCP-capable agent — Claude, a custom LLM, your own orchestrator — can browse and purchase in minutes, not months.',
    href: '/agent-native',
  },
  {
    Icon: Handshake,
    title: 'ACP adapter — test mode',
    description: 'First-class Agentic Commerce Protocol adapter (spec pin: 2026-04). Agentic checkout sessions work end-to-end in test mode. Live delegated payment is in active development (Phase H5).',
    href: '/acp',
  },
  {
    Icon: Globe,
    title: 'UCP adapter — test mode',
    description: 'Universal Commerce Protocol (Google surfaces / NRF 2026-01 baseline). Catalog entities, checkout create/update/submit work in test mode. Live payment token passthrough is in active development.',
    href: '/ucp',
  },
  {
    Icon: ShieldCheck,
    title: 'Signed agent mandates',
    description: 'Verifiable consent chain: intent to cart to payment. Each link is ed25519-signed by the agent and audit-logged. Configurable spend limits per agent, per time window.',
    href: '/agent-native',
  },
  {
    Icon: Search,
    title: 'Semantic catalog search',
    description: 'pgvector + Reciprocal Rank Fusion on top of Postgres full-text. BYO OpenAI-compatible embeddings key. Natural-language queries like "warm merino hoodie under $100" just work.',
    href: '/agent-native',
  },
  {
    Icon: Store,
    title: 'Agent-readable storefront',
    description: 'Structured product data, variant options, inventory status, shipping rates, and pricing — all machine-readable and consistently shaped for AI agents to reason over.',
    href: '/api-overview',
  },
]

// ── Commerce core features ────────────────────────────────────────────────────
const commerceFeatures: FeatureItem[] = [
  {
    Icon: Package,
    title: 'Catalog and inventory',
    description: 'Products (simple, bundle, configurable, digital, service, subscription, rental), unlimited variants, collections, metafields, i18n. Warehouses, lot tracking, FEFO, reorder points.',
    href: '/api-overview',
  },
  {
    Icon: ShoppingCart,
    title: 'Carts, checkout and orders',
    description: 'Atomic CompleteByID with price re-validation, inventory decrement, and discount burn in a single transaction. Order lifecycle state machines, cancel, notes, abandoned cart recovery.',
    href: '/api-overview',
  },
  {
    Icon: CreditCard,
    title: '4 payment providers, BYO',
    description: 'Stripe, Paystack, Razorpay, and Xendit — bring your own credentials. AES-256-GCM secret encryption. Inbound webhook router with replay protection. Zero percent platform rake.',
    href: '/byo-keys',
  },
  {
    Icon: Building2,
    title: 'B2B and subscriptions',
    description: 'Companies, credit limits, net terms, quotes/RFQ lifecycle, purchase orders, and customer group pricing. Subscription plans with trial, pause/resume, and generated orders.',
    href: '/api-overview',
  },
  {
    Icon: RotateCcw,
    title: 'Returns, gift cards and more',
    description: 'Full RMA flow (refund/exchange/store credit/repair), restock. Gift card transactions, store credit ledger. Shipping zones, live rates (BobGo), collection points (PUDO).',
    href: '/api-overview',
  },
  {
    Icon: Lock,
    title: 'Customer auth and feeds',
    description: 'Register, login, magic link, OAuth (Google, Microsoft, Discord). Google Shopping XML and Facebook Catalog feeds. GA4 server-side purchase events.',
    href: '/api-overview',
  },
]

// ── DX features ───────────────────────────────────────────────────────────────
const dxFeatures: FeatureItem[] = [
  {
    Icon: Braces,
    title: 'TypeScript end-to-end',
    description: 'The backend is TypeScript on Fastify + zod + plain pg. The generated @cartcrft/sdk is typed from the same OpenAPI 3.1 spec that drives your REST API.',
    href: '/api-overview',
  },
  {
    Icon: Zap,
    title: 'One-command quickstart',
    description: 'Clone, pnpm install, pnpm migrate, pnpm seed, pnpm dev. A seeded demo store with 12 products at localhost:3000 in under five minutes.',
    href: '/quickstart',
  },
  {
    Icon: Container,
    title: 'Single Docker image',
    description: 'One image, three subcommands: serve, worker, migrate. Deploy on any VPS, Fly.io, Railway, or Render. Or run the full stack with docker compose up.',
    href: '/self-host',
  },
  {
    Icon: CheckCircle,
    title: 'Tested core',
    description: 'Backend ships with ~830 tests across 45 suites using Vitest and simulated-time billing tests. Suites cover catalog, carts, orders, payments, B2B, subscriptions, and more.',
    href: '/testing',
  },
]

// Code-panel body preserved verbatim from the Astro source (HTML entities + syntax spans).
const CODE_PANEL_HTML = `<span class="c-comment">// 1. Search catalog</span>
<span class="c-tool">search_products</span>(&#123; query: <span class="c-str">"merino hoodie"</span> &#125;)

<span class="c-comment">// 2. Create cart + add item</span>
<span class="c-tool">create_cart</span>(&#123; currency: <span class="c-str">"USD"</span> &#125;)
<span class="c-tool">add_to_cart</span>(&#123; variantId: <span class="c-str">"var_..."</span>, qty: 1 &#125;)

<span class="c-comment">// 3. Checkout atomically</span>
<span class="c-tool">start_checkout</span>(&#123; cartId, address &#125;)
<span class="c-tool">complete_checkout</span>(&#123; cartId &#125;)
<span class="c-comment">// &#8594; order confirmed, mandate logged</span>`

export default function Landing() {
  useDocumentMeta({
    title: 'The open-source, agent-native commerce backend',
    description:
      'Cartcrft is an open-source headless commerce backend built for the agentic era. MCP server, ACP/UCP adapters, signed mandates, 4 payment providers. MIT licensed, zero take rate, self-host or cloud.',
  })

  return (
    <SiteLayout>
      <div className="mk-landing">
        {/* Hero */}
        <Hero
          badge="Open source · MIT licensed · TypeScript"
          headline='The <span class="gradient">open-source, agent-native</span> commerce backend.'
          subheadline="Make your store reachable by every AI agent — owned by no single platform. MCP server shipped by default. ACP + UCP adapters. Signed agent mandates. Zero take rate. BYO keys. Self-host or cloud."
          ctaPrimary={{ label: 'Get started', href: '/quickstart' }}
          ctaSecondary={{ label: 'View on GitHub', href: 'https://github.com/webcrft/cartcrft' }}
        />

        {/* Stats / proof band */}
        <section className="stats-band" aria-label="At a glance" data-reveal>
          <div className="stats-inner">
            <div className="stat">
              <div className="stat-num gradient-num">0%</div>
              <div className="stat-label">Platform take rate</div>
            </div>
            <div className="stat">
              <div className="stat-num gradient-num">3</div>
              <div className="stat-label">Agent protocols<br />MCP · ACP · UCP</div>
            </div>
            <div className="stat">
              <div className="stat-num gradient-num">4</div>
              <div className="stat-label">Payment providers<br />bring your own keys</div>
            </div>
            <div className="stat">
              <div className="stat-num gradient-num">MIT</div>
              <div className="stat-label">License · self-host<br />or fair cloud</div>
            </div>
          </div>
        </section>

        {/* Why-now section */}
        <section className="why-now" data-reveal>
          <div className="why-now-inner">
            <div className="why-now-label">Why now</div>
            <h2>Agentic commerce is not a future roadmap item.</h2>
            <p>
              AI agents already browse, compare, and purchase on behalf of humans. MCP, ACP, and UCP are
              shipping standards in 2025 and 2026 — not hypotheticals. But every major commerce platform treats
              agent access as an afterthought: a webhook here, a plugin there.
            </p>
            <p>
              Merchants face a new dilemma: surrender to Shopify's closed ecosystem, or hand control to
              OpenAI and Google's native checkout surfaces. Cartcrft is the neutral, open layer you own —
              the Switzerland of agentic commerce. Implement the protocols once; reach every agent platform.
            </p>
            <div className="protocol-pills">
              <span className="pill pill--shipped">MCP — shipped</span>
              <span className="pill pill--test">ACP 2026-04 — test mode</span>
              <span className="pill pill--test">UCP 2026-01 — test mode</span>
              <span className="pill pill--shipped">ed25519 mandates — shipped</span>
              <span className="pill pill--shipped">Semantic search — shipped</span>
            </div>
          </div>
        </section>

        {/* Agent-native features */}
        <FeatureGrid
          heading="Agent-native in the core, not bolted on."
          subheading="Every Cartcrft store is MCP-accessible by default. ACP and UCP protocol adapters are isolated so spec churn never touches your commerce data model."
          features={agentFeatures}
          columns={3}
        />

        {/* How it works — with a connecting line illustration */}
        <section className="how-it-works" data-reveal>
          <div className="how-it-works-inner">
            <h2>How an agent buys from your store</h2>
            <p className="how-subtitle">5 steps. No custom integration. Any MCP-capable agent.</p>

            <div className="steps-layout">
              {/* Steps list */}
              <ol className="steps">
                <li>
                  <span className="step-num">1</span>
                  <div>
                    <strong>Agent connects</strong> — point any MCP client at{' '}
                    <code>POST /mcp/&lt;storeId&gt;</code> with a <code>cc_pub_</code> key.
                  </div>
                </li>
                <li>
                  <span className="step-num">2</span>
                  <div>
                    <strong>Agent searches</strong> — <code>search_products</code> runs hybrid
                    semantic + full-text search over your catalog.
                  </div>
                </li>
                <li>
                  <span className="step-num">3</span>
                  <div>
                    <strong>Agent carts</strong> — <code>create_cart</code> then{' '}
                    <code>add_to_cart</code> with variant and quantity.
                  </div>
                </li>
                <li>
                  <span className="step-num">4</span>
                  <div>
                    <strong>Agent checks out</strong> — <code>start_checkout</code> calculates tax +
                    shipping; <code>complete_checkout</code> places the order atomically.
                  </div>
                </li>
                <li>
                  <span className="step-num">5</span>
                  <div>
                    <strong>Mandate verified</strong> — if configured, the ed25519 intent to cart to payment
                    chain is verified before funds move.
                  </div>
                </li>
              </ol>

              {/* Mini-illustration: code snippet panel */}
              <div className="how-code-panel" aria-label="Example MCP tool call sequence">
                <div className="code-panel-header">
                  <span className="dot red"></span>
                  <span className="dot amber"></span>
                  <span className="dot green"></span>
                  <span className="panel-title">mcp://cartcrft.io/&lt;storeId&gt;</span>
                </div>
                <pre className="code-panel-body"><code dangerouslySetInnerHTML={{ __html: CODE_PANEL_HTML }} /></pre>
              </div>
            </div>

            <p className="how-note">
              Full 9-step walkthrough with verified tool-call transcripts in{' '}
              <Link to="/quickstart-mcp">quickstart-mcp</Link>.
              Test mode requires no payment credentials.
            </p>
          </div>
        </section>

        {/* Commerce core features */}
        <FeatureGrid
          heading="A complete commerce stack under the agent layer."
          subheading="Catalog, orders, payments, shipping, tax, discounts, B2B, subscriptions, returns — all shipped, all tested. Not a prototype."
          features={commerceFeatures}
          columns={3}
        />

        {/* Fair and open section */}
        <section className="fair-open" data-reveal>
          <div className="fair-open-inner">
            <div className="fair-open-header">
              <div className="section-label">Fair by design</div>
              <h2>Built for developers who want to own their stack.</h2>
            </div>
            <div className="fair-open-grid">
              <div className="fair-card">
                <div className="fair-icon-wrap">
                  <FileBadge size={22} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                </div>
                <h3>MIT licensed</h3>
                <p>
                  Everything outside the cloud layer is MIT. No copyleft, no open-core feature paywalls,
                  no delayed conversion. Fork it, build on it, ship it.
                </p>
              </div>
              <div className="fair-card">
                <div className="fair-icon-wrap">
                  <KeyRound size={22} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                </div>
                <h3>BYO keys, zero rake</h3>
                <p>
                  Your Stripe, Paystack, Razorpay, or Xendit credentials. Your OpenAI-compatible
                  embeddings key. Cartcrft takes 0% of your revenue — ever.
                </p>
              </div>
              <div className="fair-card">
                <div className="fair-icon-wrap">
                  <Server size={22} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                </div>
                <h3>Self-host or fair cloud</h3>
                <p>
                  One Docker image, three subcommands. Deploy anywhere. Or use Cartcrft Cloud — a
                  flat fee, no GMV percentage, no lock-in. Self-hosting requires nothing from
                  the cloud layer.
                </p>
              </div>
              <div className="fair-card">
                <div className="fair-icon-wrap">
                  <ShieldCheck size={22} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                </div>
                <h3>Security by design</h3>
                <p>
                  AES-256-GCM credential encryption, argon2id password hashing, JWT + HMAC auth,
                  multi-tenant isolation, CORS hardening, rate limiting.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* DX section */}
        <FeatureGrid
          heading="Developer experience as a retention moat."
          subheading="TypeScript end-to-end. Generated SDK. OpenAPI 3.1. One-command setup. Tested core. No magic, no black boxes."
          features={dxFeatures}
          columns={4}
        />

        {/* Compare teaser */}
        <section className="compare-teaser" data-reveal>
          <div className="compare-teaser-inner">
            <div className="compare-teaser-text">
              <div className="section-label">Platform comparison</div>
              <h2>See how we stack up.</h2>
              <p>
                Side-by-side comparison of Cartcrft vs Shopify, Medusa v2, Vendure, Saleor, Swell, and
                WooCommerce — across licensing, pricing, agent-native capabilities, and commerce features.
                No strawmen; where competitors lead, we say so.
              </p>
              <Link to="/compare" className="teaser-link">
                Read the full comparison
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" />
                </svg>
              </Link>
            </div>
            {/* Mini comparison preview */}
            <div className="compare-mini" aria-label="Quick comparison preview">
              <table className="mini-table">
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th className="col-us">Cartcrft</th>
                    <th>Shopify</th>
                    <th>Medusa</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>MCP server</td>
                    <td className="col-us yes">✓</td>
                    <td className="yes">✓</td>
                    <td className="no">✗</td>
                  </tr>
                  <tr>
                    <td>ACP / UCP</td>
                    <td className="col-us yes">✓</td>
                    <td className="partial">Partial</td>
                    <td className="no">✗</td>
                  </tr>
                  <tr>
                    <td>Transaction fee</td>
                    <td className="col-us yes">0%</td>
                    <td className="no">0.6–2%</td>
                    <td className="yes">0%</td>
                  </tr>
                  <tr>
                    <td>Self-hostable</td>
                    <td className="col-us yes">✓</td>
                    <td className="no">✗</td>
                    <td className="yes">✓</td>
                  </tr>
                  <tr>
                    <td>License</td>
                    <td className="col-us">MIT</td>
                    <td className="partial">Closed</td>
                    <td>MIT</td>
                  </tr>
                </tbody>
              </table>
              <p className="mini-table-note">Figures as of June 2026. <Link to="/compare">Full comparison →</Link></p>
            </div>
          </div>
        </section>

        {/* CTA band */}
        <section className="cta-band" data-reveal>
          <div className="cta-band-inner">
            {/* decorative SVG circles */}
            <div className="cta-deco" aria-hidden="true">
              <svg viewBox="0 0 200 200" width="200" height="200">
                <circle cx="100" cy="100" r="80" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
                <circle cx="100" cy="100" r="55" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" />
                <circle cx="100" cy="100" r="30" fill="rgba(255,255,255,0.06)" />
                <path d="M75 75 H85 L92 105 a4 4 0 0 0 3.9 3.1 h21 a4 4 0 0 0 3.9-3.1 L110 85 H80" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="93" cy="115" r="3.5" fill="rgba(255,255,255,0.5)" />
                <circle cx="107" cy="115" r="3.5" fill="rgba(255,255,255,0.5)" />
              </svg>
            </div>

            <div className="cta-band-text">
              <h2>Your store, reachable by every agent.</h2>
              <p>
                Get a Cartcrft server running and MCP-connected in under 10 minutes.
                No payment credentials required for test mode.
              </p>
              <div className="cta-band-actions">
                <Link to="/quickstart" className="cc-btn cc-btn--primary cc-btn--on-dark cc-btn--lg">Read the quickstart</Link>
                <Link to="/quickstart-mcp" className="cc-btn cc-btn--ghost cc-btn--on-dark cc-btn--lg">Agent quickstart (MCP)</Link>
              </div>
              <p className="cta-compare-link">
                See how Cartcrft compares to Shopify, Medusa, Vendure, Saleor, and others —{' '}
                <Link to="/compare">feature comparison</Link>.
              </p>
            </div>
          </div>
        </section>
      </div>
    </SiteLayout>
  )
}
