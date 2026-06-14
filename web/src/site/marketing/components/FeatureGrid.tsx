import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import './FeatureGrid.css'

/**
 * FeatureGrid — a responsive grid of premium feature cards.
 * Each card renders a monoline lucide icon in a refined icon tile.
 */
export interface FeatureItem {
  /** Lucide icon component for this feature */
  Icon: LucideIcon
  title: string
  description: string
  href?: string
}

export interface FeatureGridProps {
  features: FeatureItem[]
  columns?: 2 | 3 | 4
  heading?: string
  subheading?: string
}

function FeatureIcon({ Icon }: { Icon: LucideIcon }) {
  return (
    <span className="feature-icon" aria-hidden="true">
      <Icon size={20} strokeWidth={1.75} absoluteStrokeWidth />
    </span>
  )
}

export default function FeatureGrid({ features, columns = 3, heading, subheading }: FeatureGridProps) {
  return (
    <section className="feature-grid-section" data-reveal>
      {(heading || subheading) && (
        <div className="section-header">
          {heading && <h2 className="section-heading">{heading}</h2>}
          {subheading && <p className="section-subheading">{subheading}</p>}
        </div>
      )}

      <ul className="feature-grid" style={{ '--cols': columns } as CSSProperties} role="list">
        {features.map((f) => (
          <li className="feature-card" key={f.title}>
            {f.href ? (
              <Link to={f.href} className="feature-card-inner feature-card-link">
                <FeatureIcon Icon={f.Icon} />
                <h3 className="feature-title">{f.title}</h3>
                <p className="feature-desc">{f.description}</p>
              </Link>
            ) : (
              <div className="feature-card-inner">
                <FeatureIcon Icon={f.Icon} />
                <h3 className="feature-title">{f.title}</h3>
                <p className="feature-desc">{f.description}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
