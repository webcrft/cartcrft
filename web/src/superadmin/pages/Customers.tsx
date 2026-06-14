/**
 * Customers search — cross-store customer lookup by email.
 */

import React, { useState, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  searchCustomers,
  type CustomerItem,
  SuperAdminApiError,
} from '../lib/api'
import {
  PageHeader,
  Spinner,
  LoadError,
  EmptyState,
  FormInput,
  TableContainer,
  TableHead,
  Th,
  Td,
  Btn,
} from '../components/ui/index'

export default function Customers() {
  const { token, handle401 } = useAuth()
  const { toast } = useToast()

  const [query, setQuery] = useState('')
  const [customers, setCustomers] = useState<CustomerItem[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = useCallback(async () => {
    if (!token || !query.trim()) return
    setLoading(true)
    setError(null)
    setSearched(true)
    try {
      const res = await searchCustomers(token, query.trim())
      setCustomers(res.customers ?? [])
    } catch (err) {
      if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
      const msg = err instanceof SuperAdminApiError ? err.message : 'Search failed'
      setError(msg)
      toast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }, [token, handle401, toast, query])

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void search()
  }

  return (
    <div>
      <PageHeader
        title="Customer Search"
        description="Search customers by email across all stores"
      />

      <div className="flex gap-3 mb-6">
        <div className="flex-1">
          <FormInput
            value={query}
            onChange={setQuery}
            placeholder="Search by email address..."
            type="email"
          />
        </div>
        <Btn onClick={() => void search()} loading={loading}>
          Search
        </Btn>
      </div>

      {/* Keyboard hint */}
      {!searched && (
        <div className="rounded-xl border border-dashed border-white/10 p-12 text-center">
          <p className="text-sm font-medium text-zinc-400 mb-1">Cross-store customer lookup</p>
          <p className="text-xs text-zinc-600">Enter a full or partial email address to find customers across all stores and organisations.</p>
        </div>
      )}

      {loading && <div className="flex justify-center py-16"><Spinner /></div>}
      {error && !loading && <LoadError message={error} onRetry={() => void search()} />}
      {!loading && searched && !error && customers.length === 0 && (
        <EmptyState title="No customers found" description={`No customers match "${query}".`} />
      )}

      {!loading && customers.length > 0 && (
        <>
          <p className="text-xs text-zinc-500 mb-3">{customers.length} result{customers.length !== 1 ? 's' : ''}</p>
          <TableContainer>
            <TableHead>
              <Th>Email</Th>
              <Th>Customer ID</Th>
              <Th>Store</Th>
              <Th>Org</Th>
              <Th>Created</Th>
            </TableHead>
            <tbody>
              {customers.map(c => (
                <tr key={c.id} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                  <Td>
                    <span className="text-xs font-medium text-zinc-200">{c.email}</span>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-zinc-600 font-mono">{c.id}</span>
                  </Td>
                  <Td>
                    <p className="text-xs text-zinc-400">{c.store_name || '—'}</p>
                    <p className="text-[11px] text-zinc-600 font-mono">{c.store_id}</p>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-zinc-600 font-mono">{c.org_id}</span>
                  </Td>
                  <Td>
                    <span className="text-xs text-zinc-500">{new Date(c.created_at).toLocaleDateString()}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableContainer>
        </>
      )}
    </div>
  )
}
