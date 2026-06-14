import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, LoadError, PageHeader, EmptyState, Spinner,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

type Tab = 'companies' | 'quotes' | 'purchase-orders'

interface Company {
  id: string; name: string; credit_limit?: string; net_terms?: number;
  po_number_required?: boolean; [k: string]: unknown
}

interface Quote {
  id: string; company_id?: string; status: string; total?: string;
  expires_at?: string; created_at: string; [k: string]: unknown
}

interface PurchaseOrder {
  id: string; company_id?: string; po_number: string; status: string;
  total?: string; created_at: string; [k: string]: unknown
}

const QUOTE_STATUS: Record<string, { color: 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'; label: string }> = {
  draft: { color: 'slate', label: 'Draft' },
  sent: { color: 'blue', label: 'Sent' },
  accepted: { color: 'emerald', label: 'Accepted' },
  rejected: { color: 'red', label: 'Rejected' },
  converted: { color: 'violet', label: 'Converted' },
  expired: { color: 'amber', label: 'Expired' },
}

export default function B2B() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('companies')
  const [companies, setCompanies] = useState<Company[]>([])
  const [quotes, setQuotes] = useState<Quote[]>([])
  const [pos, setPos] = useState<PurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [companyForm, setCompanyForm] = useState({ name: '', credit_limit: '', net_terms: '0' })
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    const sdk = getSdk()
    try {
      const [companiesRes, quotesRes, posRes] = await Promise.allSettled([
        sdk.b2b.listCompanies(activeStore.id),
        sdk.b2b.listQuotes(activeStore.id),
        sdk.request<{ purchase_orders: PurchaseOrder[] }>(`/commerce/stores/${activeStore.id}/purchase-orders`),
      ])
      if (companiesRes.status === 'fulfilled') {
        setCompanies((companiesRes.value as { companies?: Company[] }).companies ?? [])
      } else {
        const msg = companiesRes.reason instanceof Error ? companiesRes.reason.message : 'Failed to load companies'
        setLoadError(msg)
        toast(msg, 'error')
        setCompanies([])
      }
      if (quotesRes.status === 'fulfilled') {
        setQuotes((quotesRes.value as { quotes?: Quote[] }).quotes ?? [])
      } else {
        setQuotes([])
      }
      if (posRes.status === 'fulfilled') {
        setPos((posRes.value as { purchase_orders?: PurchaseOrder[] }).purchase_orders ?? [])
      } else {
        setPos([])
      }
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  const createCompany = async () => {
    if (!activeStore || !companyForm.name) { toast('Name required', 'error'); return }
    setSaving(true)
    try {
      const body: { name: string; [key: string]: unknown } = { name: companyForm.name }
      if (companyForm.credit_limit) body.credit_limit = companyForm.credit_limit
      if (companyForm.net_terms) body.net_terms = Number(companyForm.net_terms)
      await getSdk().b2b.createCompany(activeStore.id, body)
      toast('Company created', 'success')
      setShowCreate(false)
      setCompanyForm({ name: '', credit_limit: '', net_terms: '0' })
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Create failed', 'error') }
    finally { setSaving(false) }
  }

  const quoteAction = async (quoteId: string, action: string) => {
    if (!activeStore) return
    setActing(quoteId)
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/quotes/${quoteId}/${action}`, { method: 'POST', body: {} })
      toast(`Quote ${action}ed`, 'success')
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : `${action} failed`, 'error') }
    finally { setActing(null) }
  }

  const setField = (k: keyof typeof companyForm) => (v: string) => setCompanyForm(f => ({ ...f, [k]: v }))

  const TABS = [
    { key: 'companies' as Tab, label: 'Companies' },
    { key: 'quotes' as Tab, label: 'Quotes / RFQ' },
    { key: 'purchase-orders' as Tab, label: 'Purchase Orders' },
  ]

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="B2B"
        description="Companies, quotes, and purchase orders"
        actions={tab === 'companies' ? <Btn onClick={() => setShowCreate(v => !v)}>+ Add Company</Btn> : undefined}
      />

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      <div className="flex border-b border-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${tab === t.key ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'companies' && (
        <div className="space-y-4">
          {showCreate && (
            <Card>
              <div className="space-y-3">
                <p className="text-sm font-semibold text-white">New Company</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormInput label="Company Name" value={companyForm.name} onChange={setField('name')} placeholder="ACME Corp" />
                  <FormInput label="Credit Limit" value={companyForm.credit_limit} onChange={setField('credit_limit')} placeholder="5000.00" type="number" />
                  <FormSelect label="Net Terms (days)" value={companyForm.net_terms} onChange={setField('net_terms')}
                    options={[{ value: '0', label: 'None' }, { value: '15', label: 'Net 15' }, { value: '30', label: 'Net 30' }, { value: '60', label: 'Net 60' }]} />
                </div>
                <div className="flex gap-2">
                  <Btn onClick={createCompany} loading={saving} variant="green">Create</Btn>
                  <Btn variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Btn>
                </div>
              </div>
            </Card>
          )}
          {companies.length === 0 ? (
            <EmptyState title="No companies" description="Add B2B companies with credit limits and net payment terms" action="Add Company" onAction={() => setShowCreate(true)} />
          ) : (
            <TableContainer>
              <table className="w-full text-sm">
                <TableHead><Th>Name</Th><Th>Credit Limit</Th><Th>Net Terms</Th></TableHead>
                <tbody>
                  {companies.map(c => (
                    <tr key={c.id} className="border-t border-white/[0.04]">
                      <Td className="text-white">{c.name}</Td>
                      <Td className="font-mono text-slate-300">{c.credit_limit ?? '—'}</Td>
                      <Td className="text-slate-400">{c.net_terms ? `Net ${c.net_terms}` : 'None'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          )}
        </div>
      )}

      {tab === 'quotes' && (
        quotes.length === 0 ? (
          <EmptyState title="No quotes" description="Quotes and RFQs from B2B companies appear here" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>ID</Th><Th>Company</Th><Th>Status</Th><Th>Total</Th><Th>Expires</Th><Th></Th></TableHead>
              <tbody>
                {quotes.map(q => {
                  const st = QUOTE_STATUS[q.status] ?? { color: 'slate' as const, label: q.status }
                  const company = companies.find(c => c.id === q.company_id)
                  return (
                    <tr key={q.id} className="border-t border-white/[0.04]">
                      <Td className="font-mono text-xs text-slate-400">{q.id.slice(0, 8)}</Td>
                      <Td className="text-slate-300">{company?.name ?? '—'}</Td>
                      <Td><Badge color={st.color}>{st.label}</Badge></Td>
                      <Td className="font-mono text-white">{q.total ?? '—'}</Td>
                      <Td className="text-slate-500 text-xs">{q.expires_at ? new Date(q.expires_at).toLocaleDateString() : '—'}</Td>
                      <Td>
                        <div className="flex gap-1">
                          {q.status === 'draft' && (
                            <Btn variant="primary" loading={acting === q.id} onClick={() => void quoteAction(q.id, 'send')}>Send</Btn>
                          )}
                          {q.status === 'sent' && (
                            <>
                              <Btn variant="green" loading={acting === q.id} onClick={() => void quoteAction(q.id, 'accept')}>Accept</Btn>
                              <Btn variant="danger" loading={acting === q.id} onClick={() => void quoteAction(q.id, 'reject')}>Reject</Btn>
                            </>
                          )}
                          {q.status === 'accepted' && (
                            <Btn variant="primary" loading={acting === q.id} onClick={() => void quoteAction(q.id, 'convert')}>Convert to Order</Btn>
                          )}
                        </div>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {tab === 'purchase-orders' && (
        pos.length === 0 ? (
          <EmptyState title="No purchase orders" description="B2B purchase orders will appear here" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>PO Number</Th><Th>Company</Th><Th>Status</Th><Th>Total</Th><Th>Date</Th></TableHead>
              <tbody>
                {pos.map(po => (
                  <tr key={po.id} className="border-t border-white/[0.04]">
                    <Td className="font-mono text-slate-300">{po.po_number}</Td>
                    <Td className="text-slate-300">{companies.find(c => c.id === po.company_id)?.name ?? '—'}</Td>
                    <Td><Badge color="slate">{po.status}</Badge></Td>
                    <Td className="font-mono text-white">{po.total ?? '—'}</Td>
                    <Td className="text-slate-500 text-xs">{new Date(po.created_at).toLocaleDateString()}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}
    </div>
  )
}
