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

// ── Inline SVG timeseries chart ────────────────────────────────────────────────

const METRIC_LABELS: Record<'orders' | 'gmv' | 'signups', string> = {
  orders: 'Orders',
  gmv: 'GMV (USD)',
  signups: 'Signups',
}

function fmtMetricValue(value: number, metric: 'orders' | 'gmv' | 'signups'): string {
  if (metric === 'gmv') {
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  }
  return Math.round(value).toLocaleString('en-US')
}

function TimeseriesChart({ points, metric }: { points: TimeseriesPoint[]; metric: 'orders' | 'gmv' | 'signups' }) {
  if (!points.length) return <p className="text-xs text-zinc-500 py-4 text-center">No data</p>

  const values = points.map(p =>
    metric === 'orders' ? p.orders :
    metric === 'signups' ? p.signups :
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

  const firstDate = pts[0].point.date
  const lastDate = pts[pts.length - 1].point.date
  const descText = `Line chart of ${METRIC_LABELS[metric]} from ${firstDate} to ${lastDate}. Minimum ${fmtMetricValue(Math.min(...values), metric)}, maximum ${fmtMetricValue(max, metric)}.`

  return (
    <div>
      {/* Legend / active-metric label */}
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="inline-block h-0.5 w-4 rounded-full bg-amber-500" aria-hidden="true" />
          <span className="text-xs font-medium text-zinc-300">{METRIC_LABELS[metric]}</span>
          <span className="text-[11px] text-zinc-500">— daily, last 30 days</span>
        </div>
        <span className="text-[11px] text-zinc-500 tabular-nums">
          Peak {fmtMetricValue(max, metric)}
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
              <line x1={PAD_L} y1={cy} x2={W} y2={cy} stroke="rgba(255,255,255,0.04)" strokeWidth={1} />
              <text x={PAD_L - 4} y={cy + 4} textAnchor="end" fontSize={9} fill="#71717a">{yTicks[i]}</text>
            </g>
          )
        })}
        {/* Area fill */}
        <defs>
          <linearGradient id="sa-chart-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#sa-chart-grad)" />
        {/* Line */}
        <path d={pathD} fill="none" stroke="#f59e0b" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {/* Data points — enlarged hit target + per-point native tooltip */}
        {pts.map((p, i) => (
          <g key={i} className="group">
            {/* invisible larger hover/touch target */}
            <circle cx={p.x} cy={p.y} r={8} fill="transparent">
              <title>{`${p.point.date}: ${fmtMetricValue(p.value, metric)}`}</title>
            </circle>
            <circle
              cx={p.x}
              cy={p.y}
              r={2.5}
              fill="#f59e0b"
              opacity={0.85}
              stroke="#f59e0b"
              strokeWidth={0}
              strokeOpacity={0.25}
              className="transition-[stroke-width] group-hover:[stroke-width:5px] group-hover:opacity-100"
            />
          </g>
        ))}
        {/* X labels — first, mid, last date */}
        {[0, Math.floor(pts.length / 2), pts.length - 1].map(i => {
          if (!pts[i]) return null
          const label = pts[i].point.date.slice(5) // MM-DD
          return (
            <text key={i} x={pts[i].x} y={H - 4} textAnchor="middle" fontSize={9} fill="#71717a">
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
        <span className="text-xs font-medium text-zinc-400">System status</span>
        <Badge color={overallColor}>{health.status}</Badge>
      </div>
      {rows.map(row => (
        <div key={row.label} className="flex items-center justify-between py-2 border-b border-white/[0.04] last:border-0">
          <span className="text-xs text-zinc-400">{row.label}</span>
          <Badge color={row.ok ? 'emerald' : 'red'}>{row.value}</Badge>
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
          <button onClick={() => void load()} className="text-xs text-zinc-500 hover:text-zinc-300 transition">
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
            <StatCard label="Orgs" value={fmt(overview.total_orgs)} />
            <StatCard label="Stores" value={fmt(overview.total_stores)} />
            <StatCard label="Customers" value={fmt(overview.total_customers)} />
            <StatCard label="Orders" value={fmt(overview.total_orders)} />
            <StatCard label="GMV" value={fmtMoney(overview.total_gmv)} color="green" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <StatCard label="Revenue" value={fmtMoney(overview.total_revenue)} color="green" />
            <StatCard
              label="Active (30d)"
              value={fmt(overview.active_30d)}
              sub="stores with activity"
            />
            <StatCard
              label="Growth"
              value={`${overview.growth_pct >= 0 ? '+' : ''}${overview.growth_pct.toFixed(1)}%`}
              color={overview.growth_pct >= 0 ? 'green' : 'red'}
              sub="new this period"
            />
          </div>

          {/* Timeseries chart */}
          <Card title="Trend (30 days)" className="mb-6">
            <div className="flex gap-2 mb-4">
              {(['orders', 'gmv', 'signups'] as Metric[]).map(m => (
                <button
                  key={m}
                  onClick={() => setMetric(m)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                    metric === m
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
                  }`}
                >
                  {m === 'gmv' ? 'GMV' : m.charAt(0).toUpperCase() + m.slice(1)}
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
