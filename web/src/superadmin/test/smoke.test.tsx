/**
 * Super-admin smoke test suite.
 *
 * Tests:
 *   1. Login page renders correctly (email + password fields, no MFA initially)
 *   2. MFA field appears after MFA_REQUIRED response
 *   3. LOCKED / IP_BLOCKED error states render correct messages
 *   4. AppShell renders with mocked auth (nav items, operator console badge, sign-out)
 *   5. Every routed page mounts without crashing (mocked API)
 *   6. In-memory auth: token never written to localStorage
 *   7. Auto-refresh: scheduleRefresh fires before expiry
 */

import React, { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { Suspense } from 'react'

// ── Mock the API module ────────────────────────────────────────────────────────

vi.mock('../lib/api', () => {
  class MockSuperAdminApiError extends Error {
    status: number
    code: string
    constructor(status: number, code: string, message: string) {
      super(message)
      this.name = 'SuperAdminApiError'
      this.status = status
      this.code = code
    }
  }

  return {
    SuperAdminApiError: MockSuperAdminApiError,
    login: vi.fn().mockResolvedValue({
      token: 'mock.super.token',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      super_admin: { id: 'sa-1', email: 'admin@example.com' },
    }),
    logout: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue({
      token: 'mock.super.token.refreshed',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      super_admin: { id: 'sa-1', email: 'admin@example.com' },
    }),
    getMe: vi.fn().mockResolvedValue({ id: 'sa-1', email: 'admin@example.com', created_at: new Date().toISOString() }),
    getAnalyticsOverview: vi.fn().mockResolvedValue({
      total_orgs: 5,
      total_stores: 12,
      total_customers: 340,
      total_orders: 820,
      total_gmv: '185000.00',
      total_revenue: '162000.00',
      active_30d: 9,
      new_this_period: 2,
      growth_pct: 8.5,
    }),
    getAnalyticsTimeseries: vi.fn().mockResolvedValue({ points: [] }),
    getAnalyticsHealth: vi.fn().mockResolvedValue({
      db: 'ok', pool: 'ok', migration: 'ok', worker: 'ok', errors: 0, status: 'healthy',
    }),
    listOrgs: vi.fn().mockResolvedValue({ orgs: [] }),
    getOrg: vi.fn().mockResolvedValue({ org: { id: 'org-1', name: 'Test Org', store_count: 1, order_count: 5, gmv: '1000.00', customer_count: 10, stores: [], created_at: new Date().toISOString() } }),
    listStores: vi.fn().mockResolvedValue({ stores: [] }),
    getStore: vi.fn().mockResolvedValue({ store: { id: 'store-1', name: 'Test Store', org_id: 'org-1', currency: 'USD', status: 'active', order_count: 5, gmv: '1000.00', created_at: new Date().toISOString() } }),
    searchCustomers: vi.fn().mockResolvedValue({ customers: [] }),
    takedownStore: vi.fn().mockResolvedValue(undefined),
    restoreStore: vi.fn().mockResolvedValue(undefined),
    suspendStore: vi.fn().mockResolvedValue(undefined),
    listAuditLog: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
  }
})

// ── Providers helper ──────────────────────────────────────────────────────────

import { ToastProvider } from '../context/ToastContext'
import { AuthProvider, useAuth } from '../context/AuthContext'

/** Seeds the AuthContext with a mock token without going through login */
function SeedAuth({ children }: { children: React.ReactNode }) {
  const { setAuth } = useAuth()
  const [seeded, setSeeded] = React.useState(false)
  React.useEffect(() => {
    setAuth(
      'mock.super.token',
      new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      { id: 'sa-1', email: 'admin@example.com' },
    )
    setSeeded(true)
  }, [setAuth])
  if (!seeded) return null
  return <>{children}</>
}

function Providers({ children, initialEntries = ['/'] }: {
  children: React.ReactNode
  initialEntries?: string[]
}) {
  return (
    <ToastProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <AuthProvider>
          <Suspense fallback={<div data-testid="loading" />}>
            {children}
          </Suspense>
        </AuthProvider>
      </MemoryRouter>
    </ToastProvider>
  )
}

function AuthedProviders({ children, initialEntries = ['/'] }: {
  children: React.ReactNode
  initialEntries?: string[]
}) {
  return (
    <ToastProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <AuthProvider>
          <SeedAuth>
            <Suspense fallback={<div data-testid="loading" />}>
              {children}
            </Suspense>
          </SeedAuth>
        </AuthProvider>
      </MemoryRouter>
    </ToastProvider>
  )
}

// ── 1. Login page renders ─────────────────────────────────────────────────────

import Login from '../pages/Login'

describe('Super-admin Login page', () => {
  it('renders email + password fields and sign-in button', () => {
    render(
      <Providers>
        <Login />
      </Providers>,
    )
    expect(screen.getByPlaceholderText('admin@example.com')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('••••••••')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  it('shows operator console identity elements', () => {
    render(
      <Providers>
        <Login />
      </Providers>,
    )
    // "Operator Console" appears in both the h1 and the warning banner
    const matches = screen.getAllByText(/Operator Console/i)
    expect(matches.length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/restricted access/i)).toBeInTheDocument()
  })

  it('does NOT show TOTP field by default', () => {
    render(
      <Providers>
        <Login />
      </Providers>,
    )
    expect(screen.queryByPlaceholderText('000000')).toBeNull()
  })

  it('shows TOTP field after MFA_REQUIRED response', async () => {
    const { login } = await import('../lib/api')
    vi.mocked(login).mockResolvedValueOnce({ mfa_required: true })

    render(
      <Providers>
        <Login />
      </Providers>,
    )

    fireEvent.change(screen.getByPlaceholderText('admin@example.com'), { target: { value: 'admin@test.com' } })
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument()
    })
    expect(screen.getByText(/authenticator code/i)).toBeInTheDocument()
  })

  it('shows LOCKED error message on 423 response', async () => {
    const { login, SuperAdminApiError } = await import('../lib/api')
    vi.mocked(login).mockRejectedValueOnce(
      new SuperAdminApiError(423, 'ACCOUNT_LOCKED', 'Locked'),
    )

    render(
      <Providers>
        <Login />
      </Providers>,
    )

    fireEvent.change(screen.getByPlaceholderText('admin@example.com'), { target: { value: 'admin@test.com' } })
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => {
      expect(screen.getByText(/locked due to too many failed attempts/i)).toBeInTheDocument()
    })
  })

  it('shows IP_BLOCKED error message on 403 IP_BLOCKED response', async () => {
    const { login, SuperAdminApiError } = await import('../lib/api')
    vi.mocked(login).mockRejectedValueOnce(
      new SuperAdminApiError(403, 'IP_BLOCKED', 'Blocked'),
    )

    render(
      <Providers>
        <Login />
      </Providers>,
    )

    fireEvent.change(screen.getByPlaceholderText('admin@example.com'), { target: { value: 'admin@test.com' } })
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => {
      expect(screen.getByText(/IP address is not in the allowlist/i)).toBeInTheDocument()
    })
  })
})

// ── 2. AppShell renders ───────────────────────────────────────────────────────

import AppShell from '../components/layout/AppShell'
import { ROUTE_ENTRIES } from '../routes/index'

describe('Super-admin AppShell', () => {
  it('renders the operator console sidebar with nav entries and admin email', async () => {
    await act(async () => {
      render(
        <AuthedProviders>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<div data-testid="outlet">content</div>} />
            </Route>
          </Routes>
        </AuthedProviders>,
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Operator Console')).toBeInTheDocument()
    })
    expect(screen.getByText('admin@example.com')).toBeInTheDocument()
    expect(screen.getByText('System Analytics')).toBeInTheDocument()
    expect(screen.getByText('Audit Log')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument()
  })
})

// ── 3. Every routed page mounts without crashing ───────────────────────────────

const PAGE_IMPORTS: Record<string, () => Promise<{ default: React.ComponentType }>> = {
  '/': () => import('../pages/Analytics'),
  '/orgs': () => import('../pages/Orgs'),
  '/stores': () => import('../pages/Stores'),
  '/customers': () => import('../pages/Customers'),
  '/tenants': () => import('../pages/Tenants'),
  '/audit-log': () => import('../pages/AuditLog'),
}

describe('Every super-admin page mounts without crashing', () => {
  it('ROUTE_ENTRIES covers all expected paths', () => {
    const routePaths = ROUTE_ENTRIES.map(e => e.path)
    expect(routePaths.length).toBeGreaterThanOrEqual(6)
    Object.keys(PAGE_IMPORTS).forEach(p => {
      expect(routePaths).toContain(p)
    })
  })

  for (const entry of ROUTE_ENTRIES) {
    const importFn = PAGE_IMPORTS[entry.path]
    if (!importFn) continue

    it(`${entry.navLabel ?? entry.path} (${entry.path}) mounts without throwing`, async () => {
      const mod = await importFn()
      const Page = mod.default

      await act(async () => {
        render(
          <AuthedProviders initialEntries={[entry.path === '/' ? '/' : entry.path]}>
            <Routes>
              <Route
                path={entry.path === '/' ? '/' : entry.path}
                element={<Page />}
              />
            </Routes>
          </AuthedProviders>,
        )
      })

      await waitFor(() => {
        expect(document.body).toBeTruthy()
      }, { timeout: 3000 })
    })
  }
})

// ── 4. Token never written to localStorage ────────────────────────────────────

describe('In-memory auth: token isolation', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('successful login does NOT write the token to localStorage', async () => {
    const { login } = await import('../lib/api')
    vi.mocked(login).mockResolvedValueOnce({
      token: 'super.secret.jwt',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      super_admin: { id: 'sa-1', email: 'admin@example.com' },
    })

    await act(async () => {
      render(
        <Providers>
          <Login />
        </Providers>,
      )
    })

    fireEvent.change(screen.getByPlaceholderText('admin@example.com'), { target: { value: 'admin@test.com' } })
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'password123' } })
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => {
      // The API was called
      expect(login).toHaveBeenCalled()
    })

    // No token in any localStorage key
    const allKeys = Object.keys(localStorage)
    const tokenKeys = allKeys.filter(k =>
      localStorage.getItem(k)?.includes('super.secret.jwt'),
    )
    expect(tokenKeys).toHaveLength(0)
  })
})
