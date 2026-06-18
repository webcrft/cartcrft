/**
 * System Analytics — overview cards + timeseries chart + health panel.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import {
  getAnalyticsOverview,
  getAnalyticsTimeseries,
  getAnalyticsHealth,
  type AnalyticsOverview,
  type TimeseriesPoint,
  type HealthResult,
  SuperAdminApiError,
} from '../lib/api'
import {
  PageHeader,
  StatCard,
  Card,
  Spinner,
  LoadError,
  Badge,
} from '../components/ui/index'
import { RefreshCw } from 'lucide-react'

// ── Inline SVG timeseries chart ────────────────────────────────────────────────

const METRIC_LABELS: Record<'orders' | 'gmv' | 'signups', string> = {
  orders: 'Orders',
  gmv: 'GMV (USD)',
  signups: 'New customers',
}

function fmtMetricValue(value: number, metric: 'orders' | 'gmv' | 'signups'): string {
  if (metric === 'gmv') {
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  }
  return Math.round(value).toLocaleString('en-US')
}

function TimeseriesChart({ points, metric }: { points: TimeseriesPoint[]; metric: 'orders' | 'gmv' | 'signups' }) {
  if (!points.length) return <p className="text-[13px] text-[var(--cc-text-muted)] py-4 text-center">No data yet</p>

  // bucket is a timestamp string ("2026-05-16 00:00:00+02") — take YYYY-MM-DD.
  const fmtBucket = (b: string | undefined) => (b ?? '').slice(0, 10)

  const values = points.map(p =>
    metric === 'orders' ? p.orders :
    metric === 'signups' ? p.newCustomers :
    parseFloat(p.gmv),
  )
  const max = Math.max(...values, 1)
  const W = 600
  const H = 120
  const PAD_L = 40
  const PAD_B = 24
  const chartW = W - PAD_L
  const chartH = H - PAD_B

  const pts = points.map((p, i) => {
    const x = PAD_L + (i / Math.max(points.length - 1, 1)) * chartW
    const y = chartH - (values[i] / max) * chartH
    return { x, y, point: p, value: values[i] }
  })

  const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
  const areaD = `${pathD} L ${pts[pts.length - 1].x} ${chartH} L ${PAD_L} ${chartH} Z`

  const yTicks = [0, max / 2, max].map(v =>
    metric === 'gmv' ? `$${(v / 1000).toFixed(0)}k` : String(Math.round(v)),
  )

  const firstDate = fmtBucket(pts[0].point.bucket)
  const lastDate = fmtBucket(pts[pts.length - 1].point.bucket)
  const descText = `Line chart of ${METRIC_LABELS[metric]} from ${firstDate} to ${lastDate}. Minimum ${fmtMetricValue(Math.min(...values), metric)}, maximum ${fmtMetricValue(max, metric)}.`

  return (
    <div>
      {/* Legend / active-metric label */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1" aria-hidden="true">
            <span className="inline-block h-0.5 w-4 rounded-full bg-[var(--cc-lime)]" />
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--cc-lime)] -ml-2.5 ring-2 ring-[var(--cc-lime)]/25" />
          </span>
          <span className="text-[12px] font-medium text-[var(--cc-text-body)]">{METRIC_LABELS[metric]}</span>
          <span className="text-[12px] text-[var(--cc-text-muted)]">— daily, last 30 days</span>
        </div>
        <span className="text-[12px] text-[var(--cc-text-muted)]">
          Peak <span className="font-mono text-[12px] text-[var(--cc-lime)] font-medium tabular-nums">{fmtMetricValue(max, metric)}</span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full"
        style={{ minHeight: 120 }}
        role="img"
        aria-label={`${METRIC_LABELS[metric]} over time`}
      >
        <title>{METRIC_LABELS[metric]} over the last 30 days</title>
        <desc>{descText}</desc>
        {/* Y-axis ticks (min / mid / max labels) */}
        {[0, 0.5, 1].map((frac, i) => {
          const cy = chartH * (1 - frac)
          return (
            <g key={i}>
              <line
                x1={PAD_L}
                y1={cy}
                x2={W}
                y2={cy}
                stroke="rgba(255,255,255,0.05)"
                strokeWidth={1}
                strokeDasharray={frac === 0 ? undefined : '2 4'}
              />
              <text x={PAD_L - 6} y={cy + 3} textAnchor="end" fontSize={9} fill="#85867a" fontFamily="'JetBrains Mono', monospace">{yTicks[i]}</text>
            </g>
          )
        })}
        {/* Area fill — lime */}
        <defs>
          <linearGradient id="sa-chart-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b5ff2e" stopOpacity="0.26" />
            <stop offset="100%" stopColor="#b5ff2e" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#sa-chart-grad)" />
        {/* Line — lime */}
        <path d={pathD} fill="none" stroke="#b5ff2e" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* Data points — enlarged hit target + per-point native tooltip */}
        {pts.map((p, i) => (
          <g key={i} className="group">
            {/* invisible larger hover/touch target */}
            <circle cx={p.x} cy={p.y} r={8} fill="transparent">
              <title>{`${fmtBucket(p.point.bucket)}: ${fmtMetricValue(p.value, metric)}`}</title>
            </circle>
            <circle
              cx={p.x}
              cy={p.y}
              r={2.5}
              fill="#0c0d0a"
              stroke="#b5ff2e"
              strokeWidth={1.5}
              className="transition-all group-hover:[r:4px] group-hover:[stroke-width:2.5px]"
            />
          </g>
        ))}
        {/* X labels — first, mid, last date */}
        {[0, Math.floor(pts.length / 2), pts.length - 1].map(i => {
          if (!pts[i]) return null
          const label = fmtBucket(pts[i].point.bucket).slice(5) // MM-DD
          return (
            <text key={i} x={pts[i].x} y={H - 4} textAnchor="middle" fontSize={9} fill="#85867a" fontFamily="'JetBrains Mono', monospace">
              {label}
            </text>
          )
        })}
      </svg>
    </div>
  )
}

// ── Health Panel ───────────────────────────────────────────────────────────────

function HealthPanel({ health }: { health: HealthResult }) {
  const rows: { label: string; value: string; ok: boolean }[] = [
    { label: 'Database', value: health.db, ok: health.db === 'ok' },
    { label: 'Pool', value: health.pool, ok: health.pool === 'ok' },
    { label: 'Migration', value: health.migration, ok: health.migration === 'ok' },
    { label: 'Worker', value: health.worker, ok: health.worker === 'ok' },
    { label: 'Errors (24h)', value: String(health.errors), ok: health.errors === 0 },
  ]

  const overallColor =
    health.status === 'healthy' ? 'emerald' :
    health.status === 'degraded' ? 'amber' : 'red'

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[12px] font-medium text-[var(--cc-text-muted)]">System status</span>
        <Badge color={overallColor}><span className="capitalize">{health.status}</span></Badge>
      </div>
      {rows.map(row => (
        <div key={row.label} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
          <span className="text-[13px] text-[var(--cc-text-body)]">{row.label}</span>
          <Badge color={row.ok ? 'emerald' : 'red'}><span className="capitalize">{row.value}</span></Badge>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Metric = 'orders' | 'gmv' | 'signups'

export default function Analytics() {
  const { token, handle401 } = useAuth()
  const { toast } = useToast()

  const [overview, setOverview] = useState<AnalyticsOverview | null>(null)
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([])
  const [health, setHealth] = useState<HealthResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [metric, setMetric] = useState<Metric>('orders')

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const [ov, ts, h] = await Promise.all([
        getAnalyticsOverview(token),
        getAnalyticsTimeseries(token, 30, 'day'),
        getAnalyticsHealth(token),
      ])
      setOverview(ov)
      setTimeseries(ts.points ?? [])
      setHealth(h)
    } catch (err) {
      if (err instanceof SuperAdminApiError && err.status === 401) { handle401(); return }
      const msg = err instanceof SuperAdminApiError ? err.message : 'Failed to load analytics'
      setError(msg)
      toast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }, [token, handle401, toast])

  useEffect(() => { void load() }, [load])

  const fmt = (n: number | undefined) => n != null ? n.toLocaleString('en-US') : '—'
  const fmtMoney = (s: string | undefined) =>
    s
      ? parseFloat(s).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '—'

  return (
    <div>
      <PageHeader
        title="System Analytics"
        description="Platform-wide metrics across all tenants"
        actions={
          <button onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[13px] font-medium text-[var(--cc-text-body)] hover:bg-white/[0.08] hover:text-[var(--cc-text)] transition">
            <RefreshCw size={13} />
            Refresh
          </button>
        }
      />

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      )}

      {error && !loading && (
        <LoadError message={error} onRetry={() => void load()} />
      )}

      {!loading && !error && overview && (
        <>
          {/* Overview stats */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            <StatCard label="Orgs" value={fmt(overview.totalOrgs)} />
            <StatCard label="Stores" value={fmt(overview.totalStores)} />
            <StatCard label="Customers" value={fmt(overview.totalCustomers)} />
            <StatCard label="Orders" value={fmt(overview.totalOrders)} />
            <StatCard label="GMV" value={fmtMoney(overview.gmv)} color="green" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <StatCard
              label="Active stores (30d)"
              value={fmt(overview.activeStores30d)}
              sub="stores with activity"
            />
            <StatCard
              label="New orders (30d)"
              value={fmt(overview.newOrders30d)}
              color="green"
              sub="this period"
            />
            <StatCard
              label="New customers (30d)"
              value={fmt(overview.newCustomers30d)}
              color="green"
              sub="this period"
            />
          </div>

          {/* Timeseries chart */}
          <Card title="Trend (30 days)" className="mb-6">
            <div className="flex gap-2 mb-4">
              {(['orders', 'gmv', 'signups'] as Metric[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMetric(m)}
                  className={`px-3 py-1.5 rounded-md text-[13px] font-medium transition ${
                    metric === m
                      ? 'bg-[var(--cc-lime)]/12 text-[var(--cc-lime)] border border-[var(--cc-lime)]/30'
                      : 'text-[var(--cc-text-muted)] hover:text-[var(--cc-text-body)] border border-transparent hover:bg-white/[0.04]'
                  }`}
                >
                  {m === 'gmv' ? 'GMV' : m === 'signups' ? 'Customers' : 'Orders'}
                </button>
              ))}
            </div>
            <TimeseriesChart points={timeseries} metric={metric} />
          </Card>

          {/* Health panel */}
          {health && (
            <Card title="System Health">
              <HealthPanel health={health} />
            </Card>
          )}
        </>
      )}
    </div>
  )
}
