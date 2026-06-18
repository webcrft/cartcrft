import { useEffect, useState } from 'react'
import { CURRENCIES, FALLBACK_RATES } from './pricingData'

/**
 * useFxRates — live USD-base FX rates for the marketing pricing surface.
 *
 * Starts from the bundled FALLBACK_RATES snapshot so SSR/prerender and offline
 * render correctly. On mount it fetches a free, keyless, CORS-enabled feed
 * (open.er-api.com — same provider family the backend uses) and merges live
 * rates for the supported currencies. All errors are swallowed: on failure we
 * keep the fallback and report live=false. Never throws.
 */
export function useFxRates(): { rates: Record<string, number>; live: boolean } {
  const [rates, setRates] = useState<Record<string, number>>(FALLBACK_RATES)
  const [live, setLive] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()

    ;(async () => {
      try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: ctrl.signal })
        if (!res.ok) return
        const data: unknown = await res.json()
        if (
          typeof data !== 'object' ||
          data === null ||
          (data as { result?: unknown }).result !== 'success' ||
          typeof (data as { rates?: unknown }).rates !== 'object' ||
          (data as { rates?: unknown }).rates === null
        ) {
          return
        }

        const feed = (data as { rates: Record<string, unknown> }).rates
        const merged: Record<string, number> = { ...FALLBACK_RATES }
        for (const { code } of CURRENCIES) {
          const r = feed[code]
          if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
            merged[code] = r
          }
        }
        if (!ctrl.signal.aborted) {
          setRates(merged)
          setLive(true)
        }
      } catch {
        // swallow — keep fallback, live stays false
      }
    })()

    return () => ctrl.abort()
  }, [])

  return { rates, live }
}
