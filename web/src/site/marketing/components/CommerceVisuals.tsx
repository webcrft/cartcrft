/**
 * CommerceVisuals — small, hand-built CSS/JSX "mockups" that give each
 * CommerceShowcase cluster a distinct visual identity instead of three
 * look-alike card grids. Pure presentational; aria-hidden. Accent colour is
 * inherited from the cluster via the --cs-accent custom property.
 */

/* Catalog — product cards + a variant/price strip */
export function CatalogVisual() {
  const products = [
    { hue: '92 80% 58%', name: 'Ankara Skirt' },
    { hue: '190 90% 62%', name: 'Kente Square' },
    { hue: '28 90% 60%', name: 'Dashiki Shirt' },
  ]
  return (
    <div className="cs-vis cs-vis--catalog" aria-hidden="true">
      <div className="cs-vis-products">
        {products.map((p) => (
          <div className="cs-prod" key={p.name}>
            <div className="cs-prod-thumb" style={{ background: `linear-gradient(135deg, hsl(${p.hue} / 0.9), hsl(${p.hue} / 0.35))` }} />
            <span className="cs-prod-line cs-prod-line--name" />
            <span className="cs-prod-line cs-prod-line--sku" />
          </div>
        ))}
      </div>
      <div className="cs-vis-variants">
        <span className="cs-chip">XS</span>
        <span className="cs-chip">S</span>
        <span className="cs-chip cs-chip--on">M</span>
        <span className="cs-chip">L</span>
        <span className="cs-vis-sep" />
        <span className="cs-swatch" style={{ background: 'hsl(245 60% 58%)' }} />
        <span className="cs-swatch" style={{ background: 'hsl(28 85% 55%)' }} />
        <span className="cs-swatch cs-swatch--on" />
        <span className="cs-price">R&nbsp;649</span>
      </div>
    </div>
  )
}

/* Selling — order pipeline + a mini receipt */
export function SellingVisual() {
  const steps = ['Cart', 'Checkout', 'Paid', 'Shipped']
  return (
    <div className="cs-vis cs-vis--flow" aria-hidden="true">
      <div className="cs-flow">
        {steps.map((s, i) => (
          <span className="cs-flow-step" key={s}>
            <span className={`cs-node${i <= 2 ? ' cs-node--on' : ''}`}>{s}</span>
            {i < steps.length - 1 && <span className={`cs-flow-line${i <= 1 ? ' cs-flow-line--on' : ''}`} />}
          </span>
        ))}
      </div>
      <div className="cs-receipt">
        <div className="cs-receipt-row">
          <span className="cs-receipt-item">Ankara Skirt&nbsp;<em>×2</em></span>
          <span className="cs-receipt-amt">R&nbsp;1,298</span>
        </div>
        <div className="cs-receipt-row">
          <span className="cs-receipt-item">Shipping&nbsp;<em>· PUDO</em></span>
          <span className="cs-receipt-amt">R&nbsp;60</span>
        </div>
        <div className="cs-receipt-row cs-receipt-row--total">
          <span>Total</span>
          <span>R&nbsp;1,358</span>
        </div>
      </div>
    </div>
  )
}

/* Customers — a customer profile card + a store-credit chip */
export function CustomersVisual() {
  return (
    <div className="cs-vis cs-vis--customer" aria-hidden="true">
      <div className="cs-cust-card">
        <span className="cs-avatar">AO</span>
        <span className="cs-cust-meta">
          <span className="cs-cust-name">Amara Okafor</span>
          <span className="cs-cust-sub">amara@lekki.co · 14 orders</span>
        </span>
        <span className="cs-tags">
          <span className="cs-tag cs-tag--accent">VIP</span>
          <span className="cs-tag">Wholesale</span>
        </span>
      </div>
      <div className="cs-cust-foot">
        <span className="cs-credit">
          <span className="cs-credit-label">Store credit</span>
          <span className="cs-credit-bal">R&nbsp;450.00</span>
        </span>
        <span className="cs-loyalty">
          <span className="cs-loyalty-dot" />
          <span className="cs-loyalty-dot" />
          <span className="cs-loyalty-dot cs-loyalty-dot--off" />
          <span className="cs-loyalty-txt">Gold tier</span>
        </span>
      </div>
    </div>
  )
}

export const CLUSTER_VISUALS = [CatalogVisual, SellingVisual, CustomersVisual]
