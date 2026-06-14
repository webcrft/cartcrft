import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import './FeatureGrid.css'

/**
 * FeatureGrid — sharp technical "spec-card" grid in the Agentic Terminal
 * language: mono index numbers, lime lucide icons, hairline cards that light
 * lime on hover. Icon prop contract + copy unchanged.
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
  /** Mono bracketed eyebrow shown above the heading */
  eyebrow?: string
  /** Exact substring within `heading` to render in lime (one phrase per section) */
  highlight?: string
}

/** Render heading with `phrase` (if present) wrapped in a lime accent span. */
function renderHeading(heading: string, phrase?: string) {
  if (!phrase) return heading
  const i = heading.indexOf(phrase)
  if (i === -1) return heading
  return (
    <>
      {heading.slice(0, i)}
      <span className="hl">{phrase}</span>
      {heading.slice(i + phrase.length)}
    </>
  )
}

function FeatureIcon({ Icon }: { Icon: LucideIcon }) {
  return (
    <span className="feature-icon" aria-hidden="true">
      <Icon size={20} strokeWidth={1.75} absoluteStrokeWidth />
    </span>
  )
}

export default function FeatureGrid({ features, columns = 3, heading, subheading, eyebrow, highlight }: FeatureGridProps) {
  return (
    <section className="feature-grid-section" data-reveal>
      {(heading || subheading) && (
        <div className="section-header">
          {eyebrow && (
            <div className="fg-eyebrow">
              <span className="fg-ey-bracket">[</span>
              <span className="fg-ey-dot" />
              {eyebrow}
              <span className="fg-ey-bracket">]</span>
            </div>
          )}
          {heading && <h2 className="section-heading">{renderHeading(heading, highlight)}</h2>}
          {subheading && <p className="section-subheading">{subheading}</p>}
        </div>
      )}

      <ul className="feature-grid" style={{ '--cols': columns } as CSSProperties} role="list">
        {features.map((f, i) => {
          const idx = String(i + 1).padStart(2, '0')
          const body = (
            <>
              <div className="feature-card-top">
                <FeatureIcon Icon={f.Icon} />
                <span className="feature-index" aria-hidden="true">{idx}</span>
              </div>
              <h3 className="feature-title">{f.title}</h3>
              <p className="feature-desc">{f.description}</p>
            </>
          )
          return (
            <li className="feature-card" key={f.title}>
              {f.href ? (
                <Link to={f.href} className="feature-card-inner feature-card-link">{body}</Link>
              ) : (
                <div className="feature-card-inner">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
