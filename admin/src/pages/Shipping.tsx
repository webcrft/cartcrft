import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner, Modal,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

type Tab = 'zones' | 'providers' | 'collection-points'

interface Zone { id: string; name: string; [k: string]: unknown }
interface Rate { id: string; name: string; price: string; [k: string]: unknown }
interface Provider { id: string; name: string; type: string; [k: string]: unknown }
interface CollectionPoint { id: string; name: string; address?: string; [k: string]: unknown }

function BobGoModal({ storeId, provider, onClose, onSaved }: {
  storeId: string; provider: Provider | null; onClose: () => void; onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({ name: provider?.name ?? 'BobGo', api_key: '', account_id: '' })
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))
  const handleSave = async () => {
    setSaving(true)
    try {
      const sdk = getSdk()
      const body = { name: form.name, type: 'webhook', config: { provider: 'bobgo', api_key: form.api_key, account_id: form.account_id } }
      if (provider?.id) {
        await sdk.request(`/commerce/stores/${storeId}/shipping-providers/${provider.id}`, { method: 'PUT', body })
      } else {
        await sdk.request(`/commerce/stores/${storeId}/shipping-providers`, { method: 'POST', body })
      }
      toast('BobGo config saved', 'success')
      onSaved(); onClose()
    } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error') }
    finally { setSaving(false) }
  }
  return (
    <Modal title="BobGo Configuration" onClose={onClose}>
      <div className="space-y-4">
        <FormInput label="Provider Name" value={form.name} onChange={set('name')} />
        <FormInput label="API Key" value={form.api_key} onChange={set('api_key')} type="password" placeholder="bobgo_..." />
        <FormInput label="Account ID" value={form.account_id} onChange={set('account_id')} placeholder="acc_123" />
        <p className="text-xs text-slate-500">BobGo provides live shipping rates and label generation. Get your API key at app.bobgo.co.za.</p>
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving}>Save</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

function AddRateModal({ storeId, zoneId, onClose, onSaved }: {
  storeId: string; zoneId: string; onClose: () => void; onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({ name: '', price: '', min_weight_g: '', max_weight_g: '', min_order_total: '', max_order_total: '' })
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))
  const handleSave = async () => {
    if (!form.name.trim()) { toast('Name required', 'error'); return }
    setSaving(true)
    try {
      const sdk = getSdk()
      const body: Record<string, unknown> = { name: form.name.trim(), price: form.price || '0' }
      if (form.min_weight_g) body.min_weight_g = Number(form.min_weight_g)
      if (form.max_weight_g) body.max_weight_g = Number(form.max_weight_g)
      if (form.min_order_total) body.min_order_total = form.min_order_total
      if (form.max_order_total) body.max_order_total = form.max_order_total
      await sdk.request(`/commerce/stores/${storeId}/shipping-zones/${zoneId}/rates`, { method: 'POST', body })
      toast('Rate added', 'success')
      onSaved(); onClose()
    } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error') }
    finally { setSaving(false) }
  }
  return (
    <Modal title="Add Shipping Rate" onClose={onClose}>
      <div className="space-y-3">
        <FormInput label="Name" value={form.name} onChange={set('name')} placeholder="Standard Shipping" />
        <FormInput label="Price" value={form.price} onChange={set('price')} placeholder="9.99" type="number" />
        <div className="grid grid-cols-2 gap-3">
          <FormInput label="Min Weight (g)" value={form.min_weight_g} onChange={set('min_weight_g')} placeholder="0" type="number" />
          <FormInput label="Max Weight (g)" value={form.max_weight_g} onChange={set('max_weight_g')} placeholder="5000" type="number" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormInput label="Min Order Total" value={form.min_order_total} onChange={set('min_order_total')} placeholder="0" />
          <FormInput label="Max Order Total" value={form.max_order_total} onChange={set('max_order_total')} placeholder="500" />
        </div>
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving}>Add Rate</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function Shipping() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('zones')
  const [zones, setZones] = useState<Zone[]>([])
  const [rates, setRates] = useState<Record<string, Rate[]>>({})
  const [expandedZone, setExpandedZone] = useState<string | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [collectionPoints, setCollectionPoints] = useState<CollectionPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateZone, setShowCreateZone] = useState(false)
  const [newZone, setNewZone] = useState({ name: '', countries: '' })
  const [creatingZone, setCreatingZone] = useState(false)
  const [addRateZoneId, setAddRateZoneId] = useState<string | null>(null)
  const [bobGoModal, setBobGoModal] = useState<Provider | null | undefined>(undefined)

  const loadZones = useCallback(async () => {
    if (!activeStore) return
    const sdk = getSdk()
    try {
      const res = await sdk.request<{ zones: Zone[] }>(`/commerce/stores/${activeStore.id}/shipping-zones`)
      setZones((res as { zones?: Zone[] }).zones ?? [])
    } catch { setZones([]) }
  }, [activeStore])

  const loadRates = useCallback(async (zoneId: string) => {
    if (!activeStore) return
    const sdk = getSdk()
    try {
      const res = await sdk.request<{ rates: Rate[] }>(`/commerce/stores/${activeStore.id}/shipping-zones/${zoneId}/rates`)
      setRates(r => ({ ...r, [zoneId]: (res as { rates?: Rate[] }).rates ?? [] }))
    } catch {}
  }, [activeStore])

  const loadProviders = useCallback(async () => {
    if (!activeStore) return
    const sdk = getSdk()
    try {
      const res = await sdk.request<{ providers: Provider[] }>(`/commerce/stores/${activeStore.id}/shipping-providers`)
      setProviders((res as { providers?: Provider[] }).providers ?? [])
    } catch { setProviders([]) }
  }, [activeStore])

  const loadCollectionPoints = useCallback(async () => {
    if (!activeStore) return
    const sdk = getSdk()
    try {
      const res = await sdk.request<{ collection_points: CollectionPoint[] }>(`/commerce/stores/${activeStore.id}/collection-points`)
      setCollectionPoints((res as { collection_points?: CollectionPoint[] }).collection_points ?? [])
    } catch { setCollectionPoints([]) }
  }, [activeStore])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await loadZones()
      setLoading(false)
    })()
  }, [loadZones])

  useEffect(() => {
    if (tab === 'providers') void loadProviders()
    if (tab === 'collection-points') void loadCollectionPoints()
  }, [tab, loadProviders, loadCollectionPoints])

  const toggleZone = (zoneId: string) => {
    if (expandedZone === zoneId) { setExpandedZone(null); return }
    setExpandedZone(zoneId)
    if (!rates[zoneId]) void loadRates(zoneId)
  }

  const createZone = async () => {
    if (!newZone.name.trim() || !activeStore) return
    setCreatingZone(true)
    try {
      const sdk = getSdk()
      const countries = newZone.countries.split(',').map(c => c.trim().toUpperCase()).filter(Boolean)
      await sdk.shipping.createZone(activeStore.id, {
        name: newZone.name.trim(),
        regions: countries.map(c => ({ country_code: c })),
      })
      setShowCreateZone(false); setNewZone({ name: '', countries: '' })
      await loadZones()
      toast('Shipping zone created', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Create failed', 'error') }
    finally { setCreatingZone(false) }
  }

  const deleteZone = async (zoneId: string) => {
    if (!activeStore || !confirm('Delete this shipping zone?')) return
    try {
      const sdk = getSdk()
      await sdk.request(`/commerce/stores/${activeStore.id}/shipping-zones/${zoneId}`, { method: 'DELETE' })
      setZones(z => z.filter(zn => zn.id !== zoneId))
      toast('Zone deleted', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Delete failed', 'error') }
  }

  const deleteRate = async (zoneId: string, rateId: string) => {
    if (!activeStore) return
    try {
      const sdk = getSdk()
      await sdk.request(`/commerce/stores/${activeStore.id}/shipping-zones/${zoneId}/rates/${rateId}`, { method: 'DELETE' })
      setRates(r => ({ ...r, [zoneId]: (r[zoneId] ?? []).filter(rt => rt.id !== rateId) }))
      toast('Rate deleted', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Delete failed', 'error') }
  }

  const TABS = [
    { key: 'zones' as Tab, label: 'Zones & Rates' },
    { key: 'providers' as Tab, label: 'Providers' },
    { key: 'collection-points' as Tab, label: 'Collection Points' },
  ]

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Shipping"
        description="Zones, rates, and shipping providers"
        actions={tab === 'zones' ? <Btn onClick={() => setShowCreateZone(v => !v)}>+ Add Zone</Btn> : tab === 'providers' ? <Btn onClick={() => setBobGoModal(null)}>+ Add BobGo</Btn> : undefined}
      />

      <div className="flex border-b border-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${tab === t.key ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'zones' && (
        <div className="space-y-4">
          {showCreateZone && (
            <Card>
              <div className="space-y-3">
                <p className="text-sm font-semibold text-white">New Shipping Zone</p>
                <div className="grid grid-cols-2 gap-3">
                  <FormInput label="Zone Name" value={newZone.name} onChange={v => setNewZone(z => ({ ...z, name: v }))} placeholder="Worldwide" />
                  <FormInput label="Countries (CSV)" value={newZone.countries} onChange={v => setNewZone(z => ({ ...z, countries: v }))} placeholder="ZA, NG, KE or *" />
                </div>
                <div className="flex gap-2">
                  <Btn onClick={createZone} loading={creatingZone} variant="green">Create</Btn>
                  <Btn variant="secondary" onClick={() => setShowCreateZone(false)}>Cancel</Btn>
                </div>
              </div>
            </Card>
          )}
          {zones.length === 0 ? (
            <EmptyState title="No shipping zones" description="Create zones to define where you ship and at what rates" action="Add Zone" onAction={() => setShowCreateZone(true)} />
          ) : (
            <div className="space-y-3">
              {zones.map(zone => (
                <div key={zone.id} className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-white/[0.02] transition" onClick={() => toggleZone(zone.id)}>
                    <p className="text-sm font-semibold text-white">{zone.name}</p>
                    <div className="flex items-center gap-2">
                      <span onClick={e => e.stopPropagation()}><Btn variant="danger" onClick={() => void deleteZone(zone.id)}>Delete</Btn></span>
                      <span className="text-slate-500 text-xs">{expandedZone === zone.id ? '▲' : '▼'}</span>
                    </div>
                  </div>
                  {expandedZone === zone.id && (
                    <div className="border-t border-white/[0.06] px-5 py-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-slate-400">Rates</p>
                        <Btn variant="secondary" onClick={() => setAddRateZoneId(zone.id)}>+ Add Rate</Btn>
                      </div>
                      {rates[zone.id] && rates[zone.id].length > 0 ? (
                        <TableContainer>
                          <table className="w-full text-sm">
                            <TableHead>
                              <Th>Name</Th><Th>Price</Th><Th>Weight (g)</Th><Th></Th>
                            </TableHead>
                            <tbody>
                              {rates[zone.id].map(rate => (
                                <tr key={rate.id} className="border-t border-white/[0.04]">
                                  <Td className="text-white">{rate.name}</Td>
                                  <Td className="font-mono text-slate-300">{rate.price}</Td>
                                  <Td className="text-slate-400 text-xs">
                                    {rate.min_weight_g != null || rate.max_weight_g != null
                                      ? `${rate.min_weight_g ?? 0}–${rate.max_weight_g ?? '∞'}`
                                      : 'Any'}
                                  </Td>
                                  <Td><Btn variant="danger" onClick={() => void deleteRate(zone.id, rate.id)}>Remove</Btn></Td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </TableContainer>
                      ) : (
                        <p className="text-xs text-slate-500">No rates yet.</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'providers' && (
        <div className="space-y-3">
          {providers.length === 0 ? (
            <EmptyState title="No shipping providers" description="Connect BobGo for live rates and label generation" action="Add BobGo" onAction={() => setBobGoModal(null)} />
          ) : (
            <TableContainer>
              <table className="w-full text-sm">
                <TableHead><Th>Name</Th><Th>Type</Th><Th></Th></TableHead>
                <tbody>
                  {providers.map(p => (
                    <tr key={p.id} className="border-t border-white/[0.04]">
                      <Td className="text-white">{p.name}</Td>
                      <Td><Badge color="blue">{p.type}</Badge></Td>
                      <Td><Btn variant="secondary" onClick={() => setBobGoModal(p)}>Configure</Btn></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          )}
        </div>
      )}

      {tab === 'collection-points' && (
        collectionPoints.length === 0 ? (
          <EmptyState title="No collection points" description="Add PUDO or other collection points for click-and-collect" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Name</Th><Th>Address</Th></TableHead>
              <tbody>
                {collectionPoints.map((cp, i) => (
                  <tr key={String(cp.id ?? i)} className="border-t border-white/[0.04]">
                    <Td className="text-white">{cp.name}</Td>
                    <Td className="text-slate-400">{cp.address ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {addRateZoneId && activeStore && (
        <AddRateModal
          storeId={activeStore.id}
          zoneId={addRateZoneId}
          onClose={() => setAddRateZoneId(null)}
          onSaved={() => void loadRates(addRateZoneId)}
        />
      )}

      {bobGoModal !== undefined && activeStore && (
        <BobGoModal
          storeId={activeStore.id}
          provider={bobGoModal}
          onClose={() => setBobGoModal(undefined)}
          onSaved={() => void loadProviders()}
        />
      )}
    </div>
  )
}
