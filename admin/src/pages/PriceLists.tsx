import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import {
  Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner,
  TableContainer, TableHead, Th, Td, Badge,
} from '../components/ui/index'

interface PriceList {
  id: string; name: string; type: string; currency: string;
  is_active?: boolean; [k: string]: unknown
}

interface PriceListItem {
  id: string; variant_id: string; price: string; currency: string; [k: string]: unknown
}

export default function PriceLists() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [lists, setLists] = useState<PriceList[]>([])
  const [items, setItems] = useState<Record<string, PriceListItem[]>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'sale', currency: '' })
  const [saving, setSaving] = useState(false)
  const [addItem, setAddItem] = useState<{ list_id: string; variant_id: string; price: string } | null>(null)
  const [savingItem, setSavingItem] = useState(false)

  const load = useCallback(async () => {
    if (!activeStore) return
    setLoading(true)
    try {
      const res = await getSdk().catalog.listPriceLists(activeStore.id)
      setLists((res as { price_lists?: PriceList[] }).price_lists ?? [])
    } catch { setLists([]) }
    setLoading(false)
  }, [activeStore])

  useEffect(() => { void load() }, [load])

  const loadItems = async (listId: string) => {
    if (!activeStore) return
    try {
      const res = await getSdk().request<{ items: PriceListItem[] }>(`/commerce/stores/${activeStore.id}/price-lists/${listId}/items`)
      setItems(it => ({ ...it, [listId]: (res as { items?: PriceListItem[] }).items ?? [] }))
    } catch {}
  }

  const toggleList = (id: string) => {
    if (expanded === id) { setExpanded(null); return }
    setExpanded(id)
    if (!items[id]) void loadItems(id)
  }

  const createList = async () => {
    if (!activeStore || !form.name) { toast('Name required', 'error'); return }
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: form.name, type: form.type,
        currency: form.currency || activeStore.currency,
      }
      await getSdk().request(`/commerce/stores/${activeStore.id}/price-lists`, { method: 'POST', body })
      toast('Price list created', 'success')
      setShowCreate(false); setForm({ name: '', type: 'sale', currency: '' })
      await load()
    } catch (err) { toast(err instanceof Error ? err.message : 'Create failed', 'error') }
    finally { setSaving(false) }
  }

  const deleteList = async (id: string) => {
    if (!activeStore || !confirm('Delete this price list?')) return
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/price-lists/${id}`, { method: 'DELETE' })
      setLists(l => l.filter(x => x.id !== id))
      toast('Deleted', 'success')
    } catch (err) { toast(err instanceof Error ? err.message : 'Delete failed', 'error') }
  }

  const addItemToList = async () => {
    if (!activeStore || !addItem || !addItem.variant_id || !addItem.price) {
      toast('Variant ID and price required', 'error'); return
    }
    setSavingItem(true)
    try {
      await getSdk().request(`/commerce/stores/${activeStore.id}/price-lists/${addItem.list_id}/items`, {
        method: 'POST',
        body: { variant_id: addItem.variant_id, price: addItem.price },
      })
      toast('Item added', 'success')
      void loadItems(addItem.list_id)
      setAddItem(null)
    } catch (err) { toast(err instanceof Error ? err.message : 'Add failed', 'error') }
    finally { setSavingItem(false) }
  }

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Price Lists"
        description="Retail, wholesale, VIP, and custom price lists"
        actions={<Btn onClick={() => setShowCreate(v => !v)}>+ New List</Btn>}
      />

      {showCreate && (
        <Card>
          <div className="space-y-3">
            <p className="text-sm font-semibold text-white">New Price List</p>
            <div className="grid grid-cols-2 gap-3">
              <FormInput label="Name" value={form.name} onChange={set('name')} placeholder="Wholesale" />
              <FormSelect label="Type" value={form.type} onChange={set('type')}
                options={[
                  { value: 'sale', label: 'Sale' }, { value: 'wholesale', label: 'Wholesale' },
                  { value: 'vip', label: 'VIP' }, { value: 'staff', label: 'Staff' },
                  { value: 'retail', label: 'Retail' },
                ]} />
              <FormInput label="Currency (default: store currency)" value={form.currency} onChange={set('currency')} placeholder="USD" />
            </div>
            <div className="flex gap-2">
              <Btn onClick={createList} loading={saving} variant="green">Create</Btn>
              <Btn variant="secondary" onClick={() => setShowCreate(false)}>Cancel</Btn>
            </div>
          </div>
        </Card>
      )}

      {lists.length === 0 ? (
        <EmptyState title="No price lists" description="Create price lists for different customer segments" action="New List" onAction={() => setShowCreate(true)} />
      ) : (
        <div className="space-y-3">
          {lists.map(list => (
            <div key={list.id} className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-white/[0.02] transition" onClick={() => toggleList(list.id)}>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-semibold text-white">{list.name}</p>
                  <Badge color="blue">{list.type}</Badge>
                  <Badge color="slate">{list.currency}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span onClick={e => e.stopPropagation()}><Btn variant="danger" onClick={() => void deleteList(list.id)}>Delete</Btn></span>
                  <span className="text-slate-500 text-xs">{expanded === list.id ? '▲' : '▼'}</span>
                </div>
              </div>

              {expanded === list.id && (
                <div className="border-t border-white/[0.06] px-5 py-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-slate-400">Items</p>
                    <Btn variant="secondary" onClick={() => setAddItem({ list_id: list.id, variant_id: '', price: '' })}>+ Add Item</Btn>
                  </div>

                  {addItem?.list_id === list.id && (
                    <div className="flex gap-2 items-end">
                      <FormInput label="Variant ID" value={addItem.variant_id}
                        onChange={v => setAddItem(a => a ? { ...a, variant_id: v } : a)} placeholder="var_..." />
                      <FormInput label="Price" value={addItem.price}
                        onChange={v => setAddItem(a => a ? { ...a, price: v } : a)} placeholder="19.99" type="number" />
                      <Btn onClick={addItemToList} loading={savingItem} variant="green">Add</Btn>
                      <Btn variant="secondary" onClick={() => setAddItem(null)}>Cancel</Btn>
                    </div>
                  )}

                  {items[list.id] && items[list.id].length > 0 ? (
                    <TableContainer>
                      <table className="w-full text-sm">
                        <TableHead><Th>Variant ID</Th><Th>Price</Th><Th>Currency</Th></TableHead>
                        <tbody>
                          {items[list.id].map(item => (
                            <tr key={item.id} className="border-t border-white/[0.04]">
                              <Td className="font-mono text-xs text-slate-400">{item.variant_id}</Td>
                              <Td className="font-mono text-white">{item.price}</Td>
                              <Td className="text-slate-400">{item.currency}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableContainer>
                  ) : (
                    <p className="text-xs text-slate-500">No items yet.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
