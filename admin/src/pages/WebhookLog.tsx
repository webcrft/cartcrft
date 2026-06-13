import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk, guardedCall } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, PageHeader, EmptyState, LoadError, Spinner, Modal, TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

/**
 * Row shape returned by GET /commerce/stores/:storeId/webhook-log
 * (notification_delivery_log table via getWebhookLog() in notifications/service.ts)
 */
interface WebhookLogEntry {
  id: string
  provider_id?: string | null
  event?: string | null
  payload?: unknown
  attempt_number?: number | null
  status_code?: number | null
  response_body?: unknown
  error_message?: string | null
  duration_ms?: number | null
  delivered_at?: string | null
  [k: string]: unknown
}

function statusColor(code: number | null | undefined): 'emerald' | 'red' | 'amber' {
  if (!code) return 'amber'
  if (code >= 200 && code < 300) return 'emerald'
  return 'red'
}

function LogDetailModal({ entry, onClose }: { entry: WebhookLogEntry; onClose: () => void }) {
  return (
    <Modal title={`Webhook — ${entry.event ?? entry.id.slice(0, 8)}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-slate-500 mb-1">Provider ID</p>
            <p className="text-white font-mono text-[11px]">{entry.provider_id ?? '—'}</p>
          </div>
          <div>
            <p className="text-slate-500 mb-1">Event</p>
            <p className="text-white">{entry.event ?? '—'}</p>
          </div>
          <div>
            <p className="text-slate-500 mb-1">Status Code</p>
            <Badge color={statusColor(entry.status_code)}>
              {entry.status_code != null ? String(entry.status_code) : 'pending'}
            </Badge>
          </div>
          <div>
            <p className="text-slate-500 mb-1">Attempt</p>
            <p className="text-slate-300">{entry.attempt_number ?? 1}</p>
          </div>
          <div>
            <p className="text-slate-500 mb-1">Duration</p>
            <p className="text-slate-300">{entry.duration_ms != null ? `${entry.duration_ms} ms` : '—'}</p>
          </div>
          <div>
            <p className="text-slate-500 mb-1">Delivered At</p>
            <p className="text-slate-300">
              {entry.delivered_at ? new Date(entry.delivered_at).toLocaleString() : '—'}
            </p>
          </div>
        </div>
        {entry.error_message && (
          <div>
            <p className="text-xs font-medium text-red-400 mb-1.5">Error</p>
            <pre className="text-xs text-red-300 bg-black/30 rounded-lg p-3 overflow-auto max-h-32 border border-red-500/20">
              {entry.error_message}
            </pre>
          </div>
        )}
        {entry.payload != null && (
          <div>
            <p className="text-xs font-medium text-slate-400 mb-1.5">Payload</p>
            <pre className="text-xs text-slate-300 bg-black/30 rounded-lg p-3 overflow-auto max-h-48 border border-white/[0.06]">
              {JSON.stringify(entry.payload, null, 2)}
            </pre>
          </div>
        )}
        {entry.response_body != null && (
          <div>
            <p className="text-xs font-medium text-slate-400 mb-1.5">Response</p>
            <pre className="text-xs text-slate-300 bg-black/30 rounded-lg p-3 overflow-auto max-h-32 border border-white/[0.06]">
              {JSON.stringify(entry.response_body, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default function WebhookLog() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [logs, setLogs] = useState<WebhookLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<WebhookLogEntry | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    try {
      // Correct endpoint: GET /commerce/stores/:storeId/webhook-log
      // Response shape: { log: WebhookLogEntry[] }
      const res = await guardedCall(
        getSdk().request<{ log: WebhookLogEntry[] }>(
          `/commerce/stores/${activeStore.id}/webhook-log`
        )
      )
      setLogs(res.log ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load webhook log'
      setLoadError(msg)
      toast(msg, 'error')
      setLogs([])
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Webhook Log"
        description="Outbound notification webhook delivery log"
        actions={<Btn variant="secondary" onClick={() => void load()}>Refresh</Btn>}
      />

      {loadError && (
        <LoadError message={loadError} onRetry={() => void load()} />
      )}

      {!loadError && logs.length === 0 ? (
        <EmptyState
          title="No webhook events"
          description="Outbound notification webhook delivery events will appear here once your store sends them"
        />
      ) : !loadError ? (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>Event</Th><Th>Status</Th><Th>Attempt</Th><Th>Delivered At</Th><Th></Th>
            </TableHead>
            <tbody>
              {logs.map((log, i) => (
                <tr key={String(log.id ?? i)} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                  <Td className="text-slate-300 text-xs font-mono">{log.event ?? '—'}</Td>
                  <Td>
                    <Badge color={statusColor(log.status_code)}>
                      {log.status_code != null ? String(log.status_code) : 'pending'}
                    </Badge>
                  </Td>
                  <Td className="text-slate-500 text-xs">{log.attempt_number ?? 1}</Td>
                  <Td className="text-slate-500 text-xs">
                    {log.delivered_at ? new Date(log.delivered_at).toLocaleString() : '—'}
                  </Td>
                  <Td><Btn variant="secondary" onClick={() => setSelected(log)}>View</Btn></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      ) : null}

      {selected && <LogDetailModal entry={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
