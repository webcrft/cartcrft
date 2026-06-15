import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Badge, Btn, Card, FormInput, PageHeader, EmptyState,
  Spinner, TableContainer, TableHead, Th, Td, Pagination, InfoRow,
} from '../components/ui/index'
import { FINANCIAL_STATUS_MAP, FULFILLMENT_MAP, ORDER_STATUS_MAP, statusBadgeProps } from '../lib/statusMaps'
import { ShoppingCart, ChevronLeft } from 'lucide-react'
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
  if (!order) return <p className="text-[var(--cc-muted)] py-8 text-center text-sm">Order not found</p>

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
    <div className="space-y-5">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs text-[var(--cc-muted)] hover:text-[var(--cc-text)] transition"
        >
          <ChevronLeft size={14} />
          Orders
        </button>
        <span className="text-[var(--cc-subtle)] text-sm">/</span>
        <span className="font-mono text-sm text-[var(--cc-lime)] font-medium">#{order.order_number}</span>
        <Badge color={ordStatus.color}>{ordStatus.label}</Badge>
        <Badge color={finStatus.color}>{finStatus.label}</Badge>
        <Badge color={fulStatus.color}>{fulStatus.label}</Badge>
        <div className="ml-auto">
          {order.status !== 'cancelled' && (
            <Btn size="sm" variant="danger" loading={cancelling} onClick={handleCancel}>Cancel Order</Btn>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Left: line items + payments + shipments + notes */}
        <div className="col-span-2 space-y-4">
          <Card title="Line Items">
            {lines.length === 0 ? (
              <p className="text-xs text-[var(--cc-subtle)]">No line items</p>
            ) : (
              <div className="space-y-0">
                {lines.map((line, i) => {
                  const l = line as Record<string, unknown>
                  return (
                    <div
                      key={String(l['id'] ?? i)}
                      className="flex items-center justify-between py-2.5"
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    >
                      <div>
                        <span className="text-sm text-[var(--cc-text)]">{String(l['title'] ?? l['variant_id'] ?? 'Item')}</span>
                        <span className="ml-2 text-xs text-[var(--cc-subtle)]">× {String(l['quantity'] ?? 1)}</span>
                      </div>
                      <span className="text-sm font-mono text-[var(--cc-body)]">
                        {order.currency} {String(l['line_total'] ?? l['unit_price'] ?? '0')}
                      </span>
                    </div>
                  )
                })}
                <div className="pt-3 space-y-1.5 mt-1">
                  <InfoRow label="Subtotal">{order.currency} {subtotal}</InfoRow>
                  <InfoRow label="Shipping">{order.currency} {shippingTotal}</InfoRow>
                  <InfoRow label="Tax">{order.currency} {taxTotal}</InfoRow>
                  {Number(discountTotal) > 0 && (
                    <div className="flex items-baseline justify-between gap-3 text-sm py-0.5">
                      <span className="text-[var(--cc-muted)] text-xs">Discount</span>
                      <span className="text-emerald-400 text-right">− {order.currency} {discountTotal}</span>
                    </div>
                  )}
                  <div
                    className="flex items-baseline justify-between gap-3 pt-2 mt-1"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}
                  >
                    <span className="text-sm font-semibold text-[var(--cc-text)]">Total</span>
                    <span className="font-mono font-semibold text-[var(--cc-text)]">{order.currency} {order.total}</span>
                  </div>
                </div>
              </div>
            )}
          </Card>

          {/* Payments */}
          <Card title="Payments">
            {payments.length === 0 ? (
              <p className="text-xs text-[var(--cc-subtle)]">No payments recorded</p>
            ) : (
              <div className="space-y-0">
                {payments.map(p => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between py-2.5"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-[var(--cc-text)]">{p.provider}</span>
                      <Badge color={p.status === 'captured' ? 'emerald' : p.status === 'pending' ? 'amber' : 'slate'}>
                        {p.status}
                      </Badge>
                      <span className="text-[11px] text-[var(--cc-subtle)]">
                        {new Date(p.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-sm font-mono text-[var(--cc-body)]">{p.currency} {p.amount}</span>
                      {p.status === 'authorized' && (
                        <Btn size="sm" variant="green" onClick={() => handleCapture(p.id)}>Capture</Btn>
                      )}
                      {p.status === 'captured' && (
                        <Btn size="sm" variant="danger" onClick={() => handleRefund(p.id, p.amount)}>Refund</Btn>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Shipments */}
          <Card
            title="Shipments"
            actions={!showShipForm ? (
              <Btn size="sm" variant="secondary" onClick={() => setShowShipForm(true)}>+ Add Shipment</Btn>
            ) : undefined}
          >
            {shipments.length === 0 && !showShipForm && (
              <p className="text-xs text-[var(--cc-subtle)]">No shipments yet</p>
            )}
            {shipments.length > 0 && (
              <div className="space-y-2 mb-3">
                {shipments.map((s, i) => (
                  <div
                    key={s.id ?? i}
                    className="rounded-lg p-3 space-y-1"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-[var(--cc-text)]">{s.carrier ?? 'Carrier'}</span>
                      <Badge color="blue">{s.status ?? 'shipped'}</Badge>
                    </div>
                    <p className="text-xs font-mono text-[var(--cc-muted)]">{s.tracking_number}</p>
                    {s.tracking_url && (
                      <a
                        href={s.tracking_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[var(--cc-lime)] hover:underline"
                      >
                        Track shipment ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
            {showShipForm && (
              <div
                className="rounded-lg p-4 space-y-3"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}
              >
                <FormInput label="Carrier" value={shipForm.carrier} onChange={v => setShipForm(f => ({ ...f, carrier: v }))} placeholder="FedEx, UPS…" />
                <FormInput label="Tracking Number" required value={shipForm.tracking_number} onChange={v => setShipForm(f => ({ ...f, tracking_number: v }))} placeholder="1Z999AA1012345678" />
                <FormInput label="Tracking URL" value={shipForm.tracking_url} onChange={v => setShipForm(f => ({ ...f, tracking_url: v }))} placeholder="https://…" />
                <div className="flex gap-2">
                  <Btn size="sm" onClick={handleAddShipment} loading={addingShipment}>Add Shipment</Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setShowShipForm(false)}>Cancel</Btn>
                </div>
              </div>
            )}
          </Card>

          {/* Notes & Timeline */}
          <Card title="Notes & Timeline">
            {events.length > 0 && (
              <div className="space-y-0 mb-4">
                {events.slice(0, 10).map((ev, i) => (
                  <div
                    key={String(ev.id ?? i)}
                    className="py-2 text-xs"
                    style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                  >
                    <span className="text-[var(--cc-body)]">{String(ev.message ?? ev.type ?? 'Event')}</span>
                    {ev.created_at && (
                      <span className="ml-2 text-[var(--cc-subtle)]">{new Date(String(ev.created_at)).toLocaleString()}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Add a note…"
                className="flex-1 rounded-lg px-3 py-2 text-xs text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--cc-lime)]/20 transition"
                style={{ background: 'var(--cc-bg-sunken)', border: '1px solid rgba(255,255,255,0.08)' }}
              />
              <Btn size="sm" onClick={handleAddNote} loading={addingNote} variant="secondary">Add Note</Btn>
            </div>
          </Card>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          <Card title="Customer">
            <div className="space-y-1.5">
              <p className="text-sm text-[var(--cc-text)]">{(order.email as string | undefined) ?? 'Guest'}</p>
              {!!order.customer_id && (
                <p className="text-[11px] font-mono text-[var(--cc-subtle)]">ID: {String(order.customer_id)}</p>
              )}
            </div>
          </Card>

          {shippingAddress && (
            <Card title="Shipping Address">
              <div className="space-y-0.5 text-xs text-[var(--cc-muted)]">
                {shippingAddress['name'] && <p className="text-[var(--cc-body)] font-medium mb-1">{shippingAddress['name']}</p>}
                {shippingAddress['address1'] && <p>{shippingAddress['address1']}</p>}
                {shippingAddress['address2'] && <p>{shippingAddress['address2']}</p>}
                <p>{[shippingAddress['city'], shippingAddress['province_code'], shippingAddress['zip']].filter(Boolean).join(', ')}</p>
                {shippingAddress['country_code'] && <p>{shippingAddress['country_code']}</p>}
                {shippingAddress['phone'] && <p className="mt-1">{shippingAddress['phone']}</p>}
              </div>
            </Card>
          )}

          <Card title="Order Info">
            <div className="space-y-1">
              <InfoRow label="Created">{new Date(order.created_at).toLocaleString()}</InfoRow>
              <InfoRow label="Updated">{new Date(order.updated_at).toLocaleString()}</InfoRow>
              {order.test && (
                <div className="mt-2"><Badge color="amber">Test Order</Badge></div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

const PAGE_SIZE = 25

export default function Orders() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)

  const load = useCallback((off: number) => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    void sdk.orders.list(activeStore.id, { limit: PAGE_SIZE, offset: off })
      .then(res => { setOrders(res.orders ?? []); setTotal(res.total ?? 0) })
      .catch(() => toast('Failed to load orders', 'error'))
      .finally(() => setLoading(false))
  }, [activeStore, toast])

  useEffect(() => { setOffset(0); load(0) }, [load])

  if (selectedOrderId && activeStore) {
    return (
      <OrderDetail
        storeId={activeStore.id}
        orderId={selectedOrderId}
        onBack={() => setSelectedOrderId(null)}
      />
    )
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  const goToPage = (newOffset: number) => {
    setOffset(newOffset)
    load(newOffset)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Orders"
        description={loading ? undefined : `${total.toLocaleString()} order${total !== 1 ? 's' : ''}`}
      />

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : orders.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart size={22} />}
          title="No orders yet"
          description="Orders will appear here once customers start purchasing."
        />
      ) : (
        <>
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead>
                <Th>Order</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>Payment</Th>
                <Th>Fulfillment</Th>
                <Th align="right">Total</Th>
              </TableHead>
              <tbody>
                {orders.map(order => {
                  const fin = statusBadgeProps(order.financial_status, FINANCIAL_STATUS_MAP)
                  const ful = statusBadgeProps(order.fulfillment_status, FULFILLMENT_MAP)
                  const ord = statusBadgeProps(order.status, ORDER_STATUS_MAP)
                  return (
                    <tr
                      key={order.id}
                      className="cursor-pointer transition-colors"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                      onClick={() => setSelectedOrderId(order.id)}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.02)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}
                    >
                      <Td>
                        <span className="font-mono text-[var(--cc-lime)] font-medium">#{order.order_number}</span>
                      </Td>
                      <Td muted>{new Date(order.created_at).toLocaleDateString()}</Td>
                      <Td className="text-[var(--cc-body)]">{(order.email as string | undefined) ?? 'Guest'}</Td>
                      <Td><Badge color={ord.color}>{ord.label}</Badge></Td>
                      <Td><Badge color={fin.color}>{fin.label}</Badge></Td>
                      <Td><Badge color={ful.color}>{ful.label}</Badge></Td>
                      <Td align="right" className="font-mono font-medium text-[var(--cc-text)]">
                        {order.currency} {Number(order.total).toFixed(2)}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableContainer>

          {totalPages > 1 && (
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              total={total}
              unit="orders"
              onPrev={() => goToPage(offset - PAGE_SIZE)}
              onNext={() => goToPage(offset + PAGE_SIZE)}
            />
          )}
        </>
      )}
    </div>
  )
}
