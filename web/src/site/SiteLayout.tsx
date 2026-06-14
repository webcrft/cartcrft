import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import './SiteLayout.css'

/**
 * SiteLayout — shared chrome (sticky header + footer) for every marketing and
 * docs page in the site zone. Ported from the prior Astro MarketingLayout:
 * same markup/classes/CSS, with the inline scripts reimplemented as effects.
 *
 * In-site links (marketing + docs) use react-router <Link> for SPA navigation;
 * cross-zone links (/dashboard, /superadmin) and external links are plain <a>
 * so they trigger a full-page load into the other zone — identical to the prior
 * multi-page behaviour.
 */

const GITHUB_URL = 'https://github.com/webcrft/cartcrft'
const CLOUD = import.meta.env.PUBLIC_CARTCRFT_CLOUD === '1'

function GitHubIcon({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"
      />
    </svg>
  )
}

export default function SiteLayout({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)

  // Close the mobile menu whenever the route changes.
  useEffect(() => { setMenuOpen(false) }, [location.pathname])

  // Sticky-header shadow on scroll.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Escape closes the mobile menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Scroll to top + re-arm scroll-reveal on every route change.
  useEffect(() => {
    window.scrollTo(0, 0)
    const reveals = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (!reveals.length) return
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReduced || !('IntersectionObserver' in window)) {
      reveals.forEach((el) => el.classList.add('is-revealed'))
      return
    }
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-revealed')
            obs.unobserve(entry.target)
          }
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    reveals.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [location.pathname])

  return (
    <>
      <header className={`site-header${scrolled ? ' is-scrolled' : ''}`}>
        <div className="header-inner">
          <Link to="/" className="header-logo" aria-label="Cartcrft home">
            <img src="/logo.svg" alt="" width={30} height={30} />
            <span className="wordmark">cart<span className="wm-accent">crft</span></span>
          </Link>

          <nav className="header-nav" aria-label="Main navigation">
            <Link to="/quickstart">Docs</Link>
            <Link to="/compare">Compare</Link>
            <Link to="/pricing">Pricing</Link>
            {CLOUD && <Link to="/cloud/overview">Cloud</Link>}
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="nav-github" aria-label="View Cartcrft on GitHub">
              <GitHubIcon size={20} />
              <span className="nav-github-label">GitHub</span>
            </a>
          </nav>

          <div className="header-cta">
            <a href="/dashboard" className="header-login">Log in</a>
            {CLOUD ? (
              <a href="/dashboard/cloud/onboarding" className="cc-btn-primary">Sign up</a>
            ) : (
              <Link to="/quickstart" className="cc-btn-primary">Get started</Link>
            )}
          </div>

          <button
            className={`hamburger${menuOpen ? ' is-open' : ''}`}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="hamburger-line" />
            <span className="hamburger-line" />
            <span className="hamburger-line" />
          </button>
        </div>

        {menuOpen && (
          <nav className="mobile-menu" aria-label="Mobile navigation">
            <Link to="/quickstart">Docs</Link>
            <Link to="/compare">Compare</Link>
            <Link to="/pricing">Pricing</Link>
            {CLOUD && <Link to="/cloud/overview">Cloud</Link>}
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a>
            <div className="mobile-cta">
              <a href="/dashboard" className="mobile-cta-login">Log in</a>
              {CLOUD ? (
                <a href="/dashboard/cloud/onboarding" className="cc-btn-primary">Sign up</a>
              ) : (
                <Link to="/quickstart" className="cc-btn-primary">Get started</Link>
              )}
            </div>
          </nav>
        )}
      </header>

      <main>{children}</main>

      <footer className="site-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <Link to="/" aria-label="Cartcrft home">
              <span className="footer-logo"><img src="/logo.svg" alt="" width={30} height={30} /><span className="wordmark wordmark--footer">cart<span className="wm-accent">crft</span></span></span>
            </Link>
            <p className="footer-tagline">Headless commerce for<br />agent-native storefronts.</p>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="footer-github" aria-label="View Cartcrft on GitHub">
              <GitHubIcon size={18} />
              Star on GitHub
            </a>
            <p className="footer-attribution">
              A <a href="https://webcrft.systems" target="_blank" rel="noopener noreferrer">Webcrft Systems</a> project.
            </p>
          </div>

          <div className="footer-links">
            <div className="footer-col">
              <h3>Product</h3>
              <ul>
                <li><Link to="/pricing">Pricing</Link></li>
                <li><Link to="/compare">Compare</Link></li>
                <li><a href="/dashboard">Dashboard</a></li>
              </ul>
            </div>
            <div className="footer-col">
              <h3>Docs</h3>
              <ul>
                <li><Link to="/quickstart">Quickstart</Link></li>
                <li><Link to="/quickstart-mcp">Agent quickstart</Link></li>
                <li><Link to="/agent-native">Agent-native</Link></li>
                <li><Link to="/self-host">Self-hosting</Link></li>
                <li><Link to="/api-overview">API Reference</Link></li>
              </ul>
            </div>
            {CLOUD && (
              <div className="footer-col">
                <h3>Cloud</h3>
                <ul>
                  <li><Link to="/cloud/overview">Cloud Overview</Link></li>
                  <li><Link to="/cloud/billing">Billing &amp; Pricing</Link></li>
                  <li><a href="/dashboard/cloud/onboarding">Get Started</a></li>
                </ul>
              </div>
            )}
            <div className="footer-col">
              <h3>Community</h3>
              <ul>
                <li><a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><Link to="/contributing">Contributing</Link></li>
                <li><Link to="/byo-keys">BYO Keys</Link></li>
              </ul>
            </div>
            <div className="footer-col">
              <h3>Legal</h3>
              <ul>
                <li><Link to="/legal/terms">Terms of Service</Link></li>
                <li><Link to="/legal/privacy">Privacy Policy</Link></li>
                <li><Link to="/legal/popia">POPIA</Link></li>
                <li><Link to="/legal/gdpr">GDPR</Link></li>
              </ul>
            </div>
          </div>
        </div>

        <div className="footer-bottom">
          <p className="footer-copyright">&copy; {new Date().getFullYear()} Webcrft Systems (Pty) Ltd. All rights reserved.</p>
          <p className="footer-mit">MIT licensed · Zero take rate · Self-host or cloud</p>
        </div>
      </footer>
    </>
  )
}
