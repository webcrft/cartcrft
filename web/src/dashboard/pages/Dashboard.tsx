import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import {
  Badge, Card, PageHeader, Spinner, EmptyState, Skeleton,
  TableContainer, TableHead, Th, Td,
} from '../components/ui/index'
import { DollarSign, ShoppingBag, TrendingUp, Users, Receipt, ArrowUpRight } from 'lucide-react'
import { FINANCIAL_STATUS_MAP, FULFILLMENT_MAP, statusBadgeProps } from '../lib/statusMaps'
import type { Order, AnalyticsOverview } from '@cartcrft/sdk'

interface Metrics {
  revenue: string
  orders: number
  aov: string
  customers: number
}

function MetricCard({
  label, value, icon: Icon, trend, prefix,
}: {
  label: string
  value: string
  icon: React.ComponentType<{ size?: number; className?: string }>
  trend?: string
  prefix?: string
}) {
  return (
    <div
      className="group relative overflow-hidden rounded-xl p-5 transition-all duration-200 hover:border-[var(--cc-lime)]/30"
      style={{
        background: 'var(--cc-surface)',
        border: '1px solid rgba(255,255,255,0.07)',
      }}
    >
      {/* Top lime shimmer on hover */}
      <div
        className="absolute inset-x-0 top-0 h-px opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{ background: 'linear-gradient(90deg,transparent,rgba(181,255,46,0.6),transparent)' }}
      />
      {/* Faint corner glow on hover */}
      <div
        className="absolute -top-8 -right-8 w-24 h-24 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{ background: 'radial-gradient(circle,rgba(181,255,46,0.1),transparent 70%)' }}
      />
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-[var(--cc-muted)]">{label}</p>
        <div
          className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0 text-[var(--cc-lime)]"
          style={{ background: 'rgba(181,255,46,0.1)', border: '1px solid rgba(181,255,46,0.18)' }}
        >
          <Icon size={14} />
        </div>
      </div>
      <div className="mt-3.5 flex items-baseline gap-1">
        {prefix && (
          <span className="text-sm text-[var(--cc-muted)]">{prefix}</span>
        )}
        <span
          className="text-[1.75rem] font-bold tabular-nums text-[var(--cc-text)] leading-none"
          style={{ fontFamily: 'var(--cc-font-display)', letterSpacing: '-0.03em' }}
        >
          {value}
        </span>
      </div>
      {trend && (
        <div className="mt-2.5 flex items-center gap-1">
          <ArrowUpRight size={12} className="text-[var(--cc-lime)]" />
          <span className="text-[12px] text-[var(--cc-muted)]">{trend}</span>
        </div>
      )}
    </div>
  )
}

function MetricSkeleton() {
  return (
    <div className="rounded-xl p-5" style={{ background: 'var(--cc-surface)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      <Skeleton className="mt-3 h-7 w-28" />
    </div>
  )
}

export default function Dashboard() {
  const { activeStore } = useStore()
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!activeStore) return
    const sdk = getSdk()
    setLoading(true)

    void (async () => {
      try {
        const [analyticsRes, ordersRes, customersRes] = await Promise.allSettled([
          sdk.analytics.overview(activeStore.id),
          sdk.orders.list(activeStore.id, { limit: 10 }),
          sdk.customers.list(activeStore.id, { limit: 1 }),
        ])

        const analytics = analyticsRes.status === 'fulfilled' ? analyticsRes.value : null
        const ordersData = ordersRes.status === 'fulfilled' ? ordersRes.value : { orders: [], total: 0 }
        const customersTotal = customersRes.status === 'fulfilled' ? (customersRes.value.total ?? 0) : 0

        setOrders(ordersData.orders ?? [])
        setMetrics({
          revenue: analytics?.revenue ?? '0',
          orders: analytics?.orders_count ?? ordersData.total ?? 0,
          aov: analytics?.average_order_value ?? '0',
          customers: customersTotal,
        })
      } finally {
        setLoading(false)
      }
    })()
  }, [activeStore])

  const currency = activeStore?.currency ?? 'USD'

  const formatMoney = (v: string) =>
    Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className="space-y-7">
      <PageHeader
        title="Overview"
        description={activeStore ? `${activeStore.name} · ${currency}` : undefined}
      />

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <MetricSkeleton key={i} />)
        ) : (
          <>
            <MetricCard
              label="Revenue"
              value={formatMoney(metrics?.revenue ?? '0')}
              prefix={currency}
              icon={DollarSign}
            />
            <MetricCard
              label="Orders"
              value={String(metrics?.orders ?? 0)}
              icon={ShoppingBag}
            />
            <MetricCard
              label="Avg Order Value"
              value={formatMoney(metrics?.aov ?? '0')}
              prefix={currency}
              icon={TrendingUp}
            />
            <MetricCard
              label="Customers"
              value={String(metrics?.customers ?? 0)}
              icon={Users}
            />
          </>
        )}
      </div>

      {/* Recent orders */}
      <Card
        title="Recent orders"
        actions={
          orders.length > 0 ? (
            <Link
              to="/orders"
              className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--cc-lime)] hover:text-[var(--cc-lime-bright)] transition"
            >
              View all
              <ArrowUpRight size={13} />
            </Link>
          ) : undefined
        }
      >
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : orders.length === 0 ? (
          <EmptyState
            icon={<Receipt size={20} />}
            title="No orders yet"
            description="Recent orders will appear here once customers start purchasing."
          />
        ) : (
          <TableContainer>
            <table className="w-full text-sm">
              <TableHead>
                <Th>Order</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Payment</Th>
                <Th>Fulfillment</Th>
                <Th align="right">Total</Th>
              </TableHead>
              <tbody>
                {orders.map(order => {
                  const fin = statusBadgeProps(order.financial_status, FINANCIAL_STATUS_MAP)
                  const ful = statusBadgeProps(order.fulfillment_status, FULFILLMENT_MAP)
                  return (
                    <tr
                      key={order.id}
                      className="transition-colors"
                      style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.02)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = '' }}
                    >
                      <Td>
                        <span className="font-mono text-[var(--cc-lime)] font-medium">
                          #{order.order_number}
                        </span>
                      </Td>
                      <Td muted>{new Date(order.created_at).toLocaleDateString()}</Td>
                      <Td className="text-[var(--cc-body)]">{(order.email as string | undefined) ?? '—'}</Td>
                      <Td><Badge color={fin.color}>{fin.label}</Badge></Td>
                      <Td><Badge color={ful.color}>{ful.label}</Badge></Td>
                      <Td align="right" className="font-mono font-medium text-[var(--cc-text)]">
                        {order.currency} {Number(order.total).toFixed(2)}
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableContainer>
        )}
      </Card>
    </div>
  )
}
