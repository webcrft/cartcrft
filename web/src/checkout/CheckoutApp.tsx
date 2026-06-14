import { useEffect, useState, useCallback } from 'react'
import { BrowserRouter, Routes, Route, useParams } from 'react-router-dom'
import '../styles/tokens.css'
import './CheckoutApp.css'

/**
 * CheckoutApp — the hosted checkout / shareable-payment-link zone (/pay/:token).
 *
 * Self-contained sub-app (its own BrowserRouter) mounted by Root.tsx's zone
 * router for any path under /pay. It:
 *   1. resolves the public checkout link (GET /storefront/checkout-links/:token)
 *   2. renders a clean hosted checkout — store name + the cartcrft mark, line
 *      items + totals, an email field, and a Pay button
 *   3. on Pay, calls POST /storefront/checkout-links/:token/start-payment and
 *      redirects the browser to the provider URL (Paystack authorization_url /
 *      Xendit invoice_url; Stripe/Razorpay return a client session the host can
 *      hand to the provider widget — here we surface a clear message since the
 *      hosted page intentionally ships no provider JS).
 *
 * Embed mode: /pay/:token?embed=1 renders a compact, shadow-less card suited to
 * an <iframe>. Provider redirects break out via window.top so the customer
 * leaves the iframe for the provider's domain, then returns to success/cancel.
 *
 * Iframe snippet (drop on any site):
 *
 *   <iframe
 *     src="https://pay.cartcrft.dev/pay/cl_xxxxx?embed=1"
 *     style="width:100%;max-width:480px;height:640px;border:0;border-radius:14px"
 *     title="Checkout"
 *     allow="payment">
 *   </iframe>
 *
 * Backend base URL is inlined by Vite from PUBLIC_API_URL (mirrors the
 * dashboard/superadmin SDKs); defaults to http://localhost:8080 in dev.
 */

const API_BASE: string = import.meta.env.PUBLIC_API_URL ?? 'http://localhost:8080'

// ── Types (mirror the backend ResolvedCheckoutLink) ─────────────────────────

interface LineView {
  variant_id: string
  qty: number
  unit_price: string
  line_total: string
  title: string
  sku: string
}
interface Totals {
  subtotal: string
  tax_total: string
  shipping_total: string
  total: string
  currency: string
}
interface ResolvedLink {
  token: string
  status: 'open' | 'completed' | 'expired' | 'void'
  store: { name: string }
  line_items: LineView[]
  totals: Totals
  customer_email: string | null
  success_url: string | null
  cancel_url: string | null
  expires_at: string | null
}

// ── Money formatting ────────────────────────────────────────────────────────

function money(amount: string, currency: string): string {
  const n = Number.parseFloat(amount)
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n)
  } catch {
    // Unknown/invalid currency code → fall back to "12.00 XYZ"
    return `${n.toFixed(2)} ${currency}`
  }
}

// ── Shared chrome ───────────────────────────────────────────────────────────

function Mark() {
  return (
    <span className="pay-mark">
      Secured by <b>cartcrft</b>
    </span>
  )
}

function StatePanel(props: {
  badge: string
  title: string
  message: string
  variant?: 'error' | 'info'
  embed: boolean
}) {
  return (
    <div className={`pay ${props.embed ? 'pay--embed' : ''}`}>
      <div className={`pay-state ${props.variant === 'error' ? 'pay-state--error' : ''}`}>
        <div className="pay-state-badge">{props.badge}</div>
        <h1 className="pay-state-title">{props.title}</h1>
        <p className="pay-state-msg">{props.message}</p>
        <div className="pay-foot">
          <Mark />
        </div>
      </div>
    </div>
  )
}

function LoadingPanel({ embed }: { embed: boolean }) {
  return (
    <div className={`pay ${embed ? 'pay--embed' : ''}`}>
      <div className="pay-card" aria-busy="true" aria-label="Loading checkout">
        <div className="pay-head">
          <div className="pay-skel" style={{ width: 140, height: 18 }} />
          <div className="pay-skel" style={{ width: 90, height: 10 }} />
        </div>
        <div className="pay-body">
          <div className="pay-skel" style={{ width: '100%', height: 44, marginBottom: 12 }} />
          <div className="pay-skel" style={{ width: '100%', height: 44, marginBottom: 12 }} />
          <div className="pay-skel" style={{ width: '100%', height: 48, marginTop: 20 }} />
        </div>
      </div>
    </div>
  )
}

// ── The checkout page ───────────────────────────────────────────────────────

function CheckoutPage() {
  const { token = '' } = useParams<{ token: string }>()
  const embed = new URLSearchParams(window.location.search).get('embed') === '1'

  const [link, setLink] = useState<ResolvedLink | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [paying, setPaying] = useState(false)
  const [payError, setPayError] = useState<string | null>(null)

  // ── Resolve the link ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLink(null)
    setLoadError(null)
    fetch(`${API_BASE}/storefront/checkout-links/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = (await res.json()) as ResolvedLink & { error?: { message?: string } }
        if (!res.ok) throw new Error(data.error?.message ?? `Unable to load checkout (${res.status})`)
        return data
      })
      .then((data) => {
        if (cancelled) return
        setLink(data)
        if (data.customer_email) setEmail(data.customer_email)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : 'Unable to load checkout')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // ── Pay ───────────────────────────────────────────────────────────────────
  const onPay = useCallback(async () => {
    if (!link || paying) return
    setPaying(true)
    setPayError(null)
    try {
      const res = await fetch(
        `${API_BASE}/storefront/checkout-links/${encodeURIComponent(token)}/start-payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(email ? { email } : {}),
        },
      )
      const data = (await res.json()) as Record<string, unknown> & { error?: { message?: string } }
      if (!res.ok) throw new Error(data.error?.message ?? `Payment could not be started (${res.status})`)

      // Redirect-style providers: break out of any iframe to the provider domain.
      const redirect = (data['authorization_url'] ?? data['invoice_url']) as string | undefined
      if (redirect) {
        const top = window.top ?? window
        top.location.href = redirect
        return
      }

      // Stripe / Razorpay return a client session rather than a redirect URL.
      // The hosted page intentionally ships no provider JS, so we surface a
      // clear next step instead of silently stalling.
      if (data['client_secret'] || data['order_id']) {
        setPayError(
          'This store uses a provider that requires an additional confirmation step. ' +
            'Please complete payment in the store or contact the merchant.',
        )
        setPaying(false)
        return
      }

      setPayError('No payment redirect was returned. Please try again.')
      setPaying(false)
    } catch (err: unknown) {
      setPayError(err instanceof Error ? err.message : 'Payment could not be started')
      setPaying(false)
    }
  }, [link, paying, token, email])

  // ── Render states ─────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <StatePanel
        embed={embed}
        variant="error"
        badge="Checkout"
        title="Link unavailable"
        message={loadError}
      />
    )
  }
  if (!link) return <LoadingPanel embed={embed} />

  if (link.status === 'completed') {
    return (
      <StatePanel
        embed={embed}
        badge="Checkout · Paid"
        title="Already paid"
        message="This checkout link has already been completed. No further action is needed."
      />
    )
  }
  if (link.status === 'expired') {
    return (
      <StatePanel
        embed={embed}
        variant="error"
        badge="Checkout · Expired"
        title="Link expired"
        message="This checkout link has expired. Please ask the merchant for a fresh link."
      />
    )
  }
  if (link.status === 'void') {
    return (
      <StatePanel
        embed={embed}
        variant="error"
        badge="Checkout · Void"
        title="Link cancelled"
        message="This checkout link was cancelled by the merchant."
      />
    )
  }

  const { totals } = link
  const hasTax = Number.parseFloat(totals.tax_total) > 0
  const hasShipping = Number.parseFloat(totals.shipping_total) > 0

  return (
    <div className={`pay ${embed ? 'pay--embed' : ''}`}>
      <div className="pay-card">
        <header className="pay-head">
          <span className="pay-store">{link.store.name}</span>
          <Mark />
        </header>

        <div className="pay-body">
          <p className="pay-label">Order summary</p>
          <div className="pay-lines">
            {link.line_items.map((li) => (
              <div className="pay-line" key={li.variant_id}>
                <div className="pay-line-main">
                  <div className="pay-line-title">{li.title}</div>
                  <div className="pay-line-meta">
                    {li.qty} × {money(li.unit_price, totals.currency)}
                    {li.sku ? ` · ${li.sku}` : ''}
                  </div>
                </div>
                <div className="pay-line-amt">{money(li.line_total, totals.currency)}</div>
              </div>
            ))}
          </div>

          <div className="pay-totals">
            <div className="pay-total-row">
              <span>Subtotal</span>
              <span className="pay-total-amt">{money(totals.subtotal, totals.currency)}</span>
            </div>
            {hasTax && (
              <div className="pay-total-row">
                <span>Tax</span>
                <span className="pay-total-amt">{money(totals.tax_total, totals.currency)}</span>
              </div>
            )}
            {hasShipping && (
              <div className="pay-total-row">
                <span>Shipping</span>
                <span className="pay-total-amt">{money(totals.shipping_total, totals.currency)}</span>
              </div>
            )}
            <div className="pay-total-row pay-total-row--grand">
              <span>Total</span>
              <span className="pay-total-amt">{money(totals.total, totals.currency)}</span>
            </div>
          </div>

          {payError && <div className="pay-error-banner">{payError}</div>}

          <div className="pay-field">
            <label className="pay-label" htmlFor="pay-email">
              Email for receipt
            </label>
            <input
              id="pay-email"
              className="pay-input"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <button className="pay-btn" onClick={onPay} disabled={paying}>
            {paying ? 'Starting payment…' : `Pay ${money(totals.total, totals.currency)}`}
          </button>

          <div className="pay-foot">
            <Mark />
          </div>
        </div>
      </div>
    </div>
  )
}

export default function CheckoutApp() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/pay/:token" element={<CheckoutPage />} />
        <Route
          path="*"
          element={
            <StatePanel
              embed={false}
              variant="error"
              badge="Checkout"
              title="Invalid link"
              message="This checkout URL is malformed. Please check the link and try again."
            />
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
