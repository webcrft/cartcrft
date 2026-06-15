import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Badge, Btn, Card, PageHeader, EmptyState, SearchInput,
  Spinner, TableContainer, TableHead, Th, Td, Pagination, InfoRow,
} from '../components/ui/index'
import { FINANCIAL_STATUS_MAP, statusBadgeProps } from '../lib/statusMaps'
import { Users, ChevronLeft } from 'lucide-react'
import type { Customer, Address, Order } from '@cartcrft/sdk'

function CustomerDetail({ storeId, customerId, onBack }: {
  storeId: string
  customerId: string
  onBack: () => void
}) {
  const { toast } = useToast()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [addresses, setAddresses] = useState<Address[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)
  const [tag, setTag] = useState('')
  const [addingTag, setAddingTag] = useState(false)

  const loadAll = useCallback(async () => {
    const sdk = getSdk()
    setLoading(true)
    try {
      const [custRes, addrRes, ordersRes] = await Promise.allSettled([
        sdk.customers.get(storeId, customerId),
        sdk.customers.listAddresses(storeId, customerId),
        sdk.orders.list(storeId, { customer_id: customerId, limit: 10 }),
      ])
      if (custRes.status === 'fulfilled') setCustomer(custRes.value.customer)
      if (addrRes.status === 'fulfilled') setAddresses(addrRes.value.addresses ?? [])
      if (ordersRes.status === 'fulfilled') setOrders(ordersRes.value.orders ?? [])
    } finally {
      setLoading(false)
    }
  }, [storeId, customerId])

  useEffect(() => { void loadAll() }, [loadAll])

  const handleAddTag = async () => {
    if (!tag.trim() || !customer) return
    setAddingTag(true)
    try {
      const sdk = getSdk()
      const existingTags = (customer.tags as string[] | undefined) ?? []
      await sdk.customers.update(storeId, customerId, { tags: [...existingTags, tag.trim()] } as Partial<Customer>)
      setTag('')
      toast('Tag added', 'success')
      void loadAll()
    } catch { toast('Failed to add tag', 'error') } finally { setAddingTag(false) }
  }

  const handleRemoveTag = async (tagToRemove: string) => {
    if (!customer) return
    try {
      const sdk = getSdk()
      const existingTags = (customer.tags as string[] | undefined) ?? []
      await sdk.customers.update(storeId, customerId, { tags: existingTags.filter(t => t !== tagToRemove) } as Partial<Customer>)
      toast('Tag removed', 'success')
      void loadAll()
    } catch { toast('Failed to remove tag', 'error') }
  }

  const handleBlock = async () => {
    if (!customer) return
    const isBlocked = (customer.is_blocked as boolean | undefined) ?? false
    if (!confirm(isBlocked ? 'Unblock this customer?' : 'Block this customer?')) return
    try {
      const sdk = getSdk()
      await sdk.customers.update(storeId, customerId, { is_blocked: !isBlocked } as Partial<Customer>)
      toast(isBlocked ? 'Customer unblocked' : 'Customer blocked', 'success')
      void loadAll()
    } catch { toast('Update failed', 'error') }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (!customer) return <p className="text-[var(--cc-muted)] py-8 text-center text-sm">Customer not found</p>

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'No name'
  const isBlocked = (customer.is_blocked as boolean | undefined) ?? false
  const tags = (customer.tags as string[] | undefined) ?? []

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs text-[var(--cc-muted)] hover:text-[var(--cc-text)] transition"
        >
          <ChevronLeft size={14} />
          Customers
        </button>
        <span className="text-[var(--cc-subtle)] text-sm">/</span>
        <span className="text-sm font-medium text-[var(--cc-text)]">{fullName}</span>
        {isBlocked && <Badge color="red">Blocked</Badge>}
        <div className="ml-auto">
          <Btn size="sm" variant={isBlocked ? 'green' : 'danger'} onClick={handleBlock}>
            {isBlocked ? 'Unblock' : 'Block'} Customer
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          {/* Recent orders */}
          <Card title="Recent Orders">
            {orders.length === 0 ? (
              <p className="text-xs text-[var(--cc-subtle)]">No orders yet</p>
            ) : (
              <TableContainer>
                <table className="w-full text-sm">
                  <TableHead>
                    <Th>Order</Th>
                    <Th>Date</Th>
                    <Th>Payment</Th>
                    <Th align="right">Total</Th>
                  </TableHead>
                  <tbody>
                    {orders.map(order => {
                      const fin = statusBadgeProps(order.financial_status, FINANCIAL_STATUS_MAP)
                      return (
                        <tr
                          key={order.id}
                          style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                        >
                          <Td>
                            <span className="font-mono text-[var(--cc-lime)]">#{order.order_number}</span>
                          </Td>
                          <Td muted>{new Date(order.created_at).toLocaleDateString()}</Td>
                          <Td><Badge color={fin.color}>{fin.label}</Badge></Td>
                          <Td align="right" className="font-mono text-[var(--cc-text)]">
                            {order.currency} {Number(order.total).toFixed(2)}
                          </Td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </TableContainer>
            )}
          </Card>

          {/* Addresses */}
          <Card title="Addresses">
            {addresses.length === 0 ? (
              <p className="text-xs text-[var(--cc-subtle)]">No addresses on file</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {addresses.map((addr, i) => {
                  const a = addr as Record<string, string | undefined>
                  return (
                    <div
                      key={i}
                      className="rounded-lg p-3 text-xs text-[var(--cc-muted)] space-y-0.5"
                      style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.02)' }}
                    >
                      {a['name'] && <p className="text-[var(--cc-text)] font-medium mb-1">{a['name']}</p>}
                      {a['address1'] && <p>{a['address1']}</p>}
                      {a['address2'] && <p>{a['address2']}</p>}
                      <p>{[a['city'], a['province_code'], a['zip']].filter(Boolean).join(', ')}</p>
                      {a['country_code'] && <p>{a['country_code']}</p>}
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          {/* Contact */}
          <Card title="Contact Info">
            <div className="space-y-2">
              <InfoRow label="Email">
                <span className="text-[var(--cc-body)]">{customer.email}</span>
              </InfoRow>
              {customer.phone && (
                <InfoRow label="Phone">
                  <span className="text-[var(--cc-body)]">{customer.phone}</span>
                </InfoRow>
              )}
              <InfoRow label="Joined">
                {new Date(customer.created_at).toLocaleDateString()}
              </InfoRow>
            </div>
          </Card>

          {/* Tags */}
          <Card title="Tags">
            <div className="space-y-3">
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map(t => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--cc-body)]"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                    >
                      {t}
                      <button
                        onClick={() => handleRemoveTag(t)}
                        className="text-[var(--cc-subtle)] hover:text-red-400 ml-0.5 transition"
                        aria-label={`Remove tag ${t}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-1.5">
                <input
                  value={tag}
                  onChange={e => setTag(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAddTag() } }}
                  placeholder="Add tag…"
                  className="flex-1 rounded-lg px-2.5 py-1.5 text-xs text-[var(--cc-text)] placeholder:text-[var(--cc-subtle)] focus:outline-none focus:ring-1 focus:ring-[var(--cc-lime)]/20 transition"
                  style={{ background: 'var(--cc-bg-sunken)', border: '1px solid rgba(255,255,255,0.08)' }}
                />
                <Btn size="sm" variant="secondary" onClick={handleAddTag} loading={addingTag}>Add</Btn>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

const PAGE_SIZE = 25

export default function Customers() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)

  const load = useCallback((off: number, q?: string) => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    const query: { limit: number; offset: number; q?: string } = { limit: PAGE_SIZE, offset: off }
    if (q?.trim()) query.q = q.trim()
    void sdk.customers.list(activeStore.id, query)
      .then(res => { setCustomers(res.customers ?? []); setTotal(res.total ?? 0) })
      .catch(() => toast('Failed to load customers', 'error'))
      .finally(() => setLoading(false))
  }, [activeStore, toast])

  useEffect(() => { setOffset(0); load(0) }, [load])

  if (selectedCustomerId && activeStore) {
    return (
      <CustomerDetail
        storeId={activeStore.id}
        customerId={selectedCustomerId}
        onBack={() => setSelectedCustomerId(null)}
      />
    )
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  const handleSearch = (q: string) => {
    setSearch(q)
    setOffset(0)
    load(0, q)
  }

  const goToPage = (newOffset: number) => {
    setOffset(newOffset)
    load(newOffset, search)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Customers"
        description={loading ? undefined : `${total.toLocaleString()} customer${total !== 1 ? 's' : ''}`}
      />

      <SearchInput value={search} onChange={handleSearch} placeholder="Search by name or email…" />

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : customers.length === 0 ? (
        <EmptyState
          icon={<Users size={22} />}
          title={search ? 'No customers found' : 'No customers yet'}
          description={search ? 'Try a different search term.' : 'Customers appear here after their first order.'}
        />
      ) : (
        <>
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Status</Th>
                <Th>Joined</Th>
              </TableHead>
              <tbody>
                {customers.map(customer => {
                  const isBlocked = (customer.is_blocked as boolean | undefined) ?? false
                  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || '—'
                  return (
                    <tr
                      key={customer.id}
                      className="cursor-pointer transition-colors"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                      onClick={() => setSelectedCustomerId(customer.id)}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.02)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}
                    >
                      <Td className="font-medium text-[var(--cc-text)]">{fullName}</Td>
                      <Td className="text-[var(--cc-body)]">{customer.email}</Td>
                      <Td>
                        {isBlocked
                          ? <Badge color="red">Blocked</Badge>
                          : <Badge color="emerald">Active</Badge>}
                      </Td>
                      <Td muted>{new Date(customer.created_at).toLocaleDateString()}</Td>
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
              unit="customers"
              onPrev={() => goToPage(offset - PAGE_SIZE)}
              onNext={() => goToPage(offset + PAGE_SIZE)}
            />
          )}
        </>
      )}
    </div>
  )
}
