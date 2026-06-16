import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

type Tab = 'config' | 'sessions' | 'email' | 'audit'

interface AuthConfig {
  auth_enabled?: boolean
  auth_email_password_enabled?: boolean
  auth_google_enabled?: boolean
  auth_microsoft_enabled?: boolean
  auth_discord_enabled?: boolean
  auth_magic_link_enabled?: boolean
  auth_require_email_verification?: boolean
  auth_allow_self_registration?: boolean
  auth_jwt_expiry_mins?: number
  auth_session_duration_days?: number
  auth_redirect_url?: string
  auth_logo_url?: string
  auth_brand_color?: string
  auth_allowed_origins?: string[]
  auth_google_client_id?: string
  auth_ms_client_id?: string
  auth_discord_client_id?: string
  has_google_secret?: boolean
  has_microsoft_secret?: boolean
  has_discord_secret?: boolean
  [k: string]: unknown
}

interface Session {
  id: string; customer_id?: string; device?: string; ip_address?: string;
  created_at: string; expires_at?: string; [k: string]: unknown
}

interface EmailLog {
  id: string; to?: string; subject?: string; template?: string;
  status?: string; created_at: string; [k: string]: unknown
}

interface AuditEntry {
  id: string; action: string; customer_id?: string; ip_address?: string;
  created_at: string; [k: string]: unknown
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${checked ? 'bg-violet-600' : 'bg-slate-700'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

function AuthConfigTab({ storeId }: { storeId: string }) {
  const { toast } = useToast()
  const [config, setConfig] = useState<AuthConfig>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [originDraft, setOriginDraft] = useState('')
  const [testEmail, setTestEmail] = useState('')
  const [sendingTest, setSendingTest] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await getSdk().customerAuth.getConfig(storeId)
        setConfig((res as { auth?: AuthConfig }).auth ?? (res as AuthConfig))
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to load auth config', 'error')
        setConfig({})
      } finally {
        setLoading(false)
      }
    })()
  }, [storeId, toast])

  const set = (k: keyof AuthConfig) => (v: unknown) => setConfig(c => ({ ...c, [k]: v }))

  const save = async () => {
    setSaving(true)
    try {
      await getSdk().request(`/commerce/stores/${storeId}/auth/config`, { method: 'PUT', body: config })
      toast('Auth config saved', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  const addOrigin = () => {
    const v = originDraft.trim()
    if (!v) return
    const existing = config.auth_allowed_origins ?? []
    if (!existing.includes(v)) setConfig(c => ({ ...c, auth_allowed_origins: [...existing, v] }))
    setOriginDraft('')
  }

  const removeOrigin = (idx: number) =>
    setConfig(c => ({ ...c, auth_allowed_origins: (c.auth_allowed_origins ?? []).filter((_, i) => i !== idx) }))

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>

  const boolField = (key: keyof AuthConfig, label: string) => (
    <div key={key} className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <span className="text-sm text-slate-300">{label}</span>
      <Toggle checked={Boolean(config[key])} onChange={v => set(key)(v)} />
    </div>
  )

  return (
    <div className="space-y-5">
      {/* Master toggle */}
      <div className="flex items-center justify-between rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
        <div>
          <p className="text-sm font-semibold text-white">Customer auth enabled</p>
          <p className="text-xs text-slate-500">Allow customers to register and sign in to your store.</p>
        </div>
        <Toggle checked={Boolean(config.auth_enabled)} onChange={v => set('auth_enabled')(v)} />
      </div>

      {/* Sign-in methods */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Sign-in Methods</p>
        {boolField('auth_email_password_enabled', 'Email + Password')}
        {boolField('auth_magic_link_enabled', 'Magic Link')}
        {boolField('auth_google_enabled', 'Google OAuth')}
        {boolField('auth_microsoft_enabled', 'Microsoft OAuth')}
        {boolField('auth_discord_enabled', 'Discord OAuth')}
      </div>

      {/* OAuth credentials */}
      {config.auth_google_enabled && (
        <Card title="Google OAuth App">
          <FormInput label="Client ID" value={config.auth_google_client_id ?? ''} onChange={v => set('auth_google_client_id')(v)} placeholder="123456.apps.googleusercontent.com" />
        </Card>
      )}
      {config.auth_microsoft_enabled && (
        <Card title="Microsoft Entra App">
          <FormInput label="Application (client) ID" value={config.auth_ms_client_id ?? ''} onChange={v => set('auth_ms_client_id')(v)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        </Card>
      )}
      {config.auth_discord_enabled && (
        <Card title="Discord App">
          <FormInput label="Client ID" value={config.auth_discord_client_id ?? ''} onChange={v => set('auth_discord_client_id')(v)} placeholder="123456789012345678" />
        </Card>
      )}

      {/* Registration */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Registration</p>
        {boolField('auth_require_email_verification', 'Require email verification')}
        {boolField('auth_allow_self_registration', 'Allow self-registration')}
      </div>

      {/* Token lifetimes */}
      <div className="grid grid-cols-2 gap-3">
        <FormInput label="JWT expiry (minutes)" value={String(config.auth_jwt_expiry_mins ?? 60)} onChange={v => set('auth_jwt_expiry_mins')(Number(v))} type="number" />
        <FormInput label="Session duration (days)" value={String(config.auth_session_duration_days ?? 30)} onChange={v => set('auth_session_duration_days')(Number(v))} type="number" />
      </div>

      {/* Branding */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Branding</p>
        <div className="grid grid-cols-2 gap-3">
          <FormInput label="Redirect URL" value={config.auth_redirect_url ?? ''} onChange={v => set('auth_redirect_url')(v)} placeholder="https://store.example.com/account" />
          <FormInput label="Logo URL" value={config.auth_logo_url ?? ''} onChange={v => set('auth_logo_url')(v)} placeholder="https://..." />
          <FormInput label="Brand Color" value={config.auth_brand_color ?? ''} onChange={v => set('auth_brand_color')(v)} placeholder="#b5ff2e" />
        </div>
      </div>

      {/* Allowed origins */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Allowed Origins</p>
        <div className="flex gap-2">
          <FormInput label="" value={originDraft} onChange={setOriginDraft} placeholder="https://store.example.com" className="flex-1" />
          <Btn variant="secondary" onClick={addOrigin}>Add</Btn>
        </div>
        {(config.auth_allowed_origins ?? []).map((o, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2">
            <span className="text-sm text-slate-300 font-mono">{o}</span>
            <Btn variant="danger" onClick={() => removeOrigin(i)}>Remove</Btn>
          </div>
        ))}
      </div>

      <div className="pt-2 border-t border-white/[0.06]">
        <Btn onClick={save} loading={saving} variant="green">Save Auth Config</Btn>
      </div>
    </div>
  )
}

function SessionsTab({ storeId }: { storeId: string }) {
  const { toast } = useToast()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const res = await getSdk().request<{ sessions: Session[] }>(`/commerce/stores/${storeId}/auth/sessions`)
        setSessions((res as { sessions?: Session[] }).sessions ?? [])
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to load sessions', 'error')
        setSessions([])
      } finally {
        setLoading(false)
      }
    })()
  }, [storeId, toast])

  const revoke = async (sessionId: string) => {
    setRevoking(sessionId)
    try {
      await getSdk().request(`/commerce/stores/${storeId}/auth/sessions/${sessionId}`, { method: 'DELETE' })
      setSessions(s => s.filter(x => x.id !== sessionId))
      toast('Session revoked', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Revoke failed', 'error') }
    finally { setRevoking(null) }
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>

  return sessions.length === 0 ? (
    <EmptyState title="No active sessions" description="Active customer sessions will appear here" />
  ) : (
    <TableContainer>
      <table className="w-full text-sm">
        <TableHead><Th>Customer</Th><Th>Device</Th><Th>IP</Th><Th>Created</Th><Th>Expires</Th><Th></Th></TableHead>
        <tbody>
          {sessions.map(s => (
            <tr key={s.id} className="border-t border-white/[0.04]">
              <Td className="font-mono text-xs text-slate-400">{String(s.customer_id ?? '—').slice(0, 8)}</Td>
              <Td className="text-slate-300 text-xs">{s.device ?? '—'}</Td>
              <Td className="font-mono text-xs text-slate-400">{s.ip_address ?? '—'}</Td>
              <Td className="text-slate-500 text-xs">{new Date(s.created_at).toLocaleDateString()}</Td>
              <Td className="text-slate-500 text-xs">{s.expires_at ? new Date(s.expires_at).toLocaleDateString() : '—'}</Td>
              <Td><Btn variant="danger" loading={revoking === s.id} onClick={() => void revoke(s.id)}>Revoke</Btn></Td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableContainer>
  )
}

function EmailTab({ storeId }: { storeId: string }) {
  const { toast } = useToast()
  const [logs, setLogs] = useState<EmailLog[]>([])
  const [loading, setLoading] = useState(true)
  const [testEmail, setTestEmail] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await getSdk().request<{ logs: EmailLog[] }>(`/commerce/stores/${storeId}/auth/email-log`)
        setLogs((res as { logs?: EmailLog[] }).logs ?? [])
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to load email log', 'error')
        setLogs([])
      } finally {
        setLoading(false)
      }
    })()
  }, [storeId, toast])

  const sendTest = async () => {
    if (!testEmail) { toast('Email required', 'error'); return }
    setSending(true)
    try {
      await getSdk().request(`/commerce/stores/${storeId}/auth/email/test`, {
        method: 'POST', body: { email: testEmail },
      })
      toast('Test email sent', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Send failed', 'error') }
    finally { setSending(false) }
  }

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>

  return (
    <div className="space-y-4">
      <Card title="Test Email">
        <div className="flex gap-2">
          <FormInput label="" value={testEmail} onChange={setTestEmail} placeholder="customer@example.com" className="flex-1" />
          <Btn onClick={sendTest} loading={sending} variant="primary">Send Test</Btn>
        </div>
      </Card>

      {logs.length === 0 ? (
        <EmptyState title="No email logs" description="Emails sent to customers (verification, password reset, etc.) will appear here" />
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead><Th>To</Th><Th>Template</Th><Th>Status</Th><Th>Sent</Th></TableHead>
            <tbody>
              {logs.map((log, i) => (
                <tr key={String(log.id ?? i)} className="border-t border-white/[0.04]">
                  <Td className="text-slate-300">{log.to ?? '—'}</Td>
                  <Td><Badge color="blue">{log.template ?? log.subject ?? '—'}</Badge></Td>
                  <Td><Badge color={log.status === 'sent' ? 'emerald' : 'red'}>{log.status ?? 'unknown'}</Badge></Td>
                  <Td className="text-slate-500 text-xs">{new Date(log.created_at).toLocaleDateString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}
    </div>
  )
}

function AuditTab({ storeId }: { storeId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void (async () => {
      try {
        const res = await getSdk().request<{ entries: AuditEntry[] }>(`/commerce/stores/${storeId}/customers/audit-log`)
        setEntries((res as { entries?: AuditEntry[] }).entries ?? [])
      } catch {
        // Fallback path
        try {
          const res2 = await getSdk().request<{ logs: AuditEntry[] }>(`/commerce/stores/${storeId}/auth/audit-log`)
          setEntries((res2 as { logs?: AuditEntry[] }).logs ?? [])
        } catch (err) {
          console.warn('Failed to load audit log:', err)
          setEntries([])
        }
      } finally {
        setLoading(false)
      }
    })()
  }, [storeId])

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>

  return entries.length === 0 ? (
    <EmptyState title="No audit log entries" description="Customer auth events (login, register, logout, etc.) are logged here" />
  ) : (
    <TableContainer>
      <table className="w-full text-sm">
        <TableHead><Th>Action</Th><Th>Customer</Th><Th>IP</Th><Th>Date</Th></TableHead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={String(e.id ?? i)} className="border-t border-white/[0.04]">
              <Td><Badge color="slate">{e.action}</Badge></Td>
              <Td className="font-mono text-xs text-slate-400">{String(e.customer_id ?? '—').slice(0, 8)}</Td>
              <Td className="font-mono text-xs text-slate-400">{e.ip_address ?? '—'}</Td>
              <Td className="text-slate-500 text-xs">{new Date(e.created_at).toLocaleString()}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableContainer>
  )
}

export default function CustomerAuth() {
  const { activeStore } = useStore()
  const [tab, setTab] = useState<Tab>('config')

  const TABS = [
    { key: 'config' as Tab, label: 'Auth Config' },
    { key: 'sessions' as Tab, label: 'Sessions' },
    { key: 'email' as Tab, label: 'Email' },
    { key: 'audit' as Tab, label: 'Audit Log' },
  ]

  if (!activeStore) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader title="Customer Auth" description="Auth methods, sessions, email logs, and audit trail" />

      <div className="flex border-b border-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${tab === t.key ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'config' && <AuthConfigTab storeId={activeStore.id} />}
      {tab === 'sessions' && <SessionsTab storeId={activeStore.id} />}
      {tab === 'email' && <EmailTab storeId={activeStore.id} />}
      {tab === 'audit' && <AuditTab storeId={activeStore.id} />}
    </div>
  )
}
