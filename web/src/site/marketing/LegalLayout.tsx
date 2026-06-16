import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import './LegalLayout.css'

/**
 * LegalLayout — wrapper for /legal/* pages.
 * Renders inside SiteLayout and adds standard legal page chrome:
 * the "DRAFT — pending legal review" banner, breadcrumb, header, and sidebar nav.
 */
export interface LegalLayoutProps {
  title: string
  description?: string
  lastUpdated?: string
  children: ReactNode
}

export default function LegalLayout({ title, description, lastUpdated, children }: LegalLayoutProps) {
  useDocumentMeta({ title, description })

  return (
    <SiteLayout>
      <div className="mk-legal">
        {/* Draft banner — rendered at the very top of every legal page until counsel finalises */}
        <div className="draft-banner" role="alert" aria-live="polite">
          <AlertTriangle className="draft-icon" size={16} strokeWidth={2.25} aria-hidden="true" />
          <span className="draft-badge">DRAFT</span>
          <span className="draft-text">
            This document is <strong>pending legal review and is not yet in force.</strong>{' '}
            It must not be relied upon as a binding policy until approved by qualified legal counsel.
          </span>
        </div>

        <article className="legal-page">
          <header className="legal-header">
            <div className="legal-header-inner">
              <div className="legal-breadcrumb">
                <Link to="/">CartCrft</Link>
                <span aria-hidden="true">›</span>
                <Link to="/legal/terms">Legal</Link>
                <span aria-hidden="true">›</span>
                <span>{title}</span>
              </div>
              <h1>{title}</h1>
              {lastUpdated && (
                <p className="last-updated">Last updated: <time dateTime={lastUpdated}>{lastUpdated}</time></p>
              )}
            </div>
          </header>

          <div className="legal-body">
            <div className="legal-content">
              {children}
            </div>

            <aside className="legal-nav">
              <h2>Legal</h2>
              <ul>
                <li><NavLink to="/legal/terms" className={({ isActive }) => isActive ? 'is-active' : undefined}>Terms of Service</NavLink></li>
                <li><NavLink to="/legal/privacy" className={({ isActive }) => isActive ? 'is-active' : undefined}>Privacy Policy</NavLink></li>
                <li><NavLink to="/legal/popia" className={({ isActive }) => isActive ? 'is-active' : undefined}>POPIA</NavLink></li>
                <li><NavLink to="/legal/gdpr" className={({ isActive }) => isActive ? 'is-active' : undefined}>GDPR</NavLink></li>
              </ul>
            </aside>
          </div>
        </article>
      </div>
    </SiteLayout>
  )
}
