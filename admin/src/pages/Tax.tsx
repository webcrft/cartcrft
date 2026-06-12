import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner, Modal,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

type Tab = 'categories' | 'zones' | 'rates'

interface TaxCategory { id: string; name: string; code: string; [k: string]: unknown }
interface TaxZone { id: string; name: string; [k: string]: unknown }
interface TaxRate { id: string; name: string; rate: string; zone_id: string; is_inclusive: boolean; [k: string]: unknown }

export default function Tax() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('categories')
  const [categories, setCategories] = useState<TaxCategory[]>([])
  const [zones, setZones] = useState<TaxZone[]>([])
  const [rates, setRates] = useState<TaxRate[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', code: '', rate: '', zone_id: '', is_inclusive: 'false' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!activeStore) return
    const sdk = getSdk()
    setLoading(true)
    try {
      const [catRes, zoneRes] = await Promise.all([
        sdk.tax.listCategories(activeStore.id),
        sdk.tax.listZones(activeStore.id),
      ])
      setCategories((catRes as { categories?: TaxCategory[] }).categories ?? [])
      setZones((zoneRes as { zones?: TaxZone[] }).zones ?? [])
    } catch { setCategories([]); setZones([]) }
    try {
      const rateRes = await sdk.request<{ rates: TaxRate[] }>(`/commerce/stores/${activeStore.id}/tax/rates`)
      setRates((rateRes as { rates?: TaxRate[] }).rates ?? [])
    } catch { setRates([]) }
    setLoading(false)
  }, [activeStore])

  useEffect(() => { void load() }, [load])

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleCreate = async () => {
    if (!activeStore) return
    setSaving(true)
    try {
      const sdk = getSdk()
      if (tab === 'categories') {
        if (!form.name || !form.code) { toast('Name and code required', 'error'); return }
        await sdk.request(`/commerce/stores/${activeStore.id}/tax/categories`, { method: 'POST', body: { name: form.name, code: form.code } })
        toast('Tax category created', 'success')
      } else if (tab === 'zones') {
        if (!form.name) { toast('Name required', 'error'); return }
        await sdk.request(`/commerce/stores/${activeStore.id}/tax/zones`, { method: 'POST', body: { name: form.name } })
        toast('Tax zone created', 'success')
      } else {
        if (!form.name || !form.rate || !form.zone_id) { toast('Name, rate, zone required', 'error'); return }
        await sdk.request(`/commerce/stores/${activeStore.id}/tax/zones/${form.zone_id}/rates`, {
          method: 'POST',
          body: { name: form.name, rate: form.rate, is_inclusive: form.is_inclusive === 'true' },
        })
        toast('Tax rate created', 'success')
      }
      setShowCreate(false)
      setForm({ name: '', code: '', rate: '', zone_id: '', is_inclusive: 'false' })
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Create failed', 'error') }
    finally { setSaving(false) }
  }

  const deleteCategory = async (id: string) => {
    if (!activeStore || !confirm('Delete tax category?')) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/tax/categories/${id}`, { method: 'DELETE' })
      setCategories(c => c.filter(x => x.id !== id))
      toast('Deleted', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Delete failed', 'error') }
  }

  const TABS = [
    { key: 'categories' as Tab, label: 'Categories' },
    { key: 'zones' as Tab, label: 'Zones' },
    { key: 'rates' as Tab, label: 'Rates' },
  ]

  const zoneOptions = zones.map(z => ({ value: z.id, label: z.name }))

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Tax"
        description="Manage tax categories, zones, and rates"
        actions={<Btn onClick={() => setShowCreate(v => !v)}>+ Add</Btn>}
      />

      <div className="flex border-b border-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${tab === t.key ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {showCreate && (
        <Card>
          <div className="space-y-3">
            <p className="text-sm font-semibold text-white">
              {tab === 'categories' ? 'New Tax Category' : tab === 'zones' ? 'New Tax Zone' : 'New Tax Rate'}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <FormInput label="Name" value={form.name} onChange={set('name')} placeholder="Standard Rate" />
              {tab === 'categories' && <FormInput label="Code" value={form.code} onChange={set('code')} placeholder="standard" />}
              {tab === 'rates' && (
                <>
                  <FormInput label="Rate (%)" value={form.rate} onChange={set('rate')} placeholder="15" type="number" />
                  {zoneOptions.length > 0 && <FormSelect label="Tax Zone" value={form.zone_id} onChange={set('zone_id')} options={[{ value: '', label: 'Select zone' }, ...zoneOptions]} />}
                  <FormSelect label="Type" value={form.is_inclusive} onChange={set('is_inclusive')} options={[{ value: 'false', label: 'Exclusive' }, { value: 'true', label: 'Inclusive' }]} />
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Btn onClick={handleCreate} loading={saving} variant="green">Create</Btn>
              <Btn variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Btn>
            </div>
          </div>
        </Card>
      )}

      {tab === 'categories' && (
        categories.length === 0 ? (
          <EmptyState title="No tax categories" description="Create tax categories like Standard Rate, Zero Rated, Exempt" action="Add Category" onAction={() => setShowCreate(true)} />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Name</Th><Th>Code</Th><Th></Th></TableHead>
              <tbody>
                {categories.map(c => (
                  <tr key={c.id} className="border-t border-white/[0.04]">
                    <Td className="text-white">{c.name}</Td>
                    <Td><Badge color="slate">{c.code}</Badge></Td>
                    <Td><Btn variant="danger" onClick={() => void deleteCategory(c.id)}>Delete</Btn></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {tab === 'zones' && (
        zones.length === 0 ? (
          <EmptyState title="No tax zones" description="Create tax zones by region to apply different rates" action="Add Zone" onAction={() => setShowCreate(true)} />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Name</Th><Th>Rates</Th></TableHead>
              <tbody>
                {zones.map(z => (
                  <tr key={z.id} className="border-t border-white/[0.04]">
                    <Td className="text-white">{z.name}</Td>
                    <Td className="text-slate-400 text-xs">
                      {rates.filter(r => r.zone_id === z.id).length} rates
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {tab === 'rates' && (
        rates.length === 0 ? (
          <EmptyState title="No tax rates" description="Add rates to your tax zones" action="Add Rate" onAction={() => setShowCreate(true)} />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Name</Th><Th>Rate</Th><Th>Zone</Th><Th>Type</Th></TableHead>
              <tbody>
                {rates.map(r => (
                  <tr key={r.id} className="border-t border-white/[0.04]">
                    <Td className="text-white">{r.name}</Td>
                    <Td className="font-mono text-slate-300">{r.rate}%</Td>
                    <Td className="text-slate-400 text-xs">{zones.find(z => z.id === r.zone_id)?.name ?? r.zone_id}</Td>
                    <Td><Badge color={r.is_inclusive ? 'blue' : 'amber'}>{r.is_inclusive ? 'Inclusive' : 'Exclusive'}</Badge></Td>
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
