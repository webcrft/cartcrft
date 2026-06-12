/**
 * @cartcrft/sdk — public API surface.
 *
 * Main export: `Cartcrft` client class.
 * Re-exports: resource types, error class.
 */

export {
  Cartcrft,
  CartcrftApiError,
  type CartcrftOptions,
  type RequestOptions,
  type CartcrftError,
  type ApiResponse,
  type PageParams,
  // Stores
  type Store,
  type CreateStoreBody,
  type UpdateStoreBody,
  // API Keys
  type ApiKey,
  type CreateApiKeyBody,
  // Catalog
  type Product,
  type Variant,
  type Collection,
  type ListProductsQuery,
  type CreateProductBody,
  type CreateVariantBody,
  // Carts
  type Cart,
  type CartLine,
  type CreateCartBody,
  type AddCartLineBody,
  // Checkout
  type Address,
  type CheckoutSession,
  type CreateCheckoutBody,
  type UpdateCheckoutBody,
  type CompleteCheckoutBody,
  // Orders
  type Order,
  type ListOrdersQuery,
  // Payments
  type Payment,
  // Customers
  type Customer,
  type ListCustomersQuery,
  // Customer Auth
  type CustomerAuthInfo,
  type CustomerSession,
  // Inventory
  type Warehouse,
  type InventoryLevel,
  // Shipping
  type ShippingZone,
  // Discounts
  type Discount,
  // Gift Cards
  type GiftCard,
  // Analytics
  type AnalyticsOverview,
  // Search
  type SearchResultItem,
  type SearchResult,
  type SearchQuery,
  // Agents
  type Agent,
  type Mandate,
  // ACP
  type AcpCheckoutSession,
} from "./client.js";
