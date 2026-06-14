/**
 * Super-admin auth context.
 *
 * The super-JWT is stored IN MEMORY (React state) ONLY — never in localStorage,
 * sessionStorage, or any Web Storage. This minimises exposure for god-mode
 * credentials. The trade-off is that a page refresh forces re-login, which is
 * intentional for an operator console.
 *
 * Auto-refresh: we schedule a refresh 60 seconds before the JWT expiry so the
 * session stays alive during an active session. On 401 from any call we clear
 * the in-memory token and send the operator back to /login.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { refresh as apiRefresh, logout as apiLogout, SuperAdminApiError } from '../lib/api'

export interface SuperAdmin {
  id: string
  email: string
}

interface AuthContextValue {
  token: string | null
  admin: SuperAdmin | null
  expiresAt: Date | null
  setAuth: (token: string, expiresAt: string, admin: SuperAdmin) => void
  clearAuth: () => void
  /** Call on any 401 response — clears auth and redirects to login. */
  handle401: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [admin, setAdmin] = useState<SuperAdmin | null>(null)
  const [expiresAt, setExpiresAt] = useState<Date | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const navigate = useNavigate()

  const clearAuth = useCallback(() => {
    setToken(null)
    setAdmin(null)
    setExpiresAt(null)
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
  }, [])

  const handle401 = useCallback(() => {
    clearAuth()
    void navigate('/login', { replace: true })
  }, [clearAuth, navigate])

  // scheduleRefresh: called whenever we have a live token. Fires a /auth/refresh
  // 60 seconds before expiry to keep the session alive without re-login.
  const scheduleRefresh = useCallback((currentToken: string, exp: Date) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    const msUntilRefresh = exp.getTime() - Date.now() - 60_000
    if (msUntilRefresh <= 0) {
      // Already expired or within 60s — refresh immediately
      void (async () => {
        try {
          const res = await apiRefresh(currentToken)
          const newExp = new Date(res.expires_at)
          setToken(res.token)
          setAdmin(res.super_admin)
          setExpiresAt(newExp)
          scheduleRefresh(res.token, newExp)
        } catch (err) {
          if (err instanceof SuperAdminApiError && err.status === 401) {
            handle401()
          }
        }
      })()
      return
    }

    refreshTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await apiRefresh(currentToken)
          const newExp = new Date(res.expires_at)
          setToken(res.token)
          setAdmin(res.super_admin)
          setExpiresAt(newExp)
          scheduleRefresh(res.token, newExp)
        } catch (err) {
          if (err instanceof SuperAdminApiError && err.status === 401) {
            handle401()
          }
        }
      })()
    }, msUntilRefresh)
  }, [handle401])

  const setAuth = useCallback((
    newToken: string,
    expiresAtStr: string,
    newAdmin: SuperAdmin,
  ) => {
    const exp = new Date(expiresAtStr)
    setToken(newToken)
    setAdmin(newAdmin)
    setExpiresAt(exp)
    scheduleRefresh(newToken, exp)
  }, [scheduleRefresh])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [])

  // Logout helper — hits the server to revoke the session, then clears local state
  const logout = useCallback(async () => {
    if (token) {
      try { await apiLogout(token) } catch { /* ignore — clear locally regardless */ }
    }
    clearAuth()
    void navigate('/login', { replace: true })
  }, [token, clearAuth, navigate])

  return (
    <AuthContext.Provider value={{ token, admin, expiresAt, setAuth, clearAuth, handle401 }}>
      {/* Expose logout as a context child helper via a separate export */}
      <LogoutContext.Provider value={logout}>
        {children}
      </LogoutContext.Provider>
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}

// Separate logout context to keep the main context value stable
const LogoutContext = createContext<(() => Promise<void>) | null>(null)

export function useLogout(): () => Promise<void> {
  const ctx = useContext(LogoutContext)
  if (!ctx) throw new Error('useLogout outside AuthProvider')
  return ctx
}
