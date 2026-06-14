import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import {
  LayoutDashboard,
  Building2,
  Store,
  Users,
  Shield,
  ScrollText,
} from 'lucide-react'

export interface RouteEntry {
  path: string
  element: LazyExoticComponent<ComponentType>
  navLabel?: string
  icon?: ComponentType<{ size?: number }>
}

const AnalyticsPage = lazy(() => import('../pages/Analytics'))
const OrgsPage = lazy(() => import('../pages/Orgs'))
const StoresPage = lazy(() => import('../pages/Stores'))
const CustomersPage = lazy(() => import('../pages/Customers'))
const TenantsPage = lazy(() => import('../pages/Tenants'))
const AuditLogPage = lazy(() => import('../pages/AuditLog'))

export const ROUTE_ENTRIES: RouteEntry[] = [
  { path: '/', element: AnalyticsPage, navLabel: 'System Analytics', icon: LayoutDashboard },
  { path: '/orgs', element: OrgsPage, navLabel: 'Organisations', icon: Building2 },
  { path: '/stores', element: StoresPage, navLabel: 'Stores', icon: Store },
  { path: '/customers', element: CustomersPage, navLabel: 'Customers', icon: Users },
  { path: '/tenants', element: TenantsPage, navLabel: 'Tenant Actions', icon: Shield },
  { path: '/audit-log', element: AuditLogPage, navLabel: 'Audit Log', icon: ScrollText },
]
