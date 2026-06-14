import React, { useState, useEffect } from 'react'
import { PageHeader, Card, FormInput, Btn, Spinner, LoadError } from '../../components/ui/index'
import { getSdk } from '../../lib/sdk'

interface CloudAccount {
  id: string
  email: string
  name: string
  org_name: string
  plan: string
  created_at: string
}

/**
 * Cloud Account page — shows org/account details for the Cloud subscription.
 * Calls /cloud/account which is only available when CARTCRFT_CLOUD is on.
 * Degrades gracefully (LoadError) if the endpoint doesn't exist.
 */
export default function CloudAccountPage() {
  const [account, setAccount] = useState<CloudAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [orgName, setOrgName] = useState('')

  useEffect(() => {
    setLoading(true)
    getSdk()
      .request<{ account: CloudAccount }>('/cloud/account')
      .then(res => {
        setAccount(res.account)
        setOrgName(res.account.org_name ?? '')
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  const handleSaveOrg = async () => {
    if (!account) return
    setSaving(true)
    try {
      await getSdk().request('/cloud/account', {
        method: 'PATCH',
        body: JSON.stringify({ org_name: orgName }),
      })
      setAccount(prev => prev ? { ...prev, org_name: orgName } : prev)
    } catch {
      // silent — user will see no feedback; could add toast
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account"
        description="Manage your Cartcrft Cloud account and organisation settings."
      />

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      )}

      {!loading && error && (
        <LoadError
          message={
            error.includes('404') || error.includes('501')
              ? 'Cloud account management is not enabled on this backend.'
              : `Failed to load account: ${error}`
          }
        />
      )}

      {!loading && !error && account && (
        <>
          <Card title="Account details">
            <dl className="space-y-3">
              {[
                { label: 'Account ID', value: account.id },
                { label: 'Email', value: account.email },
                { label: 'Plan', value: account.plan },
                { label: 'Member since', value: new Date(account.created_at).toLocaleDateString() },
              ].map(({ label, value }) => (
                <div key={label} className="flex items-center gap-4">
                  <dt className="w-32 text-xs font-medium text-slate-500 flex-shrink-0">{label}</dt>
                  <dd className="text-xs text-slate-300">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card title="Organisation">
            <div className="flex gap-3 items-end">
              <FormInput
                label="Organisation name"
                value={orgName}
                onChange={setOrgName}
                placeholder="Your company name"
                className="flex-1"
              />
              <Btn onClick={handleSaveOrg} loading={saving} className="mb-0">
                Save
              </Btn>
            </div>
          </Card>

          <Card title="Danger zone">
            <p className="text-xs text-slate-400 mb-3">
              Deleting your account is permanent and will immediately cancel your subscription and
              schedule your data for deletion (30-day grace period).
            </p>
            <Btn
              variant="danger"
              onClick={() =>
                window.open('mailto:hello@webcrft.systems?subject=Delete+cloud+account', '_blank')
              }
            >
              Request account deletion
            </Btn>
          </Card>
        </>
      )}
    </div>
  )
}
