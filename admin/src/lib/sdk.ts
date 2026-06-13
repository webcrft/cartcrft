import { Cartcrft, CartcrftApiError } from '@cartcrft/sdk'
import { getToken, getApiKey, clearToken } from './auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BASE_URL: string = (import.meta as any).env?.['VITE_API_URL'] ?? 'http://localhost:3000'

/** Called on 401 — clears auth and redirects to /login. Injected at app boot. */
let _on401: (() => void) | null = null
export function setOn401Handler(fn: () => void): void { _on401 = fn }

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
 * Thin wrapper around any SDK promise that intercepts CartcrftApiError with
 * status 401 — clears auth and fires the registered redirect handler so the
 * user is sent to /login instead of seeing a blank screen.
 */
export async function guardedCall<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (err) {
    if (err instanceof CartcrftApiError && err.status === 401) {
      clearToken()
      localStorage.removeItem('cc_admin_apikey')
      localStorage.removeItem('cc_admin_store')
      resetSdk()
      _on401?.()
    }
    throw err
  }
}
