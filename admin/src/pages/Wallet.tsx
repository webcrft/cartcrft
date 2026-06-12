import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, PageHeader, EmptyState, Spinner, Modal,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'
import type { GiftCard, Customer } from '@cartcrft/sdk'

type Tab = 'credits' | 'gift-cards'

interface CreditTx { id: string; amount: string; tx_type: string; reason?: string; created_at: string; [k: string]: unknown }

function CustomerCreditsModal({ storeId, customer, onClose }: {
  storeId: string; customer: Customer; onClose: () => void
}) {
  const { toast } = useToast()
  const [balance, setBalance] = useState<string | null>(null)
  const [transactions, setTransactions] = useState<CreditTx[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ amount: '', delta: '', reason: '' })
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'overview' | 'issue' | 'adjust' | 'ledger'>('overview')

  useEffect(() => {
    void (async () => {
      try {
        const sdk = getSdk()
        const res = await sdk.wallet.getBalance(storeId, customer.id)
        setBalance(res.balance)
        const txRes = await sdk.wallet.listTransactions(storeId, customer.id)
        setTransactions((txRes as { transactions?: CreditTx[] }).transactions ?? [])
      } catch { setBalance('0.00') }
      setLoading(false)
    })()
  }, [storeId, customer.id])

  const handleIssue = async () => {
    setSaving(true)
    try {
      const issueBody: { amount: string; reason?: string } = { amount: form.amount }
      if (form.reason) issueBody.reason = form.reason
      await getSdk().wallet.issue(storeId, customer.id, issueBody)
      toast('Credits issued', 'success')
      setForm({ amount: '', delta: '', reason: '' }); setView('overview')
      const res = await getSdk().wallet.getBalance(storeId, customer.id)
      setBalance(res.balance)
    } catch (err) { toast(err instanceof Error ? err.message : 'Issue failed', 'error') }
    finally { setSaving(false) }
  }

  const handleAdjust = async () => {
    setSaving(true)
    try {
      const adjustBody: { delta: string; reason?: string } = { delta: form.delta }
      if (form.reason) adjustBody.reason = form.reason
      await getSdk().wallet.adjust(storeId, customer.id, adjustBody)
      toast('Credits adjusted', 'success')
      setForm({ amount: '', delta: '', reason: '' }); setView('overview')
      const res = await getSdk().wallet.getBalance(storeId, customer.id)
      setBalance(res.balance)
    } catch (err) { toast(err instanceof Error ? err.message : 'Adjust failed', 'error') }
    finally { setSaving(false) }
  }

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  return (
    <Modal title={`Credits — ${customer.first_name ?? ''} ${customer.last_name ?? customer.email}`} onClose={onClose}>
      {loading ? <div className="flex justify-center py-8"><Spinner /></div> : (
        <div className="space-y-4">
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.08] px-4 py-3 flex items-center justify-between">
            <span className="text-xs text-slate-400">Current Balance</span>
            <span className="text-lg font-bold text-white font-mono">{balance}</span>
          </div>

          {view === 'overview' && (
            <div className="flex gap-2">
              <Btn onClick={() => setView('issue')}>Issue Credits</Btn>
              <Btn variant="secondary" onClick={() => setView('adjust')}>Adjust</Btn>
              <Btn variant="secondary" onClick={() => setView('ledger')}>Ledger</Btn>
            </div>
          )}

          {view === 'issue' && (
            <div className="space-y-3">
              <FormInput label="Amount" value={form.amount} onChange={set('amount')} placeholder="50.00" type="number" />
              <FormInput label="Reason (optional)" value={form.reason} onChange={set('reason')} placeholder="Loyalty reward" />
              <div className="flex gap-2"><Btn onClick={handleIssue} loading={saving} variant="green">Issue</Btn><Btn variant="secondary" onClick={() => setView('overview')}>Back</Btn></div>
            </div>
          )}

          {view === 'adjust' && (
            <div className="space-y-3">
              <FormInput label="Delta (+ add, - remove)" value={form.delta} onChange={set('delta')} placeholder="+10 or -5" type="number" />
              <FormInput label="Reason (optional)" value={form.reason} onChange={set('reason')} placeholder="Correction" />
              <div className="flex gap-2"><Btn onClick={handleAdjust} loading={saving}>Adjust</Btn><Btn variant="secondary" onClick={() => setView('overview')}>Back</Btn></div>
            </div>
          )}

          {view === 'ledger' && (
            <div className="space-y-3">
              <Btn variant="secondary" onClick={() => setView('overview')}>Back</Btn>
              {transactions.length === 0 ? (
                <p className="text-xs text-slate-500">No transactions.</p>
              ) : (
                <TableContainer>
                  <table className="w-full text-xs">
                    <TableHead><Th>Type</Th><Th>Amount</Th><Th>Reason</Th><Th>Date</Th></TableHead>
                    <tbody>
                      {transactions.map((tx, i) => (
                        <tr key={String(tx.id ?? i)} className="border-t border-white/[0.04]">
                          <Td><Badge color={tx.tx_type === 'issue' ? 'emerald' : tx.tx_type === 'spend' ? 'amber' : 'slate'}>{tx.tx_type}</Badge></Td>
                          <Td className="font-mono text-white">{tx.amount}</Td>
                          <Td className="text-slate-400">{tx.reason ?? '—'}</Td>
                          <Td className="text-slate-500">{new Date(tx.created_at).toLocaleDateString()}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableContainer>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

export default function Wallet() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('gift-cards')
  const [giftCards, setGiftCards] = useState<GiftCard[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newGC, setNewGC] = useState({ code: '', initial_value: '' })
  const [creatingGC, setCreatingGC] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)

  const loadGiftCards = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    try {
      const res = await getSdk().giftCards.list(activeStore.id)
      setGiftCards(res.gift_cards ?? [])
    } catch { setGiftCards([]) }
    setLoading(false)
  }, [activeStore])

  const loadCustomers = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    try {
      const res = await getSdk().customers.list(activeStore.id, { limit: 50 })
      setCustomers(res.customers ?? [])
    } catch { setCustomers([]) }
    setLoading(false)
  }, [activeStore])

  useEffect(() => {
    if (tab === 'gift-cards') void loadGiftCards()
    else void loadCustomers()
  }, [tab, loadGiftCards, loadCustomers])

  const createGiftCard = async () => {
    if (!newGC.code.trim() || !newGC.initial_value || !activeStore) return
    setCreatingGC(true)
    try {
      await getSdk().giftCards.create(activeStore.id, { initial_value: newGC.initial_value })
      setShowCreate(false); setNewGC({ code: '', initial_value: '' })
      await loadGiftCards()
      toast('Gift card created', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Create failed', 'error') }
    finally { setCreatingGC(false) }
  }

  const disableGiftCard = async (id: string) => {
    if (!activeStore) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/gift-cards/${id}/disable`, { method: 'POST', body: {} })
      setGiftCards(gc => gc.map(g => g.id === id ? { ...g, is_active: false } : g))
      toast('Gift card disabled', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Disable failed', 'error') }
  }

  const TABS = [
    { key: 'gift-cards' as Tab, label: 'Gift Cards' },
    { key: 'credits' as Tab, label: 'Store Credits' },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Wallet"
        description="Gift cards and store credits"
        actions={tab === 'gift-cards' ? <Btn onClick={() => setShowCreate(v => !v)}>+ Create Gift Card</Btn> : undefined}
      />

      <div className="flex border-b border-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${tab === t.key ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'gift-cards' && (
        <div className="space-y-4">
          {showCreate && (
            <Card>
              <div className="space-y-3">
                <p className="text-sm font-semibold text-white">New Gift Card</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormInput label="Code" value={newGC.code} onChange={v => setNewGC(g => ({ ...g, code: v.toUpperCase() }))} placeholder="GIFT-ABC123" />
                  <FormInput label="Value" value={newGC.initial_value} onChange={v => setNewGC(g => ({ ...g, initial_value: v }))} placeholder="100.00" type="number" />
                </div>
                <div className="flex gap-2">
                  <Btn onClick={createGiftCard} loading={creatingGC} variant="green">Create</Btn>
                  <Btn variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Btn>
                </div>
              </div>
            </Card>
          )}

          {loading ? <div className="flex justify-center py-8"><Spinner /></div> : giftCards.length === 0 ? (
            <EmptyState title="No gift cards" description="Create gift cards to offer as vouchers to customers" action="Create Gift Card" onAction={() => setShowCreate(true)} />
          ) : (
            <TableContainer>
              <table className="w-full text-sm">
                <TableHead><Th>Code</Th><Th>Initial</Th><Th>Balance</Th><Th>Status</Th><Th></Th></TableHead>
                <tbody>
                  {giftCards.map(gc => (
                    <tr key={gc.id} className="border-t border-white/[0.04]">
                      <Td className="font-mono text-slate-300">{gc.code}</Td>
                      <Td className="font-mono text-slate-400">{gc.initial_value}</Td>
                      <Td className="font-mono text-white">{gc.balance}</Td>
                      <Td><Badge color={gc.is_active ? 'emerald' : 'red'}>{gc.is_active ? 'Active' : 'Disabled'}</Badge></Td>
                      <Td>
                        {gc.is_active && (
                          <Btn variant="danger" onClick={() => void disableGiftCard(gc.id)}>Disable</Btn>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          )}
        </div>
      )}

      {tab === 'credits' && (
        loading ? <div className="flex justify-center py-8"><Spinner /></div> : customers.length === 0 ? (
          <EmptyState title="No customers" description="Customers appear here once they register. Click a customer to issue or adjust credits." />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Customer</Th><Th>Email</Th><Th></Th></TableHead>
              <tbody>
                {customers.map(c => (
                  <tr key={c.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                    <Td className="text-white">{c.first_name ?? ''} {c.last_name ?? ''}</Td>
                    <Td className="text-slate-400">{c.email}</Td>
                    <Td><Btn variant="secondary" onClick={() => setSelectedCustomer(c)}>Manage Credits</Btn></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {selectedCustomer && activeStore && (
        <CustomerCreditsModal
          storeId={activeStore.id}
          customer={selectedCustomer}
          onClose={() => setSelectedCustomer(null)}
        />
      )}
    </div>
  )
}
