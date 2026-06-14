import { Suspense, lazy } from 'react'

/**
 * Zone router — the top of the single Vite + React SPA.
 *
 * One app hosts four surfaces. Rather than nest four <BrowserRouter>s (which
 * react-router forbids), we pick exactly ONE sub-app at mount time from the URL
 * prefix and let it own routing for its zone:
 *
 *   /dashboard*   → merchant admin SPA   (its own BrowserRouter, basename=/dashboard)
 *   /superadmin*  → operator console SPA (its own BrowserRouter, basename=/superadmin)
 *   everything    → marketing + docs     (its own BrowserRouter)
 *
 * Crossing zones (e.g. a marketing "Log in" link → /dashboard) is a normal
 * full-page navigation — identical to how the prior Astro multi-page site
 * behaved. Each zone is a lazy import so its CSS + JS only load for that zone
 * (the dashboard's dark body/theme never bleeds into marketing and vice-versa).
 */
const DashboardApp = lazy(() => import('./dashboard/DashboardApp'))
const SuperAdminApp = lazy(() => import('./superadmin/SuperAdminApp'))
const SiteApp = lazy(() => import('./site/SiteApp'))
// Hosted checkout / shareable payment links (/pay/:token). Self-contained zone
// with its own BrowserRouter + minimal "Agentic Terminal" styling.
const CheckoutApp = lazy(() => import('./checkout/CheckoutApp'))

function zoneFor(pathname: string): 'dashboard' | 'superadmin' | 'pay' | 'site' {
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) return 'dashboard'
  if (pathname === '/superadmin' || pathname.startsWith('/superadmin/')) return 'superadmin'
  if (pathname === '/pay' || pathname.startsWith('/pay/')) return 'pay'
  return 'site'
}

export default function Root() {
  const zone = zoneFor(window.location.pathname)
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh' }} aria-hidden="true" />}>
      {zone === 'dashboard' ? (
        <DashboardApp />
      ) : zone === 'superadmin' ? (
        <SuperAdminApp />
      ) : zone === 'pay' ? (
        <CheckoutApp />
      ) : (
        <SiteApp />
      )}
    </Suspense>
  )
}
