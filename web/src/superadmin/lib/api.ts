/**
 * Super-admin API client.
 *
 * The super-JWT is NEVER stored in localStorage (it's god-mode; minimize
 * exposure). It lives exclusively in React state/context (AuthContext). This
 * module only knows how to call the /superadmin/* endpoints — it receives the
 * token as a parameter so there's no global mutable state for the token.
 *
 * All requests are Bearer-authed. On 401 the caller should clear the in-memory
 * token and redirect to /login.
 */

const BASE_URL: string = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8080'

export class SuperAdminApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'SuperAdminApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}/superadmin${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  })

  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = res.statusText
    try {
      const err = await res.json() as { error?: { code?: string; message?: string } }
      code = err.error?.code ?? code
      message = err.error?.message ?? message
    } catch { /* ignore */ }
    throw new SuperAdminApiError(res.status, code, message)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface LoginResult {
  token: string
  expires_at: string
  super_admin: { id: string; email: string }
}

export interface MfaRequired {
  mfa_required: true
}

export async function login(
  email: string,
  password: string,
  totp_code?: string,
): Promise<LoginResult | MfaRequired> {
  return request<LoginResult | MfaRequired>('POST', '/auth/login', null, {
    email,
    password,
    ...(totp_code ? { totp_code } : {}),
  })
}

export async function logout(token: string): Promise<void> {
  return request<void>('POST', '/auth/logout', token)
}

export async function refresh(token: string): Promise<LoginResult> {
  return request<LoginResult>('POST', '/auth/refresh', token)
}

export interface MeResult {
  id: string
  email: string
  created_at: string
}

export async function getMe(token: string): Promise<MeResult> {
  return request<MeResult>('GET', '/me', token)
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  totalOrgs: number
  totalStores: number
  totalCustomers: number
  totalOrders: number
  gmv: string
  revenueCents: number | null
  activeStores30d: number
  newStores30d: number
  newOrders30d: number
  newCustomers30d: number
}

export async function getAnalyticsOverview(token: string): Promise<AnalyticsOverview> {
  return request<AnalyticsOverview>('GET', '/analytics/overview', token)
}

export interface TimeseriesPoint {
  bucket: string
  orders: number
  gmv: string
  newCustomers: number
}

export interface TimeseriesResult {
  points: TimeseriesPoint[]
}

export async function getAnalyticsTimeseries(
  token: string,
  days = 30,
  interval = 'day',
): Promise<TimeseriesResult> {
  return request<TimeseriesResult>(
    'GET',
    `/analytics/timeseries?days=${days}&interval=${interval}`,
    token,
  )
}

export interface HealthResult {
  db: string
  pool: string
  migration: string
  worker: string
  errors: number
  status: 'healthy' | 'degraded' | 'down'
}

export async function getAnalyticsHealth(token: string): Promise<HealthResult> {
  return request<HealthResult>('GET', '/analytics/health', token)
}

// ── Orgs ──────────────────────────────────────────────────────────────────────

export interface Org {
  id: string
  name: string
  email?: string
  store_count: number
  order_count: number
  gmv: string
  billing_status?: string
  created_at: string
}

export async function listOrgs(token: string): Promise<{ orgs: Org[] }> {
  return request<{ orgs: Org[] }>('GET', '/orgs', token)
}

export interface OrgDetail extends Org {
  stores: StoreItem[]
  customer_count: number
}

export async function getOrg(token: string, orgId: string): Promise<{ org: OrgDetail }> {
  return request<{ org: OrgDetail }>('GET', `/orgs/${orgId}`, token)
}

// ── Stores ────────────────────────────────────────────────────────────────────

export interface StoreItem {
  id: string
  name: string
  org_id: string
  org_name?: string
  currency: string
  status: string
  order_count: number
  gmv: string
  created_at: string
}

export async function listStores(token: string): Promise<{ stores: StoreItem[] }> {
  return request<{ stores: StoreItem[] }>('GET', '/stores', token)
}

export interface StoreDetail extends StoreItem {
  email?: string
  country_code?: string
  timezone?: string
}

export async function getStore(token: string, storeId: string): Promise<{ store: StoreDetail }> {
  return request<{ store: StoreDetail }>('GET', `/stores/${storeId}`, token)
}

// ── Customers ─────────────────────────────────────────────────────────────────

export interface CustomerItem {
  id: string
  email: string
  store_id: string
  store_name?: string
  org_id: string
  created_at: string
}

export async function searchCustomers(
  token: string,
  query: string,
): Promise<{ customers: CustomerItem[] }> {
  return request<{ customers: CustomerItem[] }>(
    'GET',
    `/customers?q=${encodeURIComponent(query)}`,
    token,
  )
}

// ── Tenant actions ────────────────────────────────────────────────────────────

export async function takedownStore(token: string, storeId: string, reason: string): Promise<void> {
  return request<void>('POST', `/stores/${storeId}/takedown`, token, { reason })
}

export async function restoreStore(token: string, storeId: string, reason: string): Promise<void> {
  return request<void>('POST', `/stores/${storeId}/restore`, token, { reason })
}

export async function suspendStore(token: string, storeId: string, reason: string): Promise<void> {
  return request<void>('POST', `/stores/${storeId}/suspend`, token, { reason })
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string
  admin_id: string
  admin_email: string
  action: string
  target_type?: string
  target_id?: string
  metadata?: Record<string, unknown>
  ip?: string
  created_at: string
}

export async function listAuditLog(
  token: string,
  page = 1,
  limit = 50,
  action?: string,
): Promise<{ entries: AuditEntry[]; total: number }> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (action) params.set('action', action)
  return request<{ entries: AuditEntry[]; total: number }>(
    'GET',
    `/audit-log?${params}`,
    token,
  )
}
