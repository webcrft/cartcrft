# @cartcrft/sdk

CartCrft TypeScript SDK — typed fetch client for the CartCrft headless commerce API.

Generated from the OpenAPI 3.1 spec at `docs/openapi.json` using `openapi-typescript`.

---

## Install

```bash
npm install @cartcrft/sdk
# or
pnpm add @cartcrft/sdk
```

No peer dependencies beyond a JS runtime with `fetch` (Node 22+, modern browsers).

---

## Init

### Storefront (public key — `cc_pub_*`)

Used in browser storefronts, Next.js Server Components, or any code where read-only
access to catalog, cart, and checkout is sufficient.

```ts
import { Cartcrft } from "@cartcrft/sdk";

const sdk = new Cartcrft({
  baseUrl: "https://api.cartcrft.dev",
  apiKey: "cc_pub_0123456789abcdef0123456789abcdef",
});
```

### Server-side (private key — `cc_prv_*`)

Used in server-side code for write operations: creating orders, managing inventory,
issuing discounts, etc. Never expose a `cc_prv_` key to the browser.

```ts
import { Cartcrft } from "@cartcrft/sdk";

const sdk = new Cartcrft({
  baseUrl: "https://api.cartcrft.dev",
  apiKey: "cc_prv_0123456789abcdef0123456789abcdef",
});
```

### Staff JWT (admin ops)

```ts
import { Cartcrft } from "@cartcrft/sdk";

const sdk = new Cartcrft({
  baseUrl: "https://api.cartcrft.dev",
  token: staffJwt,
});
```

---

## Examples

### List products

```ts
const { products } = await sdk.catalog.listProducts(STORE_ID, {
  status: "active",
  limit: 20,
});

for (const p of products) {
  console.log(p.title, p.price_min);
}
```

### Semantic search

Long natural-language queries work best — the backend uses pgvector + full-text
hybrid with Reciprocal Rank Fusion.

```ts
const { products } = await sdk.search.search(STORE_ID, {
  q: "warm wool sweater for cold weather",
  in_stock: true,
  price_max: 150,
});
```

### Cart → Checkout → Complete (test mode)

```ts
// 1. Create a cart
const { cart } = await sdk.carts.create(STORE_ID);

// 2. Add a line item
await sdk.carts.addLine(STORE_ID, cart.id, {
  variant_id: VARIANT_ID,
  quantity: 1,
});

// 3. Open a checkout session
const { checkout } = await sdk.checkout.create(STORE_ID, {
  cart_id: cart.id,
  email: "buyer@example.com",
  shipping_address: {
    name: "Jane Doe",
    address1: "1 Commerce St",
    city: "Cape Town",
    country_code: "ZA",
    zip: "8001",
  },
  discount_code: "WELCOME10",
});

// 4. Complete in test mode (no real payment)
const { order } = await sdk.checkout.complete(STORE_ID, checkout.id, {
  test_mode: true,
});

console.log("Order placed:", order.order_number);
```

### Escape hatch — raw `request()`

For any path not yet covered by a named helper:

```ts
// GET /commerce/stores/:storeId/shipments?order_id=abc
const data = await sdk.request<{ shipments: unknown[] }>(
  `/commerce/stores/${STORE_ID}/shipments`,
  {
    method: "GET",
    query: { order_id: ORDER_ID },
  }
);

// POST with idempotency key
const result = await sdk.request("/commerce/stores/:storeId/checkouts/:id/complete", {
  method: "POST",
  body: { test_mode: true },
  idempotencyKey: "unique-key-123",
});
```

---

## SDK surface

| Namespace | Key methods |
|---|---|
| `sdk.stores` | `list`, `get`, `create`, `update`, `delete` |
| `sdk.apiKeys` | `list`, `create`, `revoke` |
| `sdk.catalog` | `listProducts`, `getProduct`, `createProduct`, `updateProduct`, `deleteProduct`, `listVariants`, `createVariant`, `updateVariant`, `deleteVariant`, `listCollections`, `getCollection`, `createCollection`, `getCollectionProducts`, `listPriceLists` |
| `sdk.carts` | `create`, `get`, `addLine`, `updateLine`, `removeLine` |
| `sdk.checkout` | `create`, `get`, `update`, `complete`, `initiatePayment` |
| `sdk.orders` | `list`, `get`, `cancel`, `addNote`, `listEvents` |
| `sdk.payments` | `list`, `capture`, `refund` |
| `sdk.customers` | `list`, `get`, `create`, `update`, `delete`, `listAddresses` |
| `sdk.customerAuth` | `getConfig`, `getInfo`, `register`, `login`, `logout`, `refresh`, `me`, `requestPasswordReset`, `requestMagicLink` |
| `sdk.inventory` | `listWarehouses`, `createWarehouse`, `listLevels`, `setLevel`, `adjustLevel` |
| `sdk.shipping` | `listZones`, `createZone`, `listAvailable`, `listShipments` |
| `sdk.tax` | `listCategories`, `listZones` |
| `sdk.discounts` | `list`, `get`, `validate`, `create` |
| `sdk.wallet` | `getBalance`, `issue`, `adjust`, `listTransactions` |
| `sdk.giftCards` | `list`, `get`, `create`, `lookup` |
| `sdk.b2b` | `listCompanies`, `createCompany`, `listQuotes`, `createQuote` |
| `sdk.subscriptions` | `listPlans`, `createPlan`, `list`, `create` |
| `sdk.returns` | `list`, `create`, `get`, `approve`, `receive` |
| `sdk.digital` | `listFiles`, `createFile`, `createDownloadLink` |
| `sdk.engagement` | `listWishlists`, `createWishlist`, `listAbandonedCarts` |
| `sdk.feeds` | `googleShopping`, `facebookCatalog`, `listMerchantFeeds` |
| `sdk.integrations` | `listDefinitions`, `list`, `create`, `listPixels` |
| `sdk.notifications` | `listProviders`, `createProvider` |
| `sdk.analytics` | `overview`, `products`, `funnel`, `revenue` |
| `sdk.search` | `search` |
| `sdk.agents` | `list`, `create`, `get`, `listMandates`, `createMandate` |
| `sdk.acp` | `getFeed`, `createSession`, `getSession`, `updateSession`, `completeSession` |

---

## Generated types

The generated `src/types/openapi.d.ts` (produced by `pnpm generate`) exposes all
request/response schemas from the OpenAPI spec. The hand-written client uses a subset
for ergonomics; use `sdk.request<T>(path, opts)` to access any path with the full
type coverage from the generated types.

```ts
import type { paths } from "@cartcrft/sdk/src/types/openapi.js";
// Infer request/response types from the generated spec directly
type ListProductsResponse = paths["/commerce/stores/{storeId}/products"]["get"]["responses"]["200"];
```
