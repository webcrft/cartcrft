import React, { Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { StoreProvider } from './context/StoreContext'
import { ToastProvider } from './context/ToastContext'
import AppShell from './components/layout/AppShell'
import Login from './pages/Login'
import { ROUTE_ENTRIES } from './routes/index'
import { hasAuth } from './lib/auth'
import { accountRefresh } from './lib/sdk'
import './index.css'
import './dashboard.css'

/**
 * AuthBoot — on first mount, try to restore a session from the httpOnly refresh
 * cookie (POST /account/refresh) so a page reload keeps the user signed in
 * WITHOUT any token in localStorage. While that round-trip is in flight we show
 * a brief splash; afterwards the access token (if any) lives in memory only.
 *
 * If the user is already on /login we skip the refresh probe (they're signing
 * in fresh) so the form renders immediately.
 */
function AuthBoot({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const onLogin = location.pathname === '/login'
  const [ready, setReady] = useState(onLogin || hasAuth())

  useEffect(() => {
    if (ready) return
    let cancelled = false
    void accountRefresh().finally(() => { if (!cancelled) setReady(true) })
    return () => { cancelled = true }
  }, [ready])

  if (!ready) {
    return (
      <div className="min-h-screen bg-[var(--cc-bg)] flex items-center justify-center text-[var(--cc-muted)] font-mono text-xs uppercase tracking-widest">
        Loading…
      </div>
    )
  }
  return <>{children}</>
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!hasAuth()) return <Navigate to="/login" replace />
  return <>{children}</>
}

/**
 * DashboardApp — the admin SPA, mounted by the zone router (src/Root.tsx) for
 * any `/dashboard*` URL. The whole admin router lives beneath the `/dashboard`
 * basename so routes like `/dashboard/products` resolve to the Products page.
 * Client-only SPA, so there are no SSR/SEO concerns.
 *
 * Auth (P3/item-1): the access token lives in memory only; persistence across
 * reloads comes from the httpOnly refresh cookie restored by AuthBoot. No
 * credential is read from localStorage.
 *
 * StoreProvider sits inside BrowserRouter because StoreContext relies on
 * react-router's useNavigate (to redirect to /login on a 401).
 */
export default function DashboardApp() {
  return (
    // #dashboard-root scopes Tailwind's base layer resets to avoid colliding
    // with Starlight or marketing page styles (which live on separate routes).
    <div id="dashboard-root" style={{ display: 'contents' }}>
      <ToastProvider>
        <BrowserRouter basename="/dashboard">
          <AuthBoot>
            <StoreProvider>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route
                  path="/"
                  element={
                    <RequireAuth>
                      <AppShell />
                    </RequireAuth>
                  }
                >
                  {ROUTE_ENTRIES.map(entry => (
                    <Route
                      key={entry.path}
                      path={entry.path === '/' ? undefined : entry.path}
                      index={entry.path === '/'}
                      element={
                        <Suspense fallback={<div className="flex justify-center py-16 text-[var(--cc-muted)] font-mono text-xs uppercase tracking-widest">Loading...</div>}>
                          <entry.element />
                        </Suspense>
                      }
                    />
                  ))}
                </Route>
              </Routes>
            </StoreProvider>
          </AuthBoot>
        </BrowserRouter>
      </ToastProvider>
    </div>
  )
}
