import React, { useEffect, useState } from 'react'
import { useStore } from '../context/StoreContext'
import { getSdk } from '../lib/sdk'
import { Badge, Card, PageHeader, Spinner, EmptyState, TableContainer, TableHead, Th, Td } from '../components/ui/index'
import { DollarSign, ShoppingBag, TrendingUp, Users, Receipt } from 'lucide-react'
import { FINANCIAL_STATUS_MAP, FULFILLMENT_MAP, statusBadgeProps } from '../lib/statusMaps'
import type { Order, AnalyticsOverview } from '@cartcrft/sdk'

interface Metrics {
  revenue: string
  orders: number
  aov: string
  customers: number
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

  if (loading) return <div className="flex justify-center py-16"><Spinner /></div>

  const currency = activeStore?.currency ?? 'USD'

  const metricCards = [
    { label: 'Revenue', value: `${currency} ${Number(metrics?.revenue ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, color: 'text-emerald-400', icon: DollarSign, accent: 'from-emerald-500/10' },
    { label: 'Orders', value: String(metrics?.orders ?? 0), color: 'text-blue-400', icon: ShoppingBag, accent: 'from-blue-500/10' },
    { label: 'Avg Order Value', value: `${currency} ${Number(metrics?.aov ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, color: 'text-violet-400', icon: TrendingUp, accent: 'from-violet-500/10' },
    { label: 'Customers', value: String(metrics?.customers ?? 0), color: 'text-amber-400', icon: Users, accent: 'from-amber-500/10' },
  ]

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description={`${activeStore?.name ?? ''} — ${currency}`} />

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {metricCards.map(card => {
          const Icon = card.icon
          return (
            <div
              key={card.label}
              className={`relative overflow-hidden rounded-xl border border-white/[0.08] bg-gradient-to-br ${card.accent} to-transparent p-5`}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-slate-400">{card.label}</p>
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.04] ${card.color}`}>
                  <Icon size={15} />
                </span>
              </div>
              <p className={`mt-3 text-2xl font-bold tracking-tight ${card.color}`}>{card.value}</p>
            </div>
          )
        })}
      </div>

      {/* Recent orders */}
      <Card title="Recent Orders">
        {orders.length === 0 ? (
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
                <Th className="text-right">Total</Th>
              </TableHead>
              <tbody>
                {orders.map(order => {
                  const fin = statusBadgeProps(order.financial_status, FINANCIAL_STATUS_MAP)
                  const ful = statusBadgeProps(order.fulfillment_status, FULFILLMENT_MAP)
                  return (
                    <tr key={order.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition">
                      <Td><span className="font-mono text-violet-400">#{order.order_number}</span></Td>
                      <Td className="text-slate-400">{new Date(order.created_at).toLocaleDateString()}</Td>
                      <Td className="text-slate-300">{(order.email as string | undefined) ?? '—'}</Td>
                      <Td><Badge color={fin.color}>{fin.label}</Badge></Td>
                      <Td><Badge color={ful.color}>{ful.label}</Badge></Td>
                      <Td className="text-right font-medium text-white">{order.currency} {Number(order.total).toFixed(2)}</Td>
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
