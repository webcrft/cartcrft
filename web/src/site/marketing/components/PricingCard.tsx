import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import './PricingCard.css'

/**
 * PricingCard — a single pricing tier card.
 */
export interface PricingCardProps {
  name: string
  price: string
  priceSub?: string
  description: string
  features: string[]
  cta: { label: string; href: string }
  highlighted?: boolean
  badge?: string
}

/** mailto:, http(s):, and other external schemes are plain anchors; in-site paths use react-router. */
function isExternal(href: string): boolean {
  return href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('/dashboard')
}

export default function PricingCard({
  name,
  price,
  priceSub,
  description,
  features,
  cta,
  highlighted = false,
  badge,
}: PricingCardProps) {
  const ctaClass = `cta-btn ${highlighted ? 'cta-btn--primary' : 'cta-btn--secondary'}`
  return (
    <div className={`pricing-card${highlighted ? ' pricing-card--highlighted' : ''}`}>
      {highlighted && <div className="popular-badge">{badge ?? 'Most popular'}</div>}

      <div className="card-header">
        <h3 className="tier-name">{name}</h3>
        <div className="tier-price">
          <span className="price-amount">{price}</span>
          {priceSub && <span className="price-sub">{priceSub}</span>}
        </div>
        <p className="tier-desc">{description}</p>
      </div>

      <ul className="feature-list" role="list">
        {features.map((f) => (
          <li className="feature-item" key={f}>
            <span className="check" aria-hidden="true">
              <Check size={15} strokeWidth={2.75} />
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {isExternal(cta.href) ? (
        <a href={cta.href} className={ctaClass}>{cta.label}</a>
      ) : (
        <Link to={cta.href} className={ctaClass}>{cta.label}</Link>
      )}
    </div>
  )
}
