import { Link } from 'react-router-dom'
import SiteLayout from './SiteLayout'
import { useDocumentMeta } from './useDocumentMeta'

export default function NotFound() {
  useDocumentMeta({ title: '404 — Not found | CartCrft', noindex: true })
  return (
    <SiteLayout>
      <section style={{ maxWidth: 640, margin: '0 auto', padding: '8rem 1.5rem', textAlign: 'center' }}>
        <p style={{ fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#b5ff2e' }}>
          404
        </p>
        <h1 style={{ fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', fontWeight: 800, letterSpacing: '-0.025em', margin: '0.75rem 0 1rem' }}>
          Page not found
        </h1>
        <p style={{ color: '#64748b', lineHeight: 1.6, marginBottom: '2rem' }}>
          The page you’re looking for doesn’t exist or may have moved.
        </p>
        <Link to="/" className="cc-btn-primary">Back to home</Link>
      </section>
    </SiteLayout>
  )
}
