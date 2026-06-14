import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSdk, setOn401Handler, resetSdk, guardedCall } from '../lib/sdk'
import { getActiveStoreId, setActiveStoreId, clearAllAuth, clearActiveStoreId } from '../lib/auth'
import { CartcrftApiError } from '@cartcrft/sdk'

interface Store {
  id: string
  name: string
  currency: string
  timezone?: string | null
  country_code?: string | null
  email?: string | null
  phone?: string | null
  is_active?: boolean
  [key: string]: unknown
}

interface StoreContextValue {
  stores: Store[]
  activeStore: Store | null
  loading: boolean
  setActiveStore: (s: Store) => void
  reload: (selectId?: string) => Promise<void>
}

const StoreContext = createContext<StoreContextValue | null>(null)

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [stores, setStores] = useState<Store[]>([])
  const [activeStore, setActiveStoreState] = useState<Store | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  // Register a global 401 handler so any SDK call that returns 401 sends the
  // user back to /login rather than leaving a blank screen.
  useEffect(() => {
    setOn401Handler(() => {
      void navigate('/login', { replace: true })
    })
  }, [navigate])

  const reload = useCallback(async (selectId?: string) => {
    setLoading(true)
    try {
      // guardedCall (thunk form) transparently attempts ONE /account/refresh on
      // a 401 — rotating the httpOnly cookie + minting a fresh in-memory access
      // token — before giving up. So an expired-but-refreshable session recovers
      // here instead of bouncing the user to /login.
      const res = await guardedCall(() => getSdk().stores.list())
      const list = res.stores ?? []
      setStores(list)
      const savedId = selectId ?? getActiveStoreId()
      const found = list.find(s => s.id === savedId) ?? list[0] ?? null
      setActiveStoreState(found)
      if (found) setActiveStoreId(found.id)
    } catch (err) {
      // A 401 that survived the refresh attempt → clear creds + redirect. The
      // guardedCall on401 handler (registered via setOn401Handler) also fires;
      // we redirect here as well to be robust.
      if (err instanceof CartcrftApiError && err.status === 401) {
        clearAllAuth()
        clearActiveStoreId()
        resetSdk()
        void navigate('/login', { replace: true })
      }
      // Other errors (network, 5xx): leave stores empty; the UI shows an empty
      // state rather than a blank screen.
    } finally { setLoading(false) }
  }, [navigate])

  useEffect(() => { void reload() }, [reload])

  const setActiveStore = (s: Store) => {
    setActiveStoreState(s)
    setActiveStoreId(s.id)
  }

  return (
    <StoreContext.Provider value={{ stores, activeStore, loading, setActiveStore, reload }}>
      {children}
    </StoreContext.Provider>
  )
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore outside StoreProvider')
  return ctx
}
