import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import './FeatureGrid.css'

/**
 * FeatureGrid — a responsive grid of feature cards.
 * Each card accepts an svg string (inline SVG icon) or falls back to the
 * icon string (emoji/text) prop for backwards compat.
 */
export interface FeatureItem {
  /** Inline SVG string for the icon (preferred) */
  svg?: string
  /** Emoji or short text fallback */
  icon?: string
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

function FeatureIcon({ f }: { f: FeatureItem }) {
  return (
    <span className="feature-icon" aria-hidden="true">
      {f.svg ? <span dangerouslySetInnerHTML={{ __html: f.svg }} /> : f.icon}
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
                <FeatureIcon f={f} />
                <h3 className="feature-title">{f.title}</h3>
                <p className="feature-desc">{f.description}</p>
              </Link>
            ) : (
              <div className="feature-card-inner">
                <FeatureIcon f={f} />
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
