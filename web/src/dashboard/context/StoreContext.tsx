import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getSdk, setOn401Handler } from '../lib/sdk'
import { getActiveStoreId, setActiveStoreId } from '../lib/auth'

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
      const sdk = getSdk()
      const res = await sdk.stores.list()
      const list = res.stores ?? []
      setStores(list)
      const savedId = selectId ?? getActiveStoreId()
      const found = list.find(s => s.id === savedId) ?? list[0] ?? null
      setActiveStoreState(found)
      if (found) setActiveStoreId(found.id)
    } catch { /* not yet authed */ } finally { setLoading(false) }
  }, [])

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
