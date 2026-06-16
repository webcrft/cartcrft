import React, { useState, useEffect } from 'react'
import { PageHeader, Card, Badge, Btn, Spinner, LoadError } from '../../components/ui/index'
import { useStore } from '../../context/StoreContext'
import { getSdk } from '../../lib/sdk'

interface Plan {
  name: string
  price_usd: number
  interval: 'monthly' | 'annual'
  status: 'active' | 'trialing' | 'past_due' | 'canceled'
  current_period_end: string
  cancel_at_period_end: boolean
}

interface Invoice {
  id: string
  amount_usd: number
  amount_zar: number
  currency: string
  status: 'paid' | 'open' | 'void'
  created_at: string
  pdf_url?: string
}

/**
 * Cloud Billing page — shows the current plan and invoice history.
 *
 * Calls the cloud billing endpoints which are only available when the backend
 * CARTCRFT_CLOUD flag is on. If the backend flag is off (or the endpoint
 * doesn't exist), the SDK call returns a 404 or 501 — the component degrades
 * gracefully by showing a "Cloud not enabled" state.
 */
export default function CloudBillingPage() {
  const { activeStore } = useStore()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!activeStore) return
    setLoading(true)
    setError(null)

    const sdk = getSdk()
    Promise.all([
      sdk.request<{ plan: Plan }>(`/cloud/billing/plan`),
      sdk.request<{ invoices: Invoice[] }>(`/cloud/billing/invoices`),
    ])
      .then(([planRes, invoicesRes]) => {
        setPlan(planRes.plan)
        setInvoices(invoicesRes.invoices ?? [])
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        setError(msg)
      })
      .finally(() => setLoading(false))
  }, [activeStore?.id])

  const planBadgeColor = (status: Plan['status']) => {
    if (status === 'active' || status === 'trialing') return 'emerald'
    if (status === 'past_due') return 'amber'
    return 'red'
  }

  const invoiceBadgeColor = (status: Invoice['status']) => {
    if (status === 'paid') return 'emerald'
    if (status === 'open') return 'amber'
    return 'slate'
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        description="Manage your CartCrft Cloud subscription, invoices, and payment method."
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
              ? 'Cloud billing is not enabled on this backend. Set CARTCRFT_CLOUD=1 and restart.'
              : `Failed to load billing data: ${error}`
          }
        />
      )}

      {!loading && !error && (
        <>
          {/* Current plan */}
          <Card title="Current plan">
            {plan ? (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base font-semibold text-white">{plan.name}</span>
                    <Badge color={planBadgeColor(plan.status)}>
                      {plan.status.replace('_', ' ')}
                    </Badge>
                  </div>
                  <p className="text-xs text-slate-400">
                    ${plan.price_usd}/mo ·{' '}
                    {plan.cancel_at_period_end
                      ? `Cancels on ${new Date(plan.current_period_end).toLocaleDateString()}`
                      : `Renews on ${new Date(plan.current_period_end).toLocaleDateString()}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Btn variant="secondary" onClick={() => window.open('mailto:hello@webcrft.io?subject=Plan+change', '_blank')}>
                    Change plan
                  </Btn>
                  {!plan.cancel_at_period_end && (
                    <Btn variant="danger" onClick={() => window.open('mailto:hello@webcrft.io?subject=Cancel+subscription', '_blank')}>
                      Cancel
                    </Btn>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-400">No active plan found.</div>
            )}
          </Card>

          {/* Invoices */}
          <Card title="Invoices">
            {invoices.length === 0 ? (
              <p className="text-sm text-slate-400 py-4 text-center">No invoices yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-left">
                      <th className="pb-2.5 pr-4 font-medium text-slate-500">Date</th>
                      <th className="pb-2.5 pr-4 font-medium text-slate-500">Amount (USD)</th>
                      <th className="pb-2.5 pr-4 font-medium text-slate-500">Amount (ZAR)</th>
                      <th className="pb-2.5 pr-4 font-medium text-slate-500">Status</th>
                      <th className="pb-2.5 font-medium text-slate-500">Receipt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {invoices.map(inv => (
                      <tr key={inv.id}>
                        <td className="py-2.5 pr-4 text-slate-300">
                          {new Date(inv.created_at).toLocaleDateString()}
                        </td>
                        <td className="py-2.5 pr-4 text-slate-300">
                          ${inv.amount_usd.toFixed(2)}
                        </td>
                        <td className="py-2.5 pr-4 text-slate-300">
                          R{inv.amount_zar.toFixed(2)}
                        </td>
                        <td className="py-2.5 pr-4">
                          <Badge color={invoiceBadgeColor(inv.status)}>{inv.status}</Badge>
                        </td>
                        <td className="py-2.5">
                          {inv.pdf_url ? (
                            <a
                              href={inv.pdf_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-violet-400 hover:text-violet-300 underline underline-offset-2 transition"
                            >
                              PDF
                            </a>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Payment method note */}
          <Card title="Payment method">
            <p className="text-xs text-slate-400 leading-relaxed">
              Subscriptions are billed via <strong className="text-slate-300">Paystack</strong> (for
              South African merchants) or <strong className="text-slate-300">Stripe</strong>{' '}
              (international). USD amounts are the contractual reference; ZAR invoices reflect the
              exchange rate at billing time.
            </p>
            <div className="mt-3">
              <Btn
                variant="secondary"
                onClick={() =>
                  window.open('mailto:hello@webcrft.io?subject=Payment+method+update', '_blank')
                }
              >
                Update payment method
              </Btn>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
