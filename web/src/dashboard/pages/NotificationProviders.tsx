import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, LoadError, Spinner, Modal,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

interface NotifProvider {
  id: string; name: string; type: string; events?: string[];
  is_active?: boolean; created_at: string; [k: string]: unknown
}

const NOTIF_EVENTS = [
  'order.created', 'order.paid', 'order.shipped', 'order.delivered', 'order.cancelled',
  'return.requested', 'return.approved',
  'customer.registered', 'customer.password_reset',
  'subscription.created', 'subscription.renewed', 'subscription.cancelled',
]

function ProviderModal({ storeId, provider, onClose, onSaved }: {
  storeId: string; provider: NotifProvider | null; onClose: () => void; onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({
    name: provider?.name ?? '',
    type: provider?.type ?? 'webhook',
    webhook_url: '',
  })
  const [selectedEvents, setSelectedEvents] = useState<string[]>(provider?.events ?? [])
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const toggleEvent = (e: string) =>
    setSelectedEvents(ev => ev.includes(e) ? ev.filter(x => x !== e) : [...ev, e])

  const handleSave = async () => {
    if (!form.name) { toast('Name required', 'error'); return }
    setSaving(true)
    try {
      const sdk = getSdk()
      const config = form.type === 'webhook' ? { url: form.webhook_url } : {}
      if (provider?.id) {
        await sdk.request(`/commerce/stores/${storeId}/notification-providers/${provider.id}`, {
          method: 'PUT', body: { name: form.name, type: form.type, config, events: selectedEvents },
        })
      } else {
        await sdk.request(`/commerce/stores/${storeId}/notification-providers`, {
          method: 'POST', body: { name: form.name, type: form.type, config, events: selectedEvents },
        })
      }
      toast(provider?.id ? 'Provider updated' : 'Provider created', 'success')
      onSaved(); onClose()
    } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  return (
    <Modal title={provider?.id ? 'Edit Provider' : 'New Notification Provider'} onClose={onClose}>
      <div className="space-y-4">
        <FormInput label="Name" value={form.name} onChange={set('name')} placeholder="Order Webhook" />
        <FormSelect label="Type" value={form.type} onChange={set('type')}
          options={[
            { value: 'webhook', label: 'Webhook' },
            { value: 'email', label: 'Email' },
            { value: 'sms', label: 'SMS' },
            { value: 'whatsapp', label: 'WhatsApp' },
          ]} />
        {form.type === 'webhook' && (
          <FormInput label="Webhook URL" value={form.webhook_url} onChange={set('webhook_url')} placeholder="https://example.com/hooks" type="url" />
        )}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-2">Events</label>
          <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
            {NOTIF_EVENTS.map(ev => (
              <label key={ev} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedEvents.includes(ev)}
                  onChange={() => toggleEvent(ev)}
                  className="rounded border-white/20 bg-white/5 text-violet-500"
                />
                <span className="text-xs text-slate-300">{ev}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving} variant="green">Save</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function NotificationProviders() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [providers, setProviders] = useState<NotifProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modal, setModal] = useState<NotifProvider | null | undefined>(undefined)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    try {
      const res = await getSdk().notifications.listProviders(activeStore.id)
      setProviders((res as { providers?: NotifProvider[] }).providers ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load notification providers'
      setLoadError(msg)
      toast(msg, 'error')
      setProviders([])
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  const deleteProvider = async (id: string) => {
    if (!activeStore || !confirm('Delete this notification provider?')) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/notification-providers/${id}`, { method: 'DELETE' })
      setProviders(p => p.filter(x => x.id !== id))
      toast('Deleted', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Delete failed', 'error') }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notification Providers"
        description="Webhook, email, SMS, and WhatsApp notification providers"
        actions={<Btn onClick={() => setModal(null)}>+ Add Provider</Btn>}
      />

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      {!loadError && providers.length === 0 ? (
        <EmptyState
          title="No notification providers"
          description="Add providers to receive webhooks or send emails/SMS on commerce events"
          action="Add Provider"
          onAction={() => setModal(null)}
        />
      ) : !loadError ? (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead><Th>Name</Th><Th>Type</Th><Th>Events</Th><Th>Status</Th><Th></Th></TableHead>
            <tbody>
              {providers.map(p => (
                <tr key={p.id} className="border-t border-white/[0.04]">
                  <Td className="text-white">{p.name}</Td>
                  <Td><Badge color="blue">{p.type}</Badge></Td>
                  <Td className="text-slate-400 text-xs">{(p.events ?? []).length} events</Td>
                  <Td><Badge color={p.is_active !== false ? 'emerald' : 'slate'}>{p.is_active !== false ? 'Active' : 'Off'}</Badge></Td>
                  <Td>
                    <div className="flex gap-1">
                      <Btn variant="secondary" onClick={() => setModal(p)}>Edit</Btn>
                      <Btn variant="danger" onClick={() => void deleteProvider(p.id)}>Delete</Btn>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      ) : null}

      {modal !== undefined && activeStore && (
        <ProviderModal
          storeId={activeStore.id}
          provider={modal}
          onClose={() => setModal(undefined)}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
