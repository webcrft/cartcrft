import React, { Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { StoreProvider } from './context/StoreContext'
import { ToastProvider } from './context/ToastContext'
import AppShell from './components/layout/AppShell'
import Login from './pages/Login'
import { ROUTE_ENTRIES } from './routes/index'
import { getToken, getApiKey } from './lib/auth'
import './index.css'
import './dashboard.css'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const authed = !!(getToken() ?? getApiKey())
  if (!authed) return <Navigate to="/login" replace />
  return <>{children}</>
}

/**
 * DashboardApp — the admin SPA, mounted as a client-only Astro island under
 * /dashboard. The whole admin router lives beneath the `/dashboard` basename so
 * routes like `/dashboard/products` resolve to the Products page. Astro renders
 * a static HTML shell and this component boots the SPA on the client
 * (`client:only="react"`), so there are no SSR/SEO concerns.
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
                      <Suspense fallback={<div className="flex justify-center py-16 text-slate-500">Loading...</div>}>
                        <entry.element />
                      </Suspense>
                    }
                  />
                ))}
              </Route>
            </Routes>
          </StoreProvider>
        </BrowserRouter>
      </ToastProvider>
    </div>
  )
}
