# Deploying CartCrft

Two Fly.io apps, one Fastify image (SPA + API same-origin), built from the repo
root via `backend/Dockerfile`.

| Env | Fly app | Config | Domain | APP_ENV | Deploy |
|-----|---------|--------|--------|---------|--------|
| Dev | `cartcrft-dev` | `fly.toml` | dev.cartcrft.com | development | manual `fly deploy` |
| **Prod** | `cartcrft-prod` | `fly.prod.toml` | **cartcrft.com** | production | **auto on push to `main`** (CI `deploy-prod` job) |

The production deploy is wired in `.github/workflows/ci.yml` (`deploy-prod`): on a
push to `main`, after typecheck/build + integration + cloud-billing all pass, it
runs `flyctl deploy --config fly.prod.toml`. **It is inert until you complete the
one-time setup below** (Fly app, secrets, DNS, and the `FLY_API_TOKEN` repo
secret).

---

## One-time production setup

Run these once, from the repo root, with the Fly CLI (`brew install flyctl`).
You'll need to be logged in: `fly auth login`.

### 1. Create the app
```sh
fly apps create cartcrft-prod --org <your-fly-org>
```

### 2. Provision Postgres (managed) and attach it
Use your managed Postgres (Neon/Supabase/Fly Postgres). Then set its URL as a
secret (do NOT use the dev database):
```sh
fly secrets set -a cartcrft-prod \
  DATABASE_URL="postgres://USER:PASS@HOST:5432/DBNAME?sslmode=require"
```

### 3. Set the required production secrets
The app refuses to boot in production without these (config guards):
```sh
# 32+ char random secret, NOT a dev default
fly secrets set -a cartcrft-prod JWT_SECRET="$(openssl rand -hex 32)"
# AES-256 key for encrypting provider/webhook secrets at rest (required in prod)
fly secrets set -a cartcrft-prod AUTH_SECRETS_KEY="$(openssl rand -hex 32)"
```

Recommended / optional secrets (set the ones you use):
```sh
fly secrets set -a cartcrft-prod \
  EXCHANGE_RATE_API_KEY="..." \        # multi-currency FX refresh
  EMAIL_FROM="noreply@cartcrft.com" \  # + AWS_SES_REGION / AWS_SES_ACCESS_KEY_ID / AWS_SES_SECRET_ACCESS_KEY for email
  REDIS_URL="rediss://..."             # shared rate-limit / worker locks across machines (recommended for multi-machine prod)
```
> Payment / shipping / tax / SMS provider keys are **BYO per store** (entered in
> the dashboard, stored encrypted) — they are NOT app-level secrets. See
> `web/src/content/docs/provider-api-keys.md`.

### 4. Run migrations against the prod database
The image entrypoint can migrate, or run once explicitly:
```sh
fly ssh console -a cartcrft-prod -C "node backend/dist/main.js migrate"
```

### 5. Custom domain + TLS (cartcrft.com)
```sh
fly certs add cartcrft.com -a cartcrft-prod
fly certs add www.cartcrft.com -a cartcrft-prod
fly ips list -a cartcrft-prod          # note the v4 (A) and v6 (AAAA) addresses
```
Then at your DNS registrar:
- `cartcrft.com`      → A  = <Fly v4 IP>,  AAAA = <Fly v6 IP>
- `www.cartcrft.com`  → CNAME = cartcrft-prod.fly.dev  (or A/AAAA)

Verify: `fly certs show cartcrft.com -a cartcrft-prod` (waits for DNS + issues the cert).

### 6. Enable CI auto-deploy
Create a deploy token and add it as a GitHub Actions repo secret:
```sh
fly tokens create deploy -a cartcrft-prod   # copy the output
```
GitHub → repo → Settings → Secrets and variables → Actions → New repository
secret → name `FLY_API_TOKEN`, value = the token.

### 7. Ship `main`
Production tracks `main`. Get the work there:
```sh
git checkout main && git merge --ff-only dev   # or open a PR: dev -> main
git push origin main
```
The push to `main` triggers CI; once green, `deploy-prod` deploys to
`cartcrft-prod`. (Or deploy manually anytime: `fly deploy -c fly.prod.toml`.)

---

## First-deploy checklist
- [ ] `cartcrft-prod` app created
- [ ] `DATABASE_URL` (prod DB, not dev), `JWT_SECRET`, `AUTH_SECRETS_KEY` secrets set
- [ ] migrations applied to prod DB
- [ ] `cartcrft.com` + `www` certs added and DNS records in place
- [ ] `FLY_API_TOKEN` GitHub secret added
- [ ] `main` updated and pushed → CI green → `deploy-prod` succeeds
- [ ] rotate any secrets that ever lived in a committed/shared `.env`
