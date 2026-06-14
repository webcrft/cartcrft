export const AUTH_KEY = 'cc_admin_token'
export const STORE_KEY = 'cc_admin_store'
export const API_KEY_STORAGE = 'cc_admin_apikey'

export function getToken(): string | null { return localStorage.getItem(AUTH_KEY) }
export function setToken(t: string): void { localStorage.setItem(AUTH_KEY, t) }
export function clearToken(): void { localStorage.removeItem(AUTH_KEY) }
export function getApiKey(): string | null { return localStorage.getItem(API_KEY_STORAGE) }
export function setApiKey(k: string): void { localStorage.setItem(API_KEY_STORAGE, k) }
export function getActiveStoreId(): string | null { return localStorage.getItem(STORE_KEY) }
export function setActiveStoreId(id: string): void { localStorage.setItem(STORE_KEY, id) }
