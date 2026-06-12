import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, PageHeader, EmptyState, Spinner, TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

interface FulfillmentOrder {
  id: string; order_id?: string; status: string; warehouse_id?: string;
  tracking_number?: string; created_at: string; [k: string]: unknown
}

const FO_STATUS: Record<string, { color: 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'; label: string }> = {
  pending: { color: 'amber', label: 'Pending' },
  in_progress: { color: 'blue', label: 'In Progress' },
  shipped: { color: 'violet', label: 'Shipped' },
  delivered: { color: 'emerald', label: 'Delivered' },
  cancelled: { color: 'red', label: 'Cancelled' },
  on_hold: { color: 'slate', label: 'On Hold' },
}

export default function FulfillmentOrders() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [orders, setOrders] = useState<FulfillmentOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    try {
      const res = await getSdk().request<{ fulfillment_orders: FulfillmentOrder[] }>(
        `/commerce/stores/${activeStore.id}/fulfillment-orders`
      )
      setOrders((res as { fulfillment_orders?: FulfillmentOrder[] }).fulfillment_orders ?? [])
    } catch { setOrders([]) }
    setLoading(false)
  }, [activeStore])

  useEffect(() => { void load() }, [load])

  const updateStatus = async (foId: string, status: string) => {
    if (!activeStore) return
    setActing(foId)
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/fulfillment-orders/${foId}`, {
        method: 'PUT', body: { status },
      })
      toast(`Status updated to ${status}`, 'success')
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Update failed', 'error') }
    finally { setActing(null) }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader title="Fulfillment Orders" description="Track and update fulfillment status for each warehouse" />

      {orders.length === 0 ? (
        <EmptyState title="No fulfillment orders" description="Fulfillment orders are created when customers place orders" />
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>ID</Th><Th>Order</Th><Th>Status</Th><Th>Tracking</Th><Th>Created</Th><Th></Th>
            </TableHead>
            <tbody>
              {orders.map(fo => {
                const st = FO_STATUS[fo.status] ?? { color: 'slate' as const, label: fo.status }
                return (
                  <tr key={fo.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                    <Td className="font-mono text-xs text-slate-400">{fo.id.slice(0, 8)}</Td>
                    <Td className="font-mono text-xs text-slate-400">{String(fo.order_id ?? '—').slice(0, 8)}</Td>
                    <Td><Badge color={st.color}>{st.label}</Badge></Td>
                    <Td className="text-slate-400 text-xs font-mono">{fo.tracking_number ?? '—'}</Td>
                    <Td className="text-slate-500 text-xs">{new Date(fo.created_at).toLocaleDateString()}</Td>
                    <Td>
                      <div className="flex gap-1">
                        {fo.status === 'pending' && (
                          <Btn variant="primary" loading={acting === fo.id} onClick={() => void updateStatus(fo.id, 'in_progress')}>Start</Btn>
                        )}
                        {fo.status === 'in_progress' && (
                          <Btn variant="green" loading={acting === fo.id} onClick={() => void updateStatus(fo.id, 'shipped')}>Mark Shipped</Btn>
                        )}
                        {fo.status === 'shipped' && (
                          <Btn variant="green" loading={acting === fo.id} onClick={() => void updateStatus(fo.id, 'delivered')}>Delivered</Btn>
                        )}
                        {!['cancelled', 'delivered'].includes(fo.status) && (
                          <Btn variant="danger" loading={acting === fo.id} onClick={() => void updateStatus(fo.id, 'cancelled')}>Cancel</Btn>
                        )}
                      </div>
                    </Td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableContainer>
      )}
    </div>
  )
}
