/**
 * Super-admin AppShell — "Agentic Terminal" operator variant.
 *
 * Same electric-lime signature as the rest of the product, but deliberately
 * distinct from the merchant dashboard so operators always know they are in the
 * hardened god-mode console:
 *   - Cooler/darker steel-graphite sidebar chrome (the operator differentiator)
 *   - Lime brand wordmark lockup + a small mono "// operator" marker
 *   - Lime active-nav pill + indicator; lime focus rings
 *   - A permanent AMBER operator-console banner (warning, not everyday accent)
 *   - No store switcher (super-admin operates globally)
 */

import React, { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ROUTE_ENTRIES } from '../../routes/index'
import { useAuth, useLogout } from '../../context/AuthContext'
import { Menu, X, LogOut, Terminal } from 'lucide-react'

function LogoLockup({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const h = size === 'sm' ? 'h-5' : 'h-6'
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <img src="/logo.svg" alt="" className={`${h} flex-shrink-0`} style={{ aspectRatio: '1' }} />
      <span className="font-[var(--cc-font-display)] text-[1.1rem] font-bold tracking-[-0.04em] text-[var(--cc-text)]">cart<span className="text-[var(--cc-lime)]">crft</span></span>
      <span className="sr-only">Cartcrft</span>
      <span className="font-mono text-[10px] font-medium tracking-[0.12em] text-[var(--cc-lime)]/80 hidden sm:inline">
        // operator
      </span>
    </div>
  )
}

export default function AppShell() {
  const { admin } = useAuth()
  const logout = useLogout()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => { setMobileOpen(false) }, [location.pathname])

  return (
    <div className="flex h-screen bg-[var(--cc-ink)] text-[var(--cc-text)] overflow-hidden">
      {/* Mobile top bar (hidden on lg+) */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-2 h-14 px-3 border-b border-white/[0.07] bg-[var(--cc-steel)]/95 backdrop-blur">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          className="rounded-md p-2 text-[var(--cc-text-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.06] transition"
        >
          <Menu size={18} />
        </button>
        <LogoLockup size="sm" />
      </div>

      {/* Mobile overlay backdrop */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — cool steel-graphite operator chrome */}
      <aside
        className={`w-64 flex-shrink-0 flex flex-col border-r border-white/[0.07] bg-gradient-to-b from-[var(--cc-steel-2)] to-[var(--cc-steel)] z-50
          fixed inset-y-0 left-0 transition-transform duration-200 ease-out
          lg:static lg:translate-x-0
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Logo / identity */}
        <div className="px-4 py-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2">
            <LogoLockup />
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation menu"
              className="lg:hidden ml-auto rounded-md p-1.5 text-[var(--cc-text-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.06] transition"
            >
              <X size={16} />
            </button>
          </div>
          {admin && (
            <div className="mt-3 flex items-center gap-2 rounded-md bg-white/[0.03] border border-white/[0.06] px-2.5 py-1.5">
              <div className="h-6 w-6 rounded-md bg-[var(--cc-lime)]/15 border border-[var(--cc-lime)]/30 flex items-center justify-center flex-shrink-0">
                <span className="font-mono text-[10px] font-semibold text-[var(--cc-lime)]">
                  {admin.email.charAt(0).toUpperCase()}
                </span>
              </div>
              <p className="font-mono text-[11px] text-[var(--cc-text-muted)] truncate">{admin.email}</p>
            </div>
          )}
        </div>

        {/* Operator marker banner — AMBER warning (the deliberate differentiator) */}
        <div className="mx-3 mt-3 rounded-md bg-amber-500/[0.07] border border-amber-500/25 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <Terminal size={11} className="text-amber-400 flex-shrink-0" />
            <p className="font-mono text-[10px] font-semibold text-amber-400 uppercase tracking-[0.12em]">
              Operator Console
            </p>
          </div>
          <p className="text-[10px] text-amber-500/70 mt-1 leading-tight">
            Actions here affect all tenants. All operations are audited.
          </p>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          <p className="px-2 mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cc-text-subtle)]">
            Platform
          </p>
          <div className="space-y-0.5">
            {ROUTE_ENTRIES.map(entry => (
              <NavLink
                key={entry.path}
                to={entry.path}
                end={entry.path === '/'}
                className={({ isActive }) =>
                  `group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium transition
                   ${isActive
                     ? 'bg-[var(--cc-lime)]/12 text-[var(--cc-lime)]'
                     : 'text-[var(--cc-text-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.04]'
                   }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={`absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-[var(--cc-lime)] transition-opacity ${
                        isActive ? 'opacity-100' : 'opacity-0'
                      }`}
                      aria-hidden="true"
                    />
                    {entry.icon && (
                      <span className={isActive ? 'text-[var(--cc-lime)]' : 'text-[var(--cc-text-subtle)] group-hover:text-[var(--cc-text-body)]'}>
                        <entry.icon size={15} />
                      </span>
                    )}
                    {entry.navLabel}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>

        {/* Footer */}
        <div className="px-3 py-3 border-t border-white/[0.07]">
          <button
            onClick={() => { void logout() }}
            className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-medium text-[var(--cc-text-muted)] hover:text-red-400 transition rounded-md hover:bg-white/[0.04]"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-[var(--cc-ink)] pt-14 lg:pt-0">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
