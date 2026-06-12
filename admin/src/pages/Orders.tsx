import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Badge, Btn, Card, FormInput, PageHeader, EmptyState, Spinner, TableContainer, TableHead, Th, Td } from '../components/ui/index'
import { FINANCIAL_STATUS_MAP, FULFILLMENT_MAP, ORDER_STATUS_MAP, statusBadgeProps } from '../lib/statusMaps'
import type { Order, Payment } from '@cartcrft/sdk'

interface Shipment {
  id: string
  carrier?: string
  tracking_number?: string
  tracking_url?: string
  status?: string
  [key: string]: unknown
}

interface OrderEvent {
  id?: string
  type?: string
  message?: string
  created_at?: string
  [key: string]: unknown
}

function OrderDetail({ storeId, orderId, onBack }: {
  storeId: string
  orderId: string
  onBack: () => void
}) {
  const { toast } = useToast()
  const [order, setOrder] = useState<Order | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [events, setEvents] = useState<OrderEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [shipForm, setShipForm] = useState({ carrier: '', tracking_number: '', tracking_url: '' })
  const [addingShipment, setAddingShipment] = useState(false)
  const [showShipForm, setShowShipForm] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const loadAll = useCallback(async () => {
    const sdk = getSdk()
    setLoading(true)
    try {
      const [orderRes, paymentsRes, shipmentsRes, eventsRes] = await Promise.allSettled([
        sdk.orders.get(storeId, orderId),
        sdk.payments.list(storeId, orderId),
        sdk.shipping.listShipments(storeId, { order_id: orderId }),
        sdk.orders.listEvents(storeId, orderId),
      ])
      if (orderRes.status === 'fulfilled') setOrder(orderRes.value.order)
      if (paymentsRes.status === 'fulfilled') setPayments(paymentsRes.value.payments ?? [])
      if (shipmentsRes.status === 'fulfilled') setShipments((shipmentsRes.value.shipments ?? []) as Shipment[])
      if (eventsRes.status === 'fulfilled') setEvents((eventsRes.value.events ?? []) as OrderEvent[])
    } finally {
      setLoading(false)
    }
  }, [storeId, orderId])

  useEffect(() => { void loadAll() }, [loadAll])

  const handleAddNote = async () => {
    if (!note.trim()) return
    setAddingNote(true)
    try {
      const sdk = getSdk()
      await sdk.orders.addNote(storeId, orderId, { note: note.trim() })
      setNote('')
      toast('Note added', 'success')
      void loadAll()
    } catch { toast('Failed to add note', 'error') } finally { setAddingNote(false) }
  }

  const handleAddShipment = async () => {
    if (!shipForm.tracking_number.trim()) { toast('Tracking number required', 'error'); return }
    setAddingShipment(true)
    try {
      const sdk = getSdk()
      await sdk.request(`/commerce/stores/${storeId}/orders/${orderId}/shipments`, {
        method: 'POST',
        body: { carrier: shipForm.carrier || undefined, tracking_number: shipForm.tracking_number, tracking_url: shipForm.tracking_url || undefined },
      })
      setShipForm({ carrier: '', tracking_number: '', tracking_url: '' })
      setShowShipForm(false)
      toast('Shipment added', 'success')
      void loadAll()
    } catch { toast('Failed to add shipment', 'error') } finally { setAddingShipment(false) }
  }

  const handleCancel = async () => {
    if (!confirm('Cancel this order?')) return
    setCancelling(true)
    try {
      const sdk = getSdk()
      await sdk.orders.cancel(storeId, orderId)
      toast('Order cancelled', 'success')
      void loadAll()
    } catch { toast('Failed to cancel order', 'error') } finally { setCancelling(false) }
  }

  const handleCapture = async (paymentId: string) => {
    try {
      const sdk = getSdk()
      await sdk.payments.capture(storeId, orderId, paymentId)
      toast('Payment captured', 'success')
      void loadAll()
    } catch { toast('Capture failed', 'error') }
  }

  const handleRefund = async (paymentId: string, amount: string) => {
    try {
      const sdk = getSdk()
      await sdk.payments.refund(storeId, orderId, paymentId, { amount })
      toast('Refund initiated', 'success')
      void loadAll()
    } catch { toast('Refund failed', 'error') }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (!order) return <div className="text-slate-500 py-8 text-center">Order not found</div>

  const finStatus = statusBadgeProps(order.financial_status, FINANCIAL_STATUS_MAP)
  const fulStatus = statusBadgeProps(order.fulfillment_status, FULFILLMENT_MAP)
  const ordStatus = statusBadgeProps(order.status, ORDER_STATUS_MAP)

  const lines = (order.lines as unknown[] | undefined) ?? []
  const subtotal = (order.subtotal as string | undefined) ?? '0'
  const shippingTotal = (order.shipping_total as string | undefined) ?? '0'
  const taxTotal = (order.tax_total as string | undefined) ?? '0'
  const discountTotal = (order.discount_total as string | undefined) ?? '0'
  const shippingAddress = order.shipping_address as Record<string, string | undefined> | undefined

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-xs text-slate-500 hover:text-white transition">&#8592; Orders</button>
        <span className="text-slate-700">/</span>
        <span className="text-sm font-mono text-violet-400">#{order.order_number}</span>
        <Badge color={ordStatus.color}>{ordStatus.label}</Badge>
        <Badge color={finStatus.color}>{finStatus.label}</Badge>
        <Badge color={fulStatus.color}>{fulStatus.label}</Badge>
        <div className="ml-auto">
          {order.status !== 'cancelled' && (
            <Btn variant="danger" loading={cancelling} onClick={handleCancel}>Cancel Order</Btn>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Line items + totals */}
        <div className="col-span-2 space-y-4">
          <Card title="Line Items">
            {lines.length === 0 ? (
              <p className="text-xs text-slate-500">No line items</p>
            ) : (
              <div className="space-y-2">
                {lines.map((line, i) => {
                  const l = line as Record<string, unknown>
                  return (
                    <div key={String(l['id'] ?? i)} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
                      <div>
                        <span className="text-sm text-white">{String(l['title'] ?? l['variant_id'] ?? 'Item')}</span>
                        <span className="ml-2 text-xs text-slate-500">× {String(l['quantity'] ?? 1)}</span>
                      </div>
                      <span className="text-sm font-mono text-slate-300">{order.currency} {String(l['line_total'] ?? l['unit_price'] ?? '0')}</span>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="mt-4 pt-3 border-t border-white/[0.06] space-y-1.5">
              <div className="flex justify-between text-xs text-slate-400">
                <span>Subtotal</span><span className="font-mono">{order.currency} {subtotal}</span>
              </div>
              <div className="flex justify-between text-xs text-slate-400">
                <span>Shipping</span><span className="font-mono">{order.currency} {shippingTotal}</span>
              </div>
              <div className="flex justify-between text-xs text-slate-400">
                <span>Tax</span><span className="font-mono">{order.currency} {taxTotal}</span>
              </div>
              {Number(discountTotal) > 0 && (
                <div className="flex justify-between text-xs text-emerald-400">
                  <span>Discount</span><span className="font-mono">- {order.currency} {discountTotal}</span>
                </div>
              )}
              <div className="flex justify-between text-sm font-semibold text-white pt-1 border-t border-white/[0.06]">
                <span>Total</span><span className="font-mono">{order.currency} {order.total}</span>
              </div>
            </div>
          </Card>

          {/* Payments */}
          <Card title="Payments">
            {payments.length === 0 ? (
              <p className="text-xs text-slate-500">No payments recorded</p>
            ) : (
              <div className="space-y-2">
                {payments.map(p => (
                  <div key={p.id} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
                    <div>
                      <span className="text-xs font-medium text-white">{p.provider}</span>
                      <Badge color={p.status === 'captured' ? 'emerald' : p.status === 'pending' ? 'amber' : 'slate'} >{p.status}</Badge>
                      <span className="ml-2 text-xs text-slate-500">{new Date(p.created_at).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-slate-300">{p.currency} {p.amount}</span>
                      {p.status === 'authorized' && (
                        <Btn variant="green" onClick={() => handleCapture(p.id)}>Capture</Btn>
                      )}
                      {p.status === 'captured' && (
                        <Btn variant="danger" onClick={() => handleRefund(p.id, p.amount)}>Refund</Btn>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Shipments */}
          <Card title="Shipments">
            {shipments.length === 0 && !showShipForm ? (
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500">No shipments yet</p>
                <Btn variant="secondary" onClick={() => setShowShipForm(true)}>+ Add Shipment</Btn>
              </div>
            ) : (
              <div className="space-y-3">
                {shipments.map((s, i) => (
                  <div key={s.id ?? i} className="rounded-lg bg-white/[0.02] border border-white/[0.06] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-white">{s.carrier ?? 'Carrier'}</span>
                      <Badge color="blue">{s.status ?? 'shipped'}</Badge>
                    </div>
                    <p className="text-xs font-mono text-slate-400 mt-1">{s.tracking_number}</p>
                    {s.tracking_url && (
                      <a href={s.tracking_url} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-violet-400 hover:text-violet-300 mt-1 inline-block">Track &#x2197;</a>
                    )}
                  </div>
                ))}
                {!showShipForm && <Btn variant="secondary" onClick={() => setShowShipForm(true)}>+ Add Shipment</Btn>}
              </div>
            )}
            {showShipForm && (
              <div className="mt-3 p-3 rounded-lg border border-white/[0.08] bg-white/[0.02] space-y-3">
                <FormInput label="Carrier" value={shipForm.carrier} onChange={v => setShipForm(f => ({ ...f, carrier: v }))} placeholder="FedEx, UPS..." />
                <FormInput label="Tracking Number *" value={shipForm.tracking_number} onChange={v => setShipForm(f => ({ ...f, tracking_number: v }))} placeholder="1Z..." />
                <FormInput label="Tracking URL" value={shipForm.tracking_url} onChange={v => setShipForm(f => ({ ...f, tracking_url: v }))} placeholder="https://..." />
                <div className="flex gap-2">
                  <Btn onClick={handleAddShipment} loading={addingShipment}>Add Shipment</Btn>
                  <Btn variant="secondary" onClick={() => setShowShipForm(false)}>Cancel</Btn>
                </div>
              </div>
            )}
          </Card>

          {/* Notes */}
          <Card title="Notes & Timeline">
            {events.length > 0 && (
              <div className="space-y-2 mb-4">
                {events.slice(0, 10).map((ev, i) => (
                  <div key={String(ev.id ?? i)} className="text-xs text-slate-400 py-1 border-b border-white/[0.04] last:border-0">
                    <span className="text-slate-300">{String(ev.message ?? ev.type ?? 'Event')}</span>
                    {ev.created_at && <span className="ml-2 text-slate-600">{new Date(String(ev.created_at)).toLocaleString()}</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Add a note..."
                className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-white/20 focus:outline-none"
              />
              <Btn onClick={handleAddNote} loading={addingNote} variant="secondary">Add Note</Btn>
            </div>
          </Card>
        </div>

        {/* Sidebar: customer + address */}
        <div className="space-y-4">
          <Card title="Customer">
            <div className="space-y-2">
              <p className="text-sm text-white">{(order.email as string | undefined) ?? 'Guest'}</p>
              {!!order.customer_id && (
                <p className="text-xs text-slate-500">ID: {String(order.customer_id)}</p>
              )}
            </div>
          </Card>
          {shippingAddress && (
            <Card title="Shipping Address">
              <div className="space-y-1 text-xs text-slate-400">
                {shippingAddress['name'] && <p className="text-white text-sm">{shippingAddress['name']}</p>}
                {shippingAddress['address1'] && <p>{shippingAddress['address1']}</p>}
                {shippingAddress['address2'] && <p>{shippingAddress['address2']}</p>}
                <p>{[shippingAddress['city'], shippingAddress['province_code'], shippingAddress['zip']].filter(Boolean).join(', ')}</p>
                {shippingAddress['country_code'] && <p>{shippingAddress['country_code']}</p>}
                {shippingAddress['phone'] && <p>{shippingAddress['phone']}</p>}
              </div>
            </Card>
          )}
          <Card title="Order Info">
            <div className="space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between"><span>Created</span><span>{new Date(order.created_at).toLocaleString()}</span></div>
              <div className="flex justify-between"><span>Updated</span><span>{new Date(order.updated_at).toLocaleString()}</span></div>
              {order.test && <Badge color="amber">Test Order</Badge>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

export default function Orders() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    void sdk.orders.list(activeStore.id, { limit: 50 })
      .then(res => { setOrders(res.orders ?? []); setTotal(res.total ?? 0) })
      .catch(() => toast('Failed to load orders', 'error'))
      .finally(() => setLoading(false))
  }, [activeStore, toast])

  useEffect(() => { load() }, [load])

  if (selectedOrderId && activeStore) {
    return (
      <OrderDetail
        storeId={activeStore.id}
        orderId={selectedOrderId}
        onBack={() => setSelectedOrderId(null)}
      />
    )
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orders"
        description={`${total} total order${total !== 1 ? 's' : ''}`}
      />

      {orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Orders will appear here once customers start purchasing"
        />
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>Order</Th>
              <Th>Date</Th>
              <Th>Customer</Th>
              <Th>Status</Th>
              <Th>Payment</Th>
              <Th>Fulfillment</Th>
              <Th className="text-right">Total</Th>
            </TableHead>
            <tbody>
              {orders.map(order => {
                const fin = statusBadgeProps(order.financial_status, FINANCIAL_STATUS_MAP)
                const ful = statusBadgeProps(order.fulfillment_status, FULFILLMENT_MAP)
                const ord = statusBadgeProps(order.status, ORDER_STATUS_MAP)
                return (
                  <tr
                    key={order.id}
                    className="border-t border-white/[0.04] hover:bg-white/[0.02] transition cursor-pointer"
                    onClick={() => setSelectedOrderId(order.id)}
                  >
                    <Td><span className="font-mono text-violet-400">#{order.order_number}</span></Td>
                    <Td className="text-slate-400">{new Date(order.created_at).toLocaleDateString()}</Td>
                    <Td className="text-slate-300">{(order.email as string | undefined) ?? 'Guest'}</Td>
                    <Td><Badge color={ord.color}>{ord.label}</Badge></Td>
                    <Td><Badge color={fin.color}>{fin.label}</Badge></Td>
                    <Td><Badge color={ful.color}>{ful.label}</Badge></Td>
                    <Td className="text-right font-mono font-medium text-white">{order.currency} {Number(order.total).toFixed(2)}</Td>
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
