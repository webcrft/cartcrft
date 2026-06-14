/**
 * SuperAdminApp — the operator console SPA, mounted by the zone router
 * (src/Root.tsx) for any /superadmin* URL. Mirrors the DashboardApp pattern with
 * a separate BrowserRouter (basename="/superadmin"), its own providers, and a
 * distinct visual identity.
 *
 * Auth:
 *   - The super-JWT is stored IN MEMORY (AuthContext React state) — NEVER in
 *     localStorage. A page refresh requires re-login — intentional for
 *     god-mode credentials.
 *   - RequireAuth checks AuthContext for a live token; unauthenticated users
 *     see the Login page.
 *   - AuthProvider handles auto-refresh (60s before expiry) and clears state
 *     on 401.
 *
 * Styling:
 *   - Zinc/neutral palette — visually distinct from the org dashboard (violet).
 *   - #superadmin-root scopes Tailwind base layer resets (same pattern as
 *     #dashboard-root in DashboardApp.tsx).
 */

import React, { Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { ToastProvider } from './context/ToastContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import AppShell from './components/layout/AppShell'
import Login from './pages/Login'
import { ROUTE_ENTRIES } from './routes/index'
import './index.css'
import './superadmin.css'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

function AppRoutes() {
  return (
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
              <Suspense fallback={<div className="flex justify-center py-16 text-slate-500 text-sm">Loading...</div>}>
                <entry.element />
              </Suspense>
            }
          />
        ))}
      </Route>
    </Routes>
  )
}

export default function SuperAdminApp() {
  return (
    <div id="superadmin-root" style={{ display: 'contents' }}>
      <ToastProvider>
        <BrowserRouter basename="/superadmin">
          {/* AuthProvider must be inside BrowserRouter because it uses useNavigate */}
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </div>
  )
}
