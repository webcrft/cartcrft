# Self-Hosting CartCrft

CartCrft runs as a single Docker image with three subcommands (`serve`, `worker`, `migrate`).
The only required infrastructure is **Postgres 16 + pgvector**.  Everything else (payments, email,
LLM embeddings, exchange rates) is BYO-keys and optional at start-up.

---

## Quickstart with Docker Compose

```bash
# 1. Clone the repo
git clone https://github.com/your-org/cartcrft.git
cd cartcrft

# 2. Copy the example env file and fill in secrets
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL, JWT_SECRET, AUTH_SECRETS_KEY

# 3. Start the full stack (db + migrate + server + worker)
docker compose up

# 4. (Optional) Load the demo store
docker compose --profile seed run --rm seed

# 5. Verify
curl http://localhost:8080/healthz
# → {"status":"ok","version":"0.0.0","db":"ok"}
```

The `db` service mounts `backend/db-init/00_extensions.sql` into
`/docker-entrypoint-initdb.d/` which runs **once on first volume creation** to
enable the `pgcrypto` and `vector` extensions.  If you use an external Postgres
instance, run this SQL manually once as a superuser:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
```

The server listens on port **8080** by default (override with `PORT`).

---

## Environment Variables

Set these in `.env` (dev) or your deployment environment (production).
Never commit values — only commit an `.env.example` with placeholder text.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Postgres connection string, e.g. `postgres://user:pass@host:5432/db` |
| `APP_ENV` | No | `development` | `development` / `test` / `production` |
| `PORT` | No | `8080` | HTTP listen port |
| `JWT_SECRET` | Yes | — | HS256 signing secret for admin JWTs — **must be ≥ 32 chars and not the dev default when `APP_ENV=production`** (boot will throw otherwise); generate with `openssl rand -hex 32` |
| `JWT_EXPIRY_HOURS` | No | `24` | Admin JWT lifetime in hours |
| `FRONTEND_URL` | No | `http://localhost:5173` | CORS allowed origin for admin SPA |
| `BASE_DOMAIN` | No | `localhost` | Root domain used for subdomain webhook routing |
| `AUTH_SECRETS_KEY` | Prod required | — | AES-256-GCM key (hex, 64 chars) for encrypting provider credentials at rest |
| `PAYSTACK_SECRET_KEY` | No | — | Paystack secret key — enables Paystack payment provider |
| `AWS_SES_REGION` | No | — | AWS region for SES transactional email |
| `AWS_SES_ACCESS_KEY_ID` | No | — | AWS access key for SES |
| `AWS_SES_SECRET_ACCESS_KEY` | No | — | AWS secret key for SES |
| `EMAIL_FROM` | No | — | From address for transactional email (e.g. `CartCrft <noreply@example.com>`) |
| `EXCHANGE_RATE_API_KEY` | No | — | exchangerate-api.com v6 key for USD→ZAR fx refreshes |
| `BILLING_SIM_ENABLED` | No | `false` | Enable compressed-time billing simulation (dev/test only) |
| `BILLING_SIM_DAY_SECONDS` | No | `86400` | Simulated billing day length in real seconds |
| `IP_RATE_LIMIT_PER_MINUTE` | No | `60` | Global IP-based rate limit (requests per minute) |
| `CARTCRFT_CLOUD` | No | — | Set to `1` to mount the cloud billing webhook plugin (requires `@cartcrft/cloud-billing`) |

---

## Stack Architecture

```
                 ┌──────────────────────────────────────────┐
                 │           docker-compose stack            │
                 │                                           │
  Browser/Agent  │   ┌─────────────────────────────────┐    │
   ──────────▶   │   │   server (Fastify, :8080)       │    │
                 │   │   node dist/main.js serve        │    │
                 │   └──────────────┬──────────────────┘    │
                 │                  │                        │
                 │   ┌─────────────────────────────────┐    │
                 │   │   worker                         │    │
                 │   │   node dist/main.js worker       │    │
                 │   └──────────────┬──────────────────┘    │
                 │                  │                        │
                 │   ┌──────────────▼──────────────────┐    │
                 │   │   db (pgvector/pgvector:pg16)    │    │
                 │   │   Postgres 16 + pgvector ext.    │    │
                 │   └─────────────────────────────────┘    │
                 └──────────────────────────────────────────┘
```

- **server** — Fastify HTTP API (REST + MCP endpoints). Stateless; scale horizontally.
- **worker** — Background job runner (embedding indexer, billing jobs). One instance recommended.
- **migrate** — One-shot job that applies pending SQL migrations then exits.  Runs before `server` and `worker` on every deploy.
- **seed** *(optional profile)* — Loads the Crft Goods demo store. Safe to run multiple times (idempotent).

---

## Upgrading / Running Migrations

Migrations are plain numbered `.sql` files in `backend/migrations/`.  The runner tracks applied files in
the `schema_migrations` table and applies only new ones, each in its own transaction.

```bash
# Run pending migrations without restarting the server
docker compose run --rm migrate

# Or against a direct DATABASE_URL
node backend/dist/main.js migrate
```

Each deploy should run `migrate` before starting the new `server` version.
The docker-compose stack does this automatically via `depends_on: migrate: condition: service_completed_successfully`.

### Rollbacks

There are no down-migrations by design (append-only schema evolution).  To roll back:
1. Restore a database snapshot.
2. Deploy the previous image version.

---

## BYO Keys — Payments, LLM, Email

CartCrft uses a BYO-keys model: you supply your own API credentials directly to the backend.
Keys are stored encrypted at rest (AES-256-GCM, `AUTH_SECRETS_KEY`).

- **Payments** — configure per-store via `POST /commerce/stores/:storeId/payment-providers`
  (Stripe, Paystack, Razorpay, Xendit, or custom webhook). No platform fee.
- **LLM / Semantic search** — configure per-store via store metadata (`llm_provider.api_key`).
  Falls back to Postgres full-text search when no key is present.
- **Email** — set `AWS_SES_*` env vars for SES; console logging used as fallback in dev.
- **Shipping** — configure BobGo or flat-rate per-store via `POST /commerce/stores/:storeId/shipping-providers`.

See `docs/quickstart-mcp.md` for an end-to-end agent demo using the demo seed store.

---

## Production Checklist

- [ ] Set `APP_ENV=production`
- [ ] Set strong `JWT_SECRET` (32+ random chars)
- [ ] Set `AUTH_SECRETS_KEY` (64-char hex, `openssl rand -hex 32`)
- [ ] Use a managed Postgres with daily backups and pgvector extension enabled
- [ ] Put the server behind a TLS-terminating reverse proxy (nginx, Caddy, etc.)
- [ ] Set `FRONTEND_URL` to your admin SPA origin for correct CORS
- [ ] Set `BASE_DOMAIN` for subdomain webhook routing
- [ ] Do NOT set `BILLING_SIM_ENABLED=true` in production
