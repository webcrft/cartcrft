/**
 * Stores browser — all stores across all orgs, searchable + filterable.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  listStores,
  getStore,
  type StoreItem,
  type StoreDetail,
  SuperAdminApiError,
} from '../lib/api'
import {
  PageHeader,
  Card,
  Spinner,
  LoadError,
  EmptyState,
  FormInput,
  Badge,
  TableContainer,
  TableHead,
  Th,
  Td,
  Btn,
} from '../components/ui/index'
import { ArrowLeft } from 'lucide-react'

/** Format a string/number USD amount explicitly (locale-independent currency). */
function fmtUsd(v: string | number | undefined): string {
  return (parseFloat(String(v ?? 0)) || 0).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

function StoreDetailView({ storeId, token, onBack, handle401 }: { storeId: string; token: string; onBack: () => void; handle401: () => void }) {
  const { toast } = useToast()
  const [store, setStore] = useState<StoreDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await getStore(token, storeId)
        setStore(res.store)
      } catch (err) {
        if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
        const msg = err instanceof SuperAdminApiError ? err.message : 'Failed to load store'
        setError(msg)
        toast(msg, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, [storeId, token, handle401, toast])

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (error) return <LoadError message={error} />
  if (!store) return null

  const statusColor = store.status === 'active' ? 'emerald' : store.status === 'suspended' ? 'amber' : 'red'

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition mb-4">
        <ArrowLeft size={13} /> Back to stores
      </button>
      <PageHeader
        title={store.name}
        description={`Store ID: ${store.id}`}
        badge={<Badge color={statusColor}>{store.status}</Badge>}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <div className="rounded-xl border border-white/[0.07] bg-zinc-900/60 px-5 py-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Orders</p>
          <p className="text-2xl font-bold text-zinc-100">{store.order_count}</p>
        </div>
        <div className="rounded-xl border border-white/[0.07] bg-zinc-900/60 px-5 py-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">GMV</p>
          <p className="text-2xl font-bold text-emerald-400">{fmtUsd(store.gmv)}</p>
        </div>
        <div className="rounded-xl border border-white/[0.07] bg-zinc-900/60 px-5 py-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Currency</p>
          <p className="text-2xl font-bold text-zinc-100">{store.currency}</p>
        </div>
      </div>

      <Card title="Store details">
        <div className="space-y-3">
          {[
            { label: 'ID', value: store.id },
            { label: 'Org ID', value: store.org_id },
            { label: 'Email', value: store.email || '—' },
            { label: 'Country', value: store.country_code || '—' },
            { label: 'Timezone', value: store.timezone || '—' },
            { label: 'Created', value: new Date(store.created_at).toLocaleString() },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-start justify-between gap-4 py-2 border-b border-white/[0.04] last:border-0">
              <span className="text-xs text-zinc-500 flex-shrink-0 w-24">{label}</span>
              <span className="text-xs text-zinc-300 font-mono text-right break-all">{value}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

export default function Stores() {
  const { token, handle401 } = useAuth()
  const { toast } = useToast()

  const [stores, setStores] = useState<StoreItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const res = await listStores(token)
      setStores(res.stores ?? [])
    } catch (err) {
      if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
      const msg = err instanceof SuperAdminApiError ? err.message : 'Failed to load stores'
      setError(msg)
      toast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }, [token, handle401, toast])

  useEffect(() => { void load() }, [load])

  if (selectedId && token) {
    return (
      <StoreDetailView
        storeId={selectedId}
        token={token}
        onBack={() => setSelectedId(null)}
        handle401={handle401}
      />
    )
  }

  const filtered = stores.filter(s => {
    const matchesSearch = !search || s.id.includes(search) || s.name?.toLowerCase().includes(search.toLowerCase()) || s.org_name?.toLowerCase().includes(search.toLowerCase())
    const matchesStatus = !statusFilter || s.status === statusFilter
    return matchesSearch && matchesStatus
  })

  const statuses = Array.from(new Set(stores.map(s => s.status).filter(Boolean)))

  return (
    <div>
      <PageHeader
        title="Stores"
        description="All stores across all organisations"
        actions={<Btn variant="secondary" onClick={() => void load()}>Refresh</Btn>}
      />

      <div className="flex gap-3 mb-4">
        <div className="flex-1">
          <FormInput value={search} onChange={setSearch} placeholder="Search by name, org, or ID..." />
        </div>
        {statuses.length > 0 && (
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="rounded-lg border border-white/[0.08] bg-zinc-800/60 px-3 py-2 text-xs text-zinc-300 focus:outline-none"
          >
            <option value="">All statuses</option>
            {statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
      </div>

      {loading && <div className="flex justify-center py-16"><Spinner /></div>}
      {error && !loading && <LoadError message={error} onRetry={() => void load()} />}
      {!loading && !error && filtered.length === 0 && (
        <EmptyState title="No stores found" description={search || statusFilter ? 'Try adjusting your filters.' : 'No stores exist yet.'} />
      )}

      {!loading && !error && filtered.length > 0 && (
        <TableContainer>
          <TableHead>
            <Th>Store</Th>
            <Th>Org</Th>
            <Th>Currency</Th>
            <Th>Status</Th>
            <Th>Orders</Th>
            <Th>GMV</Th>
            <Th>Created</Th>
            <Th></Th>
          </TableHead>
          <tbody>
            {filtered.map(s => (
              <tr key={s.id} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                <Td>
                  <p className="text-xs font-medium text-zinc-200">{s.name}</p>
                  <p className="text-[11px] text-zinc-600 font-mono">{s.id}</p>
                </Td>
                <Td>
                  <span className="text-xs text-zinc-400">{s.org_name || s.org_id}</span>
                </Td>
                <Td><span className="text-xs text-zinc-400">{s.currency}</span></Td>
                <Td>
                  <Badge color={s.status === 'active' ? 'emerald' : s.status === 'suspended' ? 'amber' : 'red'}>
                    {s.status}
                  </Badge>
                </Td>
                <Td><span className="text-xs text-zinc-400">{s.order_count}</span></Td>
                <Td><span className="text-xs text-emerald-400">{fmtUsd(s.gmv)}</span></Td>
                <Td><span className="text-xs text-zinc-500">{new Date(s.created_at).toLocaleDateString()}</span></Td>
                <Td>
                  <button onClick={() => setSelectedId(s.id)} className="text-xs text-amber-400 hover:text-amber-300 transition">
                    View
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableContainer>
      )}
    </div>
  )
}
