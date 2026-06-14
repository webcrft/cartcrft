/**
 * Super-admin AppShell.
 *
 * Harmonized with the product's indigo-violet brand and Inter typography, but
 * deliberately distinct from the org dashboard:
 *   - Darker steel-graphite slate sidebar chrome (operator differentiator)
 *   - Brand violet as the everyday accent (active nav pill, logo lockup)
 *   - A reserved amber "OPS" marker + permanent operator banner so operators
 *     always know they are in the hardened god-mode console
 *   - No store switcher (super-admin operates globally)
 */

import React, { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { ROUTE_ENTRIES } from '../../routes/index'
import { useAuth, useLogout } from '../../context/AuthContext'
import { Shield, Menu, X, LogOut } from 'lucide-react'

function LogoLockup({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-5 w-5' : 'h-7 w-7'
  const icon = size === 'sm' ? 11 : 15
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div
        className={`${box} rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center flex-shrink-0 shadow-sm shadow-violet-950/50 ring-1 ring-white/10`}
      >
        <Shield size={icon} className="text-white" strokeWidth={2.25} />
      </div>
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className="text-sm font-bold text-white tracking-tight">Cartcrft</span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-400">
          Ops
        </span>
      </div>
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
    <div className="flex h-screen bg-[#080a0f] text-slate-100 overflow-hidden">
      {/* Mobile top bar (hidden on lg+) */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-2 h-14 px-3 border-b border-white/[0.06] bg-[#0b0e15]/95 backdrop-blur">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          className="rounded-lg p-2 text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition"
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

      {/* Sidebar — steel-graphite operator chrome */}
      <aside
        className={`w-64 flex-shrink-0 flex flex-col border-r border-white/[0.07] bg-gradient-to-b from-[#0c0f17] to-[#090b11] z-50
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
              className="lg:hidden ml-auto rounded-lg p-1.5 text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition"
            >
              <X size={16} />
            </button>
          </div>
          {admin && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-white/[0.03] border border-white/[0.06] px-2.5 py-1.5">
              <div className="h-6 w-6 rounded-full bg-violet-600/20 border border-violet-500/30 flex items-center justify-center flex-shrink-0">
                <span className="text-[10px] font-semibold text-violet-300">
                  {admin.email.charAt(0).toUpperCase()}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 truncate">{admin.email}</p>
            </div>
          )}
        </div>

        {/* Ops marker banner — the deliberate operator differentiator */}
        <div className="mx-3 mt-3 rounded-lg bg-amber-500/[0.07] border border-amber-500/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <Shield size={11} className="text-amber-400 flex-shrink-0" />
            <p className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">
              Operator Console
            </p>
          </div>
          <p className="text-[10px] text-amber-500/60 mt-1 leading-tight">
            Actions here affect all tenants. All operations are audited.
          </p>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          <p className="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
            Platform
          </p>
          <div className="space-y-0.5">
            {ROUTE_ENTRIES.map(entry => (
              <NavLink
                key={entry.path}
                to={entry.path}
                end={entry.path === '/'}
                className={({ isActive }) =>
                  `group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition
                   ${isActive
                     ? 'bg-violet-600/15 text-violet-200'
                     : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'
                   }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={`absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-violet-400 transition-opacity ${
                        isActive ? 'opacity-100' : 'opacity-0'
                      }`}
                      aria-hidden="true"
                    />
                    {entry.icon && (
                      <span className={isActive ? 'text-violet-300' : 'text-slate-500 group-hover:text-slate-300'}>
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
            className="w-full flex items-center gap-2 px-2.5 py-2 text-xs font-medium text-slate-500 hover:text-red-400 transition rounded-lg hover:bg-white/[0.04]"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-[#080a0f] pt-14 lg:pt-0">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
