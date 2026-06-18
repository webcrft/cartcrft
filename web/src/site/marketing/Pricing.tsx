import { Link } from 'react-router-dom'
import { Info } from 'lucide-react'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import PricingCard, { type PricingCardProps } from './components/PricingCard'
import ComparisonTable, { type ComparisonRow } from './components/ComparisonTable'
import PricingCalculator from './components/PricingCalculator'
import { PLANS } from './pricingData'
import './Pricing.css'

// Flat-tier billing copy, sourced from the shared catalog (./pricingData).
const solo = PLANS.find((p) => p.id === 'solo')!
const studio = PLANS.find((p) => p.id === 'studio')!
const growth = PLANS.find((p) => p.id === 'growth')!
const scale = PLANS.find((p) => p.id === 'scale')!
const intFmt = new Intl.NumberFormat('en-US')

/** "Up to 3 sites · 5,000 orders/mo · 3 seats" — these are upgrade boundaries, never metered. */
const sitesLine = (p: typeof solo) => `Up to ${p.sites} site${p.sites === 1 ? '' : 's'}`
const ordersLine = (p: typeof solo) => `${intFmt.format(p.orders)} orders/mo`
const seatsLine = (p: typeof solo) => `${p.seats} team seat${p.seats === 1 ? '' : 's'}`

/**
 * Pricing page — /pricing
 * Grounded, transparent pricing with real cost comparison.
 * Tiers are illustrative; final prices TBD. See preview disclaimer below.
 */

// ---- Tier definitions -------------------------------------------------------
const tiers: PricingCardProps[] = [
  {
    name: 'Open Source',
    price: 'Free',
    priceSub: 'forever',
    description: 'MIT licensed. You run it, you own it. No call-home, no usage fees, no vendor lock-in.',
    features: [
      'Full REST API (160+ endpoints)',
      'Postgres + pgvector semantic search',
      'MCP server — agent-native by default',
      'ACP + UCP protocol adapters',
      'Signed agent mandates + audit log',
      'Stripe, Paystack, Razorpay, Xendit',
      'B2B, subscriptions, returns, gift cards',
      'Admin dashboard + TypeScript SDK',
      'Docker image (serve | worker | migrate)',
      'Community support (GitHub)',
    ],
    cta: { label: 'Read self-host docs', href: '/self-host' },
    highlighted: false,
    badge: undefined,
  },
  {
    name: 'Solo',
    price: '$9',
    priceSub: '/mo',
    description:
      'One store, flat. For a single shop getting off the ground. No transaction fees, no rake — your sales are yours.',
    features: [
      'Everything in Open Source',
      'Managed Postgres + pgvector (included)',
      'Automated daily backups',
      'Managed SSL + custom domain',
      sitesLine(solo),
      ordersLine(solo),
      seatsLine(solo),
      '0% GMV rake',
      'No transaction fees',
      'BYO payment keys (Stripe / Paystack)',
      'Community support (GitHub)',
    ],
    cta: {
      label: 'Join the waitlist',
      href: 'mailto:hello@webcrft.io?subject=Solo+waitlist',
    },
    highlighted: false,
    badge: 'Preview pricing',
  },
  {
    name: 'Studio',
    price: '$29',
    priceSub: '/mo',
    description:
      'A few stores, one flat fee. Managed infra, backups and upgrades. Still zero percent of your revenue.',
    features: [
      'Everything in Solo',
      'One-click deploy + zero-downtime upgrades',
      'Agent-surface onboarding wizard',
      sitesLine(studio),
      ordersLine(studio),
      seatsLine(studio),
      '0% GMV rake',
      'No transaction fees',
      'BYO payment keys (Stripe / Paystack)',
      'Email support (next business day)',
    ],
    cta: {
      label: 'Join the waitlist',
      href: 'mailto:hello@webcrft.io?subject=Studio+waitlist',
    },
    highlighted: false,
    badge: 'Preview pricing',
  },
  {
    name: 'Growth',
    price: '$79',
    priceSub: '/mo',
    description:
      'Multi-store scaling on a flat fee. The same $79 whether you do $10k or $1M in sales — Shopify would rake thousands.',
    features: [
      'Everything in Studio',
      sitesLine(growth),
      ordersLine(growth),
      seatsLine(growth),
      'Higher compute + storage allocation',
      '0% GMV rake',
      'No transaction fees',
      'BYO payment keys (Stripe / Paystack)',
      'Priority email support',
      'SLA: 99.9% monthly uptime target',
    ],
    cta: {
      label: 'Join the waitlist',
      href: 'mailto:hello@webcrft.io?subject=Growth+waitlist',
    },
    highlighted: true,
    badge: 'Preview pricing',
  },
  {
    name: 'Scale',
    price: '$199',
    priceSub: '/mo',
    description: 'Serious multi-store volume, still flat. No percentage of your revenue — ever.',
    features: [
      'Everything in Growth',
      sitesLine(scale),
      ordersLine(scale),
      seatsLine(scale),
      'Highest compute + storage allocation',
      '0% GMV rake',
      'No transaction fees',
      'BYO payment keys (Stripe / Paystack)',
      'Priority support + dedicated onboarding',
      'SLA: 99.9% monthly uptime target',
    ],
    cta: {
      label: 'Join the waitlist',
      href: 'mailto:hello@webcrft.io?subject=Scale+waitlist',
    },
    highlighted: false,
    badge: 'Preview pricing',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    priceSub: '',
    description:
      'On-prem or cloud. Custom SLAs, SSO, dedicated support, and volume terms negotiated directly. Still flat — never a rake.',
    features: [
      'Everything in Scale',
      'On-prem or private cloud deployment',
      'Custom SLA + dedicated support',
      'SSO / SAML integration',
      'Custom integrations + professional services',
      'Audit log export + compliance reports',
      'Custom flat plan for high store counts',
    ],
    cta: {
      label: 'Talk to us',
      href: 'mailto:hello@webcrft.io?subject=Enterprise+inquiry',
    },
    highlighted: false,
    badge: undefined,
  },
]

// ---- Feature comparison rows -----------------------------------------------
const compRows: ComparisonRow[] = [
  {
    category: 'Pricing model',
    feature: 'Monthly platform fee',
    values: {
      'CartCrft Cloud': '$9-$199 flat',
      'Shopify Basic': '$39/mo',
      'Medusa Cloud': '$99-$299/mo',
      'Self-host': '~$20-$60 infra',
    },
    highlight: true,
  },
  {
    category: 'Pricing model',
    feature: 'GMV rake / transaction fee',
    values: {
      'CartCrft Cloud': '0%',
      'Shopify Basic': '2.0% external',
      'Medusa Cloud': '0%',
      'Self-host': '0%',
    },
    highlight: true,
  },
  {
    category: 'Pricing model',
    feature: 'Open source / self-hostable',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': false,
      'Medusa Cloud': true,
      'Self-host': true,
    },
  },
  {
    category: 'Agent-native',
    feature: 'MCP server (out of the box)',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': false,
      'Medusa Cloud': false,
      'Self-host': true,
    },
    highlight: true,
  },
  {
    category: 'Agent-native',
    feature: 'ACP + UCP protocol adapters',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': false,
      'Medusa Cloud': false,
      'Self-host': true,
    },
    highlight: true,
  },
  {
    category: 'Agent-native',
    feature: 'Signed agent mandates',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': false,
      'Medusa Cloud': false,
      'Self-host': true,
    },
  },
  {
    category: 'Agent-native',
    feature: 'Semantic search (pgvector, BYO key)',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': 'Paid app',
      'Medusa Cloud': true,
      'Self-host': true,
    },
  },
  {
    category: 'Payments',
    feature: 'BYO payment provider keys',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': 'Partial',
      'Medusa Cloud': true,
      'Self-host': true,
    },
  },
  {
    category: 'Payments',
    feature: 'Paystack (SA-native)',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': 'Paid app',
      'Medusa Cloud': 'Plugin',
      'Self-host': true,
    },
  },
  {
    category: 'Commerce features',
    feature: 'B2B / net terms / quotes',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': 'Plus only',
      'Medusa Cloud': true,
      'Self-host': true,
    },
  },
  {
    category: 'Commerce features',
    feature: 'Subscriptions',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': 'Paid app',
      'Medusa Cloud': true,
      'Self-host': true,
    },
  },
  {
    category: 'Commerce features',
    feature: 'Returns / RMA',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': true,
      'Medusa Cloud': true,
      'Self-host': true,
    },
  },
  {
    category: 'Infrastructure',
    feature: 'Managed Postgres + backups',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': 'N/A (SaaS)',
      'Medusa Cloud': true,
      'Self-host': 'You manage it',
    },
  },
  {
    category: 'Infrastructure',
    feature: 'Zero-downtime upgrades',
    values: {
      'CartCrft Cloud': true,
      'Shopify Basic': 'N/A (SaaS)',
      'Medusa Cloud': true,
      'Self-host': 'You manage it',
    },
  },
]

// ---- FAQ data ---------------------------------------------------------------
const faqs: { q: string; a: string }[] = [
  {
    q: 'Is CartCrft really free to self-host?',
    a: 'Yes. Everything outside the cloud/ directory is MIT licensed — use it, modify it, ship it, build commercial products on it. No call-home, no license check, no usage metering. The cloud/ billing layer is source-visible under a separate license and is only needed if you run the cartcrft.com hosted service.',
  },
  {
    q: 'What does "0% GMV rake" actually mean?',
    a: 'It means CartCrft takes zero percentage of your revenue and charges no per-transaction fee. When a customer pays $100, $100 lands in your Stripe or Paystack account (minus what Stripe/Paystack charges — typically 2.9% + $0.30 for Stripe, 2.9% + R1 for Paystack SA). CartCrft\'s flat monthly fee is the same whether you do $1,000 or $1,000,000 in sales that month.',
  },
  {
    q: 'Are the plan limits (sites, orders, seats) charged per unit?',
    a: 'No. The sites, orders/mo, and seats on each plan are upgrade boundaries — they decide which flat tier fits your usage, nothing more. There are no per-site, per-order, or per-seat overage charges. If you outgrow a tier you move up to the next flat price (Solo $9 → Studio $29 → Growth $79 → Scale $199), or talk to us about Enterprise. Your bill never moves with your sales.',
  },
  {
    q: "How does payment processing work if CartCrft doesn't touch payments?",
    a: 'You configure your own Stripe, Paystack, Razorpay, or Xendit credentials directly in CartCrft via the API. CartCrft stores your keys encrypted (AES-256-GCM) and routes webhooks — but the actual charges, settlements, and payouts happen entirely between your store and your payment provider. CartCrft never holds or touches funds.',
  },
  {
    q: 'What is the LLM key for semantic search?',
    a: 'CartCrft uses pgvector for semantic product search. To enable it, you supply your own OpenAI-compatible embeddings key (any /v1/embeddings endpoint). You pay that provider directly at cost. No CartCrft markup. Full-text search via Postgres works without an LLM key.',
  },
  {
    q: 'How does cloud billing work?',
    a: 'Cloud subscriptions are billed in USD via Paystack (card) or Stripe. The cloud billing layer handles FX conversion to ZAR internally for invoicing. You see USD prices on this page; your invoice reflects ZAR at the rate at billing time. USD pricing is the fixed reference.',
  },
  {
    q: 'Why are Cloud tiers marked "preview"?',
    a: "CartCrft Cloud is in active development. The tier structure and prices shown here are illustrative and grounded in our cost model, but are not final. We're being upfront rather than publishing a price sheet and changing it later. Waitlist members will be notified of final pricing before billing starts.",
  },
  {
    q: 'Can I switch from self-host to a Cloud plan later?',
    a: 'Yes. The MIT backend and the cloud-hosted backend are the same codebase. You can self-host while you evaluate, then migrate your Postgres database to the managed cloud instance when ready. No data lock-in, no proprietary format.',
  },
  {
    q: 'What happens to self-hosters if cloud pricing changes?',
    a: 'Nothing. Self-hosting is MIT and always free. Cloud price changes only affect cloud subscribers. The self-host path will never require a paid license.',
  },
]

export default function Pricing() {
  useDocumentMeta({
    title: 'Pricing',
    description:
      'CartCrft is free to self-host forever (MIT). Cloud hosting charges a flat fee with 0% GMV rake. Transparent cost comparison vs Shopify and Medusa included.',
  })

  return (
    <SiteLayout>
      <div className="mk-pricing">
        {/* ---- Preview banner -------------------------------------------------- */}
        <div className="preview-banner" role="note">
          <span className="preview-icon" aria-hidden="true">
            <Info size={16} strokeWidth={2.25} />
          </span>
          <span>
            <strong>Cloud pricing is in preview.</strong>{' '}
            Tier structure and final prices are illustrative — not yet locked in. Self-host is free, forever.{' '}
            <a href="mailto:hello@webcrft.io?subject=Cloud+waitlist">Join the waitlist</a> to be notified before billing starts.
          </span>
        </div>

        {/* ---- Page header ------------------------------------------------------ */}
        <section className="page-header">
          <div className="page-header-fx" aria-hidden="true">
            <div className="page-header-grid cc-grid-bg" />
          </div>
          <div className="cc-grain" aria-hidden="true" />
          <div className="page-header-inner">
            <div className="header-badge">
              <span className="ey-b">[</span>
              <span className="ey-dot" />
              MIT · 0% GMV rake · BYO keys
              <span className="ey-b">]</span>
            </div>
            <h1>No Shopify <span className="hl">tax</span>. Ever.</h1>
            <p>
              Self-host free. Or pay a flat monthly fee for managed infra.
              Either way, CartCrft takes <strong>zero percent</strong> of your revenue.
            </p>
          </div>
        </section>

        {/* ---- Pricing grid ----------------------------------------------------- */}
        <section className="pricing-section" data-reveal>
          <div className="pricing-grid">
            {tiers.map((t) => (
              <PricingCard
                key={t.name}
                name={t.name}
                price={t.price}
                priceSub={t.priceSub}
                description={t.description}
                features={t.features}
                cta={t.cta}
                highlighted={t.highlighted}
                badge={t.badge}
              />
            ))}
          </div>
        </section>

        {/* ---- Interactive grounded cost calculator ---------------------------- */}
        <section className="calc-section" data-reveal style={{ padding: 'clamp(2rem, 5vw, 4.5rem) var(--gutter)' }}>
          <PricingCalculator />
        </section>

        {/* ---- Where your money goes -------------------------------------------- */}
        <section className="money-section" data-reveal>
          <div className="money-inner">
            <h2>Where your money goes</h2>
            <p className="money-sub">
              Growth at $79/mo. Merchant using Paystack SA doing $10k/mo GMV over ~200 orders.
            </p>

            <div className="money-grid">
              <div className="money-card money-card--cartcrft">
                <div className="money-amount">$79</div>
                <div className="money-label">CartCrft flat fee</div>
                <div className="money-desc">
                  Managed Postgres + pgvector, backups, upgrades, SSL, support.
                  <em>Fixed — same at $1k or $1M GMV.</em>
                </div>
              </div>
              <div className="money-card money-card--provider">
                <div className="money-amount">~$295</div>
                <div className="money-label">Paystack (goes to Paystack, at cost)</div>
                <div className="money-desc">
                  2.9% + R1/txn x ~200 orders = 2.9% x $10,000 + ~$5 flat fees.
                  <em>Paystack's fee — you're in the contract with them directly.</em>
                </div>
              </div>
              <div className="money-card money-card--llm">
                <div className="money-amount">$0–$20</div>
                <div className="money-label">LLM / semantic search (optional, BYO)</div>
                <div className="money-desc">
                  OpenAI text-embedding-3-small: ~$0.02/1M tokens. Light workload costs a few dollars.
                  <em>BYO key — CartCrft never sees this bill.</em>
                </div>
              </div>
            </div>

            <p className="money-note">
              <strong>The anti-Shopify comparison:</strong> Shopify Basic at $39/mo + 2.0% external-gateway fee on $10k GMV
              = $39 + $200 = $239/mo before any paid apps. CartCrft Growth: $79 flat + $295 Paystack at cost = $374/mo
              total — but Paystack's cut goes to Paystack, not us. At $50k/mo GMV, Shopify's rake alone is $1,000/mo
              extra on top of the $39 plan. CartCrft: still $79 flat.
            </p>
          </div>
        </section>

        {/* ---- Cost comparison -------------------------------------------------- */}
        <section className="compare-section" data-reveal>
          <div className="compare-inner">
            <h2>Real cost comparison</h2>
            <p className="compare-sub">
              Worked example: $10,000/mo GMV · ~200 orders · avg order $50 · external payment gateway.
              All assumptions are stated below the table.
            </p>

            <div className="cost-table-wrapper">
              <table className="cost-table" aria-label="Monthly cost comparison at $10k GMV">
                <thead>
                  <tr>
                    <th className="th-platform">Platform</th>
                    <th>Plan fee</th>
                    <th>Platform rake</th>
                    <th>Payment processing</th>
                    <th className="th-total">Total est./mo</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="td-platform">
                      <strong>Shopify Basic</strong>
                      <span className="td-note">Monthly billing</span>
                    </td>
                    <td>$39</td>
                    <td>
                      <span className="rake-bad">$200</span>
                      <span className="rake-pct">(2.0% of $10k)</span>
                    </td>
                    <td>Waived with Shopify Payments; 2.0% if external</td>
                    <td className="td-total">
                      <strong className="total-bad">$239+</strong>
                      <span className="td-note">plus app fees for subscriptions, B2B</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="td-platform">
                      <strong>Medusa Cloud</strong>
                      <span className="td-note">Launch $99 / Scale $299</span>
                    </td>
                    <td>$99–$299</td>
                    <td>
                      <span className="rake-good">$0</span>
                      <span className="rake-pct">(0% rake)</span>
                    </td>
                    <td>Stripe/Paystack at cost (~$290)</td>
                    <td className="td-total">
                      <strong>$389–$589</strong>
                      <span className="td-note">plus infra add-ons</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="td-platform">
                      <strong>Self-host CartCrft</strong>
                      <span className="td-note">MIT, you operate it</span>
                    </td>
                    <td>
                      $0 software
                      <span className="td-note">+ ~$40/mo infra</span>
                    </td>
                    <td>
                      <span className="rake-good">$0</span>
                      <span className="rake-pct">(0% rake)</span>
                    </td>
                    <td>Paystack/Stripe at cost (~$290)</td>
                    <td className="td-total">
                      <strong>~$330</strong>
                      <span className="td-note">ops overhead not counted</span>
                    </td>
                  </tr>
                  <tr className="row-ours">
                    <td className="td-platform">
                      <strong>CartCrft Growth</strong>
                      <span className="td-note">Preview · managed infra</span>
                    </td>
                    <td>$79 flat</td>
                    <td>
                      <span className="rake-good">$0</span>
                      <span className="rake-pct">(0% rake)</span>
                    </td>
                    <td>Paystack/Stripe at cost (~$290)</td>
                    <td className="td-total">
                      <strong className="total-good">~$369</strong>
                      <span className="td-note">managed infra, backups, upgrades included</span>
                    </td>
                  </tr>
                  <tr className="row-ours">
                    <td className="td-platform">
                      <strong>CartCrft Solo / Studio</strong>
                      <span className="td-note">Preview · single-store entry tiers</span>
                    </td>
                    <td>$9–$29 flat</td>
                    <td>
                      <span className="rake-good">$0</span>
                      <span className="rake-pct">(0% rake)</span>
                    </td>
                    <td>Paystack/Stripe at cost (~$290)</td>
                    <td className="td-total">
                      <strong className="total-good">~$299–$319</strong>
                      <span className="td-note">vs Shopify Basic $239 fee+rake at $10k GMV</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="assumptions-box">
              <h3>
                Assumptions &amp; sources
                <span className="as-of">as of June 2026</span>
              </h3>
              <ul>
                <li>
                  <strong>Shopify Basic:</strong> $39/mo (monthly billing) + 2.0% external-gateway fee on GMV.
                  Source: <a href="https://www.shopify.com/pricing" target="_blank" rel="noopener noreferrer">shopify.com/pricing</a>.
                  External-gateway fee waived with Shopify Payments; modelled here with an external provider.
                </li>
                <li>
                  <strong>Medusa Cloud:</strong> Launch $99/mo, Scale $299/mo. 0% GMV rake confirmed across all plans.
                  Source: <a href="https://docs.medusajs.com/cloud/pricing" target="_blank" rel="noopener noreferrer">docs.medusajs.com/cloud/pricing</a>.
                </li>
                <li>
                  <strong>Self-host infra:</strong> ~$40/mo estimate (Hetzner CX21 ~$5 + managed Postgres on Neon/Supabase ~$25-$35).
                  Roadmap cites $2,400-$7,200/yr (~$200-$600/mo) for a more capable setup with DevOps tooling.
                  $40 is a minimal-viable configuration. Does not include your operational time.
                </li>
                <li>
                  <strong>Paystack SA fees:</strong> 2.9% + R1 per successful local-card transaction.
                  At $10,000 GMV / 200 orders: 2.9% x $10,000 = $290 + 200 x R1 = ~$295.
                  Source: <a href="https://paystack.com/pricing" target="_blank" rel="noopener noreferrer">paystack.com/pricing</a>
                  {' '}and <code>billingmodel/costs.py</code> (paystack_pct=0.029, paystack_flat_zar=1.0).
                </li>
                <li>
                  <strong>CartCrft Solo:</strong> $9/mo illustrative flat fee (preview, subject to change before GA).
                  1 site, up to 1,000 orders/mo, 1 seat, community support. 0% GMV rake, no transaction fees. Entry tier for a
                  single store. At $1k GMV: Solo $39/mo total (incl. ~$30 Paystack at cost) vs Shopify Basic $89/mo — Solo saves
                  ~$50/mo. Limits are upgrade boundaries, never per-unit charges.
                </li>
                <li>
                  <strong>CartCrft Growth:</strong> $79/mo illustrative flat fee (preview, subject to change before GA).
                  Up to 10 sites / 25,000 orders/mo / 10 seats. 0% GMV rake, no transaction fees. Payment processing goes to
                  Paystack/Stripe at cost.
                </li>
                <li>
                  <strong>Honest caveat:</strong> Self-hosting is cheapest at scale if you have ops capacity.
                  CartCrft Cloud wins on total platform cost vs Shopify when using an external gateway at any GMV.
                  Vs self-host, Cloud adds ~$40/mo for managed infra convenience.
                  If you have a DevOps team and prefer to run your own infra, self-host is cheaper.
                </li>
              </ul>
            </div>

            <div className="breakeven-callout">
              <h3 className="breakeven-heading">The rake compounds with GMV</h3>
              <div className="breakeven-grid">
                <div className="breakeven-item">
                  <div className="breakeven-gmv">$10k/mo GMV</div>
                  <div className="breakeven-row">
                    <span className="breakeven-label-sm">Shopify 2% rake:</span>
                    <strong className="rake-bad">$200/mo</strong>
                  </div>
                  <div className="breakeven-row">
                    <span className="breakeven-label-sm">CartCrft flat:</span>
                    <strong className="rake-good">$79/mo</strong>
                  </div>
                </div>
                <div className="breakeven-arrow" aria-hidden="true">→</div>
                <div className="breakeven-item">
                  <div className="breakeven-gmv">$50k/mo GMV</div>
                  <div className="breakeven-row">
                    <span className="breakeven-label-sm">Shopify 2% rake:</span>
                    <strong className="rake-bad">$1,000/mo</strong>
                  </div>
                  <div className="breakeven-row">
                    <span className="breakeven-label-sm">CartCrft flat:</span>
                    <strong className="rake-good">$79/mo</strong>
                  </div>
                </div>
                <div className="breakeven-arrow" aria-hidden="true">→</div>
                <div className="breakeven-item">
                  <div className="breakeven-gmv">$200k/mo GMV</div>
                  <div className="breakeven-row">
                    <span className="breakeven-label-sm">Shopify 2% rake:</span>
                    <strong className="rake-bad">$4,000/mo</strong>
                  </div>
                  <div className="breakeven-row">
                    <span className="breakeven-label-sm">CartCrft flat:</span>
                    <strong className="rake-good">$79/mo</strong>
                  </div>
                </div>
              </div>
              <p className="breakeven-note">
                Shopify rake figures are the platform fee only; your payment processor (Stripe, Paystack) charges
                additionally on top. Upgrade to Shopify Advanced to reduce rake to 0.6% at $299/mo.
              </p>
              <div className="nano-callout" role="note">
                <strong>Just one store?</strong> The Solo tier at $9/mo gives you the same 0% rake and zero transaction fees
                at the lowest entry point. Solo total at $1k GMV ≈ $39/mo vs Shopify Basic $89/mo — you save ~$50/mo.
              </div>
            </div>
          </div>
        </section>

        {/* ---- Feature comparison table ---------------------------------------- */}
        <section className="feature-compare-section" data-reveal>
          <div className="feature-compare-inner">
            <h2>Feature comparison</h2>
            <p className="feature-compare-sub">
              Key differentiators across platforms. CartCrft brings agent-native features
              that require plugins or are not available elsewhere.
            </p>
            <ComparisonTable
              competitors={['CartCrft Cloud', 'Shopify Basic', 'Medusa Cloud', 'Self-host']}
              rows={compRows}
              ourName="CartCrft Cloud"
              caption="Feature comparison: CartCrft Cloud vs Shopify Basic, Medusa Cloud, and self-hosted CartCrft"
            />
            <p className="table-note">
              Data sourced from platform documentation as of June 2026.
              Self-host column refers to CartCrft self-hosted (MIT), which has feature parity with Cloud
              except for managed infra and support. Medusa plugin availability varies by version.
            </p>
          </div>
        </section>

        {/* ---- FAQ -------------------------------------------------------------- */}
        <section className="faq-section" data-reveal>
          <div className="faq-inner">
            <h2>Frequently asked questions</h2>
            <dl className="faq-list">
              {faqs.map((f) => (
                <div className="faq-item" key={f.q}>
                  <dt>{f.q}</dt>
                  <dd>{f.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ---- CTA band --------------------------------------------------------- */}
        <section className="pricing-cta-band" data-reveal>
          <div className="pricing-cta-inner">
            <h2>Start free. Move to cloud when you are ready.</h2>
            <p>Same codebase. No data lock-in. Flat fee only, ever.</p>
            <div className="cta-buttons">
              <Link to="/quickstart" className="cc-btn cc-btn--lg cc-btn--on-dark cc-btn--primary">Get started free</Link>
              <a href="mailto:hello@webcrft.io?subject=Cloud+waitlist" className="cc-btn cc-btn--lg cc-btn--on-dark cc-btn--ghost">
                Join cloud waitlist
              </a>
            </div>
          </div>
        </section>
      </div>
    </SiteLayout>
  )
}
