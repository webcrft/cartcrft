import { lazy, type ComponentType } from 'react'
import type { LazyExoticComponent } from 'react'
import {
  LayoutDashboard, Package, ShoppingBag, Users, Warehouse,
  Tag, Layers, Settings, Truck, Receipt, RotateCcw, Wallet,
  Repeat, List, Building2, UsersRound, Star, Heart,
  ShoppingCart, Package2, Plug, Bell, Webhook, CreditCard,
  ShieldCheck, Bot, Key, Download, Cloud, UserCircle,
} from 'lucide-react'

/**
 * BUILD-TIME cloud flag.
 *
 * Vite inlines `import.meta.env.PUBLIC_CARTCRFT_CLOUD` as a string literal at
 * build time (or `undefined` when the var is unset).  Using the literal form
 * `import.meta.env.PUBLIC_CARTCRFT_CLOUD` (without casting to `any`) is
 * required so Vite's bundler can statically analyse the condition and
 * dead-code-eliminate the unreachable branches:
 *
 *   - OFF build (var unset):  `undefined === "1"` -> false
 *     -> Vite removes the cloud lazy() branches -> Billing/Account/CloudOnboarding
 *     chunks are never emitted into the output.
 *   - ON  build (PUBLIC_CARTCRFT_CLOUD=1): `"1" === "1"` -> true
 *     -> all three cloud chunks are included.
 *
 * IMPORTANT: Do NOT wrap this in a function call (e.g. useCloud()) -- the
 * indirection defeats Vite's static analysis.  The `as any` cast also defeats
 * it (Vite needs to see the literal `import.meta.env.*` property access).
 */
const CLOUD_ENABLED = import.meta.env.PUBLIC_CARTCRFT_CLOUD === '1'

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

// T5.4 -- remaining pages
const ShippingPage = lazy(() => import('../pages/Shipping'))
const TaxPage = lazy(() => import('../pages/Tax'))
const ReturnsPage = lazy(() => import('../pages/Returns'))
const WalletPage = lazy(() => import('../pages/Wallet'))
const SubscriptionsPage = lazy(() => import('../pages/Subscriptions'))
const PriceListsPage = lazy(() => import('../pages/PriceLists'))
const B2BPage = lazy(() => import('../pages/B2B'))
const CustomerGroupsPage = lazy(() => import('../pages/CustomerGroups'))
const ReviewsPage = lazy(() => import('../pages/Reviews'))
const WishlistsPage = lazy(() => import('../pages/Wishlists'))
const AbandonedCartsPage = lazy(() => import('../pages/AbandonedCarts'))
const FulfillmentOrdersPage = lazy(() => import('../pages/FulfillmentOrders'))
const IntegrationsPage = lazy(() => import('../pages/Integrations'))
const NotificationProvidersPage = lazy(() => import('../pages/NotificationProviders'))
const WebhookLogPage = lazy(() => import('../pages/WebhookLog'))
const PaymentProvidersPage = lazy(() => import('../pages/PaymentProviders'))
const CustomerAuthPage = lazy(() => import('../pages/CustomerAuth'))
const AgentsPage = lazy(() => import('../pages/Agents'))

// H4.2 -- new pages
const ApiKeysPage = lazy(() => import('../pages/ApiKeys'))
const DigitalProductsPage = lazy(() => import('../pages/DigitalProducts'))

// Cloud-only pages.
// The lazy imports live INSIDE the CLOUD_ENABLED branch so that Vite's static
// analyser can see them as dead code in an OFF build and omit the chunks
// entirely from the output.  Do NOT hoist them to module top-level as
// const CloudBillingPage = lazy(() => import(...)) -- that pattern includes
// the chunk in the bundle regardless of the runtime condition.
const CLOUD_ROUTE_ENTRIES: RouteEntry[] = CLOUD_ENABLED
  ? [
      {
        path: '/cloud/billing',
        element: lazy(() => import('../pages/cloud/Billing')),
        navSection: 'Cloud',
        navLabel: 'Billing',
        icon: CreditCard,
      },
      {
        path: '/cloud/account',
        element: lazy(() => import('../pages/cloud/Account')),
        navSection: 'Cloud',
        navLabel: 'Account',
        icon: UserCircle,
      },
      {
        path: '/cloud/onboarding',
        element: lazy(() => import('../pages/cloud/CloudOnboarding')),
        navSection: 'Cloud',
        navLabel: 'Onboarding',
        icon: Cloud,
      },
    ]
  : []

export const ROUTE_ENTRIES: RouteEntry[] = [
  { path: '/', element: DashboardPage, navSection: '', navLabel: 'Overview', icon: LayoutDashboard },
  { path: '/products', element: ProductsPage, navSection: 'Catalog', navLabel: 'Products', icon: Package },
  { path: '/collections', element: CollectionsPage, navSection: 'Catalog', navLabel: 'Collections', icon: Layers },
  { path: '/orders', element: OrdersPage, navSection: 'Sales', navLabel: 'Orders', icon: ShoppingBag },
  { path: '/customers', element: CustomersPage, navSection: 'Sales', navLabel: 'Customers', icon: Users },
  { path: '/inventory', element: InventoryPage, navSection: 'Operations', navLabel: 'Inventory', icon: Warehouse },
  { path: '/discounts', element: DiscountsPage, navSection: 'Operations', navLabel: 'Discounts', icon: Tag },
  { path: '/settings', element: SettingsPage, navSection: 'Store', navLabel: 'Settings', icon: Settings },

  // T5.4 -- remaining pages
  { path: '/shipping', element: ShippingPage, navSection: 'Operations', navLabel: 'Shipping', icon: Truck },
  { path: '/tax', element: TaxPage, navSection: 'Operations', navLabel: 'Tax', icon: Receipt },
  { path: '/returns', element: ReturnsPage, navSection: 'Operations', navLabel: 'Returns', icon: RotateCcw },
  { path: '/fulfillment-orders', element: FulfillmentOrdersPage, navSection: 'Operations', navLabel: 'Fulfillment', icon: Package2 },
  { path: '/wallet', element: WalletPage, navSection: 'Sales', navLabel: 'Wallet', icon: Wallet },
  { path: '/subscriptions', element: SubscriptionsPage, navSection: 'Sales', navLabel: 'Subscriptions', icon: Repeat },
  { path: '/price-lists', element: PriceListsPage, navSection: 'Catalog', navLabel: 'Price Lists', icon: List },
  { path: '/b2b', element: B2BPage, navSection: 'Sales', navLabel: 'B2B', icon: Building2 },
  { path: '/customer-groups', element: CustomerGroupsPage, navSection: 'Sales', navLabel: 'Customer Groups', icon: UsersRound },
  { path: '/reviews', element: ReviewsPage, navSection: 'Sales', navLabel: 'Reviews', icon: Star },
  { path: '/wishlists', element: WishlistsPage, navSection: 'Sales', navLabel: 'Wishlists', icon: Heart },
  { path: '/abandoned-carts', element: AbandonedCartsPage, navSection: 'Sales', navLabel: 'Abandoned Carts', icon: ShoppingCart },
  { path: '/integrations', element: IntegrationsPage, navSection: 'Store', navLabel: 'Integrations', icon: Plug },
  { path: '/notification-providers', element: NotificationProvidersPage, navSection: 'Store', navLabel: 'Notifications', icon: Bell },
  { path: '/webhook-log', element: WebhookLogPage, navSection: 'Store', navLabel: 'Webhook Log', icon: Webhook },
  { path: '/payment-providers', element: PaymentProvidersPage, navSection: 'Store', navLabel: 'Payments', icon: CreditCard },
  { path: '/customer-auth', element: CustomerAuthPage, navSection: 'Store', navLabel: 'Customer Auth', icon: ShieldCheck },
  { path: '/agents', element: AgentsPage, navSection: 'Store', navLabel: 'Agents', icon: Bot },

  // H4.2 -- new pages
  { path: '/api-keys', element: ApiKeysPage, navSection: 'Store', navLabel: 'API Keys', icon: Key },
  { path: '/digital-products', element: DigitalProductsPage, navSection: 'Catalog', navLabel: 'Digital Files', icon: Download },

  // Cloud-only routes -- empty array in OFF builds, populated in ON builds
  ...CLOUD_ROUTE_ENTRIES,
]

const SECTION_ORDER = CLOUD_ENABLED
  ? ['', 'Catalog', 'Sales', 'Operations', 'Store', 'Cloud']
  : ['', 'Catalog', 'Sales', 'Operations', 'Store']

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
