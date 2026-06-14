import React, { useEffect, useState, useCallback } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Badge, Btn, Card, FormInput, FormSelect, PageHeader, EmptyState, Spinner, Modal, TableContainer, TableHead, Th, Td } from '../components/ui/index'
import type { Discount } from '@cartcrft/sdk'

const DISCOUNT_TYPES = [
  { value: 'percentage', label: 'Percentage (%)' },
  { value: 'fixed_amount', label: 'Fixed Amount' },
  { value: 'free_shipping', label: 'Free Shipping' },
  { value: 'bogo', label: 'Buy One Get One' },
  { value: 'buy_x_get_y', label: 'Buy X Get Y' },
]

interface DiscountForm {
  code: string
  discount_type: string
  value: string
  min_order_total: string
  max_uses: string
  once_per_customer: boolean
  starts_at: string
  ends_at: string
  is_automatic: boolean
  title: string
}

const defaultForm: DiscountForm = {
  code: '',
  discount_type: 'percentage',
  value: '',
  min_order_total: '',
  max_uses: '',
  once_per_customer: false,
  starts_at: '',
  ends_at: '',
  is_automatic: false,
  title: '',
}

function DiscountEditor({ storeId, isAutomatic, onClose, onSaved }: {
  storeId: string
  isAutomatic: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [form, setForm] = useState<DiscountForm>({ ...defaultForm, is_automatic: isAutomatic })
  const [saving, setSaving] = useState(false)

  const set = (k: keyof DiscountForm) => (v: string | boolean) =>
    setForm(f => ({ ...f, [k]: v }))

  const handleSave = async () => {
    if (!isAutomatic && !form.code.trim()) { toast('Code is required', 'error'); return }
    if (isAutomatic && !form.title.trim()) { toast('Title is required', 'error'); return }
    if (!form.value && form.discount_type !== 'free_shipping') { toast('Value is required', 'error'); return }
    setSaving(true)
    try {
      const sdk = getSdk()
      const body = {
        code: isAutomatic ? (form.title.trim().toUpperCase().replace(/\s+/g, '_')) : form.code.trim(),
        discount_type: form.discount_type,
        value: form.value || '0',
        title: form.title || undefined,
        is_automatic: isAutomatic,
        min_order_total: form.min_order_total || undefined,
        max_uses: form.max_uses ? Number(form.max_uses) : undefined,
        once_per_customer: form.once_per_customer,
        starts_at: form.starts_at || undefined,
        ends_at: form.ends_at || undefined,
      }
      await sdk.discounts.create(storeId, body)
      toast(isAutomatic ? 'Auto-discount created' : 'Discount code created', 'success')
      onSaved()
      onClose()
    } catch (err) {
      toast((err instanceof Error ? err.message : 'Save failed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={isAutomatic ? 'New Auto-Discount' : 'New Discount Code'} onClose={onClose}>
      <div className="space-y-4">
        {isAutomatic ? (
          <FormInput label="Title *" value={form.title} onChange={set('title')} placeholder="Summer Sale" />
        ) : (
          <FormInput label="Code *" value={form.code} onChange={set('code')} placeholder="SAVE20" />
        )}
        <div className="grid grid-cols-2 gap-3">
          <FormSelect label="Type" value={form.discount_type} onChange={set('discount_type')} options={DISCOUNT_TYPES} />
          {form.discount_type !== 'free_shipping' && (
            <FormInput
              label={form.discount_type === 'percentage' ? 'Value (%)' : 'Value'}
              value={form.value}
              onChange={set('value')}
              placeholder={form.discount_type === 'percentage' ? '10' : '50.00'}
              type="number"
            />
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormInput label="Min Order Total" value={form.min_order_total} onChange={set('min_order_total')} placeholder="0.00" type="number" />
          <FormInput label="Max Uses" value={form.max_uses} onChange={set('max_uses')} placeholder="Unlimited" type="number" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormInput label="Starts At" value={form.starts_at} onChange={set('starts_at')} type="datetime-local" />
          <FormInput label="Ends At" value={form.ends_at} onChange={set('ends_at')} type="datetime-local" />
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input type="checkbox" checked={form.once_per_customer} onChange={e => set('once_per_customer')(e.target.checked)} className="rounded" />
          Limit to one use per customer
        </label>
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleSave} loading={saving}>
            {isAutomatic ? 'Create Auto-Discount' : 'Create Code'}
          </Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}

type Tab = 'codes' | 'automatic'

export default function Discounts() {
  const { activeStore } = useStore()
  const { toast } = useToast()
  const [discounts, setDiscounts] = useState<Discount[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('codes')
  const [creating, setCreating] = useState<'codes' | 'automatic' | null>(null)

  const load = useCallback(() => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    void sdk.discounts.list(activeStore.id)
      .then(res => setDiscounts(res.discounts ?? []))
      .catch(() => toast('Failed to load discounts', 'error'))
      .finally(() => setLoading(false))
  }, [activeStore, toast])

  useEffect(() => { load() }, [load])

  const autoDiscounts = discounts.filter(d => (d.is_automatic as boolean | undefined) ?? false)
  const codeDiscounts = discounts.filter(d => !((d.is_automatic as boolean | undefined) ?? false))
  const displayed = tab === 'codes' ? codeDiscounts : autoDiscounts

  const toggleActive = async (discount: Discount) => {
    try {
      const sdk = getSdk()
      await sdk.request(`/commerce/stores/${activeStore?.id}/discounts/${discount.id}`, {
        method: 'PUT',
        body: { is_active: !discount.is_active },
      })
      toast(discount.is_active ? 'Discount deactivated' : 'Discount activated', 'success')
      load()
    } catch { toast('Update failed', 'error') }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-4">
      <PageHeader
        title="Discounts"
        description="Manage discount codes and automatic promotions"
        actions={
          <Btn onClick={() => setCreating(tab === 'codes' ? 'codes' : 'automatic')}>
            + New {tab === 'codes' ? 'Code' : 'Auto-Discount'}
          </Btn>
        }
      />

      <div className="flex border-b border-white/[0.06]">
        {(['codes', 'automatic'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-xs font-medium border-b-2 transition -mb-px ${
              tab === t ? 'border-violet-500 text-violet-400' : 'border-transparent text-slate-500 hover:text-white'
            }`}
          >
            {t === 'codes' ? `Codes (${codeDiscounts.length})` : `Automatic (${autoDiscounts.length})`}
          </button>
        ))}
      </div>

      {displayed.length === 0 ? (
        <EmptyState
          title={tab === 'codes' ? 'No discount codes yet' : 'No automatic discounts yet'}
          description={tab === 'codes' ? 'Create codes customers can enter at checkout' : 'Create automatic promotions that apply without a code'}
          action={tab === 'codes' ? 'New Code' : 'New Auto-Discount'}
          onAction={() => setCreating(tab)}
        />
      ) : (
        <TableContainer>
          <table className="w-full text-sm">
            <TableHead>
              {tab === 'codes' ? (
                <>
                  <Th>Code</Th>
                  <Th>Type</Th>
                  <Th>Value</Th>
                  <Th>Status</Th>
                  <Th>Created</Th>
                  <Th></Th>
                </>
              ) : (
                <>
                  <Th>Title</Th>
                  <Th>Type</Th>
                  <Th>Value</Th>
                  <Th>Status</Th>
                  <Th></Th>
                </>
              )}
            </TableHead>
            <tbody>
              {displayed.map(discount => (
                <tr key={discount.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                  <Td>
                    <span className="font-mono text-sm text-white">{discount.code}</span>
                  </Td>
                  <Td><Badge color="slate">{discount.discount_type.replace(/_/g, ' ')}</Badge></Td>
                  <Td className="font-mono text-slate-300">
                    {discount.discount_type === 'percentage' ? `${discount.value}%` :
                     discount.discount_type === 'free_shipping' ? 'Free' :
                     discount.value}
                  </Td>
                  <Td>
                    <Badge color={discount.is_active ? 'emerald' : 'slate'}>
                      {discount.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </Td>
                  {tab === 'codes' && (
                    <Td className="text-slate-500">{new Date(discount.created_at).toLocaleDateString()}</Td>
                  )}
                  <Td>
                    <div className="flex justify-end">
                      <Btn variant="secondary" onClick={() => toggleActive(discount)}>
                        {discount.is_active ? 'Deactivate' : 'Activate'}
                      </Btn>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
      )}

      {creating && (
        <DiscountEditor
          storeId={activeStore?.id ?? ''}
          isAutomatic={creating === 'automatic'}
          onClose={() => setCreating(null)}
          onSaved={load}
        />
      )}
    </div>
  )
}
