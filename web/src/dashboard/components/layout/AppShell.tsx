import React, { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useStore } from '../../context/StoreContext'
import { accountLogout } from '../../lib/sdk'
import { NAV_SECTIONS } from '../../routes/index'
import CreateStoreModal from '../CreateStoreModal'
import { Btn } from '../ui/index'
import { ChevronDown, Menu, X } from 'lucide-react'

export default function AppShell() {
  const { stores, activeStore, setActiveStore, reload } = useStore()
  const [showStoreMenu, setShowStoreMenu] = useState(false)
  const [showCreateStore, setShowCreateStore] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const navigate = useNavigate()

  const handleSignOut = async () => {
    // Revoke the server-side refresh session + clear the httpOnly cookie and
    // in-memory creds, then return to the login screen.
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
      {/* Mobile backdrop — only when the sidebar is open under md */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — static on desktop, fixed overlay on mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-56 flex-shrink-0 flex flex-col border-r border-white/[0.07] bg-[var(--cc-bg-subtle)]
          transform transition-transform duration-200 md:static md:translate-x-0
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        {/* Logo lockup — wordmark image + retained "Cartcrft" text */}
        <div className="px-4 h-14 border-b border-white/[0.07] flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <img src="/logo.svg" alt="" className="h-7 w-7 flex-shrink-0" />
            <span className="font-[var(--cc-font-display)] text-[1.15rem] font-bold tracking-[-0.04em] text-[var(--cc-text)]">cart<span className="text-[var(--cc-lime)]">crft</span></span>
            <span className="sr-only">Cartcrft</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden rounded-lg p-1 text-[var(--cc-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.06] transition"
            aria-label="Close menu"
          >
            <X size={16} />
          </button>
        </div>

        {/* Store switcher */}
        <div className="px-3 py-3 border-b border-white/[0.07] relative">
          <button
            onClick={() => setShowStoreMenu(s => !s)}
            className="w-full flex items-center justify-between gap-2 rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] px-2.5 py-2 text-xs font-medium text-[var(--cc-text)] hover:bg-[var(--cc-surface-2)] hover:border-white/15 transition"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-5 w-5 rounded bg-[var(--cc-lime)] flex-shrink-0 flex items-center justify-center font-mono text-[10px] font-bold text-[var(--cc-ink)]">
                {(activeStore?.name ?? '·').charAt(0).toUpperCase()}
              </div>
              <span className="truncate">{activeStore?.name ?? 'No store'}</span>
            </div>
            <ChevronDown size={14} className="text-[var(--cc-muted)] flex-shrink-0" />
          </button>
          {showStoreMenu && (
            <div className="absolute left-3 right-3 top-full mt-1 z-50 rounded-lg border border-white/[0.08] bg-[var(--cc-surface)] shadow-xl overflow-hidden">
              {stores.map(s => (
                <button
                  key={s.id}
                  onClick={() => { setActiveStore(s); setShowStoreMenu(false) }}
                  className={`w-full text-left px-3 py-2.5 text-xs transition hover:bg-white/[0.04] ${s.id === activeStore?.id ? 'text-[var(--cc-lime)]' : 'text-[var(--cc-body)]'}`}
                >
                  {s.name}
                </button>
              ))}
              {/* Always show "Create store" in the switcher dropdown */}
              <button
                onClick={() => { setShowCreateStore(true); setShowStoreMenu(false) }}
                className="w-full text-left px-3 py-2.5 text-xs text-[var(--cc-lime)] hover:bg-white/[0.04] transition border-t border-white/[0.07]"
              >
                + Create new store
              </button>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
          {NAV_SECTIONS.map(section => (
            <div key={section.label}>
              {section.label && (
                <p className="px-2.5 mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--cc-subtle)]">
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
                      `group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors
                       ${isActive
                         ? 'bg-[var(--cc-lime)]/10 text-[var(--cc-lime)] ring-1 ring-inset ring-[var(--cc-lime)]/20'
                         : 'text-[var(--cc-muted)] hover:text-[var(--cc-text)] hover:bg-white/[0.04]'}`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={`absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-[var(--cc-lime)] transition-opacity ${isActive ? 'opacity-100' : 'opacity-0'}`} />
                        {item.icon && (
                          <span className={isActive ? 'text-[var(--cc-lime)]' : 'text-[var(--cc-subtle)] group-hover:text-[var(--cc-body)]'}>
                            <item.icon size={14} />
                          </span>
                        )}
                        {item.label}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-3 py-3 border-t border-white/[0.07]">
          <button
            onClick={onSignOutClick}
            className="w-full text-left px-2.5 py-2 font-mono text-[11px] uppercase tracking-wider text-[var(--cc-subtle)] hover:text-red-400 transition rounded-lg hover:bg-white/[0.04]"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-[var(--cc-bg)] bg-[radial-gradient(60rem_40rem_at_75%_-10%,rgba(181,255,46,0.05),transparent)]">
        {/* Mobile top bar with hamburger — hidden on desktop */}
        <div className="md:hidden sticky top-0 z-20 flex items-center gap-3 border-b border-white/[0.07] bg-[var(--cc-bg)]/90 backdrop-blur px-4 py-3">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-[var(--cc-body)] hover:text-[var(--cc-text)] hover:bg-white/[0.06] transition"
            aria-label="Open menu"
          >
            <Menu size={18} />
            <span className="sr-only">Open navigation</span>
          </button>
        </div>
        <div className="max-w-5xl mx-auto px-6 py-6">
          {!activeStore ? (
            <div className="flex flex-col items-center justify-center py-32 gap-4">
              <p className="text-[var(--cc-muted)] text-sm">
                {stores.length === 0
                  ? 'No stores found. Create your first store to get started.'
                  : 'Select a store to continue.'}
              </p>
              {stores.length === 0 && (
                <Btn onClick={() => setShowCreateStore(true)}>Create Store</Btn>
              )}
            </div>
          ) : (
            <Outlet />
          )}
        </div>
      </main>

      {/* Create-store modal — reachable from zero-store landing AND store switcher */}
      {showCreateStore && (
        <CreateStoreModal
          onClose={() => setShowCreateStore(false)}
          onCreated={storeId => { void handleStoreCreated(storeId) }}
        />
      )}
    </div>
  )
}
