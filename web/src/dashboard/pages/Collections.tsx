import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Badge, Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner, Modal, TableContainer, TableHead, Th, Td } from '../components/ui/index'
import type { Collection } from '@cartcrft/sdk'

const RULE_FIELDS = [
  { value: 'title', label: 'Product Title' },
  { value: 'tag', label: 'Tag' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'price', label: 'Price' },
  { value: 'type', label: 'Product Type' },
]

const RULE_OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'not equals' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
]

interface SmartRule {
  id: string
  field: string
  operator: string
  value: string
}

interface CollectionForm {
  title: string
  description: string
  collection_type: 'manual' | 'smart'
  rules: SmartRule[]
}

function CollectionEditor({ storeId, collection, onClose, onSaved }: {
  storeId: string
  collection: Collection | null
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState<CollectionForm>({
    title: collection?.title ?? '',
    description: (collection?.description as string | undefined) ?? '',
    collection_type: collection?.collection_type ?? 'manual',
    rules: [],
  })
  const [saving, setSaving] = useState(false)

  const addRule = () => {
    setForm(f => ({
      ...f,
      rules: [...f.rules, { id: crypto.randomUUID(), field: 'title', operator: 'contains', value: '' }],
    }))
  }

  const updateRule = (id: string, key: keyof SmartRule, value: string) => {
    setForm(f => ({
      ...f,
      rules: f.rules.map(r => r.id === id ? { ...r, [key]: value } : r),
    }))
  }

  const removeRule = (id: string) => {
    setForm(f => ({ ...f, rules: f.rules.filter(r => r.id !== id) }))
  }

  const handleSave = async () => {
    if (!form.title.trim()) { toast('Title is required', 'error'); return }
    setSaving(true)
    try {
      const sdk = getSdk()
      const body: { title: string; collection_type: 'manual' | 'smart'; description?: string; rules?: unknown } = {
        title: form.title.trim(),
        collection_type: form.collection_type,
      }
      if (form.description) body.description = form.description
      if (form.collection_type === 'smart' && form.rules.length > 0) {
        body.rules = form.rules.map(r => ({ field: r.field, operator: r.operator, value: r.value }))
      }
      if (collection) {
        // No update method in SDK for collections, use request escape hatch
        const sdk2 = getSdk()
        await sdk2.request(`/commerce/stores/${storeId}/collections/${collection.id}`, { method: 'PUT', body })
      } else {
        await sdk.catalog.createCollection(storeId, body)
      }
      toast(collection ? 'Collection updated' : 'Collection created', 'success')
      onSaved()
      onClose()
    } catch (err) {
      toast((err instanceof Error ? err.message : 'Save failed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={collection ? 'Edit Collection' : 'New Collection'} onClose={onClose}>
      <div className="space-y-4">
        <FormInput label="Title *" value={form.title} onChange={v => setForm(f => ({ ...f, title: v }))} placeholder="Summer Collection" />
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={2}
            placeholder="Collection description..."
            className="w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-white/20 focus:outline-none resize-none"
          />
        </div>
        <FormSelect
          label="Type"
          value={form.collection_type}
          onChange={v => setForm(f => ({ ...f, collection_type: v as 'manual' | 'smart' }))}
          options={[
            { value: 'manual', label: 'Manual — add products manually' },
            { value: 'smart', label: 'Smart — auto-populate by rules' },
          ]}
        />

        {form.collection_type === 'smart' && (
          <div className="border-t border-white/[0.06] pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-400">Smart Rules</p>
              <button
                onClick={addRule}
                className="text-xs text-violet-400 hover:text-violet-300 transition"
              >
                + Add rule
              </button>
            </div>
            {form.rules.length === 0 ? (
              <p className="text-xs text-slate-600 text-center py-4">No rules yet. Add a rule to auto-populate this collection.</p>
            ) : (
              <div className="space-y-2">
                {form.rules.map(rule => (
                  <div key={rule.id} className="flex items-center gap-2">
                    <select
                      value={rule.field}
                      onChange={e => updateRule(rule.id, 'field', e.target.value)}
                      className="flex-1 rounded-lg border border-white/[0.08] bg-slate-900 px-2 py-2 text-xs text-white focus:outline-none"
                    >
                      {RULE_FIELDS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select
                      value={rule.operator}
                      onChange={e => updateRule(rule.id, 'operator', e.target.value)}
                      className="flex-1 rounded-lg border border-white/[0.08] bg-slate-900 px-2 py-2 text-xs text-white focus:outline-none"
                    >
                      {RULE_OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <input
                      value={rule.value}
                      onChange={e => updateRule(rule.id, 'value', e.target.value)}
                      placeholder="Value"
                      className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-2 text-xs text-white placeholder:text-slate-600 focus:outline-none"
                    />
                    <button
                      onClick={() => removeRule(rule.id)}
                      className="text-slate-600 hover:text-red-400 transition text-sm px-1"
                    >
                      &#x2715;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving}>{collection ? 'Save Changes' : 'Create Collection'}</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

export default function Collections() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)
  const [editCollection, setEditCollection] = useState<Collection | null | undefined>(undefined)

  const load = useCallback(() => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    void sdk.catalog.listCollections(activeStore.id)
      .then(res => setCollections(res.collections ?? []))
      .catch(() => toast('Failed to load collections', 'error'))
      .finally(() => setLoading(false))
  }, [activeStore, toast])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Collections"
        description={`${collections.length} collection${collections.length !== 1 ? 's' : ''}`}
        actions={<Btn onClick={() => setEditCollection(null)}>+ New Collection</Btn>}
      />

      {collections.length === 0 ? (
        <EmptyState
          title="No collections yet"
          description="Group products into collections for easy browsing"
          action="New Collection"
          onAction={() => setEditCollection(null)}
        />
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              <Th>Title</Th>
              <Th>Type</Th>
              <Th>Created</Th>
              <Th></Th>
            </TableHead>
            <tbody>
              {collections.map(col => (
                <tr key={col.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                  <Td>
                    <span className="font-medium text-white">{col.title}</span>
                  </Td>
                  <Td>
                    <Badge color={col.collection_type === 'smart' ? 'violet' : 'slate'}>
                      {col.collection_type}
                    </Badge>
                  </Td>
                  <Td className="text-slate-400">{new Date(col.created_at).toLocaleDateString()}</Td>
                  <Td>
                    <div className="flex justify-end">
                      <Btn variant="secondary" onClick={() => setEditCollection(col)}>Edit</Btn>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}

      {editCollection !== undefined && (
        <CollectionEditor
          storeId={activeStore?.id ?? ''}
          collection={editCollection}
          onClose={() => setEditCollection(undefined)}
          onSaved={load}
        />
      )}
    </div>
  )
}
