import { useEffect, useRef, useState } from 'react'
import './PricingCalculator.css'

/**
 * PricingCalculator — an honestly-grounded GMV cost comparison.
 *
 * Model (June 2026, USD/mo). Platform cost = subscription + platform rake × GMV.
 * Payment-gateway processing (~2.9% + 30¢) is IDENTICAL across all of these
 * (everyone is bring-your-own-keys) so it is excluded — the differentiator is the
 * platform's own take rate. Sources:
 *   - Cartcrft Cloud: cloud/billing/model/REPORT.md — Nano $19 / Starter $79 /
 *     Scale $199, 0% GMV rake, BYO keys.
 *   - Shopify: public plan pricing — Basic $39 / Shopify $105 / Advanced $399,
 *     with third-party-gateway transaction fees of 2% / 1% / 0.6% respectively.
 *   - Medusa Cloud: Launch $99, 0% rake.
 *   - Self-host: ~$40/mo infra, 0% rake.
 */

type Quote = { key: string; name: string; plan: string; cost: number; rakePct: number; us?: boolean }

function cartcrft(gmv: number): Quote {
  const t = gmv <= 4000 ? { plan: 'Nano', sub: 19 } : gmv <= 50000 ? { plan: 'Starter', sub: 79 } : { plan: 'Scale', sub: 199 }
  return { key: 'cc', name: 'Cartcrft Cloud', plan: t.plan, cost: t.sub, rakePct: 0, us: true }
}
function shopify(gmv: number): Quote {
  const plans = [
    { plan: 'Basic', sub: 39, rake: 0.02 },
    { plan: 'Shopify', sub: 105, rake: 0.01 },
    { plan: 'Advanced', sub: 399, rake: 0.006 },
  ]
  let best = plans[0]
  let bestCost = Infinity
  for (const p of plans) {
    const c = p.sub + p.rake * gmv
    if (c < bestCost) { bestCost = c; best = p }
  }
  return { key: 'shopify', name: 'Shopify', plan: best.plan, cost: best.sub + best.rake * gmv, rakePct: best.rake * 100 }
}
const medusa = (): Quote => ({ key: 'medusa', name: 'Medusa Cloud', plan: 'Launch', cost: 99, rakePct: 0 })
const selfhost = (): Quote => ({ key: 'self', name: 'Self-host', plan: 'infra', cost: 40, rakePct: 0 })

// log slider: t∈[0,1] → GMV ∈ [1_000, 500_000]
const GMV_MIN = 1000
const GMV_MAX = 500000
const tToGmv = (t: number) => {
  const raw = GMV_MIN * Math.pow(GMV_MAX / GMV_MIN, t)
  // round to a clean-ish number
  const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1)
  return Math.round(raw / mag) * mag
}
const gmvToT = (g: number) => Math.log(g / GMV_MIN) / Math.log(GMV_MAX / GMV_MIN)

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

/** ease a displayed number toward a target with rAF */
function useCountUp(target: number, ms = 420) {
  const [val, setVal] = useState(target)
  const fromRef = useRef(target)
  const startRef = useRef(0)
  const rafRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || from === target) { fromRef.current = target; setVal(target); return }
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

export default function PricingCalculator() {
  const [t, setT] = useState(gmvToT(25000))
  const gmv = tToGmv(t)

  const quotes = [cartcrft(gmv), shopify(gmv), medusa(), selfhost()]
  const max = Math.max(...quotes.map((q) => q.cost))
  const cc = quotes[0]
  const shop = quotes[1]
  const saving = Math.max(0, shop.cost - cc.cost)

  const animSaving = useCountUp(saving)
  const animYear = useCountUp(saving * 12)
  const animGmv = useCountUp(gmv)

  return (
    <div className="calc">
      <div className="calc-grain cc-grain" aria-hidden="true" />
      <div className="calc-head">
        <span className="calc-eyebrow">[ <span className="calc-dot" /> live · grounded ]</span>
        <h3 className="calc-title">Run <span className="lime">your</span> numbers.</h3>
        <p className="calc-sub">Drag your monthly GMV. We compute platform cost — subscription plus take-rate — at that volume. Gateway fees (~2.9%) are the same everywhere and excluded.</p>
      </div>

      <div className="calc-control">
        <div className="calc-gmv">
          <span className="calc-gmv-label">monthly GMV</span>
          <span className="calc-gmv-val">{usd(animGmv)}</span>
        </div>
        <input
          className="calc-slider"
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={t}
          onChange={(e) => setT(Number(e.target.value))}
          aria-label="Monthly GMV"
        />
        <div className="calc-ticks"><span>$1k</span><span>$10k</span><span>$100k</span><span>$500k</span></div>
      </div>

      <div className="calc-bars">
        {quotes.map((q) => (
          <div key={q.key} className={`calc-row${q.us ? ' calc-row--us' : ''}`}>
            <div className="calc-row-head">
              <span className="calc-row-name">{q.name}</span>
              <span className="calc-row-plan">{q.plan}{q.rakePct > 0 ? ` · ${q.rakePct % 1 === 0 ? q.rakePct : q.rakePct.toFixed(1)}% rake` : ' · 0% rake'}</span>
            </div>
            <div className="calc-track">
              <div className="calc-fill" style={{ width: `${Math.max(4, (q.cost / max) * 100)}%` }} />
              <span className="calc-cost">{usd(q.cost)}<span className="calc-per">/mo</span></span>
            </div>
          </div>
        ))}
      </div>

      <div className="calc-result">
        {saving > 0 ? (
          <>
            <div className="calc-save">
              <span className="calc-save-num">{usd(animSaving)}<span>/mo</span></span>
              <span className="calc-save-lab">saved vs Shopify at {usd(gmv)} GMV</span>
            </div>
            <div className="calc-year">≈ <strong>{usd(animYear)}</strong> a year · 0% of it is our take</div>
          </>
        ) : (
          <div className="calc-save calc-save--flat">
            <span className="calc-save-lab">At {usd(gmv)} GMV, Shopify’s plan edges it — our Nano tier closes the sub-$4k gap. The bigger you get, the more 0% rake wins.</span>
          </div>
        )}
      </div>

      <p className="calc-note">
        Grounded June 2026: Cartcrft Nano $19 / Starter $79 / Scale $199 (0% rake) · Shopify Basic $39 / $105 / $399 with 2% / 1% / 0.6% third-party-gateway fees · Medusa Launch $99 · self-host ~$40 infra. Platform cost only — your payment gateway is bring-your-own and identical across all.
      </p>
    </div>
  )
}
