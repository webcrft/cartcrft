import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, LoadError, PageHeader, EmptyState, Spinner, Modal, TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'
import { statusBadgeProps } from '../lib/statusMaps'

const RETURN_STATUS_MAP: Record<string, { color: 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'; label: string }> = {
  requested: { color: 'amber', label: 'Requested' },
  approved: { color: 'blue', label: 'Approved' },
  received: { color: 'violet', label: 'Received' },
  resolved: { color: 'emerald', label: 'Resolved' },
  rejected: { color: 'red', label: 'Rejected' },
  cancelled: { color: 'slate', label: 'Cancelled' },
}

interface ReturnItem {
  id: string
  order_id: string
  status: string
  return_type?: string
  created_at: string
  [k: string]: unknown
}

interface ReturnLine { id: string; variant_id?: string; quantity?: number; condition?: string; [k: string]: unknown }

function ReturnDetail({ storeId, returnId, onClose }: { storeId: string; returnId: string; onClose: () => void }) {
  const { toast } = useToast()
  const [ret, setRet] = useState<{ id: string; status: string; lines?: ReturnLine[]; [k: string]: unknown } | null>(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const sdk = getSdk()
        const res = await sdk.returns.get(storeId, returnId)
        setRet((res as { return?: typeof ret }).return ?? null)
      } catch { setRet(null) }
      setLoading(false)
    })()
  }, [storeId, returnId])

  const act = async (action: string) => {
    setActing(true)
    try {
      const sdk = getSdk()
      if (action === 'approve') await sdk.returns.approve(storeId, returnId)
      else if (action === 'receive') await sdk.returns.receive(storeId, returnId)
      else await sdk.request(`/commerce/stores/${storeId}/returns/${returnId}/${action}`, { method: 'POST', body: {} })
      toast(`Return ${action}d`, 'success')
      const res = await sdk.returns.get(storeId, returnId)
      setRet((res as { return?: typeof ret }).return ?? null)
    } catch (err) { toast(err instanceof Error ? err.message : `${action} failed`, 'error') }
    finally { setActing(false) }
  }

  if (loading) return <Modal title="Return Detail" onClose={onClose}><div className="flex justify-center py-8"><Spinner /></div></Modal>
  if (!ret) return <Modal title="Return Detail" onClose={onClose}><p className="text-slate-400 text-sm">Not found.</p></Modal>

  const { color, label } = statusBadgeProps(ret.status, RETURN_STATUS_MAP)
  const lines: ReturnLine[] = (ret.lines as ReturnLine[] | undefined) ?? []

  return (
    <Modal title={`Return — ${String(ret.id).slice(0, 8)}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Badge color={color}>{label}</Badge>
          <span className="text-xs text-slate-500">Order: {String(ret.order_id ?? '—').slice(0, 8)}</span>
          <span className="text-xs text-slate-500">Type: {String(ret.return_type ?? 'refund')}</span>
        </div>

        {lines.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-400 mb-2">Return Lines</p>
            <TableContainer>
              <table className="w-full text-sm">
                <TableHead><Th>Variant</Th><Th>Qty</Th><Th>Condition</Th></TableHead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={String(l.id ?? i)} className="border-t border-white/[0.04]">
                      <Td className="font-mono text-xs text-slate-400">{l.variant_id ?? '—'}</Td>
                      <Td className="text-white">{l.quantity ?? 1}</Td>
                      <Td><Badge color="slate">{l.condition ?? 'unknown'}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          </div>
        )}

        <div className="flex gap-2 flex-wrap pt-2 border-t border-white/[0.06]">
          {ret.status === 'requested' && (
            <>
              <Btn variant="green" loading={acting} onClick={() => void act('approve')}>Approve</Btn>
              <Btn variant="danger" loading={acting} onClick={() => void act('reject')}>Reject</Btn>
            </>
          )}
          {ret.status === 'approved' && (
            <Btn variant="primary" loading={acting} onClick={() => void act('receive')}>Mark Received</Btn>
          )}
          {ret.status === 'received' && (
            <Btn variant="green" loading={acting} onClick={() => void act('resolve')}>Resolve</Btn>
          )}
          <Btn variant="secondary" onClick={onClose}>Close</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function Returns() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [returns, setReturns] = useState<ReturnItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    try {
      const sdk = getSdk()
      const res = await sdk.returns.list(activeStore.id)
      setReturns((res as { returns?: ReturnItem[] }).returns ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load returns'
      setLoadError(msg)
      toast(msg, 'error')
      setReturns([])
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader title="Returns" description="RMA list — approve, receive, and resolve return requests" />

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      {!loadError && returns.length === 0 ? (
        <EmptyState title="No returns" description="Customer return requests will appear here" />
      ) : !loadError ? (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>ID</Th><Th>Order</Th><Th>Type</Th><Th>Status</Th><Th>Date</Th><Th></Th>
            </TableHead>
            <tbody>
              {returns.map(r => {
                const { color, label } = statusBadgeProps(r.status, RETURN_STATUS_MAP)
                return (
                  <tr key={r.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                    <Td className="font-mono text-xs text-slate-400">{r.id.slice(0, 8)}</Td>
                    <Td className="font-mono text-xs text-slate-400">{String(r.order_id ?? '—').slice(0, 8)}</Td>
                    <Td className="text-slate-300 capitalize">{r.return_type ?? 'refund'}</Td>
                    <Td><Badge color={color}>{label}</Badge></Td>
                    <Td className="text-slate-500 text-xs">{new Date(r.created_at).toLocaleDateString()}</Td>
                    <Td><Btn variant="secondary" onClick={() => setSelected(r.id)}>View</Btn></Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableContainer>
      ) : null}

      {selected && activeStore && (
        <ReturnDetail
          storeId={activeStore.id}
          returnId={selected}
          onClose={() => { setSelected(null); void load() }}
        />
      )}
    </div>
  )
}
