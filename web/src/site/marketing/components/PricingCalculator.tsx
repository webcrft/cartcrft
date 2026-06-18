import { useEffect, useRef, useState } from 'react'
import {
  CURRENCIES,
  PLANS,
  computePlanPriceUsd,
  formatMoney,
  planFits,
  recommendPlan,
  type BillingPeriod,
  type Currency,
} from '../pricingData'
import { useFxRates } from '../useFxRates'
import './PricingCalculator.css'

/**
 * PricingCalculator — usage-first, multi-currency flat-price explorer.
 *
 * CartCrft is PURE FLAT: every plan is one flat monthly price with NO
 * transaction fees, NO GMV rake, and NO per-unit overages. The two levers
 * here — NUMBER OF SITES and ORDERS / MONTH — only change WHICH tier fits your
 * usage. They never add cost. Limits are upgrade boundaries, not meters.
 *
 * Honest Shopify comparison (June 2026):
 *   Shopify ≈ sites × $39 (Basic, monthly) + 2% platform rake on assumed GMV,
 *   where GMV = orders × average order value (AOV, default $65). Shopify needs a
 *   separate subscription per store and rakes a percentage of revenue — so the
 *   more you run, the more our flat model wins.
 * Gateway processing (~2.9% + 30¢) is identical everywhere (BYO keys) and is
 * excluded — the differentiator is the platform's own take rate.
 *
 * Catalog + math mirror cloud/billing/src/pricing.ts via ../pricingData.
 */

const SITES_MIN = 1
const SITES_MAX = 30

// Orders slider runs on a log scale so the full small-to-large range is usable.
const ORDERS_MIN = 50
const ORDERS_MAX = 200_000
const ORDERS_DEFAULT = 5000
const LOG_MIN = Math.log10(ORDERS_MIN)
const LOG_MAX = Math.log10(ORDERS_MAX)

/** slider position (0..1000) → orders count (log scale, snapped to a clean step) */
function sliderToOrders(pos: number): number {
  const t = pos / 1000
  const raw = Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN))
  // snap to a sensible granularity by magnitude
  const step = raw < 200 ? 10 : raw < 1000 ? 50 : raw < 10_000 ? 100 : raw < 50_000 ? 500 : 1000
  const snapped = Math.round(raw / step) * step
  return Math.min(ORDERS_MAX, Math.max(ORDERS_MIN, snapped))
}

/** orders count → slider position (0..1000) */
function ordersToSlider(orders: number): number {
  const clamped = Math.min(ORDERS_MAX, Math.max(ORDERS_MIN, orders))
  const t = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN)
  return Math.round(t * 1000)
}

// Honest, labelled GMV assumption. Shopify rake = 2% of orders × AOV.
const SHOPIFY_BASIC_USD = 39
const SHOPIFY_RAKE = 0.02
const AOV_MIN = 20
const AOV_MAX = 300
const AOV_DEFAULT = 65

// Reference plan used for the Shopify saving when usage exceeds every tier.
const GROWTH_REF = PLANS.find((p) => p.id === 'growth')!

/** Shopify monthly estimate (USD): a Basic sub per store + 2% rake on GMV. */
function shopifyMonthlyUsd(sites: number, orders: number, aov: number): number {
  return sites * SHOPIFY_BASIC_USD + SHOPIFY_RAKE * (orders * aov)
}

/** ease a displayed number toward a target with rAF */
function useCountUp(target: number, ms = 420) {
  const [val, setVal] = useState(target)
  const fromRef = useRef(target)
  const startRef = useRef(0)
  const rafRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || from === target) {
      fromRef.current = target
      setVal(target)
      return
    }
    startRef.current = performance.now()
    const tick = (now: number) => {
      const p = Math.min(1, (now - startRef.current) / ms)
      const e = 1 - Math.pow(1 - p, 3)
      setVal(from + (target - from) * e)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
      else fromRef.current = target
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, ms])
  return val
}

const intFmt = new Intl.NumberFormat('en-US')

export default function PricingCalculator() {
  const [sites, setSites] = useState(3)
  const [orders, setOrders] = useState(ORDERS_DEFAULT)
  const [period, setPeriod] = useState<BillingPeriod>('monthly')
  const [currencyCode, setCurrencyCode] = useState('USD')
  const [aov, setAov] = useState(AOV_DEFAULT)

  const { rates, live } = useFxRates()
  const currency: Currency = CURRENCIES.find((c) => c.code === currencyCode) ?? CURRENCIES[0]!
  const rate = rates[currency.code] ?? 1
  const fmt = (usd: number) => formatMoney(usd, rate, currency)

  const clampSites = (n: number) => Math.min(SITES_MAX, Math.max(SITES_MIN, Math.round(n)))

  // recommendPlan returns null when usage exceeds Scale → route to Enterprise.
  const winner = recommendPlan(sites, orders)
  const rows = PLANS.map((p) => {
    const price = computePlanPriceUsd(p.id, period)
    return { plan: p, price, isWinner: winner != null && p.id === winner.id, fits: planFits(p, sites, orders) }
  })
  const maxPerMonth = Math.max(...rows.map((r) => r.price.perMonthUsd))

  // Saving vs Shopify uses the recommended flat price, or Growth $79 as the
  // reference when usage exceeds every tier (Enterprise / custom).
  const refPrice = computePlanPriceUsd(winner?.id ?? GROWTH_REF.id, period)
  const refPlan = winner ?? GROWTH_REF
  const shopUsd = shopifyMonthlyUsd(sites, orders, aov)
  const savingUsd = Math.max(0, shopUsd - refPrice.perMonthUsd)

  const animSaving = useCountUp(savingUsd)
  const animYear = useCountUp(savingUsd * 12)

  return (
    <div className="calc">
      <div className="calc-grain cc-grain" aria-hidden="true" />
      <div className="calc-head">
        <span className="calc-eyebrow">
          [ <span className={`calc-dot${live ? '' : ' calc-dot--idle'}`} /> {live ? 'live FX' : 'indicative FX'} · grounded ]
        </span>
        <h3 className="calc-title">
          One flat price. <span className="lime">No usage fees.</span>
        </h3>
        <p className="calc-sub">
          Every CartCrft plan is a flat monthly fee — no transaction fees, no GMV rake, no per-order charges. Your sites and
          orders only decide which tier fits. Shopify needs a subscription per store and rakes 2% of revenue.
        </p>
        <span className="calc-flat-badge">Flat price — no transaction fees, no GMV rake</span>
      </div>

      {/* — Primary control: number of sites — */}
      <div className="calc-control">
        <div className="calc-gmv">
          <span className="calc-gmv-label">how many sites?</span>
          <span className="calc-gmv-val">{sites}</span>
        </div>
        <div className="calc-stepper">
          <button
            type="button"
            className="calc-step-btn"
            onClick={() => setSites((s) => clampSites(s - 1))}
            disabled={sites <= SITES_MIN}
            aria-label="Remove a site"
          >
            −
          </button>
          <input
            className="calc-slider calc-slider--sites"
            type="range"
            min={SITES_MIN}
            max={SITES_MAX}
            step={1}
            value={sites}
            onChange={(e) => setSites(clampSites(Number(e.target.value)))}
            aria-label="Number of sites"
          />
          <button
            type="button"
            className="calc-step-btn"
            onClick={() => setSites((s) => clampSites(s + 1))}
            disabled={sites >= SITES_MAX}
            aria-label="Add a site"
          >
            +
          </button>
        </div>
        <div className="calc-ticks">
          <span>1</span>
          <span>10</span>
          <span>25</span>
          <span>30</span>
        </div>
      </div>

      {/* — Secondary control: orders / month (log scale) — */}
      <div className="calc-control">
        <div className="calc-gmv">
          <span className="calc-gmv-label">orders / month?</span>
          <span className="calc-gmv-val">{intFmt.format(orders)}</span>
        </div>
        <input
          className="calc-slider calc-slider--orders"
          type="range"
          min={0}
          max={1000}
          step={1}
          value={ordersToSlider(orders)}
          onChange={(e) => setOrders(sliderToOrders(Number(e.target.value)))}
          aria-label="Orders per month"
        />
        <div className="calc-ticks">
          <span>50</span>
          <span>1k</span>
          <span>25k</span>
          <span>200k</span>
        </div>
      </div>

      {/* — Period toggle + currency selector — */}
      <div className="calc-options">
        <div className="calc-toggle" role="group" aria-label="Billing period">
          <button
            type="button"
            className={`calc-toggle-btn${period === 'monthly' ? ' is-active' : ''}`}
            onClick={() => setPeriod('monthly')}
            aria-pressed={period === 'monthly'}
          >
            Monthly
          </button>
          <button
            type="button"
            className={`calc-toggle-btn${period === 'annual' ? ' is-active' : ''}`}
            onClick={() => setPeriod('annual')}
            aria-pressed={period === 'annual'}
          >
            Annual <span className="calc-toggle-save">2 months free</span>
          </button>
        </div>

        <label className="calc-currency">
          <span className="calc-currency-lab">currency</span>
          <select
            className="calc-currency-select"
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value)}
            aria-label="Display currency"
          >
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} ({c.symbol})
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="calc-fx-note">
        <span className={`calc-dot${live ? '' : ' calc-dot--idle'}`} aria-hidden="true" />
        {currency.code === 'USD'
          ? 'USD billed'
          : `indicative · USD billed${live ? '' : ' · indicative FX'}`}
      </p>

      {/* — Plan bars — */}
      <div className="calc-bars">
        {rows.map(({ plan, price, isWinner, fits }) => (
          <div key={plan.id} className={`calc-row${isWinner ? ' calc-row--us' : ''}${!fits ? ' calc-row--unfit' : ''}`}>
            <div className="calc-row-head">
              <span className="calc-row-name">
                {plan.name}
                {isWinner && <span className="calc-badge">best fit for your usage</span>}
              </span>
              <span className="calc-row-plan">
                {plan.sites} site{plan.sites === 1 ? '' : 's'} · {intFmt.format(plan.orders)} orders/mo · {plan.seats} seat
                {plan.seats === 1 ? '' : 's'}
              </span>
            </div>
            <div className="calc-track">
              <div className="calc-fill" style={{ width: `${Math.max(4, (price.perMonthUsd / maxPerMonth) * 100)}%` }} />
              <span className="calc-cost">
                {fmt(price.perMonthUsd)}
                <span className="calc-per">/mo</span>
              </span>
            </div>
          </div>
        ))}

        {/* Enterprise recommendation when usage exceeds every tier. */}
        {winner == null && (
          <div className="calc-row calc-row--us calc-row--ent">
            <div className="calc-row-head">
              <span className="calc-row-name">
                Enterprise
                <span className="calc-badge">best fit for your usage</span>
              </span>
              <span className="calc-row-plan">beyond Scale · custom limits</span>
            </div>
            <div className="calc-track calc-track--ent">
              <span className="calc-cost">
                Let’s talk
                <span className="calc-per"> · custom flat</span>
              </span>
            </div>
            <a className="calc-ent-cta" href="mailto:hello@webcrft.io?subject=Enterprise+inquiry">
              Talk to us →
            </a>
          </div>
        )}
      </div>

      {/* — Result vs Shopify — */}
      <div className="calc-result">
        {savingUsd > 0 ? (
          <>
            <div className="calc-save">
              <span className="calc-save-num">
                {fmt(animSaving)}
                <span>/mo</span>
              </span>
              <span className="calc-save-lab">
                saved vs Shopify at {sites} site{sites === 1 ? '' : 's'} · {intFmt.format(orders)} orders (
                {winner ? `${refPlan.name} ${fmt(refPrice.perMonthUsd)}/mo flat` : `Growth ${fmt(refPrice.perMonthUsd)}/mo reference`})
              </span>
            </div>
            <div className="calc-year">
              ≈ <strong>{fmt(animYear)}</strong> a year · 0% of it is our take
            </div>
          </>
        ) : (
          <div className="calc-save calc-save--flat">
            <span className="calc-save-lab">
              At {sites} site{sites === 1 ? '' : 's'} and this volume, Shopify’s Basic plan edges it on the sticker — but it
              rakes 2% as your sales grow. Our flat price never moves with revenue.
            </span>
          </div>
        )}
      </div>

      {/* — Shopify AOV assumption (small, honest, labelled) — */}
      <div className="calc-assume">
        <div className="calc-assume-head">
          <span className="calc-assume-lab">Shopify estimate assumes</span>
          <span className="calc-assume-val">{fmt(aov)} average order</span>
        </div>
        <input
          className="calc-slider calc-slider--gmv"
          type="range"
          min={AOV_MIN}
          max={AOV_MAX}
          step={5}
          value={aov}
          onChange={(e) => setAov(Number(e.target.value))}
          aria-label="Assumed average order value"
        />
        <p className="calc-assume-note">
          Shopify ≈ {sites} × $39 Basic {sites === 1 ? 'subscription' : 'subscriptions'} + 2% platform rake on{' '}
          {intFmt.format(orders)} orders × {fmt(aov)} AOV = {fmt(orders * aov)} GMV ≈ <strong>{fmt(shopUsd)}/mo</strong>.
          Gateway fees (~2.9%) are the same everywhere and excluded.
        </p>
      </div>

      <p className="calc-note">
        Flat monthly — no transaction fees, no GMV rake, bring your own payment keys. Limits are upgrade boundaries, never
        per-unit charges. USD billed; other currencies indicative. Solo $9 (1 site/1k orders) · Studio $29 (3/5k) · Growth
        $79 (10/25k) · Scale $199 (25/100k). Annual = 10 months billed (2 free) · Shopify Basic $39/store + 2%
        external-gateway rake · FX {live ? 'live' : 'indicative'}, for reference only.
      </p>
    </div>
  )
}
