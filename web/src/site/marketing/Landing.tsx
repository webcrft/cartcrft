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
  Braces,
  Zap,
  Container,
  CheckCircle,
  FileBadge,
  KeyRound,
  Server,
  UserCircle,
  Boxes,
  Repeat,
  Truck,
  Receipt,
  Tag,
  Gift,
  CalendarClock,
  Check,
} from 'lucide-react'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import Hero from './components/Hero'
import FeatureGrid, { type FeatureItem } from './components/FeatureGrid'
import CommerceShowcase, { type ShowcaseCluster } from './components/CommerceShowcase'
import Integrations from './components/Integrations'
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

// ── Commerce core — clustered for CommerceShowcase ───────────────────────────
const commerceClusters: ShowcaseCluster[] = [
  {
    label: 'catalog & products',
    descriptor: 'the goods you sell',
    features: [
      {
        Icon: Package,
        title: 'Catalog',
        description: 'Products (simple, bundle, configurable, digital, service, subscription, rental), unlimited variants, collections, metafields, and full i18n. The model real catalogs need.',
        href: '/api-overview',
      },
      {
        Icon: Boxes,
        title: 'Inventory and warehousing',
        description: 'Multi-warehouse stock, lot tracking with FEFO, and reorder points. Inventory is decremented inside the same transaction that places the order, so you never oversell.',
        href: '/api-overview',
      },
      {
        Icon: Container,
        title: 'Digital products',
        description: 'Sell downloads and licenses with digital delivery — first-class product types, not a workaround layered on physical goods.',
        href: '/api-overview',
      },
      {
        Icon: CalendarClock,
        title: 'Bookings and rentals',
        description: 'Time-based products with availability and iCal sync for bookings and rentals, sitting in the same catalog as everything else you sell.',
        href: '/api-overview',
      },
      {
        Icon: Search,
        title: 'Channels, feeds and analytics',
        description: 'Google Shopping XML and Meta / Facebook Catalog feeds, plus GA4 server-side purchase events and built-in ecommerce analytics. Reach shopping surfaces without a third-party app.',
        href: '/api-overview',
      },
    ],
  },
  {
    label: 'selling & fulfilment',
    descriptor: 'from cart to doorstep',
    features: [
      {
        Icon: ShoppingCart,
        title: 'Carts, checkout and orders',
        description: 'Atomic checkout with price re-validation, inventory decrement, and discount burn in a single transaction. Order lifecycle state machines, cancellations, notes, and abandoned-cart recovery.',
        href: '/api-overview',
      },
      {
        Icon: CreditCard,
        title: 'Payments — bring your own keys',
        description: 'Connect your own Stripe, Paystack, Razorpay, or Xendit account — Cartcrft never sits in the payment flow and takes 0% of your sales. AES-256-GCM secret encryption and an inbound webhook router with replay protection.',
        href: '/byo-keys',
      },
      {
        Icon: Truck,
        title: 'Shipping',
        description: 'Shipping zones, live carrier rates (BobGo), and collection points (PUDO). Rates and tax are calculated at checkout so the order total is correct before payment.',
        href: '/api-overview',
      },
      {
        Icon: Receipt,
        title: 'Tax',
        description: 'Configurable tax rules applied at checkout across regions, included in the atomic checkout calculation alongside shipping and discounts.',
        href: '/api-overview',
      },
      {
        Icon: Tag,
        title: 'Discounts and promotions',
        description: 'Codes, automatic discounts, and customer-group pricing. Discount burn is part of the single checkout transaction, so a code can never be double-spent.',
        href: '/api-overview',
      },
      {
        Icon: RotateCcw,
        title: 'Returns and RMA',
        description: 'A full return-merchandise flow — refund, exchange, store credit, or repair — with restock. The post-purchase side of commerce that most headless stacks leave out.',
        href: '/api-overview',
      },
    ],
  },
  {
    label: 'customers & loyalty',
    descriptor: 'identity, retention, revenue',
    features: [
      {
        Icon: UserCircle,
        title: 'Customer identity and accounts',
        description: 'First-class customer accounts: register, login, magic-link, and social sign-in with Google, Microsoft, and Discord. Sessions, saved addresses, and customer groups — built in, not bolted on.',
        href: '/api-overview',
      },
      {
        Icon: Building2,
        title: 'B2B commerce',
        description: 'Companies, credit limits and net terms, a full quotes/RFQ lifecycle, purchase orders, and customer-group pricing. Wholesale alongside DTC on one backend.',
        href: '/api-overview',
      },
      {
        Icon: Repeat,
        title: 'Subscriptions and recurring orders',
        description: 'Subscription plans with trials, pause/resume, and automatically generated orders on each cycle. Recurring revenue handled in the core, not a plugin.',
        href: '/api-overview',
      },
      {
        Icon: Gift,
        title: 'Wallet — gift cards and store credit',
        description: 'Gift-card transactions and a store-credit ledger, usable at checkout and as a refund destination from the returns flow.',
        href: '/api-overview',
      },
    ],
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

// MCP snippet for the "Build agent-native commerce" card
const MCP_CARD_HTML = `<span class="c-comment"># connect any MCP agent to your store</span>
<span class="c-tool">search_products</span>(&#123; query: <span class="c-str">"merino hoodie"</span> &#125;)<span class="c-ok"> → 12 results</span>
<span class="c-tool">create_cart</span>() · <span class="c-tool">add_to_cart</span>(<span class="c-str">var_8x</span>)
<span class="c-tool">complete_checkout</span>()<span class="c-ok"> ✓ mandate verified</span>`

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
    title: 'The complete commerce backend — also agent-native',
    description:
      'Cartcrft is a complete open-source commerce backend: catalog, payments, customer accounts and social login, B2B, subscriptions, returns, shipping, tax. It also ships an MCP server and ACP/UCP adapters, making it the most agent-ready stack you can self-host. MIT licensed, zero take rate.',
  })

  return (
    <SiteLayout>
      <div className="mk-landing">
        {/* Hero */}
        <Hero
          badge="Open source · MIT licensed · TypeScript"
          headline='A complete commerce backend. That&rsquo;s also <span class="gradient">agent-native</span>.'
          subheadline="Catalog, payments, customer accounts and social login, B2B, subscriptions, returns, shipping and tax — everything a real store needs, shipped and tested. And every store is MCP-accessible with ACP + UCP adapters, so it&rsquo;s the most agent-ready stack you can own. Zero take rate. BYO keys. Self-host or cloud."
          ctaPrimary={{ label: 'Get started', href: '/quickstart' }}
          ctaSecondary={{ label: 'View on GitHub', href: 'https://github.com/webcrft/cartcrft' }}
        />

        {/* Stats / proof band */}
        <section className="stats-band" aria-label="At a glance" data-reveal>
          <div className="stats-inner">
            <div className="stat">
              <div className="stat-num">0<span className="stat-unit">%</span></div>
              <div className="stat-label">Platform take rate</div>
            </div>
            <div className="stat">
              <div className="stat-num">3</div>
              <div className="stat-label">Agent protocols<br />MCP · ACP · UCP</div>
            </div>
            <div className="stat">
              <div className="stat-num">4</div>
              <div className="stat-label">Payment providers<br />bring your own keys</div>
            </div>
            <div className="stat">
              <div className="stat-num stat-num--word">MIT</div>
              <div className="stat-label">License · self-host<br />or fair cloud</div>
            </div>
          </div>
        </section>

        {/* Two-audience section — "Two ways to ship" */}
        <section className="two-paths" data-reveal aria-label="Two ways to use Cartcrft">
          <div className="two-paths-inner">
            <div className="mk-eyebrow">
              <span className="ey-b">[</span>
              <span className="ey-dot" />
              two ways to ship
              <span className="ey-b">]</span>
            </div>
            <h2 className="two-paths-heading">
              Your complete stack. <span className="hl">Choose your adventure.</span>
            </h2>

            <div className="two-paths-grid">
              {/* ── Left card: merchant / Shopify alternative ── */}
              <div className="path-card path-card--merchant">
                <div className="path-card-header">
                  <span className="path-badge path-badge--lime">For merchants</span>
                  <h3>Replace your storefront platform</h3>
                  <p className="path-sub">
                    Everything Shopify gives you — catalog, payments, accounts, B2B, subscriptions —
                    on infrastructure you own, at 0% take rate.
                  </p>
                </div>

                <ul className="path-bullets">
                  <li>
                    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="path-check path-check--lime" />
                    Complete commerce backend: catalog, payments, identity, B2B, subscriptions, returns, shipping, tax
                  </li>
                  <li>
                    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="path-check path-check--lime" />
                    Real admin dashboard — orders, products, customers, analytics — on day one
                  </li>
                  <li>
                    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="path-check path-check--lime" />
                    MIT licensed, self-host anywhere — you own the stack, not a vendor
                  </li>
                  <li>
                    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="path-check path-check--lime" />
                    0% platform take rate — bring your own Stripe, Paystack, Razorpay, or Xendit keys
                  </li>
                </ul>

                {/* dashboard-overview.png — browser-chrome frame */}
                <figure className="path-screenshot showcase-frame">
                  <div className="browser-chrome" aria-hidden="true">
                    <div className="bc-dots">
                      <span className="bc-dot bc-dot--red" />
                      <span className="bc-dot bc-dot--amber" />
                      <span className="bc-dot bc-dot--green" />
                    </div>
                    <div className="bc-bar">
                      <svg className="bc-lock" viewBox="0 0 8 10" fill="currentColor" aria-hidden="true">
                        <rect x="1" y="4.5" width="6" height="5" rx="1" />
                        <path d="M2 4.5V3a2 2 0 1 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
                      </svg>
                      <span className="bc-address">cartcrft.dev / dashboard</span>
                    </div>
                  </div>
                  <img
                    src="/screenshots/dashboard-overview.png"
                    alt="Cartcrft admin dashboard — store overview with revenue metrics, recent orders, and full nav"
                    width="1512"
                    height="900"
                    loading="lazy"
                    decoding="async"
                    className="showcase-img path-img"
                  />
                  <figcaption className="showcase-caption">
                    <span className="cap-label">admin / overview</span>
                    <span className="cap-sep" aria-hidden="true" />
                    <span className="cap-text">Revenue, orders, AOV, customers — full nav in a single sidebar.</span>
                  </figcaption>
                </figure>

                <Link to="/quickstart" className="cc-btn cc-btn--primary cc-btn--on-dark path-cta">
                  Get started
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" />
                  </svg>
                </Link>
              </div>

              {/* ── Right card: LLM / builder path ── */}
              <div className="path-card path-card--builder">
                <div className="path-card-header">
                  <span className="path-badge path-badge--cyan">For builders &amp; agents</span>
                  <h3>Build agent-native commerce</h3>
                  <p className="path-sub">
                    Every Cartcrft store is MCP-accessible by default. Wire up any LLM, build an
                    AI shopping agent, or integrate ACP/UCP in hours.
                  </p>
                </div>

                <ul className="path-bullets">
                  <li>
                    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="path-check path-check--cyan" />
                    MCP server by default — any MCP-capable agent connects in minutes, no integration code
                  </li>
                  <li>
                    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="path-check path-check--cyan" />
                    ACP &amp; UCP adapters — agent checkout sessions work end-to-end in test mode today
                  </li>
                  <li>
                    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="path-check path-check--cyan" />
                    Signed ed25519 agent mandates — verifiable consent chain, configurable spend limits
                  </li>
                  <li>
                    <Check size={15} strokeWidth={2.5} aria-hidden="true" className="path-check path-check--cyan" />
                    Semantic catalog search and agent-readable storefront — structured data agents reason over
                  </li>
                </ul>

                {/* Compact terminal snippet */}
                <div className="path-console how-code-panel" aria-label="Example MCP tool call sequence">
                  <div className="code-panel-header">
                    <span className="dot red" />
                    <span className="dot amber" />
                    <span className="dot green" />
                    <span className="panel-title">mcp://cartcrft.io/&lt;storeId&gt;</span>
                    <span className="panel-live"><span className="panel-live-dot" />live</span>
                  </div>
                  <pre className="code-panel-body"><code dangerouslySetInnerHTML={{ __html: MCP_CARD_HTML }} /></pre>
                </div>

                <Link to="/quickstart-mcp" className="cc-btn cc-btn--ghost cc-btn--on-dark path-cta path-cta--ghost">
                  Agent quickstart (MCP)
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" />
                  </svg>
                </Link>
              </div>
            </div>
          </div>
        </section>

        {/* Everything a store needs — commerce-first reframe */}
        <section className="everything" data-reveal>
          <div className="everything-inner">
            <div className="mk-eyebrow">
              <span className="ey-b">[</span>
              <span className="ey-dot" />
              everything a store needs
              <span className="ey-b">]</span>
            </div>
            <h2>
              First, it&rsquo;s a <span className="hl">full commerce platform</span>.
            </h2>
            <p>
              Before the agent layer, Cartcrft is a complete, standard ecommerce backend. Catalog and
              inventory, carts and orders, payments, customer accounts, B2B, subscriptions, returns,
              shipping, tax, discounts, gift cards, digital products, and bookings — all shipped, all tested,
              all on a clean REST API and typed SDK. The agent-native part sits on top of a real store.
            </p>
          </div>
        </section>

        {/* Commerce core features — clustered showcase (catalog, selling, customers) */}
        <CommerceShowcase clusters={commerceClusters} />

        {/* Contextual screenshot: product catalog — illustrates "a real admin for your whole catalog" */}
        <section className="catalog-shot" data-reveal aria-label="Product catalog screenshot">
          <div className="catalog-shot-inner">
            <div className="catalog-shot-text">
              <div className="mk-eyebrow">
                <span className="ey-b">[</span>
                <span className="ey-dot" />
                real admin
                <span className="ey-b">]</span>
              </div>
              <h2>A real admin for <span className="hl">your whole catalog</span>.</h2>
              <p>
                Products, variants, collections, digital files, and inventory — managed through a purpose-built
                dashboard, not cobbled together from third-party apps. Your catalog is a first-class citizen,
                not an afterthought.
              </p>
            </div>
            <figure className="catalog-shot-frame showcase-frame">
              <div className="browser-chrome" aria-hidden="true">
                <div className="bc-dots">
                  <span className="bc-dot bc-dot--red" />
                  <span className="bc-dot bc-dot--amber" />
                  <span className="bc-dot bc-dot--green" />
                </div>
                <div className="bc-bar">
                  <svg className="bc-lock" viewBox="0 0 8 10" fill="currentColor" aria-hidden="true">
                    <rect x="1" y="4.5" width="6" height="5" rx="1" />
                    <path d="M2 4.5V3a2 2 0 1 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
                  </svg>
                  <span className="bc-address">cartcrft.dev / dashboard / products</span>
                </div>
              </div>
              <img
                src="/screenshots/dashboard-products.png"
                alt="Cartcrft admin dashboard — product catalog list with variants and pricing"
                width="1512"
                height="900"
                loading="lazy"
                decoding="async"
                className="showcase-img"
              />
              <figcaption className="showcase-caption">
                <span className="cap-label">catalog</span>
                <span className="cap-sep" aria-hidden="true" />
                <span className="cap-text">Products, variants, collections, digital files — no plugin required.</span>
              </figcaption>
            </figure>
          </div>
        </section>

        {/* Contextual callout: hosted checkout — near payments content */}
        <section className="checkout-callout" data-reveal aria-label="Hosted checkout screenshot">
          <div className="checkout-callout-inner">
            <figure className="checkout-callout-frame showcase-frame">
              <div className="browser-chrome" aria-hidden="true">
                <div className="bc-dots">
                  <span className="bc-dot bc-dot--red" />
                  <span className="bc-dot bc-dot--amber" />
                  <span className="bc-dot bc-dot--green" />
                </div>
                <div className="bc-bar">
                  <svg className="bc-lock" viewBox="0 0 8 10" fill="currentColor" aria-hidden="true">
                    <rect x="1" y="4.5" width="6" height="5" rx="1" />
                    <path d="M2 4.5V3a2 2 0 1 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
                  </svg>
                  <span className="bc-address">pay.cartcrft.dev / pay / cl_…</span>
                </div>
              </div>
              <img
                src="/screenshots/checkout.png"
                alt="Cartcrft hosted checkout — branded payment page with line items and total"
                width="1512"
                height="982"
                loading="lazy"
                decoding="async"
                className="showcase-img"
              />
              <figcaption className="showcase-caption">
                <span className="cap-label">checkout</span>
                <span className="cap-sep" aria-hidden="true" />
                <span className="cap-text">Shareable hosted checkout — one API call, one URL, no storefront code.</span>
              </figcaption>
            </figure>
            <div className="checkout-callout-text">
              <div className="mk-eyebrow">
                <span className="ey-b">[</span>
                <span className="ey-dot" />
                hosted checkout &amp; cart links
                <span className="ey-b">]</span>
              </div>
              <h2>One API call. <span className="hl">One URL. Done.</span></h2>
              <p>
                Generate a hosted checkout link from any cart — shareable by email, SMS, or QR code.
                Payments run on your own Stripe, Paystack, Razorpay, or Xendit credentials. 0% take rate.
                No storefront code required.
              </p>
              <Link to="/api-overview" className="checkout-callout-link">
                See the checkout API
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" />
                </svg>
              </Link>
            </div>
          </div>
        </section>

        {/* Integrations — works-with / BYO keys */}
        <Integrations />

        {/* Why-now section */}
        <section className="why-now" data-reveal>
          <div className="why-now-fx" aria-hidden="true">
            <div className="why-now-glow" />
          </div>
          <div className="why-now-inner">
            <div className="why-now-lead">
              <div className="mk-eyebrow">
                <span className="ey-b">[</span>
                <span className="ey-dot" />
                why now
                <span className="ey-b">]</span>
              </div>
              <h2>
                And the agent layer is <span className="hl">not a future</span> roadmap item.
              </h2>
            </div>
            <div className="why-now-body">
              <p>
                A complete commerce backend is table stakes. What makes Cartcrft different is that the same
                store is agent-ready today. AI agents already browse, compare, and purchase on behalf of humans. MCP, ACP, and UCP are
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
          </div>
        </section>

        {/* Agent-native features — the differentiator on top of the platform */}
        <FeatureGrid
          eyebrow="agent layer"
          heading="And it&rsquo;s the most agent-native backend on the market."
          highlight="agent-native"
          subheading="The same complete store is MCP-accessible by default, with ACP and UCP adapters and signed mandates. The protocol adapters are isolated, so spec churn never touches your commerce data model."
          features={agentFeatures}
          columns={3}
        />

        {/* How it works — with a connecting line illustration */}
        <section className="how-it-works" data-reveal>
          <div className="how-it-works-inner">
            <div className="how-header">
              <div className="mk-eyebrow">
                <span className="ey-b">[</span>
                <span className="ey-dot" />
                how it works
                <span className="ey-b">]</span>
              </div>
              <h2>How an <span className="hl">agent buys</span> from your store</h2>
              <p className="how-subtitle">5 steps. No custom integration. Any MCP-capable agent.</p>
            </div>

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

              {/* Mini-illustration: code snippet panel — matches the hero console */}
              <div className="how-code-panel" aria-label="Example MCP tool call sequence">
                <div className="code-panel-header">
                  <span className="dot red"></span>
                  <span className="dot amber"></span>
                  <span className="dot green"></span>
                  <span className="panel-title">mcp://cartcrft.io/&lt;storeId&gt;</span>
                  <span className="panel-live"><span className="panel-live-dot" />live</span>
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

        {/* Fair and open section */}
        <section className="fair-open" data-reveal>
          <div className="fair-open-inner">
            <div className="fair-open-header">
              <div className="mk-eyebrow">
                <span className="ey-b">[</span>
                <span className="ey-dot" />
                fair by design
                <span className="ey-b">]</span>
              </div>
              <h2>Built for developers who want to <span className="hl">own their stack</span>.</h2>
            </div>
            <div className="fair-open-grid">
              <div className="fair-card">
                <div className="fair-card-top">
                  <div className="fair-icon-wrap">
                    <FileBadge size={22} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                  </div>
                  <span className="fair-index" aria-hidden="true">01</span>
                </div>
                <h3>MIT licensed</h3>
                <p>
                  Everything outside the cloud layer is MIT. No copyleft, no open-core feature paywalls,
                  no delayed conversion. Fork it, build on it, ship it.
                </p>
              </div>
              <div className="fair-card">
                <div className="fair-card-top">
                  <div className="fair-icon-wrap">
                    <KeyRound size={22} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                  </div>
                  <span className="fair-index" aria-hidden="true">02</span>
                </div>
                <h3>BYO keys, zero rake</h3>
                <p>
                  Your Stripe, Paystack, Razorpay, or Xendit credentials. Your OpenAI-compatible
                  embeddings key. Cartcrft takes 0% of your revenue — ever.
                </p>
              </div>
              <div className="fair-card">
                <div className="fair-card-top">
                  <div className="fair-icon-wrap">
                    <Server size={22} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                  </div>
                  <span className="fair-index" aria-hidden="true">03</span>
                </div>
                <h3>Self-host or fair cloud</h3>
                <p>
                  One Docker image, three subcommands. Deploy anywhere. Or use Cartcrft Cloud — a
                  flat fee, no GMV percentage, no lock-in. Self-hosting requires nothing from
                  the cloud layer.
                </p>
              </div>
              <div className="fair-card">
                <div className="fair-card-top">
                  <div className="fair-icon-wrap">
                    <ShieldCheck size={22} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
                  </div>
                  <span className="fair-index" aria-hidden="true">04</span>
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
          eyebrow="developer experience"
          heading="Developer experience as a retention moat."
          highlight="retention moat"
          subheading="TypeScript end-to-end. Generated SDK. OpenAPI 3.1. One-command setup. Tested core. No magic, no black boxes."
          features={dxFeatures}
          columns={4}
        />

        {/* Compare teaser */}
        <section className="compare-teaser" data-reveal>
          <div className="compare-teaser-inner">
            <div className="compare-teaser-text">
              <div className="mk-eyebrow">
                <span className="ey-b">[</span>
                <span className="ey-dot" />
                platform comparison
                <span className="ey-b">]</span>
              </div>
              <h2>See how we <span className="hl">stack up</span>.</h2>
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

        {/* Part of Webcrft Systems */}
        <section className="webcrft-band" data-reveal>
          <a className="webcrft-band-inner" href="https://webcrft.systems" target="_blank" rel="noopener noreferrer">
            <img src="/webcrft.svg" alt="" width={44} height={44} />
            <div className="webcrft-band-text">
              <span className="webcrft-eyebrow">[ part of the family ]</span>
              <p>A <strong>Webcrft Systems</strong> project — built by the team behind the webcrft platform.</p>
            </div>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" className="webcrft-arrow"><path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" /></svg>
          </a>
        </section>

        {/* CTA band */}
        <section className="cta-band" data-reveal>
          <div className="cta-band-inner">
            {/* decorative SVG circles */}
            <div className="cta-deco" aria-hidden="true">
              <svg viewBox="0 0 200 200" width="200" height="200">
                <circle cx="100" cy="100" r="80" fill="none" stroke="var(--brand-ink)" strokeOpacity="0.18" strokeWidth="1.5" />
                <circle cx="100" cy="100" r="55" fill="none" stroke="var(--brand-ink)" strokeOpacity="0.12" strokeWidth="1.5" />
                <circle cx="100" cy="100" r="30" fill="var(--brand-ink)" fillOpacity="0.06" />
                <path d="M75 75 H85 L92 105 a4 4 0 0 0 3.9 3.1 h21 a4 4 0 0 0 3.9-3.1 L110 85 H80" fill="none" stroke="var(--brand-ink)" strokeOpacity="0.55" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="93" cy="115" r="3.5" fill="var(--brand-ink)" fillOpacity="0.55" />
                <circle cx="107" cy="115" r="3.5" fill="var(--brand-ink)" fillOpacity="0.55" />
              </svg>
            </div>

            <div className="cta-band-text">
              <div className="cta-eyebrow">
                <span className="ey-b">[</span>
                <span className="ey-dot" />
                ship it
                <span className="ey-b">]</span>
              </div>
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
