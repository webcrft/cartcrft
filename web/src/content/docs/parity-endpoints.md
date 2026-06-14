---
title: "Endpoint Reference"
description: "Full endpoint inventory with auth tiers (JWT, read, write, admin, super) and Wave 2 task mapping."
sidebar:
  label: "Endpoint Reference"
  order: 2
---

# Cartcrft Parity Endpoints

Full endpoint inventory ported from webcrft-mono `backend/cmd/server/main.go` route registrations.
Each row marks the owning Wave 2 task (T2.1–T2.10).
Auth tiers: **JWT** = management JWT only; **read** = storeAuthRead (cc_pub_/cc_prv_/JWT); **write** = storeAuthWrite (cc_prv_+/JWT); **admin** = storeAuthAdmin (cc_prv_ commerce:admin / JWT); **super** = SUPER_TOKEN env header.

---

## JWT Claim Shape (T2.1)

Management dashboard tokens use HS256 signed with `JWT_SECRET` from config.

```json
{
  "sub":   "<userId UUID>",
  "org":   "<orgId UUID>",
  "email": "<user email>  (optional)",
  "jti":   "<random UUID> (for future blacklisting)",
  "iat":   1234567890,
  "exp":   1234567890
}
```

**`sub`** — the user's UUID (principal identity).  
**`org`** — the org the user is acting in. Embedded in the token so Cartcrft doesn't need an `organization_members` table (no platform profiles yet).  
Every store endpoint verifies `org` matches `stores.organization_id`.

Test helper: `mintTestJwt({ userId, orgId })` in `backend/src/lib/auth/jwt.ts`. Import in suites: `import { mintJwt } from '../shared/helpers.js'`.

---

## Error Envelope

All errors use `{ error: { code: string, message: string, details?: unknown } }`.

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing/invalid/expired credentials |
| `FORBIDDEN` | 403 | Valid creds, insufficient scope/access |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Request schema validation failed |
| `DUPLICATE_SLUG` | 409 | Store slug conflict |
| `CURRENCY_LOCKED` | 409 | Currency change blocked by existing orders |
| `INVALID_SCOPES` | 400 | Unknown or disallowed scope string |
| `INVALID_KEY_TYPE` | 400 | key_type not "public" or "private" |
| `RATE_LIMIT_EXCEEDED` | 429 | IP rate limit hit |
| `INTERNAL_ERROR` | 500 | Unhandled server error |

---

## T2.1 — Stores + API keys + Auth middleware

### Stores
| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/commerce/stores` | JWT | ListStores |
| POST | `/commerce/stores` | JWT | CreateStore |
| GET | `/commerce/stores/:storeId` | admin | GetStore |
| PUT | `/commerce/stores/:storeId` | admin | UpdateStore |
| DELETE | `/commerce/stores/:storeId` | JWT | DeleteStore |
| POST | `/super/commerce/stores/:storeId/takedown` | super | TakedownStore |
| POST | `/super/commerce/stores/:storeId/restore` | super | RestoreStore |

### API Keys
| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/api-keys` | JWT | ListApiKeys |
| POST | `/api-keys` | JWT | CreateApiKey |
| PATCH | `/api-keys/:keyId` | JWT | UpdateApiKey |
| DELETE | `/api-keys/:keyId` | JWT | RevokeApiKey |

---

## T2.2 — Catalog

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/commerce/stores/:storeId/products` | read | ListProducts |
| POST | `/commerce/stores/:storeId/products` | write | CreateProduct |
| GET | `/commerce/stores/:storeId/products/:productId` | read | GetProduct |
| PUT | `/commerce/stores/:storeId/products/:productId` | write | UpdateProduct |
| DELETE | `/commerce/stores/:storeId/products/:productId` | admin | DeleteProduct |
| GET | `/commerce/stores/:storeId/products/:productId/variants` | read | ListVariants |
| POST | `/commerce/stores/:storeId/products/:productId/variants` | write | CreateVariant |
| PUT | `/commerce/stores/:storeId/products/:productId/variants/:variantId` | write | UpdateVariant |
| DELETE | `/commerce/stores/:storeId/products/:productId/variants/:variantId` | admin | DeleteVariant |
| GET | `/commerce/stores/:storeId/products/:productId/options` | read | ListOptions |
| POST | `/commerce/stores/:storeId/products/:productId/options` | write | CreateOption |
| DELETE | `/commerce/stores/:storeId/products/:productId/options/:optionId` | admin | DeleteOption |
| POST | `/commerce/stores/:storeId/products/:productId/media` | write | AddMedia |
| DELETE | `/commerce/stores/:storeId/products/:productId/media/:mediaId` | admin | DeleteMedia |
| GET | `/commerce/stores/:storeId/products/:productId/bundle-items` | read | ListBundleItems |
| POST | `/commerce/stores/:storeId/products/:productId/bundle-items` | write | AddBundleItem |
| PUT | `/commerce/stores/:storeId/products/:productId/bundle-items/:itemId` | write | UpdateBundleItem |
| DELETE | `/commerce/stores/:storeId/products/:productId/bundle-items/:itemId` | admin | DeleteBundleItem |
| GET | `/commerce/stores/:storeId/products/:productId/digital-files` | read | ListDigitalFiles |
| POST | `/commerce/stores/:storeId/products/:productId/digital-files` | write | CreateDigitalFile |
| DELETE | `/commerce/stores/:storeId/products/:productId/digital-files/:fileId` | admin | DeleteDigitalFile |
| GET | `/commerce/stores/:storeId/products/:productId/reviews` | read | ListProductReviews |
| POST | `/commerce/stores/:storeId/products/:productId/reviews` | write | CreateProductReview |
| PUT | `/commerce/stores/:storeId/reviews/:reviewId` | admin | UpdateReviewStatus |
| GET | `/commerce/stores/:storeId/products/:productId/tags` | read | ListProductTags |
| PUT | `/commerce/stores/:storeId/products/:productId/tags` | write | SetProductTags |
| GET | `/commerce/stores/:storeId/collections` | read | ListCollections |
| POST | `/commerce/stores/:storeId/collections` | write | CreateCollection |
| GET | `/commerce/stores/:storeId/collections/:collectionId` | read | GetCollection |
| PUT | `/commerce/stores/:storeId/collections/:collectionId` | write | UpdateCollection |
| DELETE | `/commerce/stores/:storeId/collections/:collectionId` | admin | DeleteCollection |
| POST | `/commerce/stores/:storeId/collections/:collectionId/products` | write | AddProductToCollection |
| DELETE | `/commerce/stores/:storeId/collections/:collectionId/products/:productId` | write | RemoveProductFromCollection |
| GET | `/commerce/stores/:storeId/collections/:collectionId/rules` | read | ListCollectionRules |
| POST | `/commerce/stores/:storeId/collections/:collectionId/rules` | write | AddCollectionRule |
| DELETE | `/commerce/stores/:storeId/collections/:collectionId/rules/:ruleId` | admin | DeleteCollectionRule |
| GET | `/commerce/stores/:storeId/price-lists` | read | ListPriceLists |
| POST | `/commerce/stores/:storeId/price-lists` | write | CreatePriceList |
| GET | `/commerce/stores/:storeId/price-lists/:listId` | read | GetPriceList |
| PUT | `/commerce/stores/:storeId/price-lists/:listId` | write | UpdatePriceList |
| DELETE | `/commerce/stores/:storeId/price-lists/:listId` | admin | DeletePriceList |
| GET | `/commerce/stores/:storeId/price-lists/:listId/items` | read | ListPriceListItems |
| POST | `/commerce/stores/:storeId/price-lists/:listId/items` | write | UpsertPriceListItem |
| PUT | `/commerce/stores/:storeId/price-lists/:listId/items/:itemId` | write | UpdatePriceListItem |
| DELETE | `/commerce/stores/:storeId/price-lists/:listId/items/:itemId` | admin | DeletePriceListItem |
| GET | `/commerce/stores/:storeId/variants/:variantId/feed-data` | read | GetProductFeedData |
| PUT | `/commerce/stores/:storeId/variants/:variantId/feed-data` | write | UpsertProductFeedData |

---

## T2.3 — Carts + Checkout + Atomic complete

| Method | Path | Auth | Handler |
|---|---|---|---|
| POST | `/commerce/stores/:storeId/carts` | read | CreateCart |
| GET | `/commerce/stores/:storeId/carts/:cartId` | read | GetCart |
| POST | `/commerce/stores/:storeId/carts/:cartId/lines` | read | AddCartLine |
| PUT | `/commerce/stores/:storeId/carts/:cartId/lines/:lineId` | read | UpdateCartLine |
| DELETE | `/commerce/stores/:storeId/carts/:cartId/lines/:lineId` | read | RemoveCartLine |
| GET | `/commerce/stores/:storeId/abandoned-carts` | admin | ListAbandonedCarts |
| POST | `/commerce/stores/:storeId/abandoned-carts` | write | MarkCartAbandoned |
| POST | `/commerce/stores/:storeId/checkouts` | read | CreateCheckout |
| GET | `/commerce/stores/:storeId/checkouts/:checkoutId` | read | GetCheckout |
| PUT | `/commerce/stores/:storeId/checkouts/:checkoutId` | read | UpdateCheckout |
| POST | `/commerce/stores/:storeId/checkouts/:checkoutId/complete` | read | CompleteCheckout |
| POST | `/commerce/stores/:storeId/checkouts/:checkoutId/payment-session` | read | InitiateCheckoutPayment |

---

## T2.4 — Orders + Payments + Provider clients

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/commerce/stores/:storeId/orders` | write | ListOrders |
| POST | `/commerce/stores/:storeId/orders` | write | CreateOrder |
| GET | `/commerce/stores/:storeId/orders/:orderId` | write | GetOrder |
| PUT | `/commerce/stores/:storeId/orders/:orderId` | write | UpdateOrder |
| POST | `/commerce/stores/:storeId/orders/:orderId/cancel` | write | CancelOrder |
| POST | `/commerce/stores/:storeId/orders/:orderId/notes` | write | AddOrderNote |
| GET | `/commerce/stores/:storeId/orders/:orderId/events` | write | ListOrderEvents |
| GET | `/commerce/stores/:storeId/orders/:orderId/payments` | write | ListPayments |
| POST | `/commerce/stores/:storeId/orders/:orderId/payments` | write | CreatePayment |
| POST | `/commerce/stores/:storeId/orders/:orderId/payments/:paymentId/capture` | admin | CapturePayment |
| POST | `/commerce/stores/:storeId/orders/:orderId/payments/:paymentId/refund` | admin | CreateRefund |
| GET | `/commerce/stores/:storeId/orders/:orderId/download-links` | write | ListDownloadLinks |
| POST | `/commerce/stores/:storeId/orders/:orderId/download-links` | write | CreateDownloadLink |
| GET | `/commerce/stores/:storeId/payment-providers` | admin | ListPaymentProviders |
| POST | `/commerce/stores/:storeId/payment-providers` | admin | UpsertPaymentProvider |
| DELETE | `/commerce/stores/:storeId/payment-providers/:providerId` | admin | DeletePaymentProvider |
| GET | `/commerce/payment-gateways` | JWT | ListPaymentGateways |
| POST | `/commerce/payment-gateways` | JWT | UpsertPaymentGateway |
| PUT | `/commerce/payment-gateways/:gatewayId/dev-credentials` | JWT | SetGatewayDevCredentials |
| GET | `/commerce/payment-gateway-status` | JWT | GetPaymentGatewayStatus |

---

## T2.5 — Inbound webhook router

| Method | Path | Auth | Handler |
|---|---|---|---|
| POST | `/webhooks/:storeId/:providerType` | none (sig-verified) | InboundWebhook |
| PUT | `/webhooks/:storeId/:providerType` | none (sig-verified) | InboundWebhook |
| POST | `/webhooks/:storeId/:providerType/:providerRef` | none (sig-verified) | InboundWebhook |
| PUT | `/webhooks/:storeId/:providerType/:providerRef` | none (sig-verified) | InboundWebhook |
| POST | `/webhooks/:storeId/tracking/:shipmentId` | none (carrier push) | PushTrackingEvent |

---

## T2.6 — Inventory + Shipping + Tax

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/commerce/stores/:storeId/warehouses` | admin | ListWarehouses |
| POST | `/commerce/stores/:storeId/warehouses` | admin | CreateWarehouse |
| PUT | `/commerce/stores/:storeId/warehouses/:warehouseId` | admin | UpdateWarehouse |
| DELETE | `/commerce/stores/:storeId/warehouses/:warehouseId` | admin | DeleteWarehouse |
| GET | `/commerce/stores/:storeId/inventory` | admin | GetInventory |
| POST | `/commerce/stores/:storeId/inventory/set` | admin | SetInventoryLevel |
| POST | `/commerce/stores/:storeId/inventory/adjust` | admin | AdjustInventory |
| GET | `/commerce/stores/:storeId/inventory/adjustments` | admin | ListInventoryAdjustments |
| GET | `/commerce/stores/:storeId/inventory/lots` | admin | ListInventoryLots |
| POST | `/commerce/stores/:storeId/inventory/lots` | admin | CreateInventoryLot |
| PUT | `/commerce/stores/:storeId/inventory/lots/:lotId` | admin | UpdateInventoryLot |
| DELETE | `/commerce/stores/:storeId/inventory/lots/:lotId` | admin | DeleteInventoryLot |
| GET | `/commerce/stores/:storeId/inventory/serials` | admin | ListSerialNumbers |
| POST | `/commerce/stores/:storeId/inventory/serials` | admin | BulkCreateSerialNumbers |
| GET | `/commerce/stores/:storeId/inventory/serials/:serialId` | admin | GetSerialNumber |
| PUT | `/commerce/stores/:storeId/inventory/serials/:serialId` | admin | UpdateSerialNumber |
| GET | `/commerce/stores/:storeId/shipping-zones` | admin | ListShippingZones |
| POST | `/commerce/stores/:storeId/shipping-zones` | admin | CreateShippingZone |
| PUT | `/commerce/stores/:storeId/shipping-zones/:zoneId` | admin | UpdateShippingZone |
| DELETE | `/commerce/stores/:storeId/shipping-zones/:zoneId` | admin | DeleteShippingZone |
| GET | `/commerce/stores/:storeId/shipping-zones/:zoneId/rates` | admin | ListShippingRates |
| POST | `/commerce/stores/:storeId/shipping-zones/:zoneId/rates` | admin | CreateShippingRate |
| PUT | `/commerce/stores/:storeId/shipping-zones/:zoneId/rates/:rateId` | admin | UpdateShippingRate |
| DELETE | `/commerce/stores/:storeId/shipping-zones/:zoneId/rates/:rateId` | admin | DeleteShippingRate |
| GET | `/commerce/stores/:storeId/shipping-rates/available` | read | GetAvailableShippingRates |
| GET | `/commerce/stores/:storeId/shipping-providers` | admin | ListShippingProviders |
| POST | `/commerce/stores/:storeId/shipping-providers` | admin | UpsertShippingProvider |
| DELETE | `/commerce/stores/:storeId/shipping-providers/:providerId` | admin | DeleteShippingProvider |
| GET | `/commerce/stores/:storeId/collection-points` | read | ListCollectionPoints |
| POST | `/commerce/stores/:storeId/collection-points` | admin | UpsertCollectionPoint |
| PUT | `/commerce/stores/:storeId/collection-points/:pointId` | admin | UpdateCollectionPoint |
| DELETE | `/commerce/stores/:storeId/collection-points/:pointId` | admin | DeleteCollectionPoint |
| GET | `/commerce/stores/:storeId/orders/:orderId/shipments` | write | ListShipments |
| POST | `/commerce/stores/:storeId/orders/:orderId/shipments` | write | CreateShipment |
| PUT | `/commerce/stores/:storeId/orders/:orderId/shipments/:shipmentId` | write | UpdateShipment |
| GET | `/commerce/stores/:storeId/orders/:orderId/shipments/:shipmentId/tracking` | write | ListShipmentTracking |
| GET | `/commerce/stores/:storeId/orders/:orderId/fulfillment-orders` | write | ListFulfillmentOrders |
| POST | `/commerce/stores/:storeId/orders/:orderId/fulfillment-orders` | write | CreateFulfillmentOrder |
| PUT | `/commerce/stores/:storeId/fulfillment-orders/:foId` | write | UpdateFulfillmentOrder |
| GET | `/commerce/stores/:storeId/tax-categories` | admin | ListTaxCategories |
| POST | `/commerce/stores/:storeId/tax-categories` | admin | CreateTaxCategory |
| DELETE | `/commerce/stores/:storeId/tax-categories/:categoryId` | admin | DeleteTaxCategory |
| GET | `/commerce/stores/:storeId/tax-zones` | admin | ListTaxZones |
| POST | `/commerce/stores/:storeId/tax-zones` | admin | CreateTaxZone |
| PUT | `/commerce/stores/:storeId/tax-zones/:zoneId` | admin | UpdateTaxZone |
| DELETE | `/commerce/stores/:storeId/tax-zones/:zoneId` | admin | DeleteTaxZone |
| GET | `/commerce/stores/:storeId/tax-zones/:zoneId/rates` | admin | ListTaxRates |
| POST | `/commerce/stores/:storeId/tax-zones/:zoneId/rates` | admin | CreateTaxRate |
| PUT | `/commerce/stores/:storeId/tax-zones/:zoneId/rates/:rateId` | admin | UpdateTaxRate |
| DELETE | `/commerce/stores/:storeId/tax-zones/:zoneId/rates/:rateId` | admin | DeleteTaxRate |

---

## T2.7 — Discounts + Wallet + Gift cards

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/commerce/stores/:storeId/discounts` | admin | ListDiscounts |
| POST | `/commerce/stores/:storeId/discounts` | admin | CreateDiscount |
| GET | `/commerce/stores/:storeId/discounts/:discountId` | admin | GetDiscount |
| PUT | `/commerce/stores/:storeId/discounts/:discountId` | admin | UpdateDiscount |
| DELETE | `/commerce/stores/:storeId/discounts/:discountId` | admin | DeleteDiscount |
| GET | `/commerce/stores/:storeId/discounts/validate` | read | ValidateDiscount |
| GET | `/commerce/stores/:storeId/auto-discounts` | admin | ListAutoDiscounts |
| POST | `/commerce/stores/:storeId/auto-discounts` | admin | CreateAutoDiscount |
| GET | `/commerce/stores/:storeId/auto-discounts/:discountId` | admin | GetAutoDiscount |
| PUT | `/commerce/stores/:storeId/auto-discounts/:discountId` | admin | UpdateAutoDiscount |
| DELETE | `/commerce/stores/:storeId/auto-discounts/:discountId` | admin | DeleteAutoDiscount |
| GET | `/commerce/stores/:storeId/customers/:customerId/credits` | admin | GetCustomerCredits |
| POST | `/commerce/stores/:storeId/customers/:customerId/credits/issue` | admin | IssueStoreCredit |
| POST | `/commerce/stores/:storeId/customers/:customerId/credits/adjust` | admin | AdjustStoreCredit |
| GET | `/commerce/stores/:storeId/customers/:customerId/credits/transactions` | admin | ListStoreCreditTransactions |
| GET | `/commerce/stores/:storeId/gift-cards` | admin | ListGiftCards |
| POST | `/commerce/stores/:storeId/gift-cards` | admin | CreateGiftCard |
| GET | `/commerce/stores/:storeId/gift-cards/lookup` | read | LookupGiftCard |
| GET | `/commerce/stores/:storeId/gift-cards/:giftCardId` | admin | GetGiftCard |
| POST | `/commerce/stores/:storeId/gift-cards/:giftCardId/disable` | admin | DisableGiftCard |

---

## T2.8 — Customers + Customer auth

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/commerce/stores/:storeId/customers` | admin | ListCustomers |
| POST | `/commerce/stores/:storeId/customers` | admin | CreateCustomer |
| POST | `/commerce/stores/:storeId/customers/invite` | admin | InviteCustomer |
| GET | `/commerce/stores/:storeId/customers/:customerId` | admin | GetCustomer |
| PUT | `/commerce/stores/:storeId/customers/:customerId` | admin | UpdateCustomer |
| POST | `/commerce/stores/:storeId/customers/:customerId/block` | admin | BlockCustomer |
| POST | `/commerce/stores/:storeId/customers/:customerId/unblock` | admin | UnblockCustomer |
| DELETE | `/commerce/stores/:storeId/customers/:customerId` | admin | DeleteCustomer |
| POST | `/commerce/stores/:storeId/customers/:customerId/addresses` | write | AddCustomerAddress |
| DELETE | `/commerce/stores/:storeId/customers/:customerId/addresses/:addressId` | write | DeleteCustomerAddress |
| GET | `/commerce/stores/:storeId/customers/:customerId/tags` | admin | ListCustomerTags |
| PUT | `/commerce/stores/:storeId/customers/:customerId/tags` | admin | SetCustomerTags |
| GET | `/commerce/stores/:storeId/audit-log` | admin | GetAuditLog |
| GET | `/commerce/stores/:storeId/auth/config` | admin | GetAuthConfig |
| PUT | `/commerce/stores/:storeId/auth/config` | admin | UpdateAuthConfig |
| GET | `/commerce/stores/:storeId/auth/email/log` | admin | GetEmailLog |
| POST | `/commerce/stores/:storeId/auth/email/test` | admin | SendTestEmail |
| POST | `/commerce/stores/:storeId/auth/email/connect` | admin | TestEmailConnection |
| GET | `/commerce/stores/:storeId/auth/info` | none | GetAuthInfo |
| POST | `/commerce/stores/:storeId/auth/register` | none | Register |
| POST | `/commerce/stores/:storeId/auth/login` | none | Login |
| POST | `/commerce/stores/:storeId/auth/token` | none | Token |
| POST | `/commerce/stores/:storeId/auth/logout` | none | Logout |
| POST | `/commerce/stores/:storeId/auth/password-reset/request` | none | RequestPasswordReset |
| POST | `/commerce/stores/:storeId/auth/password-reset/complete` | none | CompletePasswordReset |
| POST | `/commerce/stores/:storeId/auth/verify-email` | none | VerifyEmail |
| POST | `/commerce/stores/:storeId/auth/verify-email/resend` | none | ResendVerification |
| POST | `/commerce/stores/:storeId/auth/magic-link` | none | RequestMagicLink |
| POST | `/commerce/stores/:storeId/auth/magic-link/verify` | none | VerifyMagicLink |
| POST | `/commerce/stores/:storeId/auth/invite/accept` | none | AcceptInvite |
| GET | `/commerce/stores/:storeId/auth/google/url` | none | GoogleAuthURL |
| POST | `/commerce/stores/:storeId/auth/google/callback` | none | GoogleCallback |
| GET | `/commerce/stores/:storeId/auth/microsoft/url` | none | MicrosoftAuthURL |
| POST | `/commerce/stores/:storeId/auth/microsoft/callback` | none | MicrosoftCallback |
| GET | `/commerce/stores/:storeId/auth/discord/url` | none | DiscordAuthURL |
| POST | `/commerce/stores/:storeId/auth/discord/callback` | none | DiscordCallback |
| GET | `/commerce/stores/:storeId/auth/me` | none | Me |
| PUT | `/commerce/stores/:storeId/auth/me` | none | UpdateMe |
| PUT | `/commerce/stores/:storeId/auth/me/password` | none | ChangePassword |
| GET | `/commerce/stores/:storeId/auth/sessions` | none | ListSessions |
| DELETE | `/commerce/stores/:storeId/auth/sessions/:sessionId` | none | RevokeSession |

---

## T2.9 — B2B + Subscriptions + Returns + Digital + Reviews/Wishlists

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/commerce/stores/:storeId/companies` | admin | ListCompanies |
| POST | `/commerce/stores/:storeId/companies` | admin | CreateCompany |
| PUT | `/commerce/stores/:storeId/companies/:companyId` | admin | UpdateCompany |
| DELETE | `/commerce/stores/:storeId/companies/:companyId` | admin | DeleteCompany |
| GET | `/commerce/stores/:storeId/customer-groups` | admin | ListCustomerGroups |
| POST | `/commerce/stores/:storeId/customer-groups` | admin | CreateCustomerGroup |
| PUT | `/commerce/stores/:storeId/customer-groups/:groupId` | admin | UpdateCustomerGroup |
| DELETE | `/commerce/stores/:storeId/customer-groups/:groupId` | admin | DeleteCustomerGroup |
| POST | `/commerce/stores/:storeId/customer-groups/:groupId/members` | admin | AddCustomerGroupMember |
| DELETE | `/commerce/stores/:storeId/customer-groups/:groupId/members/:customerId` | admin | RemoveCustomerGroupMember |
| GET | `/commerce/stores/:storeId/quotes` | admin | ListQuotes |
| POST | `/commerce/stores/:storeId/quotes` | admin | CreateQuote |
| GET | `/commerce/stores/:storeId/quotes/:quoteId` | admin | GetQuote |
| PUT | `/commerce/stores/:storeId/quotes/:quoteId` | admin | UpdateQuote |
| POST | `/commerce/stores/:storeId/quotes/:quoteId/send` | admin | SendQuote |
| POST | `/commerce/stores/:storeId/quotes/:quoteId/accept` | admin | AcceptQuote |
| POST | `/commerce/stores/:storeId/quotes/:quoteId/reject` | admin | RejectQuote |
| GET | `/commerce/stores/:storeId/purchase-orders` | admin | ListPurchaseOrders |
| GET | `/commerce/stores/:storeId/purchase-orders/:poId` | admin | GetPurchaseOrder |
| POST | `/commerce/stores/:storeId/orders/:orderId/purchase-order` | admin | AttachPurchaseOrder |
| PUT | `/commerce/stores/:storeId/purchase-orders/:poId` | admin | UpdatePurchaseOrder |
| GET | `/commerce/stores/:storeId/subscription-plans` | admin | ListSubscriptionPlans |
| POST | `/commerce/stores/:storeId/subscription-plans` | admin | CreateSubscriptionPlan |
| GET | `/commerce/stores/:storeId/subscription-plans/:planId` | admin | GetSubscriptionPlan |
| PUT | `/commerce/stores/:storeId/subscription-plans/:planId` | admin | UpdateSubscriptionPlan |
| DELETE | `/commerce/stores/:storeId/subscription-plans/:planId` | admin | DeleteSubscriptionPlan |
| GET | `/commerce/stores/:storeId/subscriptions` | admin | ListSubscriptions |
| POST | `/commerce/stores/:storeId/subscriptions` | admin | CreateSubscription |
| GET | `/commerce/stores/:storeId/subscriptions/:subId` | admin | GetSubscription |
| POST | `/commerce/stores/:storeId/subscriptions/:subId/pause` | admin | PauseSubscription |
| POST | `/commerce/stores/:storeId/subscriptions/:subId/resume` | admin | ResumeSubscription |
| POST | `/commerce/stores/:storeId/subscriptions/:subId/cancel` | admin | CancelSubscription |
| POST | `/commerce/stores/:storeId/subscriptions/:subId/bill` | admin | BillSubscription |
| GET | `/commerce/stores/:storeId/returns` | admin | ListReturns |
| POST | `/commerce/stores/:storeId/orders/:orderId/returns` | admin | CreateReturn |
| GET | `/commerce/stores/:storeId/returns/:returnId` | admin | GetReturn |
| PUT | `/commerce/stores/:storeId/returns/:returnId` | admin | UpdateReturn |
| POST | `/commerce/stores/:storeId/returns/:returnId/events` | admin | AddReturnEvent |
| GET | `/commerce/stores/:storeId/wishlists` | read | ListWishlists |
| POST | `/commerce/stores/:storeId/wishlists` | read | GetOrCreateWishlist |
| GET | `/commerce/stores/:storeId/wishlists/:wishlistId` | read | GetWishlist |
| DELETE | `/commerce/stores/:storeId/wishlists/:wishlistId` | write | DeleteWishlist |
| POST | `/commerce/stores/:storeId/wishlists/:wishlistId/items` | write | AddWishlistItem |
| DELETE | `/commerce/stores/:storeId/wishlists/:wishlistId/items/:itemId` | write | RemoveWishlistItem |

---

## T2.10 — Feeds + Integrations + Notifications + Analytics

| Method | Path | Auth | Handler |
|---|---|---|---|
| GET | `/storefront/:storeId/feeds/google-shopping` | none | GetGoogleShoppingFeed |
| GET | `/storefront/:storeId/feeds/facebook-catalog` | none | GetFacebookCatalogFeed |
| GET | `/storefront/:storeId/pixels` | none | GetStorePixelsPublic |
| GET | `/commerce/stores/:storeId/merchant-feeds` | admin | ListMerchantFeeds |
| POST | `/commerce/stores/:storeId/merchant-feeds` | admin | CreateMerchantFeed |
| PUT | `/commerce/stores/:storeId/merchant-feeds/:feedId` | admin | UpdateMerchantFeed |
| DELETE | `/commerce/stores/:storeId/merchant-feeds/:feedId` | admin | DeleteMerchantFeed |
| GET | `/commerce/integration-definitions` | JWT | ListIntegrationDefinitions |
| GET | `/commerce/stores/:storeId/integrations` | admin | ListStoreIntegrations |
| POST | `/commerce/stores/:storeId/integrations` | admin | UpsertStoreIntegration |
| DELETE | `/commerce/stores/:storeId/integrations/:integrationId` | admin | DeleteStoreIntegration |
| GET | `/commerce/stores/:storeId/tracking-pixels` | admin | ListTrackingPixels |
| POST | `/commerce/stores/:storeId/tracking-pixels` | admin | UpsertTrackingPixel |
| DELETE | `/commerce/stores/:storeId/tracking-pixels/:pixelId` | admin | DeleteTrackingPixel |
| GET | `/commerce/stores/:storeId/notification-providers` | admin | ListNotificationProviders |
| POST | `/commerce/stores/:storeId/notification-providers` | admin | CreateNotificationProvider |
| PUT | `/commerce/stores/:storeId/notification-providers/:providerId` | admin | UpdateNotificationProvider |
| DELETE | `/commerce/stores/:storeId/notification-providers/:providerId` | admin | DeleteNotificationProvider |
| GET | `/commerce/stores/:storeId/webhook-url` | admin | GetWebhookURL |
| GET | `/commerce/stores/:storeId/webhook-log` | admin | ListWebhookLog |
| GET | `/analytics/ecommerce/overview` | JWT | Overview |
| GET | `/analytics/ecommerce/products` | JWT | Products |
| GET | `/analytics/ecommerce/funnel` | JWT | Funnel |
| GET | `/analytics/ecommerce/revenue` | JWT | Revenue |

---

_Generated by T2.1 from webcrft-mono/backend/cmd/server/main.go. Last updated: 2026-06-12._
