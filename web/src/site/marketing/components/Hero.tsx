import './Hero.css'

/**
 * Hero — "Agentic Terminal" aesthetic. Big Bricolage display headline, mono
 * spec-strip, electric-lime accents over a grained, grid-lit dark canvas, and a
 * custom animated agent-console illustration. Orchestrated staggered entrance.
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
      <div className="hero-fx" aria-hidden="true">
        <div className="hero-gridlines cc-grid-bg" />
        <div className="hero-glow" />
        <div className="hero-glow hero-glow--2" />
      </div>
      <div className="cc-grain" aria-hidden="true" />

      <div className="hero-inner">
        <div className="hero-lead">
          <div className="hero-eyebrow">
            <span className="ey-bracket">[</span>
            <span className="ey-dot" />
            {badge ?? 'open source · agent-native'}
            <span className="ey-bracket">]</span>
          </div>

          <h1 className="hero-h1" dangerouslySetInnerHTML={{ __html: headline }} />

          <p className="hero-sub">{subheadline}</p>

          <div className="hero-cta">
            <a href={ctaPrimary.href} className="cc-btn cc-btn--primary cc-btn--lg">
              {ctaPrimary.label}
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path fill="currentColor" d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06z" />
              </svg>
            </a>
            {ctaSecondary && (
              <a
                href={ctaSecondary.href}
                className="cc-btn cc-btn--ghost cc-btn--lg"
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

          <dl className="hero-spec">
            <div><dt>protocols</dt><dd>MCP · ACP · UCP</dd></div>
            <div><dt>take rate</dt><dd>0<span>%</span></dd></div>
            <div><dt>providers</dt><dd>4 · BYO</dd></div>
            <div><dt>license</dt><dd>MIT</dd></div>
          </dl>
        </div>

        <div className="hero-stage" aria-hidden="true">
          <div className="console">
            <div className="console-bar">
              <span className="cb-dot" /><span className="cb-dot" /><span className="cb-dot" />
              <span className="cb-title">agent_session.mcp</span>
              <span className="cb-live"><span className="cb-live-dot" />live</span>
            </div>
            <pre className="console-body"><code>
<span className="ln"><span className="c-cmt"># any MCP agent — Claude, your own — connects</span></span>
<span className="ln"><span className="c-fn">search_products</span>(<span className="c-str">"merino hoodie &lt; $100"</span>)<span className="c-ok"> → 12</span></span>
<span className="ln"><span className="c-fn">create_cart</span>() · <span className="c-fn">add</span>(<span className="c-var">var_8x</span>, <span className="c-num">1</span>)</span>
<span className="ln"><span className="c-fn">start_checkout</span>(<span className="c-var">addr</span>)<span className="c-cmt"> # tax+ship</span></span>
<span className="ln ln-final"><span className="c-fn">complete_checkout</span>()<span className="c-ok"> ✓ paid #1024</span><span className="caret" /></span>
            </code></pre>
          </div>

          {/* custom node illustration: agent → cart → store, animated */}
          <svg className="flow" viewBox="0 0 320 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path className="flow-path" d="M40 60 H140 M180 60 H280" stroke="var(--brand)" strokeWidth="2" strokeDasharray="4 6" strokeLinecap="round" />
            <g className="node node--a">
              <circle cx="40" cy="60" r="22" fill="var(--bg-subtle)" stroke="var(--line-strong)" strokeWidth="1.5" />
              <circle cx="40" cy="60" r="5" fill="var(--accent)" />
              <circle cx="30" cy="52" r="2.4" fill="var(--ink-subtle)" /><circle cx="50" cy="52" r="2.4" fill="var(--ink-subtle)" />
              <circle cx="30" cy="68" r="2.4" fill="var(--ink-subtle)" /><circle cx="50" cy="68" r="2.4" fill="var(--ink-subtle)" />
            </g>
            <g className="node node--c">
              <rect x="138" y="38" width="44" height="44" rx="10" fill="var(--brand)" />
              <path d="M150 52 H154 L157 68 H171 L174 57 H156" stroke="var(--brand-ink)" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="156" cy="72" r="1.8" fill="var(--brand-ink)" /><circle cx="168" cy="72" r="1.8" fill="var(--brand-ink)" />
            </g>
            <g className="node node--s">
              <circle cx="280" cy="60" r="22" fill="var(--bg-subtle)" stroke="var(--line-strong)" strokeWidth="1.5" />
              <path d="M270 64 v-7 l10 -7 l10 7 v7 z" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round" />
            </g>
          </svg>
        </div>
      </div>
    </section>
  )
}
