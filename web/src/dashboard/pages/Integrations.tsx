import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner, Modal,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

type Tab = 'integrations' | 'pixels' | 'feeds'

interface Definition {
  id: string; name: string; type: string; description?: string; [k: string]: unknown
}

interface Integration {
  id: string; integration_definition_id: string; name?: string;
  is_active?: boolean; created_at: string; [k: string]: unknown
}

interface Pixel {
  id: string; name: string; type: string; pixel_id?: string;
  is_active?: boolean; created_at: string; [k: string]: unknown
}

interface MerchantFeed {
  id: string; name: string; feed_type: string; is_active?: boolean;
  created_at: string; [k: string]: unknown
}

function AddIntegrationModal({ storeId, definitions, onClose, onSaved }: {
  storeId: string; definitions: Definition[]; onClose: () => void; onSaved: () => void
}) {
  const { toast } = useToast()
  const [defId, setDefId] = useState(definitions[0]?.id ?? '')
  const [credentials, setCredentials] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!defId) { toast('Select an integration', 'error'); return }
    setSaving(true)
    try {
      let creds: unknown = {}
      if (credentials.trim()) {
        try { creds = JSON.parse(credentials) } catch { toast('Credentials must be valid JSON', 'error'); setSaving(false); return }
      }
      await getSdk().integrations.create(storeId, { integration_definition_id: defId, credentials: creds })
      toast('Integration added', 'success')
      onSaved(); onClose()
    } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="Add Integration" onClose={onClose}>
      <div className="space-y-4">
        <FormSelect
          label="Integration"
          value={defId}
          onChange={setDefId}
          options={definitions.map(d => ({ value: d.id, label: d.name }))}
        />
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Credentials (JSON)</label>
          <textarea
            value={credentials}
            onChange={e => setCredentials(e.target.value)}
            placeholder='{"api_key": "..."}'
            rows={4}
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-white/20 focus:outline-none font-mono"
          />
        </div>
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving} variant="green">Add</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

function AddPixelModal({ storeId, onClose, onSaved }: { storeId: string; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast()
  const [form, setForm] = useState({ name: '', type: 'ga4', pixel_id: '' })
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    if (!form.name || !form.pixel_id) { toast('Name and Pixel ID required', 'error'); return }
    setSaving(true)
    try {
      await getSdk().request(`/commerce/stores/${storeId}/tracking-pixels`, {
        method: 'POST',
        body: { name: form.name, type: form.type, pixel_id: form.pixel_id },
      })
      toast('Pixel added', 'success')
      onSaved(); onClose()
    } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title="Add Tracking Pixel" onClose={onClose}>
      <div className="space-y-4">
        <FormInput label="Name" value={form.name} onChange={set('name')} placeholder="Google Analytics 4" />
        <FormSelect label="Type" value={form.type} onChange={set('type')}
          options={[
            { value: 'ga4', label: 'Google Analytics 4' },
            { value: 'facebook', label: 'Facebook Pixel' },
            { value: 'gtm', label: 'Google Tag Manager' },
            { value: 'tiktok', label: 'TikTok Pixel' },
            { value: 'custom', label: 'Custom' },
          ]} />
        <FormInput label="Pixel / Measurement ID" value={form.pixel_id} onChange={set('pixel_id')} placeholder="G-XXXXXXXXXX" />
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving} variant="green">Add</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function Integrations() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('integrations')
  const [definitions, setDefinitions] = useState<Definition[]>([])
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [pixels, setPixels] = useState<Pixel[]>([])
  const [feeds, setFeeds] = useState<MerchantFeed[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [showAddPixel, setShowAddPixel] = useState(false)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    try {
      const [defRes, intRes, pixelsRes, feedsRes] = await Promise.allSettled([
        sdk.integrations.listDefinitions(),
        sdk.integrations.list(activeStore.id),
        sdk.integrations.listPixels(activeStore.id),
        sdk.feeds.listMerchantFeeds(activeStore.id),
      ])
      if (defRes.status === 'fulfilled') setDefinitions((defRes.value as { definitions?: Definition[] }).definitions ?? [])
      else setDefinitions([])
      if (intRes.status === 'fulfilled') {
        setIntegrations((intRes.value as { integrations?: Integration[] }).integrations ?? [])
      } else {
        toast(intRes.reason instanceof Error ? intRes.reason.message : 'Failed to load integrations', 'error')
        setIntegrations([])
      }
      if (pixelsRes.status === 'fulfilled') setPixels((pixelsRes.value as { pixels?: Pixel[] }).pixels ?? [])
      else setPixels([])
      if (feedsRes.status === 'fulfilled') setFeeds((feedsRes.value as { feeds?: MerchantFeed[] }).feeds ?? [])
      else setFeeds([])
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  const deleteIntegration = async (id: string) => {
    if (!activeStore || !confirm('Remove this integration?')) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/integrations/${id}`, { method: 'DELETE' })
      setIntegrations(i => i.filter(x => x.id !== id))
      toast('Removed', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Remove failed', 'error') }
  }

  const deletePixel = async (id: string) => {
    if (!activeStore || !confirm('Remove this pixel?')) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/tracking-pixels/${id}`, { method: 'DELETE' })
      setPixels(p => p.filter(x => x.id !== id))
      toast('Removed', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Remove failed', 'error') }
  }

  const TABS = [
    { key: 'integrations' as Tab, label: 'Integrations' },
    { key: 'pixels' as Tab, label: 'Tracking Pixels' },
    { key: 'feeds' as Tab, label: 'Merchant Feeds' },
  ]

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Integrations"
        description="Connect third-party services, tracking pixels, and merchant feeds"
        actions={
          tab === 'integrations' ? <Btn onClick={() => setShowAdd(true)}>+ Add Integration</Btn> :
          tab === 'pixels' ? <Btn onClick={() => setShowAddPixel(true)}>+ Add Pixel</Btn> : undefined
        }
      />

      <div className="flex border-b border-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${tab === t.key ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'integrations' && (
        integrations.length === 0 ? (
          <EmptyState title="No integrations" description={`${definitions.length} integrations available`} action="Add Integration" onAction={() => setShowAdd(true)} />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Integration</Th><Th>Status</Th><Th>Added</Th><Th></Th></TableHead>
              <tbody>
                {integrations.map(intg => {
                  const def = definitions.find(d => d.id === intg.integration_definition_id)
                  return (
                    <tr key={intg.id} className="border-t border-white/[0.04]">
                      <Td className="text-white">{def?.name ?? intg.name ?? intg.integration_definition_id}</Td>
                      <Td><Badge color={intg.is_active !== false ? 'emerald' : 'slate'}>{intg.is_active !== false ? 'Active' : 'Inactive'}</Badge></Td>
                      <Td className="text-slate-500 text-xs">{new Date(intg.created_at).toLocaleDateString()}</Td>
                      <Td><Btn variant="danger" onClick={() => void deleteIntegration(intg.id)}>Remove</Btn></Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {tab === 'pixels' && (
        pixels.length === 0 ? (
          <EmptyState title="No tracking pixels" description="Add GA4, Facebook, GTM, or custom pixels" action="Add Pixel" onAction={() => setShowAddPixel(true)} />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Name</Th><Th>Type</Th><Th>Pixel ID</Th><Th>Status</Th><Th></Th></TableHead>
              <tbody>
                {pixels.map(px => (
                  <tr key={px.id} className="border-t border-white/[0.04]">
                    <Td className="text-white">{px.name}</Td>
                    <Td><Badge color="blue">{px.type}</Badge></Td>
                    <Td className="font-mono text-xs text-slate-400">{px.pixel_id ?? '—'}</Td>
                    <Td><Badge color={px.is_active !== false ? 'emerald' : 'slate'}>{px.is_active !== false ? 'Active' : 'Off'}</Badge></Td>
                    <Td><Btn variant="danger" onClick={() => void deletePixel(px.id)}>Remove</Btn></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {tab === 'feeds' && (
        feeds.length === 0 ? (
          <EmptyState title="No merchant feeds" description="Configure Google Shopping and Facebook catalog feed settings" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Name</Th><Th>Type</Th><Th>Status</Th><Th>Created</Th></TableHead>
              <tbody>
                {feeds.map(f => (
                  <tr key={f.id} className="border-t border-white/[0.04]">
                    <Td className="text-white">{f.name}</Td>
                    <Td><Badge color="violet">{f.feed_type}</Badge></Td>
                    <Td><Badge color={f.is_active !== false ? 'emerald' : 'slate'}>{f.is_active !== false ? 'Active' : 'Off'}</Badge></Td>
                    <Td className="text-slate-500 text-xs">{new Date(f.created_at).toLocaleDateString()}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

      {showAdd && activeStore && (
        <AddIntegrationModal
          storeId={activeStore.id}
          definitions={definitions}
          onClose={() => setShowAdd(false)}
          onSaved={() => void load()}
        />
      )}

      {showAddPixel && activeStore && (
        <AddPixelModal
          storeId={activeStore.id}
          onClose={() => setShowAddPixel(false)}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
