import React, { useEffect, useState } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { useToast } from '../context/ToastContext'
import { Btn, Card, FormInput, FormSelect, PageHeader, Spinner } from '../components/ui/index'
import { Settings2, AlertTriangle } from 'lucide-react'

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

  const set = (k: string) => (v: string) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div className="space-y-6">
      <PageHeader
        title="Store Settings"
        description="Manage your store details and configuration"
        badge={
          <div className="flex items-center gap-1.5">
            <Settings2 size={13} className="text-[var(--cc-lime)]" />
          </div>
        }
      />

      <Card title="Store Details" description="Basic information about your store">
        <div className="space-y-4 max-w-xl">
          <FormInput
            label="Store Name"
            value={form.name}
            onChange={set('name')}
            placeholder="My Store"
            required
          />
          <div className="grid grid-cols-2 gap-4">
            <FormInput
              label="Email"
              value={form.email}
              onChange={set('email')}
              placeholder="store@example.com"
              type="email"
            />
            <FormInput
              label="Phone"
              value={form.phone}
              onChange={set('phone')}
              placeholder="+1 555 0100"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormSelect
              label="Country"
              value={form.country_code}
              onChange={set('country_code')}
              options={COUNTRY_OPTIONS}
            />
            <FormSelect
              label="Timezone"
              value={form.timezone}
              onChange={set('timezone')}
              options={TZ_OPTIONS}
            />
          </div>

          {/* Currency — read-only */}
          <div>
            <label className="block font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cc-muted)] mb-1.5">
              Currency
            </label>
            <div
              className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <span className="font-mono font-semibold text-[var(--cc-body)]">{activeStore?.currency ?? '—'}</span>
              <span className="text-[11px] text-[var(--cc-subtle)]">Cannot be changed after store creation</span>
            </div>
          </div>

          <div className="pt-1">
            <Btn onClick={handleSave} loading={saving}>Save Settings</Btn>
          </div>
        </div>
      </Card>

      {/* Danger zone */}
      <Card title="Danger Zone">
        <div className="space-y-4 max-w-xl">
          <div
            className="flex items-start gap-2.5 rounded-lg px-4 py-3 text-xs text-[var(--cc-muted)]"
            style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)' }}
          >
            <AlertTriangle size={14} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p>
              Deleting a store is permanent and cannot be undone. All products, orders, and customer data
              will be permanently deleted.
            </p>
          </div>

          {!confirmDelete ? (
            <Btn variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete Store
            </Btn>
          ) : (
            <div
              className="rounded-xl p-5 space-y-4"
              style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)' }}
            >
              <p className="text-sm font-semibold text-red-300">
                Are you sure you want to delete <span className="text-red-200 font-bold">{activeStore?.name}</span>?
              </p>
              <p className="text-xs text-red-400/75">This action cannot be undone. All data will be permanently lost.</p>
              <div className="flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 transition disabled:opacity-50 active:scale-[0.97]"
                >
                  {deleting ? 'Deleting…' : 'Yes, delete store'}
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
