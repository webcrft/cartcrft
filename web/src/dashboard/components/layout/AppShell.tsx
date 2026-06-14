import React, { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useStore } from '../../context/StoreContext'
import { accountLogout } from '../../lib/sdk'
import { NAV_SECTIONS } from '../../routes/index'
import CreateStoreModal from '../CreateStoreModal'
import { Btn } from '../ui/index'

export default function AppShell() {
  const { stores, activeStore, setActiveStore, reload } = useStore()
  const [showStoreMenu, setShowStoreMenu] = useState(false)
  const [showCreateStore, setShowCreateStore] = useState(false)
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
    <div className="flex h-screen bg-slate-950 text-white overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r border-white/[0.06] bg-slate-950">
        {/* Logo */}
        <div className="px-4 py-4 border-b border-white/[0.06]">
          <span className="text-sm font-bold text-white tracking-tight">Cartcrft</span>
        </div>

        {/* Store switcher */}
        <div className="px-3 py-3 border-b border-white/[0.06] relative">
          <button
            onClick={() => setShowStoreMenu(s => !s)}
            className="w-full flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs font-medium text-slate-300 hover:bg-white/[0.04] transition"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-5 w-5 rounded bg-violet-600/40 flex-shrink-0" />
              <span className="truncate">{activeStore?.name ?? 'No store'}</span>
            </div>
            <span className="text-slate-500">&#x2304;</span>
          </button>
          {showStoreMenu && (
            <div className="absolute left-3 right-3 top-full mt-1 z-50 rounded-xl border border-white/[0.08] bg-slate-900 shadow-xl overflow-hidden">
              {stores.map(s => (
                <button
                  key={s.id}
                  onClick={() => { setActiveStore(s); setShowStoreMenu(false) }}
                  className={`w-full text-left px-3 py-2.5 text-xs transition hover:bg-white/[0.04] ${s.id === activeStore?.id ? 'text-violet-400' : 'text-slate-300'}`}
                >
                  {s.name}
                </button>
              ))}
              {/* Always show "Create store" in the switcher dropdown */}
              <button
                onClick={() => { setShowCreateStore(true); setShowStoreMenu(false) }}
                className="w-full text-left px-3 py-2.5 text-xs text-violet-400 hover:bg-white/[0.04] transition border-t border-white/[0.06]"
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
                <p className="px-2 mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                  {section.label}
                </p>
              )}
              <div className="space-y-0.5">
                {section.items.map(item => (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    end={item.path === '/'}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-xs font-medium transition
                       ${isActive ? 'bg-violet-600/15 text-violet-300' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'}`
                    }
                  >
                    {item.icon && <item.icon size={14} />}
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-3 py-3 border-t border-white/[0.06]">
          <button
            onClick={onSignOutClick}
            className="w-full text-left px-2.5 py-2 text-xs text-slate-500 hover:text-red-400 transition rounded-lg hover:bg-white/[0.04]"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-6">
          {!activeStore ? (
            <div className="flex flex-col items-center justify-center py-32 gap-4">
              <p className="text-slate-400 text-sm">
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
