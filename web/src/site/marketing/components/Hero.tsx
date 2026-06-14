import './Hero.css'

/**
 * Hero — landing hero. Left: headline + CTAs + protocol chips. Right: a premium
 * glass "agent session" terminal showing a real MCP tool-call sequence, with a
 * floating order-confirmed card. Restrained palette, layered depth.
 */
export interface HeroProps {
  headline: string
  subheadline: string
  ctaPrimary: { label: string; href: string }
  ctaSecondary?: { label: string; href: string }
  badge?: string
}

export default function Hero({ headline, subheadline, ctaPrimary, ctaSecondary, badge }: HeroProps) {
  const isExternal = ctaSecondary?.href.startsWith('http')
  return (
    <section className="hero">
      <div className="hero-bg" aria-hidden="true">
        <div className="hero-aurora" />
        <div className="hero-grid" />
      </div>

      <div className="hero-inner">
        <div className="hero-content">
          {badge && (
            <div className="hero-eyebrow">
              <span className="eyebrow-dot" aria-hidden="true" />
              <span>{badge}</span>
            </div>
          )}

          <h1 className="hero-headline" dangerouslySetInnerHTML={{ __html: headline }} />
          <p className="hero-sub">{subheadline}</p>

          <div className="hero-actions">
            <a href={ctaPrimary.href} className="cc-btn cc-btn--primary">
              {ctaPrimary.label}
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" />
              </svg>
            </a>
            {ctaSecondary && (
              <a
                href={ctaSecondary.href}
                className="cc-btn cc-btn--ghost"
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
              >
                {ctaSecondary.href.includes('github') && (
                  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
                    <path fill="currentColor" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
                  </svg>
                )}
                {ctaSecondary.label}
              </a>
            )}
          </div>

          <div className="hero-chips" role="list" aria-label="Protocol status">
            <span className="chip chip--on" role="listitem"><span className="chip-dot" />MCP server</span>
            <span className="chip chip--beta" role="listitem"><span className="chip-dot" />ACP · UCP</span>
            <span className="chip chip--on" role="listitem"><span className="chip-dot" />Signed mandates</span>
            <span className="chip chip--on" role="listitem"><span className="chip-dot" />0% take rate</span>
          </div>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="term">
            <div className="term-bar">
              <span className="term-dot" />
              <span className="term-dot" />
              <span className="term-dot" />
              <span className="term-title">agent · mcp session</span>
            </div>
            <pre className="term-body"><code>
<span className="t-cmt"># any MCP agent connects in minutes</span>{'\n'}
<span className="t-fn">search_products</span>(<span className="t-str">"merino hoodie under $100"</span>)<span className="t-ok">  → 12</span>{'\n'}
<span className="t-fn">create_cart</span>() · <span className="t-fn">add_to_cart</span>(<span className="t-var">var_8x</span>, <span className="t-num">1</span>){'\n'}
<span className="t-fn">start_checkout</span>(<span className="t-var">address</span>)<span className="t-cmt">  # tax + shipping</span>{'\n'}
<span className="t-fn">complete_checkout</span>()<span className="t-ok">  ✓ paid · order #1024</span>{'\n'}
<span className="t-cmt"># ed25519 mandate verified ✓</span>
            </code></pre>
          </div>

          <div className="hero-receipt">
            <div className="receipt-check">
              <svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" d="M5 12.5l4.2 4.2L19 7" /></svg>
            </div>
            <div className="receipt-text">
              <strong>Order confirmed</strong>
              <span>#1024 · $89.00 · captured live</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
