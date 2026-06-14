import './Integrations.css'

/**
 * Integrations — a tasteful, grouped logo strip in the Agentic Terminal
 * language: hairline spec-sheet cards, mono category labels, logos tinted to
 * ink/off-white on the dark surface (grayscale + brightness). Framed as
 * "works with / BYO keys" — no implied partnerships. Every entry maps to a
 * real backend module (payments, customer-auth, feeds, analytics).
 */

interface Logo {
  /** filename under /logos */
  src: string
  /** accessible label / tooltip */
  name: string
}

interface IntegrationGroup {
  label: string
  /** mono index, e.g. "01" */
  index: string
  note: string
  logos: Logo[]
}

const groups: IntegrationGroup[] = [
  {
    label: 'Payments',
    index: '01',
    note: 'Charge in your own merchant accounts.',
    logos: [
      { src: '/logos/stripe.svg', name: 'Stripe' },
      { src: '/logos/paystack.svg', name: 'Paystack' },
      { src: '/logos/razorpay.svg', name: 'Razorpay' },
      { src: '/logos/xendit.svg', name: 'Xendit' },
    ],
  },
  {
    label: 'Identity / SSO',
    index: '02',
    note: 'Social login for first-class customer accounts.',
    logos: [
      { src: '/logos/google.svg', name: 'Google' },
      { src: '/logos/microsoft.svg', name: 'Microsoft' },
      { src: '/logos/discord.svg', name: 'Discord' },
    ],
  },
  {
    label: 'Channels',
    index: '03',
    note: 'Generated product feeds for shopping surfaces.',
    logos: [
      { src: '/logos/google_shopping.svg', name: 'Google Shopping' },
      { src: '/logos/facebook_catalog.svg', name: 'Meta / Facebook Catalog' },
    ],
  },
  {
    label: 'Analytics',
    index: '04',
    note: 'Server-side ecommerce + purchase events.',
    logos: [
      { src: '/logos/google_analytics_4.svg', name: 'Google Analytics 4' },
    ],
  },
]

export default function Integrations() {
  return (
    <section className="integrations" data-reveal>
      <div className="integrations-inner">
        <div className="integrations-header">
          <div className="mk-eyebrow">
            <span className="ey-b">[</span>
            <span className="ey-dot" />
            works with
            <span className="ey-b">]</span>
          </div>
          <h2>
            Bring your own keys. <span className="hl">Plug in the rest.</span>
          </h2>
          <p>
            Cartcrft is provider-neutral. Connect your own payment, identity, channel, and analytics
            accounts — no platform rake, no lock-in. Every adapter is BYO-credentials and the surface is
            extensible, so adding another provider is a module, not a rewrite.
          </p>
        </div>

        <ul className="integration-groups" role="list">
          {groups.map((g) => (
            <li className="integration-group" key={g.label}>
              <div className="ig-top">
                <span className="ig-label">{g.label}</span>
                <span className="ig-index" aria-hidden="true">{g.index}</span>
              </div>
              <ul className="ig-logos" role="list">
                {g.logos.map((logo) => (
                  <li className="ig-logo" key={logo.name} title={logo.name}>
                    <img src={logo.src} alt={logo.name} loading="lazy" decoding="async" />
                  </li>
                ))}
              </ul>
              <p className="ig-note">{g.note}</p>
            </li>
          ))}
        </ul>

        <p className="integrations-foot">
          Names and marks belong to their owners. Cartcrft works with these services via your own keys —
          no partnership implied.
        </p>
      </div>
    </section>
  )
}
