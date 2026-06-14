import React, { useEffect, useState, useCallback } from 'react'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Badge, Btn, Card, FormInput, FormSelect, PageHeader,
  EmptyState, Spinner, Modal, LoadError,
  TableContainer, TableHead, Th, Td,
} from '../components/ui/index'
import type { ApiKey, CreateApiKeyBody } from '@cartcrft/sdk'
import { useStore } from '../context/StoreContext'

const KEY_TYPE_OPTIONS = [
  { value: 'private', label: 'Private (cc_prv_) — server-side, read+write' },
  { value: 'public', label: 'Public (cc_pub_) — storefront, read-only' },
]

interface NewKeyReveal {
  key: string
  name: string
}

export default function ApiKeys() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newKey, setNewKey] = useState<NewKeyReveal | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  const [form, setForm] = useState<{ name: string; key_type: 'public' | 'private'; scopes: string }>({
    name: '',
    key_type: 'private',
    scopes: '',
  })
  const [creating, setCreating] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    const sdk = getSdk()
    const query = activeStore ? { store_id: activeStore.id } : undefined
    void sdk.apiKeys.list(query)
      .then(res => setKeys(res.keys ?? []))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Failed to load API keys'
        setLoadError(msg)
      })
      .finally(() => setLoading(false))
  }, [activeStore])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!form.name.trim()) { toast('Name is required', 'error'); return }
    setCreating(true)
    try {
      const sdk = getSdk()
      const body: CreateApiKeyBody = {
        name: form.name.trim(),
        key_type: form.key_type,
      }
      if (form.scopes.trim()) {
        body.scopes = form.scopes.split(',').map(s => s.trim()).filter(Boolean)
      }
      if (activeStore) body.store_id = activeStore.id
      const res = await sdk.apiKeys.create(body)
      setNewKey({ key: res.key, name: res.api_key.name })
      setShowCreate(false)
      setForm({ name: '', key_type: 'private', scopes: '' })
      toast('API key created', 'success')
      load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create key', 'error')
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async (keyId: string, keyName: string) => {
    if (!confirm(`Revoke key "${keyName}"? This cannot be undone.`)) return
    setRevoking(keyId)
    try {
      const sdk = getSdk()
      await sdk.apiKeys.revoke(keyId)
      toast('Key revoked', 'success')
      load()
    } catch {
      toast('Failed to revoke key', 'error')
    } finally {
      setRevoking(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="API Keys"
        description="Manage API keys for store access. Private keys (cc_prv_) have full read/write access; public keys (cc_pub_) are safe for storefronts."
        actions={<Btn onClick={() => setShowCreate(true)}>+ New Key</Btn>}
      />

      {loadError && <LoadError message={loadError} onRetry={load} />}

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : keys.length === 0 && !loadError ? (
        <EmptyState
          title="No API keys yet"
          description="Create a key to authenticate SDK and API calls for this store"
          action="New Key"
          onAction={() => setShowCreate(true)}
        />
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th>Key (masked)</Th>
              <Th>Scopes</Th>
              <Th>Created</Th>
              <Th></Th>
            </TableHead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                  <Td className="font-medium text-white">{k.name}</Td>
                  <Td>
                    <Badge color={k.key_type === 'private' ? 'violet' : 'blue'}>
                      {k.key_type === 'private' ? 'Private' : 'Public'}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="font-mono text-xs text-slate-400">{k.key_masked}</span>
                  </Td>
                  <Td className="text-slate-500 text-xs">
                    {k.scopes && k.scopes.length > 0
                      ? k.scopes.join(', ')
                      : <span className="text-slate-600">all</span>
                    }
                  </Td>
                  <Td className="text-slate-500">{new Date(k.created_at).toLocaleDateString()}</Td>
                  <Td>
                    <Btn
                      variant="danger"
                      loading={revoking === k.id}
                      onClick={() => handleRevoke(k.id, k.name)}
                    >
                      Revoke
                    </Btn>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}

      {/* Create Key Modal */}
      {showCreate && (
        <Modal title="Create API Key" onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            <FormInput
              label="Name *"
              value={form.name}
              onChange={v => setForm(f => ({ ...f, name: v }))}
              placeholder="e.g. Production server key"
            />
            <FormSelect
              label="Key Type"
              value={form.key_type}
              onChange={v => setForm(f => ({ ...f, key_type: v as 'public' | 'private' }))}
              options={KEY_TYPE_OPTIONS}
            />
            <FormInput
              label="Scopes (comma-separated, leave empty for all)"
              value={form.scopes}
              onChange={v => setForm(f => ({ ...f, scopes: v }))}
              placeholder="read:products, write:orders"
            />
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3">
              <p className="text-xs text-amber-300">
                The full key is shown <strong>once</strong> immediately after creation. Copy it somewhere safe — it cannot be retrieved again.
              </p>
            </div>
            <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
              <Btn onClick={handleCreate} loading={creating}>Create Key</Btn>
              <Btn variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Btn>
            </div>
          </div>
        </Modal>
      )}

      {/* One-time Key Reveal Modal */}
      {newKey && (
        <Modal title="Key Created — Copy Now" onClose={() => setNewKey(null)}>
          <div className="space-y-4">
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3">
              <p className="text-xs text-emerald-300 mb-2">
                This is the only time you will see the full key for <strong>{newKey.name}</strong>.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-md bg-black/30 px-3 py-2 text-xs font-mono text-emerald-200 select-all">
                  {newKey.key}
                </code>
                <button
                  onClick={() => { void navigator.clipboard.writeText(newKey.key); toast('Copied!', 'success') }}
                  className="flex-shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300 hover:bg-white/10 transition"
                >
                  Copy
                </button>
              </div>
            </div>
            <Card>
              <p className="text-xs text-slate-400">
                Use this key in the SDK or as an <code className="text-violet-400">Authorization: Bearer &lt;key&gt;</code> header.
                Private keys (<code className="text-violet-400">cc_prv_</code>) have full access — never expose them in browser code.
              </p>
            </Card>
            <div className="flex justify-end pt-2">
              <Btn onClick={() => setNewKey(null)}>I have copied the key</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
