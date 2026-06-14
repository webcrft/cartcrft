/**
 * renderWithProviders — wraps components in the same provider tree used in
 * production (ToastProvider, StoreProvider, MemoryRouter) so page-level smoke
 * tests can mount any page component without needing a real backend.
 *
 * Usage:
 *   const { container } = renderWithProviders(<Dashboard />, {
 *     initialEntries: ['/'],
 *   })
 */
import React, { Suspense } from 'react'
import { render, type RenderResult } from '@testing-library/react'
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom'
import { ToastProvider } from '../context/ToastContext'
import { StoreProvider } from '../context/StoreContext'

interface Options {
  /** MemoryRouter initial route entries. Default: ['/'] */
  initialEntries?: string[]
  /** Route path the element sits at. Default: '/' */
  path?: string
}

export function renderWithProviders(
  ui: React.ReactElement,
  { initialEntries = ['/'], path = '/' }: Options = {},
): RenderResult {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <StoreProvider>
          <Suspense fallback={<div data-testid="suspense-fallback" />}>
            <Routes>
              <Route path={path} element={ui} />
            </Routes>
          </Suspense>
        </StoreProvider>
      </MemoryRouter>
    </ToastProvider>,
  )
}

/**
 * renderShell — renders a minimal shell wrapper (sidebar + outlet) with the
 * given page component as the outlet child.
 */
export function renderShell(
  Page: React.ComponentType,
  { initialEntries = ['/'], path = '/' }: Options = {},
): RenderResult {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <StoreProvider>
          <Suspense fallback={<div data-testid="suspense-fallback" />}>
            <Routes>
              <Route
                path={path}
                element={
                  <div>
                    <Outlet />
                  </div>
                }
              >
                <Route index element={<Page />} />
              </Route>
            </Routes>
          </Suspense>
        </StoreProvider>
      </MemoryRouter>
    </ToastProvider>,
  )
}
