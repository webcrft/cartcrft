/**
 * dashboard/lib/auth.ts — token handling for the org dashboard (P3 / audit item 1).
 *
 * SECURITY MODEL (replaces the cc_prv_-in-localStorage trust model the audit
 * flagged):
 *
 *   - The ACCESS token is a short-lived JWT held ONLY in module memory (never
 *     localStorage). An XSS payload cannot read it from storage, and it expires
 *     in ~15 min. Persistence across reloads comes from the httpOnly refresh
 *     cookie (set by the backend, scoped to /account, unreadable by JS) via a
 *     boot-time /account/refresh call — not from any browser-stored secret.
 *
 *   - The cc_prv_ API key path is kept ONLY as an explicitly-opted-in
 *     "advanced / CI" mode. When chosen it is held in memory by default; it is
 *     persisted to sessionStorage (cleared when the tab closes — NOT
 *     localStorage) ONLY when the operator ticks the "remember on this tab" box.
 *     It is powerful (full commerce:admin) and the UI warns accordingly.
 *
 *   - The active store id is non-secret UI state and may live in localStorage.
 */

// ── In-memory access token (the default, secure path) ────────────────────────

let _accessToken: string | null = null

export function getToken(): string | null { return _accessToken }
export function setToken(t: string | null): void { _accessToken = t }
export function clearToken(): void { _accessToken = null }

// ── Advanced: cc_prv_ API key (opt-in, in-memory by default) ─────────────────

/** sessionStorage (NOT localStorage) key for the optional remembered API key. */
export const API_KEY_SESSION = 'cc_admin_apikey'

let _apiKey: string | null = null

/** Read the advanced API key — memory first, then sessionStorage (tab-scoped). */
export function getApiKey(): string | null {
  if (_apiKey) return _apiKey
  try {
    const fromSession = sessionStorage.getItem(API_KEY_SESSION)
    if (fromSession) { _apiKey = fromSession; return _apiKey }
  } catch { /* sessionStorage unavailable */ }
  return null
}

/**
 * Set the advanced API key. By default it is held in memory only. Pass
 * `{ remember: true }` to persist it to sessionStorage (cleared on tab close).
 * We deliberately never write it to localStorage.
 */
export function setApiKey(k: string, opts: { remember?: boolean } = {}): void {
  _apiKey = k
  try {
    if (opts.remember) sessionStorage.setItem(API_KEY_SESSION, k)
    else sessionStorage.removeItem(API_KEY_SESSION)
  } catch { /* sessionStorage unavailable */ }
}

export function clearApiKey(): void {
  _apiKey = null
  try { sessionStorage.removeItem(API_KEY_SESSION) } catch { /* noop */ }
}

/** Clear every credential (memory access token + advanced API key). */
export function clearAllAuth(): void {
  clearToken()
  clearApiKey()
}

// ── Active store (non-secret UI state) ───────────────────────────────────────

export const STORE_KEY = 'cc_admin_store'

export function getActiveStoreId(): string | null {
  try { return localStorage.getItem(STORE_KEY) } catch { return null }
}
export function setActiveStoreId(id: string): void {
  try { localStorage.setItem(STORE_KEY, id) } catch { /* noop */ }
}
export function clearActiveStoreId(): void {
  try { localStorage.removeItem(STORE_KEY) } catch { /* noop */ }
}

// ── Auth presence ────────────────────────────────────────────────────────────

/** True when some credential is present in memory (access JWT or advanced key). */
export function hasAuth(): boolean {
  return !!(_accessToken || getApiKey())
}
