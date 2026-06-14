import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, LoadError, PageHeader, EmptyState, Spinner, Modal,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

type Tab = 'plans' | 'subscriptions'

interface Plan {
  id: string; name: string; interval: string; interval_count: number;
  price: string; trial_days?: number; [k: string]: unknown
}

interface Sub {
  id: string; customer_id: string; plan_id: string; status: string;
  next_billing_at?: string; created_at: string; [k: string]: unknown
}

const SUB_STATUS: Record<string, { color: 'emerald' | 'amber' | 'red' | 'blue' | 'violet' | 'slate'; label: string }> = {
  active: { color: 'emerald', label: 'Active' },
  paused: { color: 'amber', label: 'Paused' },
  cancelled: { color: 'red', label: 'Cancelled' },
  trialing: { color: 'blue', label: 'Trial' },
  past_due: { color: 'red', label: 'Past Due' },
}

export default function Subscriptions() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('plans')
  const [plans, setPlans] = useState<Plan[]>([])
  const [subs, setSubs] = useState<Sub[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [planForm, setPlanForm] = useState({ name: '', interval: 'month', interval_count: '1', price: '', trial_days: '' })
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    const sdk = getSdk()
    try {
      const [plansRes, subsRes] = await Promise.allSettled([
        sdk.subscriptions.listPlans(activeStore.id),
        sdk.subscriptions.list(activeStore.id),
      ])
      if (plansRes.status === 'fulfilled') {
        setPlans((plansRes.value as { plans?: Plan[] }).plans ?? [])
      } else {
        const msg = plansRes.reason instanceof Error ? plansRes.reason.message : 'Failed to load plans'
        setLoadError(msg)
        toast(msg, 'error')
        setPlans([])
      }
      if (subsRes.status === 'fulfilled') {
        setSubs((subsRes.value as { subscriptions?: Sub[] }).subscriptions ?? [])
      } else {
        setSubs([])
      }
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  const createPlan = async () => {
    if (!activeStore || !planForm.name || !planForm.price) { toast('Name and price required', 'error'); return }
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: planForm.name,
        interval: planForm.interval,
        interval_count: Number(planForm.interval_count) || 1,
        price: planForm.price,
      }
      if (planForm.trial_days) body.trial_days = Number(planForm.trial_days)
      await getSdk().subscriptions.createPlan(activeStore.id, body as Parameters<ReturnType<typeof getSdk>['subscriptions']['createPlan']>[1])
      toast('Plan created', 'success')
      setShowCreate(false)
      setPlanForm({ name: '', interval: 'month', interval_count: '1', price: '', trial_days: '' })
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Create failed', 'error') }
    finally { setSaving(false) }
  }

  const subAction = async (subId: string, action: string) => {
    if (!activeStore) return
    setActing(subId)
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/subscriptions/${subId}/${action}`, { method: 'POST', body: {} })
      toast(`Subscription ${action}d`, 'success')
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : `${action} failed`, 'error') }
    finally { setActing(null) }
  }

  const TABS = [
    { key: 'plans' as Tab, label: 'Plans' },
    { key: 'subscriptions' as Tab, label: 'Subscriptions' },
  ]

  const setField = (k: keyof typeof planForm) => (v: string) => setPlanForm(f => ({ ...f, [k]: v }))

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Subscriptions"
        description="Subscription plans and active subscriptions"
        actions={tab === 'plans' ? <Btn onClick={() => setShowCreate(v => !v)}>+ New Plan</Btn> : undefined}
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

      {tab === 'plans' && (
        <div className="space-y-4">
          {showCreate && (
            <Card>
              <div className="space-y-3">
                <p className="text-sm font-semibold text-white">New Subscription Plan</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormInput label="Name" value={planForm.name} onChange={setField('name')} placeholder="Monthly Pro" />
                  <FormInput label="Price" value={planForm.price} onChange={setField('price')} placeholder="29.99" type="number" />
                  <FormSelect label="Interval" value={planForm.interval} onChange={setField('interval')}
                    options={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly' }]} />
                  <FormInput label="Interval Count" value={planForm.interval_count} onChange={setField('interval_count')} placeholder="1" type="number" />
                  <FormInput label="Trial Days" value={planForm.trial_days} onChange={setField('trial_days')} placeholder="14" type="number" />
                </div>
                <div className="flex gap-2">
                  <Btn onClick={createPlan} loading={saving} variant="green">Create</Btn>
                  <Btn variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Btn>
                </div>
              </div>
            </Card>
          )}
          {plans.length === 0 ? (
            <EmptyState title="No subscription plans" description="Create plans to offer recurring billing to customers" action="New Plan" onAction={() => setShowCreate(true)} />
          ) : (
            <TableContainer>
              <table className="w-full text-sm">
                <TableHead><Th>Name</Th><Th>Price</Th><Th>Interval</Th><Th>Trial</Th></TableHead>
                <tbody>
                  {plans.map(p => (
                    <tr key={p.id} className="border-t border-white/[0.04]">
                      <Td className="text-white">{p.name}</Td>
                      <Td className="font-mono text-slate-300">{p.price}</Td>
                      <Td className="text-slate-400">every {p.interval_count} {p.interval}{p.interval_count > 1 ? 's' : ''}</Td>
                      <Td className="text-slate-500">{p.trial_days ? `${p.trial_days} days` : '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          )}
        </div>
      )}

      {tab === 'subscriptions' && (
        subs.length === 0 ? (
          <EmptyState title="No subscriptions" description="Customer subscriptions will appear here" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Customer</Th><Th>Plan</Th><Th>Status</Th><Th>Next Billing</Th><Th></Th></TableHead>
              <tbody>
                {subs.map(s => {
                  const st = SUB_STATUS[s.status] ?? { color: 'slate' as const, label: s.status }
                  const planName = plans.find(p => p.id === s.plan_id)?.name ?? s.plan_id.slice(0, 8)
                  return (
                    <tr key={s.id} className="border-t border-white/[0.04]">
                      <Td className="font-mono text-xs text-slate-400">{s.customer_id.slice(0, 8)}</Td>
                      <Td className="text-slate-300">{planName}</Td>
                      <Td><Badge color={st.color}>{st.label}</Badge></Td>
                      <Td className="text-slate-400 text-xs">
                        {s.next_billing_at ? new Date(s.next_billing_at).toLocaleDateString() : '—'}
                      </Td>
                      <Td>
                        <div className="flex gap-1">
                          {s.status === 'active' && (
                            <>
                              <Btn variant="secondary" loading={acting === s.id} onClick={() => void subAction(s.id, 'pause')}>Pause</Btn>
                              <Btn variant="secondary" loading={acting === s.id} onClick={() => void subAction(s.id, 'bill')}>Bill Now</Btn>
                              <Btn variant="danger" loading={acting === s.id} onClick={() => void subAction(s.id, 'cancel')}>Cancel</Btn>
                            </>
                          )}
                          {s.status === 'paused' && (
                            <Btn variant="green" loading={acting === s.id} onClick={() => void subAction(s.id, 'resume')}>Resume</Btn>
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
    </div>
  )
}
