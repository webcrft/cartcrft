# Quickstart: Buy with an AI Agent in 10 Minutes

This guide sets up a running CartCrft store with a demo catalog and walks an AI agent
through a complete purchase — search → cart → checkout → order — over the MCP protocol.

---

## Prerequisites

- **Node.js** 22 LTS (`node --version` → `v22.x.x`)
- **pnpm** 9+ (`pnpm --version` → `9.x.x`)
- **PostgreSQL** 16+ with the `pgvector` extension

  ```bash
  # macOS (Homebrew)
  brew install postgresql@16
  brew install pgvector  # or: psql -c "CREATE EXTENSION IF NOT EXISTS vector"

  # Docker (fastest, no local install)
  docker run -d \
    --name cartcrft-pg \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=cartcrft \
    -p 5432:5432 \
    pgvector/pgvector:pg16
  ```

- **MCP client** — Claude Desktop, Claude Code, or any MCP-compatible agent.

---

## 1. Install dependencies

```bash
git clone https://github.com/webcrftsystems/cartcrft
cd cartcrft
pnpm install
```

---

## 2. Configure environment

Copy `.env.example` to `.env` at the repo root and fill in your Postgres URL:

```env
# .env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cartcrft
JWT_SECRET=change-me-in-production
AUTH_SECRETS_KEY=32-char-hex-secret-for-aes-gcm   # optional for dev
PORT=3000
APP_ENV=development
```

---

## 3. Run migrations + seed demo store

```bash
pnpm migrate   # applies 12 SQL migration files → creates all tables
pnpm seed      # creates the Crft Goods demo store + 12 products
```

On first run, `pnpm seed` prints your store credentials **once**:

```
╔══════════════════════════════════════════════════════╗
║         Crft Goods Demo Store — API Keys             ║
╠══════════════════════════════════════════════════════╣
║  STORE_ID:   7293672e-8377-4b97-bf6c-11c4ba2a8219   ║
║  cc_pub_:    cc_pub_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3  ║
║  cc_prv_:    cc_prv_9z8y7x6w5v4u3t2s1r0q9p8o7n6m5  ║
╚══════════════════════════════════════════════════════╝
  Save these — they are printed once and not stored in plain text.

[seed] Done! Crft Goods demo store seeded.
  12 products (12 total, various types)
  2 collections: "New Arrivals" (manual) + "All Active Products" (smart)
  Discount: WELCOME10 (10% off, no minimum)
  Shipping: Worldwide flat $7.99, free over $100
  Warehouse: Crft Goods Fulfilment Centre

  Add to your MCP client config:
    CARTCRFT_STORE_ID=7293672e-8377-4b97-bf6c-11c4ba2a8219
    CARTCRFT_API_KEY=cc_pub_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3   # read-only
    # For checkout flows use the private key:
    CARTCRFT_API_KEY=cc_prv_9z8y7x6w5v4u3t2s1r0q9p8o7n6m5   # read+write
```

**Save the `STORE_ID` and keys now.** They will not be shown again.

---

## 4. Start the server

```bash
pnpm dev    # starts Fastify on PORT (default 3000)
```

Confirm it's running:

```bash
curl http://localhost:3000/healthz
# → {"status":"ok","version":"0.0.0"}
```

---

## 5. Connect your MCP client

See [mcp/README.md](../mcp/README.md) for full connection options.

### Claude Desktop (stdio)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cartcrft": {
      "command": "pnpm",
      "args": ["--filter", "backend", "mcp:stdio"],
      "cwd": "/path/to/cartcrft",
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/cartcrft",
        "CARTCRFT_STORE_ID": "<your-store-uuid>",
        "CARTCRFT_API_KEY": "cc_prv_<your-private-key>"
      }
    }
  }
}
```

### Claude Code (HTTP)

```bash
# Start the server first (pnpm dev), then:
claude mcp add cartcrft \
  --transport http \
  --url "http://localhost:3000/mcp/<your-store-uuid>" \
  --header "Authorization: Bearer cc_prv_<your-private-key>"
```

---

## 6. The agent-buyable walkthrough

Below is a scripted conversation that buys the *Alpine Merino Pullover Hoodie* using
the WELCOME10 discount code. Copy the tool calls verbatim into any MCP client.

### Step 1 — Find a warm merino hoodie

**Tool call:**
```json
{
  "tool": "search_products",
  "arguments": {
    "query": "merino pullover hoodie",
    "limit": 5
  }
}
```

**Response (excerpt):**
```json
{
  "products": [
    {
      "id": "b6d1e2a3-...",
      "title": "Alpine Merino Pullover Hoodie",
      "slug": "alpine-merino-pullover-hoodie",
      "type": "configurable",
      "description": "Crafted from 100% New Zealand merino wool (250 GSM midweight)...",
      "variants": [
        { "id": "c7f2g3h4-...", "title": "M / Slate Grey",   "price": "89.00" },
        { "id": "d8i4j5k6-...", "title": "M / Forest Green", "price": "89.00" }
      ]
    }
  ],
  "total": 3,
  "offset": 0,
  "limit": 5
}
```

Under $90. Merino. Hoodie. Found it.

---

### Step 2 — Inspect the product

**Tool call:**
```json
{
  "tool": "get_product",
  "arguments": { "product_id": "b6d1e2a3-..." }
}
```

**Response (excerpt):**
```json
{
  "id": "b6d1e2a3-...",
  "title": "Alpine Merino Pullover Hoodie",
  "type": "configurable",
  "status": "active",
  "options": [
    { "name": "Size",   "values": ["XS","S","M","L","XL"] },
    { "name": "Colour", "values": ["Slate Grey","Forest Green"] }
  ],
  "variants": [
    { "id": "c7f2g3h4-...", "title": "M / Slate Grey",  "price": "89.00", "sku": "AMH-M-SG" },
    { "id": "l9m0n1o2-...", "title": "L / Slate Grey",  "price": "89.00", "sku": "AMH-L-SG" },
    { "id": "d8i4j5k6-...", "title": "M / Forest Green","price": "89.00", "sku": "AMH-M-FG" }
  ]
}
```

---

### Step 3 — Create a cart

**Tool call:**
```json
{
  "tool": "create_cart",
  "arguments": {}
}
```

**Response:**
```json
{
  "cart_id": "e9p3q4r5-...",
  "cart": {
    "id": "e9p3q4r5-...",
    "store_id": "7293672e-...",
    "status": "active",
    "currency": "USD",
    "lines": []
  }
}
```

---

### Step 4 — Add the hoodie (size M, Slate Grey)

**Tool call:**
```json
{
  "tool": "add_to_cart",
  "arguments": {
    "cart_id": "e9p3q4r5-...",
    "variant_id": "c7f2g3h4-...",
    "quantity": 1
  }
}
```

**Response:**
```json
{
  "line_id": "f1s5t6u7-...",
  "cart": {
    "id": "e9p3q4r5-...",
    "status": "active",
    "lines": [
      {
        "id": "f1s5t6u7-...",
        "variant_id": "c7f2g3h4-...",
        "title": "Alpine Merino Pullover Hoodie",
        "variant_title": "M / Slate Grey",
        "quantity": 1,
        "price": "89.00"
      }
    ]
  }
}
```

---

### Step 5 — Review the cart

**Tool call:**
```json
{
  "tool": "get_cart",
  "arguments": { "cart_id": "e9p3q4r5-..." }
}
```

**Response:**
```json
{
  "id": "e9p3q4r5-...",
  "status": "active",
  "currency": "USD",
  "lines": [
    { "quantity": 1, "price": "89.00", "title": "Alpine Merino Pullover Hoodie", "variant_title": "M / Slate Grey" }
  ]
}
```

---

### Step 6 — Start checkout

**Tool call:**
```json
{
  "tool": "start_checkout",
  "arguments": {
    "cart_id": "e9p3q4r5-...",
    "email": "agent@example.com",
    "shipping_address": {
      "first_name": "AI",
      "last_name": "Agent",
      "address1": "1 Commerce Lane",
      "city": "New York",
      "province_code": "NY",
      "country_code": "US",
      "zip": "10001"
    }
  }
}
```

**Response:**
```json
{
  "id": "g2v7w8x9-...",
  "subtotal": "89.00",
  "shipping_total": "7.99",
  "tax_total": "0.00",
  "discount_total": "0.00",
  "total": "96.99",
  "currency": "USD"
}
```

---

### Step 7 — Apply the WELCOME10 discount

**Tool call:**
```json
{
  "tool": "update_checkout",
  "arguments": {
    "checkout_id": "g2v7w8x9-...",
    "discount_code": "WELCOME10"
  }
}
```

**Response:**
```json
{
  "id": "g2v7w8x9-...",
  "subtotal": "89.00",
  "shipping_total": "7.99",
  "tax_total": "0.00",
  "discount_total": "8.90",
  "total": "88.09",
  "currency": "USD",
  "discount_lines": [
    { "code": "WELCOME10", "type": "percentage", "value": "10", "amount": "8.90" }
  ]
}
```

10% off applied. Total: $88.09.

---

### Step 8 — Place the order (test mode)

**Tool call:**
```json
{
  "tool": "complete_checkout",
  "arguments": { "checkout_id": "g2v7w8x9-..." }
}
```

**Response:**
```json
{
  "order_id": "h3y0z1a2-...",
  "order_number": "CG-1001",
  "total": "88.09",
  "currency": "USD",
  "item_count": 1,
  "message": "Order created successfully"
}
```

Order placed. No payment credentials required in test mode.

---

### Step 9 — Check order status

**Tool call:**
```json
{
  "tool": "get_order_status",
  "arguments": { "order_id": "h3y0z1a2-..." }
}
```

**Response:**
```json
{
  "id": "h3y0z1a2-...",
  "order_number": "CG-1001",
  "status": "open",
  "financial_status": "pending",
  "fulfillment_status": "unfulfilled",
  "currency": "USD",
  "total": "88.09",
  "lines": [
    {
      "variant_id": "c7f2g3h4-...",
      "title": "Alpine Merino Pullover Hoodie",
      "variant_title": "M / Slate Grey",
      "quantity": 1,
      "price": "89.00"
    }
  ]
}
```

Done. The agent bought a merino hoodie in 9 tool calls.

---

## Real test-harness verification

The flow above was verified by the automated test suite (`pnpm suite seed`),
which seeds the demo store into an isolated Postgres schema and drives the full
MCP purchase flow via `StreamableHTTPClientTransport`:

```
 ✓ seed idempotency > seedDemoStore() does not return alreadyExisted on fresh run
 ✓ seed idempotency > re-running seedDemoStore returns alreadyExisted=true
 ✓ products > seeds exactly 12 products
 ✓ products > all 12 products are active in the DB
 ✓ products > covers all required product types (configurable, simple, digital, bundle, subscription)
 ✓ products > every product has at least one variant with price > 0
 ✓ products > total variant count is reasonable (>= 12)
 ✓ products > the merino hoodie has size and colour options
 ✓ inventory > creates the default warehouse
 ✓ inventory > tracked variants have inventory_levels rows with qty > 0
 ✓ inventory > digital + subscription variants do NOT have inventory_levels rows
 ✓ collections > creates 2 collections (manual + smart)
 ✓ collections > manual collection 'New Arrivals' has at least 6 products
 ✓ collections > smart collection 'All Active Products' has all 12 products
 ✓ discount code WELCOME10 > WELCOME10 exists in the DB
 ✓ discount code WELCOME10 > WELCOME10 validates via REST API (10% off a $50 order)
 ✓ semantic search > search for 'merino pullover hoodie' returns the Alpine hoodie
 ✓ semantic search > search for 'merino wool' returns multiple products
 ✓ semantic search > search for 'digital download design assets' returns the asset pack
 ✓ MCP agent purchase flow > search_products finds merino hoodie by keyword 'merino'
 ✓ MCP agent purchase flow > get_product returns full hoodie detail with variants
 ✓ MCP agent purchase flow > create_cart creates a new cart for the store
 ✓ MCP agent purchase flow > add_to_cart adds M / Slate Grey hoodie (qty=1)
 ✓ MCP agent purchase flow > get_cart shows the hoodie at $89.00
 ✓ MCP agent purchase flow > start_checkout creates checkout session
 ✓ MCP agent purchase flow > update_checkout applies WELCOME10 discount (10% off)
 ✓ MCP agent purchase flow > complete_checkout places the order (test mode)
 ✓ MCP agent purchase flow > get_order_status returns the placed order
 ✓ shipping zone > shipping zone 'Worldwide' exists
 ✓ shipping zone > has flat rate $7.99 and free over $100

 Tests  31 passed (31)
```

---

## Demo product catalogue

The seed creates 12 products across 5 types:

| # | Title | Type | Price | Variants |
|---|-------|------|-------|----------|
| 1 | Alpine Merino Pullover Hoodie | configurable | $89.00 | 9 (size × colour) |
| 2 | Everyday Organic Cotton Tee | configurable | $34.00 | 9 (size × colour) |
| 3 | Merino Ribbed Beanie | simple | $28.00 | 3 (colour) |
| 4 | Heritage Waxed Canvas Tote | simple | $79.00 | 2 (colourway) |
| 5 | Single-Origin Pour-Over Starter Set | simple | $54.00 | 2 (finish) |
| 6 | Insulated Stainless Steel Water Bottle 750 ml | simple | $38.00 | 4 (colour) |
| 7 | Lay-Flat Dotted Notebook — A5 | simple | $22.00 | 3 (colour) |
| 8 | Brand Foundations Asset Pack | **digital** | $49–$119 | 2 (licence tier) |
| 9 | The Creator Starter Kit | **bundle** | $129.00 | 1 |
| 10 | Monthly Coffee Replenishment | **subscription** | $18–$32 | 2 (size) |
| 11 | Merino Hiking Crew Socks — 3-Pack | simple | $24.00 | 2 (size) |
| 12 | Organic Beeswax Food Wraps — 3-Pack | simple | $19.00 | 2 (pattern) |

All descriptions are written for semantic search — they include materials,
use-cases, and audience so a BYO embedding model (OpenAI text-embedding-3-small,
or any OpenAI-compatible endpoint) will produce meaningful similarity rankings.

---

## Connecting semantic search (optional)

Without a BYO LLM key, search falls back to Postgres full-text (`websearch_to_tsquery`),
which works well for keyword queries. To enable hybrid semantic + full-text search:

```bash
# After seeding, store your LLM key in the store metadata:
curl -X PUT http://localhost:3000/commerce/stores/<storeId> \
  -H "Authorization: Bearer cc_prv_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "metadata": {
      "llm_provider": {
        "api_key": "<your-openai-api-key>",
        "model": "text-embedding-3-small"
      }
    }
  }'
```

The embedding worker will index all 12 products automatically (30-second polling interval
when `pnpm dev` runs in `worker` mode: `pnpm dev worker`).

---

## Next steps

- **REST API** — Browse the full endpoint list in `docs/parity-endpoints.md`
- **MCP tools reference** — See `mcp/README.md` for all 9 tools and error codes
- **Custom storefront** — Use the `cc_pub_` key in a browser + `sdk/storefront.js`
  (T5.2) or any HTTP client
- **Production deployment** — Replace `DATABASE_URL`, set `APP_ENV=production`,
  configure a real payment provider (`POST /commerce/payment-providers`)
- **ACP adapter** — Coming in T3.4 for agentic checkout sessions per the ACP spec
