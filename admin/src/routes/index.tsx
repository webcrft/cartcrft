import { lazy, type ComponentType } from 'react'
import type { LazyExoticComponent } from 'react'
import {
  LayoutDashboard, Package, ShoppingBag, Users, Warehouse,
  Tag, Layers, Settings
} from 'lucide-react'

export interface NavItem {
  path: string
  label: string
  icon?: ComponentType<{ size?: number }>
}

export interface NavSection {
  label: string
  items: NavItem[]
}

export interface RouteEntry {
  path: string
  element: LazyExoticComponent<ComponentType>
  navSection?: string
  navLabel?: string
  icon?: ComponentType<{ size?: number }>
}

const DashboardPage = lazy(() => import('../pages/Dashboard'))
const ProductsPage = lazy(() => import('../pages/Products'))
const OrdersPage = lazy(() => import('../pages/Orders'))
const CustomersPage = lazy(() => import('../pages/Customers'))
const InventoryPage = lazy(() => import('../pages/Inventory'))
const DiscountsPage = lazy(() => import('../pages/Discounts'))
const CollectionsPage = lazy(() => import('../pages/Collections'))
const SettingsPage = lazy(() => import('../pages/Settings'))

export const ROUTE_ENTRIES: RouteEntry[] = [
  { path: '/', element: DashboardPage, navSection: '', navLabel: 'Overview', icon: LayoutDashboard },
  { path: '/products', element: ProductsPage, navSection: 'Catalog', navLabel: 'Products', icon: Package },
  { path: '/collections', element: CollectionsPage, navSection: 'Catalog', navLabel: 'Collections', icon: Layers },
  { path: '/orders', element: OrdersPage, navSection: 'Sales', navLabel: 'Orders', icon: ShoppingBag },
  { path: '/customers', element: CustomersPage, navSection: 'Sales', navLabel: 'Customers', icon: Users },
  { path: '/inventory', element: InventoryPage, navSection: 'Operations', navLabel: 'Inventory', icon: Warehouse },
  { path: '/discounts', element: DiscountsPage, navSection: 'Operations', navLabel: 'Discounts', icon: Tag },
  { path: '/settings', element: SettingsPage, navSection: 'Store', navLabel: 'Settings', icon: Settings },
]

const SECTION_ORDER = ['', 'Catalog', 'Sales', 'Operations', 'Store']

export const NAV_SECTIONS: NavSection[] = SECTION_ORDER.map(label => ({
  label,
  items: ROUTE_ENTRIES
    .filter(r => r.navSection === label && r.navLabel)
    .map(r => {
      const item: NavItem = { path: r.path, label: r.navLabel! }
      if (r.icon) item.icon = r.icon
      return item
    }),
})).filter(s => s.items.length > 0)
