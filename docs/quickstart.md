# Quickstart — Local Development

Get a Cartcrft server running locally with a seeded demo store and make your
first API calls in under five minutes.

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Node.js | 22 LTS | `node --version` → `v22.x.x` |
| pnpm | 9+ | `pnpm --version` → `9.x.x` |
| PostgreSQL | 16+ with `pgvector` | see below |

### PostgreSQL + pgvector

**Option A — Docker (fastest)**

```bash
docker run -d \
  --name cartcrft-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=cartcrft \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

**Option B — Homebrew (macOS)**

```bash
brew install postgresql@16
brew services start postgresql@16
# Install pgvector extension:
psql postgres -c "CREATE EXTENSION IF NOT EXISTS vector"
```

`pgvector` is optional for basic use. Without it the search endpoint falls back
to Postgres full-text automatically. The migration applies the extension inside a
`DO $$ BEGIN ... EXCEPTION ... END $$` guard so migration never fails if the
extension is absent.

---

## Install

```bash
git clone https://github.com/webcrftsystems/cartcrft
cd cartcrft
pnpm install
```

---

## Configure

Create a `.env` file at the repo root:

```bash
cp .env.example .env   # if the example exists, otherwise create manually
```

Minimum required variables:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cartcrft
JWT_SECRET=change-me-in-production
APP_ENV=development
PORT=3000
```

Optional but recommended for production:

```env
# AES-256-GCM key for encrypting provider secrets at rest.
# 64-char hex (openssl rand -hex 32) or 44-char base64 (openssl rand -base64 32).
# Required when APP_ENV=production — server refuses to start without it.
AUTH_SECRETS_KEY=<64-char-hex>
```

All variable names mirror the webcrft-mono `.env.dev` file — the same `.env`
works with both repos.

---

## Migrate

```bash
pnpm migrate
```

Applies all `backend/migrations/*.sql` files in order. Re-running is a no-op
(files already in `schema_migrations` are skipped). Current migration count: 18
files (0001–0018), covering 105+ tables.

---

## Seed the demo store

```bash
pnpm seed
```

Creates the **Crft Goods** demo store idempotently. On the first run it prints
your store credentials **once** — save them now:

```
╔══════════════════════════════════════════════════════╗
║         Crft Goods Demo Store — API Keys             ║
╠══════════════════════════════════════════════════════╣
║  STORE_ID:   <uuid>                                  ║
║  cc_pub_:    cc_pub_<...>                            ║
║  cc_prv_:    cc_prv_<...>                            ║
╚══════════════════════════════════════════════════════╝
```

The seeded store contains:
- 12 products (configurable, simple, digital, bundle, subscription types)
- 9-variant configurable merino hoodie (size × colour)
- 2 collections: "New Arrivals" (manual) and "All Active Products" (smart)
- `WELCOME10` discount code — 10% off, no minimum
- Worldwide shipping zone — $7.99 flat rate, free over $100
- US tax zone
- Inventory levels in a default warehouse

Re-running `pnpm seed` is safe (idempotent) — it returns without creating duplicates.

---

## Start the server

```bash
pnpm dev
```

Starts Fastify on `PORT` (default `3000`) with `tsx` watch mode.

Confirm it is running:

```bash
curl http://localhost:3000/healthz
# {"status":"ok","version":"0.0.0","db":"ok"}
```

The server returns `{ "status": "degraded" }` when the database is unreachable
so readiness probes work before the DB is up.

---

## First API calls with the seeded keys

Replace `<STORE_ID>`, `<cc_pub_>`, and `<cc_prv_>` with the values printed by
`pnpm seed`.

### List products (public key)

```bash
curl -s \
  -H "Authorization: Bearer <cc_pub_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/products" \
  | jq '.products[].title'
```

### Search (natural language)

```bash
curl -s \
  -H "Authorization: Bearer <cc_pub_>" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/search?q=merino+hoodie" \
  | jq '.results[0].title'
```

### Create a cart

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_pub_>" \
  -H "Content-Type: application/json" \
  "http://localhost:3000/commerce/stores/<STORE_ID>/carts" \
  | jq '{cart_id: .id}'
```

### Add a line item (requires private key)

```bash
# Use a variant ID from the list-products response
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{"variant_id":"<variant-uuid>","quantity":1}' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/carts/<cart-id>/lines"
```

### Validate a discount code

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_pub_>" \
  -H "Content-Type: application/json" \
  -d '{"code":"WELCOME10","subtotal":"89.00"}' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/discounts/validate"
```

---

## Start the worker (optional, needed for embeddings)

The embedding indexer runs as a separate process that polls every 30 seconds for
products missing embeddings:

```bash
pnpm dev worker
```

Without this, search still works via Postgres full-text. With it (and a BYO LLM
key configured), search uses hybrid pgvector + full-text ranking. See
[byo-keys.md](./byo-keys.md) for how to configure the LLM key.

---

## Next steps

- **Agent flow** — follow [quickstart-mcp.md](./quickstart-mcp.md) to buy from
  the store with an AI agent in 10 minutes.
- **Docker compose** — `docker compose up` (see [docs/self-host.md](./self-host.md)) runs postgres + server + worker.
- **API reference** — see [api-overview.md](./api-overview.md) and the full
  endpoint table in [parity-endpoints.md](./parity-endpoints.md).
- **BYO payment provider** — see [byo-keys.md](./byo-keys.md).
- **Self-hosting** — see [cloud-vs-selfhost.md](./cloud-vs-selfhost.md).
