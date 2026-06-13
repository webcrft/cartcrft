# Cartcrft MCP Server

Any MCP-capable agent (Claude Desktop, Claude Code, custom agent) can browse and buy from a
Cartcrft store using the tools described here.

---

## Transports

### 1. Streamable HTTP (remote / cloud)

Each store gets its own endpoint:

```
POST/GET/DELETE https://<your-host>/mcp/<storeId>
Authorization: Bearer <cc_pub_ or cc_prv_ key>
```

> **Security note:** The API key must be supplied via the `Authorization` header.
> The `?key=` query-parameter path has been removed — query strings appear in
> access logs, reverse-proxy logs, and browser Referer headers, which would leak
> privileged `cc_prv_` keys.

### 2. stdio (local dev)

```bash
pnpm mcp:stdio
```

Required env vars (put in `.env` at the repo root):

```env
DATABASE_URL=postgres://...
CARTCRFT_STORE_ID=<your-store-uuid>
CARTCRFT_API_KEY=<cc_pub_ or cc_prv_ key>
```

---

## Connecting from Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

### stdio

```json
{
  "mcpServers": {
    "cartcrft": {
      "command": "pnpm",
      "args": ["--filter", "backend", "mcp:stdio"],
      "cwd": "/path/to/cartcrft",
      "env": {
        "DATABASE_URL": "postgres://...",
        "CARTCRFT_STORE_ID": "<store-uuid>",
        "CARTCRFT_API_KEY": "cc_pub_..."
      }
    }
  }
}
```

### HTTP (remote server)

```json
{
  "mcpServers": {
    "cartcrft": {
      "type": "http",
      "url": "https://your-host/mcp/<storeId>",
      "headers": {
        "Authorization": "Bearer cc_pub_..."
      }
    }
  }
}
```

---

## Connecting from Claude Code

### stdio

```bash
claude mcp add cartcrft \
  --command "pnpm --filter backend mcp:stdio" \
  --cwd /path/to/cartcrft \
  --env DATABASE_URL=postgres://... \
  --env CARTCRFT_STORE_ID=<store-uuid> \
  --env CARTCRFT_API_KEY=cc_pub_...
```

### HTTP

```bash
claude mcp add cartcrft \
  --transport http \
  --url "https://your-host/mcp/<storeId>" \
  --header "Authorization: Bearer cc_pub_..."
```

---

## API Key Types

| Prefix    | Typical scopes                              | Use for                       |
|-----------|---------------------------------------------|-------------------------------|
| `cc_pub_` | `commerce:read`                             | Browse catalog, read cart     |
| `cc_prv_` | `commerce:read commerce:write`              | Create cart, checkout, orders |

Create keys via the REST API (`POST /api-keys`) or the Cartcrft admin.

---

## Tool Catalog

| Tool                | Scope needed      | Description                                                        |
|---------------------|-------------------|--------------------------------------------------------------------|
| `search_products`   | `commerce:read`   | Full-text search over the active catalog; returns variants + prices |
| `get_product`       | `commerce:read`   | Fetch a single product by UUID, including all variants              |
| `create_cart`       | `commerce:read`   | Create a new empty cart; returns `cart_id`                          |
| `add_to_cart`       | `commerce:write`  | Add a variant to the cart (increments qty on duplicate)             |
| `get_cart`          | `commerce:read`   | Retrieve cart with lines, quantities, and unit prices               |
| `start_checkout`    | `commerce:write`  | Convert a cart into a checkout; calculates tax/shipping             |
| `update_checkout`   | `commerce:write`  | Update email, shipping/billing address, or apply a discount code    |
| `complete_checkout` | `commerce:write`  | Place the order (test-mode; no real payment required)               |
| `get_order_status`  | `commerce:read`   | Retrieve an order with financial + fulfillment status               |

---

## 10-Minute Walkthrough

Below is a minimal purchase flow an agent would execute:

### Step 1 — Discover products

```
search_products(query="coffee mug", limit=5)
```

Returns a list of products with variants and prices.

### Step 2 — Inspect a product

```
get_product(product_id="<uuid from search>")
```

Returns full product detail including variant UUIDs and prices.

### Step 3 — Create a cart

```
create_cart()
```

Returns `{ cart_id: "<uuid>", cart: { ... } }`.

### Step 4 — Add items

```
add_to_cart(cart_id="<cart_id>", variant_id="<variant_uuid>", quantity=2)
```

Returns `{ line_id: "<uuid>", cart: { lines: [...] } }`.

### Step 5 — Review cart

```
get_cart(cart_id="<cart_id>")
```

Returns cart with lines, quantities, unit prices, and subtotal.

### Step 6 — Start checkout

```
start_checkout(
  cart_id="<cart_id>",
  email="buyer@example.com",
  shipping_address={ first_name: "Alice", address1: "1 Main St", city: "Cape Town",
                     country_code: "ZA", zip: "8001" }
)
```

Returns `{ id: "<checkout_id>", subtotal, shipping_total, tax_total, total, currency }`.

### Step 7 — (Optional) Update checkout

```
update_checkout(
  checkout_id="<checkout_id>",
  billing_address={ ... }
)
```

### Step 8 — Complete the order

```
complete_checkout(checkout_id="<checkout_id>")
```

Returns `{ order_id, order_number, total, currency, item_count, message }`.

### Step 9 — Check order status

```
get_order_status(order_id="<order_id>")
```

Returns full order with `status`, `financial_status`, `fulfillment_status`, and line items.

---

## Error Codes

All tool errors return `{ error: { code: string, message: string } }` as the text content.

| Code                    | Meaning                                         |
|-------------------------|-------------------------------------------------|
| `NOT_FOUND`             | Resource does not exist or is not visible       |
| `INSUFFICIENT_INVENTORY`| Not enough stock to fulfil the order            |
| `DISCOUNT_EXHAUSTED`    | Discount code has reached its usage cap         |
| `DISCOUNT_ALREADY_USED` | Once-per-customer code already used             |
| `TOOL_ERROR`            | Generic error (see message for details)         |
