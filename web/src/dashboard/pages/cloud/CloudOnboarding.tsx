import React, { useCallback, useEffect, useState } from 'react'
import {
  PageHeader, Card, Btn, Badge, Spinner, Modal, FormInput, LoadError,
} from '../../components/ui/index'
import { useStore } from '../../context/StoreContext'
import { useToast } from '../../context/ToastContext'
import { getToken, getApiKey } from '../../lib/auth'

// ── Agent surfaces ──────────────────────────────────────────────────────────

type Surface = 'google_merchant' | 'chatgpt_acp'

interface SurfaceMeta {
  surface: Surface
  name: string
  blurb: string
  accountLabel: string
  accountPlaceholder: string
}

const SURFACE_META: Record<Surface, SurfaceMeta> = {
  google_merchant: {
    surface: 'google_merchant',
    name: 'Google AI Shopping',
    blurb:
      'Publish your catalog to Google Merchant Center so it surfaces in Google’s AI shopping & Shopping Graph.',
    accountLabel: 'Merchant Center account ID',
    accountPlaceholder: 'e.g. 1234567',
  },
  chatgpt_acp: {
    surface: 'chatgpt_acp',
    name: 'ChatGPT (ACP)',
    blurb:
      'Register your live ACP product feed with OpenAI so ChatGPT shopping agents can discover & buy from your store.',
    accountLabel: 'OpenAI merchant ID',
    accountPlaceholder: 'e.g. merch_abc123',
  },
}

interface Connection {
  id: string
  store_id: string
  surface: Surface
  status: 'disconnected' | 'pending' | 'connected' | 'error'
  external_account_id: string | null
  has_credentials: boolean
  config: Record<string, unknown>
  last_sync_at: string | null
  created_at: string
}

interface ConnectInfo {
  surface: Surface
  authorize_url: string | null
  instructions: string[]
  mock_available: boolean
  required_to_go_live: string[]
}

interface FeedResult {
  surface: Surface
  ok: boolean
  item_count: number
  submission_id: string | null
  endpoint: string
  error?: string
}

// ── Raw API helper (onboarding endpoints aren't in the typed SDK) ───────────

const BASE_URL: string =
  (import.meta as unknown as { env: Record<string, string> }).env
    .PUBLIC_API_URL ?? 'http://localhost:8080'

async function api<T>(
  storeId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  }
  const apiKey = getApiKey()
  const token = getToken()
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
  else if (token) headers['authorization'] = `Bearer ${token}`

  const res = await fetch(
    `${BASE_URL}/commerce/stores/${storeId}/agent-surfaces${path}`,
    { ...init, headers },
  )
  const json = (await res.json().catch(() => ({}))) as unknown
  if (!res.ok) {
    const err = json as { error?: { message?: string; code?: string } }
    throw new Error(err.error?.message ?? `Request failed (${res.status})`)
  }
  return json as T
}

// ── Presentational helpers ──────────────────────────────────────────────────

function statusBadge(status: Connection['status']) {
  switch (status) {
    case 'connected':
      return <Badge color="emerald">Connected</Badge>
    case 'pending':
      return <Badge color="amber">Pending</Badge>
    case 'error':
      return <Badge color="red">Error</Badge>
    default:
      return <Badge color="slate">Not connected</Badge>
  }
}

function fmtTime(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString()
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function CloudOnboardingPage() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const storeId = activeStore?.id ?? ''

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connections, setConnections] = useState<Connection[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const [connectModal, setConnectModal] = useState<{
    surface: Surface
    info: ConnectInfo
  } | null>(null)
  const [accountId, setAccountId] = useState('')
  const [credential, setCredential] = useState('')

  const bySurface = (s: Surface) => connections.find((c) => c.surface === s)

  const load = useCallback(() => {
    if (!storeId) return
    setLoading(true)
    setLoadError(null)
    api<{ connections: Connection[] }>(storeId, '')
      .then((r) => setConnections(r.connections))
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false))
  }, [storeId])

  useEffect(() => {
    load()
  }, [load])

  async function openConnect(surface: Surface) {
    setBusy(`connect:${surface}`)
    try {
      const r = await api<{ connect: ConnectInfo }>(
        storeId,
        `/${surface}/connect`,
      )
      setAccountId(bySurface(surface)?.external_account_id ?? '')
      setCredential('')
      setConnectModal({ surface, info: r.connect })
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  async function submitConnect() {
    if (!connectModal) return
    const { surface, info } = connectModal
    setBusy('save')
    try {
      // Real OAuth surfaces (Google) hand off to the provider when configured.
      if (info.authorize_url) {
        window.location.href = info.authorize_url
        return
      }
      // Dev mock connector, or manual credential entry.
      if (info.mock_available && !credential) {
        await api(storeId, `/${surface}/mock-connect`, {
          method: 'POST',
          body: JSON.stringify({
            external_account_id: accountId || `mock-${surface}`,
          }),
        })
      } else {
        await api(storeId, '', {
          method: 'POST',
          body: JSON.stringify({
            surface,
            external_account_id: accountId || undefined,
            credentials: credential || undefined,
          }),
        })
      }
      toast(`${SURFACE_META[surface].name} connected`, 'success')
      setConnectModal(null)
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  async function disconnect(conn: Connection) {
    if (!window.confirm(`Disconnect ${SURFACE_META[conn.surface].name}?`)) return
    setBusy(`disc:${conn.id}`)
    try {
      await api(storeId, `/${conn.id}`, { method: 'DELETE' })
      toast('Disconnected', 'success')
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  async function submitFeed(conn: Connection) {
    setBusy(`feed:${conn.id}`)
    try {
      const r = await api<{ result: FeedResult }>(
        storeId,
        `/${conn.id}/submit-feed`,
        { method: 'POST', body: '{}' },
      )
      if (r.result.ok) {
        toast(
          `Submitted ${r.result.item_count} product(s) to ${SURFACE_META[conn.surface].name}`,
          'success',
        )
      } else {
        toast(r.result.error ?? 'Feed submission failed', 'error')
      }
      load()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }

  if (!storeId) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Agent Surfaces"
          description="Connect your store to AI shopping surfaces."
        />
        <Card>
          <p className="text-[13px] text-[var(--cc-muted)]">
            Select a store to manage its agent surfaces.
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Surfaces"
        description="Make your store discoverable & buyable on AI shopping surfaces in two clicks."
      />

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : loadError ? (
        <LoadError message={loadError} onRetry={load} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(Object.keys(SURFACE_META) as Surface[]).map((surface) => {
            const meta = SURFACE_META[surface]
            const conn = bySurface(surface)
            const connected = conn && conn.status === 'connected'
            const lastCount = conn?.config?.['last_feed_item_count'] as
              | number
              | undefined
            return (
              <Card key={surface} title={meta.name}>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    {statusBadge(conn?.status ?? 'disconnected')}
                    {conn?.external_account_id && (
                      <span className="font-mono text-[12px] text-[var(--cc-muted)] truncate">
                        {conn.external_account_id}
                      </span>
                    )}
                  </div>
                  <p className="text-[13px] text-[var(--cc-muted)] leading-relaxed">
                    {meta.blurb}
                  </p>

                  {conn && (
                    <div className="rounded-lg bg-white/[0.02] border border-white/[0.06] px-3 py-2.5 text-[12px] text-[var(--cc-muted)] space-y-1.5">
                      <div className="flex justify-between gap-3">
                        <span>Last feed sync</span>
                        <span className="font-mono text-[var(--cc-body)]">
                          {fmtTime(conn.last_sync_at)}
                        </span>
                      </div>
                      {typeof lastCount === 'number' && (
                        <div className="flex justify-between gap-3">
                          <span>Products in last feed</span>
                          <span className="font-mono text-[var(--cc-body)]">{lastCount}</span>
                        </div>
                      )}
                      {conn.status === 'error' &&
                        typeof conn.config?.['last_error'] === 'string' && (
                          <div className="text-red-300 break-words">
                            {String(conn.config['last_error'])}
                          </div>
                        )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    {!connected && (
                      <Btn
                        variant="primary"
                        loading={busy === `connect:${surface}`}
                        onClick={() => openConnect(surface)}
                      >
                        Connect
                      </Btn>
                    )}
                    {connected && conn && (
                      <>
                        <Btn
                          variant="green"
                          loading={busy === `feed:${conn.id}`}
                          onClick={() => submitFeed(conn)}
                        >
                          Submit feed now
                        </Btn>
                        <Btn
                          variant="danger"
                          loading={busy === `disc:${conn.id}`}
                          onClick={() => disconnect(conn)}
                        >
                          Disconnect
                        </Btn>
                      </>
                    )}
                    {conn && conn.status !== 'connected' && (
                      <Btn
                        variant="danger"
                        loading={busy === `disc:${conn.id}`}
                        onClick={() => disconnect(conn)}
                      >
                        Remove
                      </Btn>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {connectModal && (
        <Modal
          title={`Connect ${SURFACE_META[connectModal.surface].name}`}
          onClose={() => setConnectModal(null)}
        >
          <div className="space-y-4">
            <ol className="space-y-1.5 text-[13px] text-[var(--cc-muted)] list-decimal list-inside leading-relaxed">
              {connectModal.info.instructions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>

            {connectModal.info.authorize_url ? (
              <p className="text-[13px] text-[var(--cc-muted)]">
                You’ll be redirected to authorize CartCrft, then returned here.
              </p>
            ) : (
              <>
                <FormInput
                  label={SURFACE_META[connectModal.surface].accountLabel}
                  value={accountId}
                  onChange={setAccountId}
                  placeholder={
                    SURFACE_META[connectModal.surface].accountPlaceholder
                  }
                />
                <FormInput
                  label="API token / credential"
                  value={credential}
                  onChange={setCredential}
                  placeholder={
                    connectModal.info.mock_available
                      ? 'optional in dev — leave blank to use the mock connector'
                      : 'paste your surface API token'
                  }
                  type="password"
                />
              </>
            )}

            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2.5">
              <p className="text-[13px] font-medium text-amber-300 mb-1.5">
                Required to go live
              </p>
              <ul className="text-[12px] text-[var(--cc-muted)] space-y-1 list-disc list-inside leading-relaxed">
                {connectModal.info.required_to_go_live.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Btn variant="secondary" onClick={() => setConnectModal(null)}>
                Cancel
              </Btn>
              <Btn
                variant="primary"
                loading={busy === 'save'}
                onClick={submitConnect}
              >
                {connectModal.info.authorize_url ? 'Authorize' : 'Connect'}
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
