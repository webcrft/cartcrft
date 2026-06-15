import type { LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import './CommerceShowcase.css'

/**
 * CommerceShowcase — replaces the flat 15-card FeatureGrid for the commerce-core
 * section only. Groups the same 15 features into 3 labelled clusters with visual
 * rhythm: a wide "featured" card for each cluster's flagship module, then a tighter
 * supporting grid for the remaining items in that cluster.
 *
 * The other two <FeatureGrid> sections (agent-layer, DX) are unchanged.
 */

export interface ShowcaseFeature {
  Icon: LucideIcon
  title: string
  description: string
  href?: string
}

export interface ShowcaseCluster {
  /** Mono sub-label (e.g. "catalog & products") */
  label: string
  /** Short descriptor line shown under the label */
  descriptor: string
  /** First item becomes the wide "featured" card — rest go in the supporting grid */
  features: ShowcaseFeature[]
}

interface CommerceShowcaseProps {
  clusters: ShowcaseCluster[]
}

function ClusterIcon({ Icon }: { Icon: LucideIcon }) {
  return (
    <span className="cs-icon" aria-hidden="true">
      <Icon size={20} strokeWidth={1.75} absoluteStrokeWidth />
    </span>
  )
}

function FeaturedCard({ feature, index }: { feature: ShowcaseFeature; index: string }) {
  const inner = (
    <>
      <div className="cs-card-top">
        <ClusterIcon Icon={feature.Icon} />
        <span className="cs-card-index" aria-hidden="true">{index}</span>
      </div>
      <h4 className="cs-card-title cs-card-title--lg">{feature.title}</h4>
      <p className="cs-card-desc">{feature.description}</p>
    </>
  )
  return (
    <div className="cs-featured-card">
      {feature.href ? (
        <Link to={feature.href} className="cs-card-inner cs-card-link cs-card-inner--featured">
          {inner}
        </Link>
      ) : (
        <div className="cs-card-inner cs-card-inner--featured">{inner}</div>
      )}
    </div>
  )
}

function SupportCard({ feature, index }: { feature: ShowcaseFeature; index: string }) {
  const inner = (
    <>
      <div className="cs-card-top">
        <ClusterIcon Icon={feature.Icon} />
        <span className="cs-card-index" aria-hidden="true">{index}</span>
      </div>
      <h4 className="cs-card-title">{feature.title}</h4>
      <p className="cs-card-desc">{feature.description}</p>
    </>
  )
  return (
    <li className="cs-support-card">
      {feature.href ? (
        <Link to={feature.href} className="cs-card-inner cs-card-link">
          {inner}
        </Link>
      ) : (
        <div className="cs-card-inner">{inner}</div>
      )}
    </li>
  )
}

export default function CommerceShowcase({ clusters }: CommerceShowcaseProps) {
  let globalIndex = 1
  return (
    <section className="cs-section" data-reveal>
      {/* Section header */}
      <div className="cs-header">
        <div className="cs-eyebrow">
          <span className="cs-ey-b">[</span>
          <span className="cs-ey-dot" aria-hidden="true" />
          commerce core
          <span className="cs-ey-b">]</span>
        </div>
        <h2 className="cs-heading">
          Every layer of a real store.{' '}
          <span className="cs-heading-hl">Built in, not bolted on.</span>
        </h2>
        <p className="cs-subheading">
          A complete commerce data model shipped and tested — not a prototype. Catalog, identity,
          orders, payments, inventory, B2B, subscriptions, returns, shipping, tax, wallet, digital
          products, and bookings, all on one clean REST API.
        </p>
      </div>

      {/* Cluster stack */}
      <div className="cs-clusters">
        {clusters.map((cluster) => {
          const [featured, ...rest] = cluster.features
          const featIdx = String(globalIndex).padStart(2, '0')
          globalIndex += 1
          const restIdxs = rest.map(() => {
            const idx = String(globalIndex).padStart(2, '0')
            globalIndex += 1
            return idx
          })

          return (
            <div className="cs-cluster" key={cluster.label}>
              {/* Cluster label bar */}
              <div className="cs-cluster-header">
                <span className="cs-cluster-label">{cluster.label}</span>
                <span className="cs-cluster-desc">{cluster.descriptor}</span>
                <span className="cs-cluster-line" aria-hidden="true" />
              </div>

              {/* Cluster content: featured card + support grid side by side */}
              <div className="cs-cluster-body">
                <FeaturedCard feature={featured} index={featIdx} />

                {rest.length > 0 && (
                  <ul className="cs-support-grid" role="list">
                    {rest.map((f, i) => (
                      <SupportCard key={f.title} feature={f} index={restIdxs[i]} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
