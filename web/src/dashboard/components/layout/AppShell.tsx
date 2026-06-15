import React, { useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useStore } from '../../context/StoreContext'
import { accountLogout } from '../../lib/sdk'
import { NAV_SECTIONS } from '../../routes/index'
import CreateStoreModal from '../CreateStoreModal'
import { Btn } from '../ui/index'
import { ChevronDown, Menu, X, LogOut, PlusCircle, Store } from 'lucide-react'

/** Hex-cart mark, tiny version for sidebar */
function MiniMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-full w-full" aria-hidden="true">
      <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" opacity="0.5" />
      <path d="M8 10h2.5l1.5 5.5h5l1.5-4H10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="11.5" cy="16.5" r="0.8" fill="currentColor" opacity="0.85" />
      <circle cx="15.5" cy="16.5" r="0.8" fill="currentColor" opacity="0.85" />
    </svg>
  )
}

/** Returns the current page's nav label from NAV_SECTIONS for the topbar breadcrumb */
function useActiveNavLabel(pathname: string): string | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      const path = item.path
      if (path === '/' ? pathname === '/' : pathname.startsWith(path)) {
        return item.label
      }
    }
  }
  return null
}

export default function AppShell() {
  const { stores, activeStore, setActiveStore, reload } = useStore()
  const [showStoreMenu, setShowStoreMenu] = useState(false)
  const [showCreateStore, setShowCreateStore] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const pageLabel = useActiveNavLabel(pathname)

  const handleSignOut = async () => {
    await accountLogout()
    void navigate('/login')
  }

  const onSignOutClick = () => { void handleSignOut() }

  const handleStoreCreated = async (newStoreId: string) => {
    setShowCreateStore(false)
    setShowStoreMenu(false)
    await reload(newStoreId)
  }

  return (
    <div className="flex h-screen bg-[var(--cc-bg)] text-[var(--cc-text)] overflow-hidden">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/65 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-56 flex-shrink-0 flex flex-col
          transform transition-transform duration-200 md:static md:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
        style={{
          background: 'var(--cc-bg-subtle)',
          borderRight: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {/* Logo lockup */}
        <div
          className="px-4 h-14 flex items-center justify-between flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-lg text-[var(--cc-lime)]"
              style={{ background: 'rgba(181,255,46,0.1)', border: '1px solid rgba(181,255,46,0.2)' }}
            >
              <MiniMark />
            </div>
            <span
              className="text-[1.1rem] font-bold tracking-[-0.04em] text-[var(--cc-text)]"
              style={{ fontFamily: 'var(--cc-font-display)' }}
            >
              cart<span className="text-[var(--cc-lime)]">crft</span>
            </span>
            <span className="sr-only">Cartcrft</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden rounded-lg p-1 text-[var(--cc-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.05] transition"
            aria-label="Close menu"
          >
            <X size={15} />
          </button>
        </div>

        {/* Store switcher */}
        <div className="px-3 py-2.5 flex-shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={() => setShowStoreMenu(s => !s)}
            className="w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-[var(--cc-text)] transition"
            style={{ border: '1px solid rgba(255,255,255,0.07)', background: 'var(--cc-surface)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--cc-surface-2)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--cc-surface)' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-5 w-5 rounded-md bg-[var(--cc-lime)] flex-shrink-0 flex items-center justify-center font-mono text-[10px] font-bold text-[var(--cc-ink)] leading-none">
                {(activeStore?.name ?? '·').charAt(0).toUpperCase()}
              </div>
              <span className="truncate">{activeStore?.name ?? 'No store'}</span>
            </div>
            <ChevronDown size={13} className={`text-[var(--cc-muted)] flex-shrink-0 transition-transform ${showStoreMenu ? 'rotate-180' : ''}`} />
          </button>

          {showStoreMenu && (
            <div
              className="absolute left-3 right-3 mt-1 z-50 rounded-lg overflow-hidden shadow-2xl"
              style={{ border: '1px solid rgba(255,255,255,0.09)', background: 'var(--cc-surface-2)', top: 'auto' }}
            >
              {stores.length > 0 && (
                <div className="py-1">
                  {stores.map(s => (
                    <button
                      key={s.id}
                      onClick={() => { setActiveStore(s); setShowStoreMenu(false) }}
                      className={`w-full flex items-center gap-2 text-left px-3 py-2 text-xs transition hover:bg-white/[0.05] ${
                        s.id === activeStore?.id ? 'text-[var(--cc-lime)]' : 'text-[var(--cc-body)]'
                      }`}
                    >
                      <Store size={12} className="flex-shrink-0 opacity-60" />
                      <span className="truncate">{s.name}</span>
                      {s.id === activeStore?.id && (
                        <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--cc-lime)] flex-shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <button
                  onClick={() => { setShowCreateStore(true); setShowStoreMenu(false) }}
                  className="w-full flex items-center gap-2 text-left px-3 py-2.5 text-xs text-[var(--cc-lime)] hover:bg-white/[0.04] transition"
                >
                  <PlusCircle size={12} />
                  New store
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-5 scrollbar-thin">
          {NAV_SECTIONS.map(section => (
            <div key={section.label ?? 'main'}>
              {section.label && (
                <p className="px-2.5 mb-1 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-[var(--cc-subtle)]">
                  {section.label}
                </p>
              )}
              <div className="space-y-0.5">
                {section.items.map(item => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    onClick={() => setSidebarOpen(false)}
                    className={({ isActive }) =>
                      `group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-xs font-medium transition-colors ${
                        isActive
                          ? 'bg-[var(--cc-lime)]/[0.1] text-[var(--cc-lime)]'
                          : 'text-[var(--cc-muted)] hover:text-[var(--cc-body)] hover:bg-white/[0.035]'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {/* Active indicator bar */}
                        <span
                          className={`absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r-full bg-[var(--cc-lime)] transition-opacity ${isActive ? 'opacity-100' : 'opacity-0'}`}
                        />
                        {item.icon && (
                          <span className={`flex-shrink-0 ${isActive ? 'text-[var(--cc-lime)]' : 'text-[var(--cc-subtle)] group-hover:text-[var(--cc-muted)]'}`}>
                            <item.icon size={13} />
                          </span>
                        )}
                        <span className="truncate">{item.label}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer / sign out */}
        <div className="flex-shrink-0 px-3 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={onSignOutClick}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs text-[var(--cc-subtle)] hover:text-red-400 hover:bg-white/[0.04] transition font-medium"
          >
            <LogOut size={13} className="flex-shrink-0" />
            Sign out
          </button>
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto flex flex-col min-w-0" style={{ background: 'var(--cc-bg)' }}>
        {/* Top bar — desktop shows page title/breadcrumb; mobile shows hamburger */}
        <header
          className="flex-shrink-0 sticky top-0 z-20 flex items-center gap-3 px-6 h-14"
          style={{
            background: 'rgba(12,13,10,0.88)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {/* Mobile hamburger */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden flex items-center justify-center h-8 w-8 rounded-lg text-[var(--cc-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.05] transition"
            aria-label="Open navigation"
          >
            <Menu size={16} />
          </button>

          {/* Page breadcrumb / title */}
          {pageLabel && (
            <div className="flex items-center gap-2 min-w-0">
              <span
                className="text-sm font-semibold text-[var(--cc-text)] truncate"
                style={{ fontFamily: 'var(--cc-font-display)', letterSpacing: '-0.02em' }}
              >
                {pageLabel}
              </span>
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Store badge (desktop, right side) — shows initial + currency only to avoid duplicate text */}
          {activeStore && (
            <div className="hidden md:flex items-center gap-1.5" aria-label={`Active store: ${activeStore.name}`}>
              <div className="h-5 w-5 rounded bg-[var(--cc-lime)] flex items-center justify-center font-mono text-[9px] font-bold text-[var(--cc-ink)]">
                {activeStore.name.charAt(0).toUpperCase()}
              </div>
              <span className="font-mono text-[9px] uppercase tracking-wider text-[var(--cc-subtle)]">{activeStore.currency}</span>
            </div>
          )}
        </header>

        {/* Ambient lime gradient behind content */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-0"
          style={{ background: 'radial-gradient(55rem 35rem at 75% -5%,rgba(181,255,46,0.04),transparent)' }}
        />

        {/* Page content */}
        <div className="relative z-10 flex-1 max-w-5xl w-full mx-auto px-6 py-7">
          {!activeStore ? (
            <div className="flex flex-col items-center justify-center py-32 gap-5 text-center">
              <div
                className="flex h-14 w-14 items-center justify-center rounded-xl text-[var(--cc-lime)]"
                style={{ background: 'rgba(181,255,46,0.08)', border: '1px solid rgba(181,255,46,0.2)' }}
              >
                <Store size={24} />
              </div>
              <div>
                <p className="text-base font-semibold text-[var(--cc-body)] mb-1">
                  {stores.length === 0 ? 'No stores yet' : 'Select a store to continue'}
                </p>
                <p className="text-sm text-[var(--cc-subtle)]">
                  {stores.length === 0
                    ? 'Create your first store to get started.'
                    : 'Pick a store from the sidebar switcher.'}
                </p>
              </div>
              {stores.length === 0 && (
                <Btn onClick={() => setShowCreateStore(true)} size="lg">
                  <PlusCircle size={15} />
                  Create Store
                </Btn>
              )}
            </div>
          ) : (
            <Outlet />
          )}
        </div>
      </main>

      {showCreateStore && (
        <CreateStoreModal
          onClose={() => setShowCreateStore(false)}
          onCreated={storeId => { void handleStoreCreated(storeId) }}
        />
      )}
    </div>
  )
}
