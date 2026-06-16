import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, LoadError, PageHeader, EmptyState, Spinner, Modal,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

interface PaymentProvider {
  id: string; name: string; type: string; slug?: string; mode?: string;
  is_active?: boolean; webhook_url?: string; created_at: string; [k: string]: unknown
}

interface Gateway {
  id: string; name: string; provider_type: string; mode: 'live' | 'dev';
  is_active?: boolean; created_at: string; [k: string]: unknown
}

type Tab = 'providers' | 'gateways'

const PROVIDER_TYPES = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'paystack', label: 'Paystack' },
  { value: 'razorpay', label: 'Razorpay' },
  { value: 'xendit', label: 'Xendit' },
  { value: 'custom', label: 'Custom Webhook' },
]

function ProviderModal({ storeId, provider, onClose, onSaved }: {
  storeId: string; provider: PaymentProvider | null; onClose: () => void; onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState({
    name: provider?.name ?? '',
    type: provider?.type ?? 'stripe',
    secret_key: '',
    public_key: '',
    webhook_secret: '',
    mode: provider?.mode ?? 'live',
  })
  const [saving, setSaving] = useState(false)
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    if (!form.name) { toast('Name required', 'error'); return }
    setSaving(true)
    try {
      const sdk = getSdk()
      const config: Record<string, unknown> = { mode: form.mode }
      // Secret fields are write-only — only include if filled
      if (form.secret_key) config.secret_key = form.secret_key
      if (form.public_key) config.public_key = form.public_key
      if (form.webhook_secret) config.webhook_secret = form.webhook_secret

      if (provider?.id) {
        await sdk.request(`/commerce/stores/${storeId}/payment-providers/${provider.id}`, {
          method: 'PUT', body: { name: form.name, config },
        })
      } else {
        await sdk.request(`/commerce/stores/${storeId}/payment-providers`, {
          method: 'POST', body: { name: form.name, type: form.type, config },
        })
      }
      toast(provider?.id ? 'Provider updated' : 'Provider added', 'success')
      onSaved(); onClose()
    } catch (err) { toast(err instanceof Error ? err.message : 'Save failed', 'error') }
    finally { setSaving(false) }
  }

  const secretLabel = form.type === 'stripe' ? 'Secret Key (sk_...)' :
    form.type === 'paystack' ? 'Secret Key (sk_...)' :
    form.type === 'razorpay' ? 'Key Secret' :
    form.type === 'xendit' ? 'API Key' : 'Secret'

  const pubLabel = form.type === 'stripe' ? 'Publishable Key (pk_...)' :
    form.type === 'paystack' ? 'Public Key (pk_...)' :
    form.type === 'razorpay' ? 'Key ID' :
    form.type === 'xendit' ? 'Public Key' : 'Public Key'

  return (
    <Modal title={provider?.id ? 'Configure Provider' : 'Add Payment Provider'} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-300">
          Secret fields are write-only. Leave blank to keep existing values.
        </div>

        <FormInput label="Display Name" value={form.name} onChange={set('name')} placeholder="My Stripe Account" />
        {!provider?.id && (
          <FormSelect label="Provider Type" value={form.type} onChange={set('type')} options={PROVIDER_TYPES} />
        )}
        <FormSelect label="Mode" value={form.mode} onChange={set('mode')}
          options={[{ value: 'live', label: 'Live' }, { value: 'test', label: 'Test / Dev' }]} />
        <FormInput label={secretLabel} value={form.secret_key} onChange={set('secret_key')} type="password" placeholder="Write-only" />
        {['stripe', 'paystack', 'razorpay'].includes(form.type) && (
          <FormInput label={pubLabel} value={form.public_key} onChange={set('public_key')} placeholder={form.type === 'stripe' ? 'pk_...' : 'pk_...'} />
        )}
        <FormInput label="Webhook Secret (for signature verification)" value={form.webhook_secret} onChange={set('webhook_secret')} type="password" placeholder="Write-only" />

        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving} variant="green">Save</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function PaymentProviders() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('providers')
  const [providers, setProviders] = useState<PaymentProvider[]>([])
  const [gateways, setGateways] = useState<Gateway[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modal, setModal] = useState<PaymentProvider | null | undefined>(undefined)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    setLoadError(null)
    const sdk = getSdk()
    try {
      const [providersRes, gatewaysRes] = await Promise.allSettled([
        sdk.request<{ providers: PaymentProvider[] }>(`/commerce/stores/${activeStore.id}/payment-providers`),
        sdk.request<{ gateways: Gateway[] }>(`/commerce/stores/${activeStore.id}/payment-gateways`),
      ])
      if (providersRes.status === 'fulfilled') {
        setProviders((providersRes.value as { providers?: PaymentProvider[] }).providers ?? [])
      } else {
        const msg = providersRes.reason instanceof Error ? providersRes.reason.message : 'Failed to load payment providers'
        setLoadError(msg)
        toast(msg, 'error')
        setProviders([])
      }
      if (gatewaysRes.status === 'fulfilled') {
        setGateways((gatewaysRes.value as { gateways?: Gateway[] }).gateways ?? [])
      } else {
        setGateways([])
      }
    } finally {
      setLoading(false)
    }
  }, [activeStore, toast])

  useEffect(() => { void load() }, [load])

  const deleteProvider = async (id: string) => {
    if (!activeStore || !confirm('Delete this payment provider?')) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/payment-providers/${id}`, { method: 'DELETE' })
      setProviders(p => p.filter(x => x.id !== id))
      toast('Deleted', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Delete failed', 'error') }
  }

  const getWebhookUrl = (p: PaymentProvider) => {
    const base = typeof window !== 'undefined' ? window.location.origin.replace('localhost:5174', 'localhost:3000') : ''
    return `${base}/webhooks/${activeStore?.id}/payment/${p.slug ?? p.id}`
  }

  const TABS = [
    { key: 'providers' as Tab, label: 'Providers' },
    { key: 'gateways' as Tab, label: 'Gateways' },
  ]

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payment Providers"
        description="Configure Stripe, Paystack, Razorpay, Xendit, or custom webhook providers"
        actions={tab === 'providers' ? <Btn onClick={() => setModal(null)}>+ Add Provider</Btn> : undefined}
      />

      <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.05] px-4 py-3 text-xs text-slate-400 leading-relaxed">
        <span className="font-semibold text-slate-200">Your keys, your payments.</span>{' '}
        Transactions are processed directly through your own provider account — CartCrft never handles customer payments.
        Webhook URL shown per provider for easy copy-paste configuration.
      </div>

      {loadError && <LoadError message={loadError} onRetry={() => void load()} />}

      <div className="flex border-b border-white/[0.06]">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${tab === t.key ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'providers' && (
        providers.length === 0 ? (
          <EmptyState
            title="No payment providers"
            description="Add Stripe, Paystack, Razorpay, Xendit, or a custom webhook provider"
            action="Add Provider"
            onAction={() => setModal(null)}
          />
        ) : (
          <div className="space-y-3">
            {providers.map(p => (
              <div key={p.id} className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-5 py-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <p className="text-sm font-semibold text-white">{p.name}</p>
                    <Badge color="blue">{p.type}</Badge>
                    <Badge color={p.mode === 'live' ? 'emerald' : 'amber'}>{p.mode ?? 'live'}</Badge>
                  </div>
                  <div className="flex gap-2">
                    <Btn variant="secondary" onClick={() => setModal(p)}>Configure</Btn>
                    <Btn variant="danger" onClick={() => void deleteProvider(p.id)}>Delete</Btn>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Webhook URL:</span>
                  <code className="text-xs text-slate-400 font-mono bg-black/20 px-2 py-0.5 rounded">
                    {getWebhookUrl(p)}
                  </code>
                  <Btn variant="secondary" onClick={() => { void navigator.clipboard.writeText(getWebhookUrl(p)); toast('Copied', 'success') }}>
                    Copy
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'gateways' && (
        gateways.length === 0 ? (
          <EmptyState title="No payment gateways" description="Platform gateways for dev credential testing" />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead><Th>Name</Th><Th>Type</Th><Th>Mode</Th><Th>Status</Th></TableHead>
              <tbody>
                {gateways.map(g => (
                  <tr key={g.id} className="border-t border-white/[0.04]">
                    <Td className="text-white">{g.name}</Td>
                    <Td><Badge color="violet">{g.provider_type}</Badge></Td>
                    <Td><Badge color={g.mode === 'live' ? 'emerald' : 'amber'}>{g.mode}</Badge></Td>
                    <Td><Badge color={g.is_active !== false ? 'emerald' : 'slate'}>{g.is_active !== false ? 'Active' : 'Off'}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
        )
      )}

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
