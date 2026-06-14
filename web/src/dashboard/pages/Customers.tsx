import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Badge, Btn, Card, PageHeader, EmptyState, SearchInput, Spinner, TableContainer, TableHead, Th, Td } from '../components/ui/index'
import { FINANCIAL_STATUS_MAP, statusBadgeProps } from '../lib/statusMaps'
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
  if (!customer) return <div className="text-slate-500 py-8 text-center">Customer not found</div>

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'No name'
  const isBlocked = (customer.is_blocked as boolean | undefined) ?? false
  const tags = (customer.tags as string[] | undefined) ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-xs text-slate-500 hover:text-white transition">&#8592; Customers</button>
        <span className="text-slate-700">/</span>
        <span className="text-sm font-medium text-white">{fullName}</span>
        {isBlocked && <Badge color="red">Blocked</Badge>}
        <div className="ml-auto">
          <Btn variant={isBlocked ? 'green' : 'danger'} onClick={handleBlock}>
            {isBlocked ? 'Unblock' : 'Block'} Customer
          </Btn>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          {/* Orders */}
          <Card title="Recent Orders">
            {orders.length === 0 ? (
              <p className="text-xs text-slate-500">No orders yet</p>
            ) : (
              <TableContainer>
                <table className="w-full text-sm">
                  <TableHead>
                    <Th>Order</Th>
                    <Th>Date</Th>
                    <Th>Payment</Th>
                    <Th className="text-right">Total</Th>
                  </TableHead>
                  <tbody>
                    {orders.map(order => {
                      const fin = statusBadgeProps(order.financial_status, FINANCIAL_STATUS_MAP)
                      return (
                        <tr key={order.id} className="border-t border-white/[0.04]">
                          <Td><span className="font-mono text-violet-400">#{order.order_number}</span></Td>
                          <Td className="text-slate-400">{new Date(order.created_at).toLocaleDateString()}</Td>
                          <Td><Badge color={fin.color}>{fin.label}</Badge></Td>
                          <Td className="text-right font-mono text-white">{order.currency} {Number(order.total).toFixed(2)}</Td>
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
              <p className="text-xs text-slate-500">No addresses on file</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {addresses.map((addr, i) => {
                  const a = addr as Record<string, string | undefined>
                  return (
                    <div key={i} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-xs text-slate-400 space-y-0.5">
                      {a['name'] && <p className="text-white font-medium">{a['name']}</p>}
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
          <Card title="Contact Info">
            <div className="space-y-2 text-xs">
              <div>
                <span className="text-slate-500">Email</span>
                <p className="text-white">{customer.email}</p>
              </div>
              {customer.phone && (
                <div>
                  <span className="text-slate-500">Phone</span>
                  <p className="text-white">{customer.phone}</p>
                </div>
              )}
              <div>
                <span className="text-slate-500">Joined</span>
                <p className="text-slate-300">{new Date(customer.created_at).toLocaleDateString()}</p>
              </div>
            </div>
          </Card>

          <Card title="Tags">
            <div className="space-y-3">
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map(t => (
                    <span key={t} className="inline-flex items-center gap-1 rounded-md bg-slate-800 border border-white/[0.08] px-2 py-1 text-xs text-slate-300">
                      {t}
                      <button onClick={() => handleRemoveTag(t)} className="text-slate-500 hover:text-red-400 ml-0.5">&#x2715;</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  value={tag}
                  onChange={e => setTag(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void handleAddTag() } }}
                  placeholder="Add tag..."
                  className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1.5 text-xs text-white placeholder:text-slate-500 focus:border-white/20 focus:outline-none"
                />
                <Btn variant="secondary" onClick={handleAddTag} loading={addingTag}>Add</Btn>
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

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const hasPrev = offset > 0
  const hasNext = offset + PAGE_SIZE < total

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
    <div className="space-y-4">
      <PageHeader
        title="Customers"
        description={`${total} customer${total !== 1 ? 's' : ''}`}
      />

      <SearchInput value={search} onChange={handleSearch} placeholder="Search by name or email..." />

      {customers.length === 0 ? (
        <EmptyState
          title="No customers found"
          description={search ? 'Try a different search term' : 'Customers will appear here after their first order'}
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
                      className="border-t border-white/[0.04] hover:bg-white/[0.02] transition cursor-pointer"
                      onClick={() => setSelectedCustomerId(customer.id)}
                    >
                      <Td className="font-medium text-white">{fullName}</Td>
                      <Td className="text-slate-400">{customer.email}</Td>
                      <Td>
                        {isBlocked ? <Badge color="red">Blocked</Badge> : <Badge color="emerald">Active</Badge>}
                      </Td>
                      <Td className="text-slate-500">{new Date(customer.created_at).toLocaleDateString()}</Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableContainer>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-1">
              <span className="text-xs text-slate-500">
                Page {currentPage} of {totalPages} &middot; {total} customers
              </span>
              <div className="flex items-center gap-2">
                <Btn
                  variant="secondary"
                  disabled={!hasPrev}
                  onClick={() => goToPage(offset - PAGE_SIZE)}
                >
                  &#8592; Prev
                </Btn>
                <Btn
                  variant="secondary"
                  disabled={!hasNext}
                  onClick={() => goToPage(offset + PAGE_SIZE)}
                >
                  Next &#8594;
                </Btn>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
