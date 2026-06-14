/**
 * Super-admin AppShell.
 *
 * Deliberately distinct from the org dashboard AppShell:
 *   - Zinc/neutral palette (not violet/slate)
 *   - Amber accent for the "ops console" identity
 *   - Permanent warning banner to reinforce this is the operator console
 *   - No store switcher (super-admin operates globally)
 */

import React, { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ROUTE_ENTRIES } from '../../routes/index'
import { useAuth, useLogout } from '../../context/AuthContext'
import { Shield, Menu, X } from 'lucide-react'

export default function AppShell() {
  const { admin } = useAuth()
  const logout = useLogout()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => { setMobileOpen(false) }, [location.pathname])

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Mobile top bar (hidden on lg+) */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-2 h-12 px-3 border-b border-white/[0.06] bg-zinc-950">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition"
        >
          <Menu size={18} />
        </button>
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded-md bg-amber-500/20 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
            <Shield size={11} className="text-amber-400" />
          </div>
          <span className="text-sm font-bold text-zinc-100 tracking-tight">Cartcrft</span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-amber-500">Ops</span>
        </div>
      </div>

      {/* Mobile overlay backdrop */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/70 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`w-60 flex-shrink-0 flex flex-col border-r border-white/[0.06] bg-zinc-950 z-50
          fixed inset-y-0 left-0 transition-transform duration-200 ease-out
          lg:static lg:translate-x-0
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Logo / identity */}
        <div className="px-4 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-md bg-amber-500/20 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
              <Shield size={13} className="text-amber-400" />
            </div>
            <div>
              <span className="text-sm font-bold text-zinc-100 tracking-tight">Cartcrft</span>
              <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-widest text-amber-500">
                Ops
              </span>
            </div>
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Close navigation menu"
              className="lg:hidden ml-auto rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.06] transition"
            >
              <X size={16} />
            </button>
          </div>
          {admin && (
            <p className="mt-2 text-[11px] text-zinc-500 truncate">{admin.email}</p>
          )}
        </div>

        {/* Ops warning banner */}
        <div className="mx-3 mt-3 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
          <p className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">
            Operator Console
          </p>
          <p className="text-[10px] text-amber-500/70 mt-0.5 leading-tight">
            Actions here affect all tenants. All operations are audited.
          </p>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-0.5">
          {ROUTE_ENTRIES.map(entry => (
            <NavLink
              key={entry.path}
              to={entry.path}
              end={entry.path === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition
                 ${isActive
                   ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                   : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04] border border-transparent'
                 }`
              }
            >
              {entry.icon && <entry.icon size={14} />}
              {entry.navLabel}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-3 py-3 border-t border-white/[0.06]">
          <button
            onClick={() => { void logout() }}
            className="w-full text-left px-2.5 py-2 text-xs text-zinc-500 hover:text-red-400 transition rounded-lg hover:bg-white/[0.04]"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-zinc-950 pt-12 lg:pt-0">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
