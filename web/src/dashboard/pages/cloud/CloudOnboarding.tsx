import React, { useState } from 'react'
import { PageHeader, Card, Btn, Badge } from '../../components/ui/index'

interface OnboardingStep {
  id: string
  label: string
  description: string
  status: 'complete' | 'active' | 'pending'
  action?: string
  actionHref?: string
}

/**
 * Cloud Onboarding page — guides the user through connecting their store to
 * Cartcrft Cloud. This is a placeholder/wizard surface; full implementation
 * ships with the cloud billing backend (CARTCRFT_CLOUD gate).
 */
export default function CloudOnboardingPage() {
  const [steps] = useState<OnboardingStep[]>([
    {
      id: 'account',
      label: 'Account created',
      description: 'Your Cartcrft Cloud account is active.',
      status: 'complete',
    },
    {
      id: 'store',
      label: 'Connect a store',
      description:
        'Link your Cartcrft store to your Cloud account. Your store data stays in the managed Postgres instance.',
      status: 'active',
      action: 'Configure store',
      actionHref: '/settings',
    },
    {
      id: 'payments',
      label: 'Configure payment provider',
      description:
        'Add your Paystack or Stripe credentials. Payments go directly to your provider — Cartcrft never touches funds.',
      status: 'pending',
      action: 'Add payment provider',
      actionHref: '/payment-providers',
    },
    {
      id: 'mcp',
      label: 'Enable MCP (agent surface)',
      description:
        'Your store MCP endpoint is live at /mcp/<storeId>. Point any MCP-capable agent at it with your cc_pub_ key.',
      status: 'pending',
      action: 'View API keys',
      actionHref: '/api-keys',
    },
    {
      id: 'domain',
      label: 'Set up custom domain',
      description:
        'Add a CNAME for your store API. SSL is provisioned automatically.',
      status: 'pending',
      action: 'Configure domain',
      actionHref: '/settings',
    },
  ])

  const stepBadgeColor = (status: OnboardingStep['status']) => {
    if (status === 'complete') return 'emerald'
    if (status === 'active') return 'violet'
    return 'slate'
  }

  const stepBadgeLabel = (status: OnboardingStep['status']) => {
    if (status === 'complete') return 'Done'
    if (status === 'active') return 'In progress'
    return 'Pending'
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cloud Onboarding"
        description="Follow these steps to get your store fully configured on Cartcrft Cloud."
      />

      <Card title="Setup checklist">
        <ol className="space-y-4">
          {steps.map((step, i) => (
            <li key={step.id} className="flex gap-4 items-start">
              {/* Step number */}
              <div
                className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
                  ${step.status === 'complete'
                    ? 'bg-emerald-600/20 text-emerald-400'
                    : step.status === 'active'
                    ? 'bg-violet-600/20 text-violet-400'
                    : 'bg-slate-700/40 text-slate-500'}`}
              >
                {step.status === 'complete' ? '✓' : i + 1}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-sm font-medium text-white">{step.label}</span>
                  <Badge color={stepBadgeColor(step.status)}>
                    {stepBadgeLabel(step.status)}
                  </Badge>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{step.description}</p>
                {step.action && step.status !== 'complete' && (
                  <div className="mt-2">
                    <Btn
                      variant={step.status === 'active' ? 'primary' : 'secondary'}
                      onClick={() => {
                        if (step.actionHref) window.location.href = `/dashboard${step.actionHref}`
                      }}
                    >
                      {step.action}
                    </Btn>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Need help?">
        <p className="text-xs text-slate-400 mb-3">
          Our team is here to help you get set up. Email us or check the docs.
        </p>
        <div className="flex gap-2">
          <Btn
            variant="secondary"
            onClick={() => window.open('mailto:hello@webcrft.systems?subject=Onboarding+help', '_blank')}
          >
            Email support
          </Btn>
          <Btn
            variant="secondary"
            onClick={() => window.open('/cloud/onboarding', '_blank')}
          >
            View docs
          </Btn>
        </div>
      </Card>
    </div>
  )
}
