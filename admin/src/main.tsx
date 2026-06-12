import React, { Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { StoreProvider } from './context/StoreContext'
import { ToastProvider } from './context/ToastContext'
import AppShell from './components/layout/AppShell'
import Login from './pages/Login'
import { ROUTE_ENTRIES } from './routes/index'
import { getToken, getApiKey } from './lib/auth'
import './index.css'

function RequireAuth({ children }: { children: React.ReactNode }) {
  const authed = !!(getToken() ?? getApiKey())
  if (!authed) return <Navigate to="/login" replace />
  return <>{children}</>
}

const root = document.getElementById('root') as HTMLElement
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ToastProvider>
      <StoreProvider>
        <BrowserRouter>
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
        </BrowserRouter>
      </StoreProvider>
    </ToastProvider>
  </React.StrictMode>
)
