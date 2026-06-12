import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, PageHeader, EmptyState, Spinner, Modal, TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

interface WebhookLogEntry {
  id: string; provider?: string; event_type?: string; status: string;
  created_at: string; request_body?: unknown; response_body?: unknown;
  [k: string]: unknown
}

function LogDetailModal({ entry, onClose }: { entry: WebhookLogEntry; onClose: () => void }) {
  return (
    <Modal title={`Webhook — ${entry.event_type ?? entry.id.slice(0, 8)}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-slate-500 mb-1">Provider</p>
            <p className="text-white">{entry.provider ?? '—'}</p>
          </div>
          <div>
            <p className="text-slate-500 mb-1">Event</p>
            <p className="text-white">{entry.event_type ?? '—'}</p>
          </div>
          <div>
            <p className="text-slate-500 mb-1">Status</p>
            <Badge color={entry.status === 'processed' ? 'emerald' : entry.status === 'failed' ? 'red' : 'amber'}>
              {entry.status}
            </Badge>
          </div>
          <div>
            <p className="text-slate-500 mb-1">Received</p>
            <p className="text-slate-300">{new Date(entry.created_at).toLocaleString()}</p>
          </div>
        </div>
        {entry.request_body != null ? (
          <div>
            <p className="text-xs font-medium text-slate-400 mb-1.5">Payload</p>
            <pre className="text-xs text-slate-300 bg-black/30 rounded-lg p-3 overflow-auto max-h-48 border border-white/[0.06]">
              {JSON.stringify(entry.request_body, null, 2)}
            </pre>
          </div>
        ) : null}
        {entry.response_body != null ? (
          <div>
            <p className="text-xs font-medium text-slate-400 mb-1.5">Response</p>
            <pre className="text-xs text-slate-300 bg-black/30 rounded-lg p-3 overflow-auto max-h-32 border border-white/[0.06]">
              {JSON.stringify(entry.response_body, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

export default function WebhookLog() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [logs, setLogs] = useState<WebhookLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<WebhookLogEntry | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    try {
      const res = await getSdk().request<{ logs: WebhookLogEntry[] }>(
        `/commerce/stores/${activeStore.id}/webhook-logs/payment`
      )
      setLogs((res as { logs?: WebhookLogEntry[] }).logs ?? [])
    } catch { setLogs([]) }
    setLoading(false)
  }, [activeStore])

  useEffect(() => { void load() }, [load])

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Webhook Log"
        description="Inbound payment webhook events"
        actions={<Btn variant="secondary" onClick={() => void load()}>Refresh</Btn>}
      />

      {logs.length === 0 ? (
        <EmptyState title="No webhook events" description="Payment webhook events will appear here once your payment provider starts sending them" />
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>Provider</Th><Th>Event</Th><Th>Status</Th><Th>Received</Th><Th></Th>
            </TableHead>
            <tbody>
              {logs.map((log, i) => (
                <tr key={String(log.id ?? i)} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                  <Td><Badge color="blue">{log.provider ?? '—'}</Badge></Td>
                  <Td className="text-slate-300 text-xs font-mono">{log.event_type ?? '—'}</Td>
                  <Td>
                    <Badge color={log.status === 'processed' ? 'emerald' : log.status === 'failed' ? 'red' : 'amber'}>
                      {log.status}
                    </Badge>
                  </Td>
                  <Td className="text-slate-500 text-xs">
                    {new Date(log.created_at).toLocaleString()}
                  </Td>
                  <Td><Btn variant="secondary" onClick={() => setSelected(log)}>View</Btn></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}

      {selected && <LogDetailModal entry={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
