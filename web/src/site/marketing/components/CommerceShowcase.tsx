import type { LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { CLUSTER_VISUALS } from './CommerceVisuals'
import './CommerceShowcase.css'

/**
 * CommerceShowcase — the commerce-core section. Each cluster pairs a distinct
 * hand-built visual mockup + its flagship module (the "showcase" tile) with a
 * compact grid of the remaining modules. Clusters alternate the showcase side
 * (left / right) and accent colour (lime / cyan) so the three blocks read as
 * three different things, not one card grid repeated. Agentic Terminal tokens.
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
  /** First item becomes the showcase flagship — rest go in the supporting grid */
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

/** The large showcase tile: a visual mockup on top, flagship module below. */
function Showcase({
  feature,
  index,
  Visual,
}: {
  feature: ShowcaseFeature
  index: string
  Visual: ComponentType
}) {
  const body = (
    <>
      <div className="cs-showcase-visual">
        <Visual />
      </div>
      <div className="cs-showcase-text">
        <div className="cs-card-top">
          <ClusterIcon Icon={feature.Icon} />
          <span className="cs-card-index" aria-hidden="true">{index}</span>
        </div>
        <h4 className="cs-card-title cs-card-title--lg">{feature.title}</h4>
        <p className="cs-card-desc">{feature.description}</p>
        {feature.href && (
          <span className="cs-card-go" aria-hidden="true">
            <span>Explore</span>
            <ArrowUpRight size={14} strokeWidth={2} />
          </span>
        )}
      </div>
    </>
  )
  return (
    <div className="cs-showcase">
      <span className="cs-flag" aria-hidden="true">flagship</span>
      {feature.href ? (
        <Link to={feature.href} className="cs-card-link cs-showcase-inner">{body}</Link>
      ) : (
        <div className="cs-showcase-inner">{body}</div>
      )}
    </div>
  )
}

function SupportCard({ feature, index }: { feature: ShowcaseFeature; index: string }) {
  const body = (
    <>
      <div className="cs-card-top">
        <ClusterIcon Icon={feature.Icon} />
        <span className="cs-card-index" aria-hidden="true">{index}</span>
      </div>
      <h4 className="cs-card-title">{feature.title}</h4>
      <p className="cs-card-desc">{feature.description}</p>
      {feature.href && (
        <span className="cs-card-go" aria-hidden="true">
          <span>Explore</span>
          <ArrowUpRight size={13} strokeWidth={2} />
        </span>
      )}
    </>
  )
  return (
    <li className="cs-support-card">
      {feature.href ? (
        <Link to={feature.href} className="cs-card-inner cs-card-link">{body}</Link>
      ) : (
        <div className="cs-card-inner">{body}</div>
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
        {clusters.map((cluster, ci) => {
          const [featured, ...rest] = cluster.features
          const featIdx = String(globalIndex).padStart(2, '0')
          globalIndex += 1
          const restIdxs = rest.map(() => {
            const idx = String(globalIndex).padStart(2, '0')
            globalIndex += 1
            return idx
          })
          const Visual = CLUSTER_VISUALS[ci % CLUSTER_VISUALS.length]

          return (
            <div
              className={`cs-cluster${ci % 2 === 1 ? ' cs-cluster--alt' : ''}`}
              data-accent={ci % 2 === 1 ? 'cyan' : 'lime'}
              key={cluster.label}
            >
              {/* Cluster label bar */}
              <div className="cs-cluster-header">
                <span className="cs-cluster-num" aria-hidden="true">{String(ci + 1).padStart(2, '0')}</span>
                <span className="cs-cluster-label">{cluster.label}</span>
                <span className="cs-cluster-desc">{cluster.descriptor}</span>
                <span className="cs-cluster-line" aria-hidden="true" />
                <span className="cs-cluster-count" aria-hidden="true">{cluster.features.length} modules</span>
              </div>

              {/* Cluster content: showcase tile + support grid */}
              <div className="cs-cluster-body">
                <Showcase feature={featured} index={featIdx} Visual={Visual} />

                {rest.length > 0 && (
                  <ul className="cs-support-grid" role="list" data-odd={rest.length % 2 === 1 ? '' : undefined}>
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
