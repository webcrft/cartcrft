import React, { useState } from 'react'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Btn, FormInput, FormSelect, Modal } from './ui/index'

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — British Pound' },
  { value: 'ZAR', label: 'ZAR — South African Rand' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'NGN', label: 'NGN — Nigerian Naira' },
  { value: 'KES', label: 'KES — Kenyan Shilling' },
]

interface Props {
  onClose: () => void
  /** Called with the new store's id once it has been created. */
  onCreated: (storeId: string) => void
}

export default function CreateStoreModal({ onClose, onCreated }: Props) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) { toast('Store name is required', 'error'); return }
    setSaving(true)
    try {
      const sdk = getSdk()
      const res = await sdk.stores.create({
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        currency,
        ...(email.trim() ? { email: email.trim() } : {}),
      })
      toast(`Store "${res.store.name}" created`, 'success')
      onCreated(res.store.id)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create store', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="Create New Store" onClose={onClose}>
      <div className="space-y-4">
        <FormInput
          label="Store Name *"
          value={name}
          onChange={v => {
            setName(v)
            // Auto-suggest a slug from the name if the slug hasn't been
            // manually edited yet.
            if (!slug) {
              setSlug(v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
            }
          }}
          placeholder="My Awesome Store"
        />
        <FormInput
          label="Slug (URL-safe identifier)"
          value={slug}
          onChange={setSlug}
          placeholder="my-awesome-store"
        />
        <FormSelect
          label="Default Currency"
          value={currency}
          onChange={setCurrency}
          options={CURRENCY_OPTIONS}
        />
        <FormInput
          label="Store Email"
          value={email}
          onChange={setEmail}
          placeholder="store@example.com"
        />
        <p className="text-[11px] text-slate-500">
          You can change these settings later in the Store &rarr; Settings page.
        </p>
        <div className="flex gap-2 pt-2 border-t border-white/[0.06]">
          <Btn onClick={handleCreate} loading={saving}>Create Store</Btn>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        </div>
      </div>
    </Modal>
  )
}
