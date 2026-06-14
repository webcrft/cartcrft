import { Cartcrft, CartcrftApiError } from '@cartcrft/sdk'
import { getToken, getApiKey, setToken, clearAllAuth, clearActiveStoreId } from './auth'

// Astro exposes client-visible env vars under the PUBLIC_ prefix.
// The literal `import.meta.env.PUBLIC_API_URL` form is required so Vite inlines
// the value at build time.  Falls back to localhost:8080 when unset.
export const BASE_URL: string = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8080'

/** Called on a final (post-refresh) 401 — clears auth and redirects to /login. */
let _on401: (() => void) | null = null
export function setOn401Handler(fn: () => void): void { _on401 = fn }

// ── Account auth API (platform-account login, P3/item-1) ─────────────────────
//
// These hit the new /account/* endpoints. They use fetch with
// credentials:'include' so the httpOnly refresh cookie (set by the backend,
// scoped to /account) is sent and stored by the browser — the dashboard JS
// never reads it. The short-lived access JWT returned here is held in memory
// (auth.ts setToken), NOT localStorage.

export interface AccountUser {
  id: string
  org_id: string
  email: string
  role: 'owner' | 'admin' | 'member'
}

interface SessionResponse {
  access_token: string
  expires_at: string
  user: AccountUser
}

async function accountFetch(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include', // send + store the httpOnly refresh cookie
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** Email + password login. On success the access token is stored in memory. */
export async function accountLogin(email: string, password: string): Promise<AccountUser> {
  const res = await accountFetch('/account/login', { email, password })
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } }
    throw new CartcrftApiError(res.status, { code: err.error?.code ?? 'UNAUTHORIZED', message: err.error?.message ?? 'Login failed' })
  }
  const data = (await res.json()) as SessionResponse
  setToken(data.access_token)
  resetSdk()
  return data.user
}

/**
 * Try to restore a session from the httpOnly refresh cookie. Returns the user
 * on success (and stores a fresh access token in memory), or null if there is
 * no valid refresh cookie. Called on app boot and on a 401.
 */
export async function accountRefresh(): Promise<AccountUser | null> {
  let res: Response
  try {
    res = await accountFetch('/account/refresh')
  } catch {
    return null // network error — treat as no session
  }
  if (!res.ok) return null
  const data = (await res.json()) as SessionResponse
  setToken(data.access_token)
  resetSdk()
  return data.user
}

/** Revoke the refresh session + clear the cookie and in-memory creds. */
export async function accountLogout(): Promise<void> {
  try { await accountFetch('/account/logout') } catch { /* best-effort */ }
  clearAllAuth()
  clearActiveStoreId()
  resetSdk()
}

// ── SDK client (carries the in-memory access token / advanced API key) ───────

export function createSdk(): Cartcrft {
  const apiKey = getApiKey()
  const token = getToken()
  return new Cartcrft({
    baseUrl: BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    ...(token && !apiKey ? { token } : {}),
  })
}

let _sdk: Cartcrft | null = null

export function getSdk(): Cartcrft {
  if (!_sdk) _sdk = createSdk()
  return _sdk
}

export function resetSdk(): void { _sdk = null }

/**
 * Wrap an SDK promise so a 401 first attempts ONE silent refresh (rotating the
 * httpOnly cookie + minting a new in-memory access token) and retries; only if
 * that fails do we clear auth and fire the redirect-to-login handler.
 *
 * The advanced cc_prv_ key path has no refresh — a 401 there clears + redirects.
 *
 * Note: callers that pass a pre-built promise cannot be transparently retried
 * (the request already captured the old token). We therefore accept a thunk
 * form too; pass `() => sdk.x.y()` to get automatic retry. A bare promise still
 * benefits from the refresh + redirect on its own 401.
 */
export async function guardedCall<T>(work: Promise<T> | (() => Promise<T>)): Promise<T> {
  const isThunk = typeof work === 'function'
  try {
    return await (isThunk ? (work as () => Promise<T>)() : work)
  } catch (err) {
    if (err instanceof CartcrftApiError && err.status === 401) {
      // Only the access-JWT path can be refreshed (no API key in play).
      if (!getApiKey()) {
        const restored = await accountRefresh()
        if (restored && isThunk) {
          try {
            return await (work as () => Promise<T>)()
          } catch (retryErr) {
            if (!(retryErr instanceof CartcrftApiError && retryErr.status === 401)) throw retryErr
          }
        }
      }
      // Refresh impossible or still 401 → clear + redirect.
      clearAllAuth()
      clearActiveStoreId()
      resetSdk()
      _on401?.()
    }
    throw err
  }
}

export { CartcrftApiError }
