/**
 * Organisations browser — searchable list with org detail view.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  listOrgs,
  getOrg,
  type Org,
  type OrgDetail,
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

function OrgDetailView({ orgId, token, onBack, handle401 }: { orgId: string; token: string; onBack: () => void; handle401: () => void }) {
  const { toast } = useToast()
  const [org, setOrg] = useState<OrgDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await getOrg(token, orgId)
        setOrg(res.org)
      } catch (err) {
        if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
        const msg = err instanceof SuperAdminApiError ? err.message : 'Failed to load org'
        setError(msg)
        toast(msg, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, [orgId, token, handle401, toast])

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>
  if (error) return <LoadError message={error} />
  if (!org) return null

  return (
    <div>
      <div className="mb-5">
        <button onClick={onBack} className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[var(--cc-text-muted)] hover:text-[var(--cc-lime)] transition mb-4">
          <ArrowLeft size={13} /> Back to orgs
        </button>
        <PageHeader
          title={org.name || org.id}
          description={`Org ID: ${org.id}`}
          badge={<Badge color="slate">{org.billing_status || 'active'}</Badge>}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] px-5 py-4">
          <p className="font-mono text-[10px] text-[var(--cc-text-subtle)] uppercase tracking-[0.14em] mb-1.5">Stores</p>
          <p className="font-display text-2xl font-bold text-[var(--cc-text)]">{org.store_count}</p>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] px-5 py-4">
          <p className="font-mono text-[10px] text-[var(--cc-text-subtle)] uppercase tracking-[0.14em] mb-1.5">Customers</p>
          <p className="font-display text-2xl font-bold text-[var(--cc-text)]">{org.customer_count}</p>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] px-5 py-4">
          <p className="font-mono text-[10px] text-[var(--cc-text-subtle)] uppercase tracking-[0.14em] mb-1.5">Orders</p>
          <p className="font-display text-2xl font-bold text-[var(--cc-text)]">{org.order_count}</p>
        </div>
        <div className="rounded-lg border border-white/[0.07] bg-[var(--cc-surface)] px-5 py-4">
          <p className="font-mono text-[10px] text-[var(--cc-text-subtle)] uppercase tracking-[0.14em] mb-1.5">GMV</p>
          <p className="font-display text-2xl font-bold text-[var(--cc-lime)]">{fmtUsd(org.gmv)}</p>
        </div>
      </div>

      {org.stores && org.stores.length > 0 && (
        <Card title="Stores">
          <TableContainer>
            <TableHead>
              <Th>Name</Th>
              <Th>Currency</Th>
              <Th>Status</Th>
              <Th>Orders</Th>
              <Th>GMV</Th>
            </TableHead>
            <tbody>
              {org.stores.map(s => (
                <tr key={s.id} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                  <Td>
                    <p className="text-xs font-medium text-[var(--cc-text-body)]">{s.name}</p>
                    <p className="text-[11px] text-[var(--cc-text-subtle)] font-mono">{s.id}</p>
                  </Td>
                  <Td><span className="text-xs text-[var(--cc-text-muted)] font-mono">{s.currency}</span></Td>
                  <Td>
                    <Badge color={s.status === 'active' ? 'emerald' : s.status === 'suspended' ? 'amber' : 'red'}>
                      {s.status}
                    </Badge>
                  </Td>
                  <Td><span className="text-xs text-[var(--cc-text-muted)] tabular-nums">{s.order_count}</span></Td>
                  <Td><span className="text-xs text-[var(--cc-lime)] tabular-nums">{fmtUsd(s.gmv)}</span></Td>
                </tr>
              ))}
            </tbody>
          </TableContainer>
        </Card>
      )}
    </div>
  )
}

export default function Orgs() {
  const { token, handle401 } = useAuth()
  const { toast } = useToast()

  const [orgs, setOrgs] = useState<Org[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const res = await listOrgs(token)
      setOrgs(res.orgs ?? [])
    } catch (err) {
      if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
      const msg = err instanceof SuperAdminApiError ? err.message : 'Failed to load orgs'
      setError(msg)
      toast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }, [token, handle401, toast])

  useEffect(() => { void load() }, [load])

  if (selectedId && token) {
    return (
      <OrgDetailView
        orgId={selectedId}
        token={token}
        onBack={() => setSelectedId(null)}
        handle401={handle401}
      />
    )
  }

  const filtered = orgs.filter(o =>
    !search || o.id.includes(search) || o.name?.toLowerCase().includes(search.toLowerCase()) || o.email?.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div>
      <PageHeader
        title="Organisations"
        description="All tenants on this platform"
        actions={
          <Btn variant="secondary" onClick={() => void load()}>Refresh</Btn>
        }
      />

      <div className="mb-4">
        <FormInput
          value={search}
          onChange={setSearch}
          placeholder="Search by name, email, or ID..."
        />
      </div>

      {loading && <div className="flex justify-center py-16"><Spinner /></div>}
      {error && !loading && <LoadError message={error} onRetry={() => void load()} />}
      {!loading && !error && filtered.length === 0 && (
        <EmptyState title="No organisations found" description={search ? 'Try a different search term.' : 'No orgs have been created yet.'} />
      )}

      {!loading && !error && filtered.length > 0 && (
        <TableContainer>
          <TableHead>
            <Th>Organisation</Th>
            <Th>Stores</Th>
            <Th>Orders</Th>
            <Th>GMV</Th>
            <Th>Billing</Th>
            <Th>Created</Th>
            <Th></Th>
          </TableHead>
          <tbody>
            {filtered.map(org => (
              <tr key={org.id} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                <Td>
                  <p className="text-xs font-medium text-[var(--cc-text-body)]">{org.name || '—'}</p>
                  <p className="text-[11px] text-[var(--cc-text-subtle)] font-mono">{org.id}</p>
                  {org.email && <p className="text-[11px] text-[var(--cc-text-muted)]">{org.email}</p>}
                </Td>
                <Td><span className="text-xs text-[var(--cc-text-muted)] tabular-nums">{org.store_count}</span></Td>
                <Td><span className="text-xs text-[var(--cc-text-muted)] tabular-nums">{org.order_count}</span></Td>
                <Td><span className="text-xs text-[var(--cc-lime)] tabular-nums">{fmtUsd(org.gmv)}</span></Td>
                <Td>
                  <Badge color={org.billing_status === 'active' ? 'emerald' : 'slate'}>
                    {org.billing_status || 'active'}
                  </Badge>
                </Td>
                <Td><span className="text-xs text-[var(--cc-text-muted)] tabular-nums">{new Date(org.created_at).toLocaleDateString()}</span></Td>
                <Td>
                  <button
                    onClick={() => setSelectedId(org.id)}
                    className="text-xs font-medium text-[var(--cc-lime)] hover:text-[var(--cc-lime-bright)] transition"
                  >
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
