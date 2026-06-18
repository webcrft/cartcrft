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
        <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.01] p-12 text-center">
          <p className="text-[15px] font-semibold text-[var(--cc-text)] mb-1.5">Cross-store customer lookup</p>
          <p className="text-[13px] text-[var(--cc-text-muted)] max-w-sm mx-auto leading-relaxed">Enter a full or partial email address to find customers across all stores and organisations.</p>
        </div>
      )}

      {loading && <div className="flex justify-center py-16"><Spinner /></div>}
      {error && !loading && <LoadError message={error} onRetry={() => void search()} />}
      {!loading && searched && !error && customers.length === 0 && (
        <EmptyState title="No customers found" description={`No customers match "${query}".`} />
      )}

      {!loading && customers.length > 0 && (
        <>
          <p className="text-[13px] text-[var(--cc-text-muted)] mb-3"><span className="font-mono text-[12px] tabular-nums text-[var(--cc-text-body)]">{customers.length}</span> result{customers.length !== 1 ? 's' : ''}</p>
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
                <tr key={c.id} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                  <Td>
                    <span className="text-[13px] font-medium text-[var(--cc-text-body)]">{c.email}</span>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--cc-text-muted)] font-mono">{c.id}</span>
                  </Td>
                  <Td>
                    <p className="text-[13px] text-[var(--cc-text-body)]">{c.store_name || '—'}</p>
                    <p className="text-[12px] text-[var(--cc-text-muted)] font-mono">{c.store_id}</p>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--cc-text-muted)] font-mono">{c.org_id}</span>
                  </Td>
                  <Td>
                    <span className="text-[12px] text-[var(--cc-text-muted)] font-mono tabular-nums">{new Date(c.created_at).toLocaleDateString()}</span>
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
