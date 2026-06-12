import React, { useEffect, useState } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Btn, Card, FormInput, FormSelect, PageHeader, Spinner } from '../components/ui/index'

const COUNTRY_OPTIONS = [
  { value: '', label: 'Select country' },
  { value: 'ZA', label: 'South Africa' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'NG', label: 'Nigeria' },
  { value: 'KE', label: 'Kenya' },
  { value: 'AU', label: 'Australia' },
  { value: 'CA', label: 'Canada' },
  { value: 'IN', label: 'India' },
  { value: 'BR', label: 'Brazil' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'OTHER', label: 'Other' },
]

const TZ_OPTIONS = [
  { value: '', label: 'Select timezone' },
  { value: 'Africa/Johannesburg', label: 'Africa/Johannesburg (SAST)' },
  { value: 'America/New_York', label: 'America/New_York (ET)' },
  { value: 'America/Chicago', label: 'America/Chicago (CT)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PT)' },
  { value: 'Europe/London', label: 'Europe/London (GMT/BST)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (CET)' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (AEDT)' },
  { value: 'Africa/Lagos', label: 'Africa/Lagos (WAT)' },
  { value: 'Africa/Nairobi', label: 'Africa/Nairobi (EAT)' },
  { value: 'UTC', label: 'UTC' },
]

export default function Settings() {
  const { activeStore, reload } = useStore()
  const { toast } = useToast()
  const [form, setForm] = useState({ name: '', email: '', phone: '', country_code: '', timezone: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (!activeStore) return
    setLoading(true)
    const sdk = getSdk()
    void sdk.stores.get(activeStore.id).then(res => {
      const s = res.store
      setForm({
        name: s.name ?? '',
        email: (s.email as string | undefined) ?? '',
        phone: (s.phone as string | undefined) ?? '',
        country_code: (s.country_code as string | undefined) ?? '',
        timezone: (s.timezone as string | undefined) ?? '',
      })
    }).catch(() => {
      // fallback to activeStore data
      setForm({
        name: activeStore.name ?? '',
        email: activeStore.email ?? '',
        phone: activeStore.phone ?? '',
        country_code: activeStore.country_code ?? '',
        timezone: activeStore.timezone ?? '',
      })
    }).finally(() => setLoading(false))
  }, [activeStore])

  const handleSave = async () => {
    if (!activeStore) return
    setSaving(true)
    try {
      const sdk = getSdk()
      type UpdateBody = Parameters<typeof sdk.stores.update>[1]
      const updateBody: UpdateBody = { name: form.name }
      if (form.email) updateBody.email = form.email
      if (form.phone) updateBody.phone = form.phone
      if (form.country_code) updateBody.country_code = form.country_code
      if (form.timezone) updateBody.timezone = form.timezone
      await sdk.stores.update(activeStore.id, updateBody)
      await reload(activeStore.id)
      toast('Settings saved', 'success')
    } catch {
      toast('Failed to save settings', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!activeStore) return
    setDeleting(true)
    try {
      const sdk = getSdk()
      await sdk.stores.delete(activeStore.id)
      await reload()
      toast('Store deleted', 'success')
      setConfirmDelete(false)
    } catch {
      toast('Failed to delete store', 'error')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  return (
    <div className="space-y-6">
      <PageHeader title="Store Settings" description="Manage your store details and configuration" />

      <Card title="Store Details">
        <div className="space-y-4">
          <FormInput label="Store Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} placeholder="My Store" />
          <div className="grid grid-cols-2 gap-4">
            <FormInput label="Email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} placeholder="store@example.com" type="email" />
            <FormInput label="Phone" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} placeholder="+1 555 0100" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormSelect label="Country" value={form.country_code} onChange={v => setForm(f => ({ ...f, country_code: v }))} options={COUNTRY_OPTIONS} />
            <FormSelect label="Timezone" value={form.timezone} onChange={v => setForm(f => ({ ...f, timezone: v }))} options={TZ_OPTIONS} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1.5">Currency</label>
            <div className="rounded-lg border border-white/[0.08] bg-white/[0.01] px-3 py-2.5 text-sm text-slate-500">
              {activeStore?.currency ?? '—'} <span className="text-xs text-slate-600">(cannot be changed after store creation)</span>
            </div>
          </div>
          <div className="pt-2">
            <Btn onClick={handleSave} loading={saving}>Save Settings</Btn>
          </div>
        </div>
      </Card>

      <Card title="Danger Zone">
        <div className="space-y-4">
          <p className="text-xs text-slate-500">Deleting a store is permanent and cannot be undone. All products, orders, and customer data will be permanently deleted.</p>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded-lg border border-red-500/30 bg-red-600/10 px-4 py-2 text-xs font-semibold text-red-300 hover:bg-red-600/20 transition"
            >
              Delete Store
            </button>
          ) : (
            <div className="rounded-xl border border-red-500/20 bg-red-900/10 p-4 space-y-3">
              <p className="text-sm font-medium text-red-300">Are you sure you want to delete <strong>{activeStore?.name}</strong>?</p>
              <p className="text-xs text-red-400/80">This action cannot be undone.</p>
              <div className="flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 transition disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Yes, delete store'}
                </button>
                <Btn variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Btn>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
