# Cartcrft Security Model

> **Hardening wave H1.1** — 2026-06-13. Reviewed against all 53 confirmed findings
> from the 2026-06-13 fan-out security review.

---

## Tenant isolation

Cartcrft is a multi-tenant headless commerce backend. Each **store** belongs to one
**org** (organisation). Every API endpoint is scoped to a `storeId` route parameter;
access is denied if the authenticated principal does not own that store.

### Isolation layers (defence-in-depth)

| Layer | Mechanism | Enforced since |
|---|---|---|
| **App-layer** (primary) | Auth middleware verifies the JWT `org` claim or API-key `orgId` matches the store's `organization_id` before any route handler runs | Wave 1 (initial build) |
| **DB-layer** (defence-in-depth) | PostgreSQL RLS policies + `SET LOCAL ROLE cartcrft_app` inside every transaction | H1.1 (2026-06-13) |

Both layers must fail independently for a cross-tenant access to succeed.

---

### App-layer enforcement

`backend/src/lib/auth/middleware.ts` implements three preHandler tiers:

| Hook | Who can call | Check |
|---|---|---|
| `storeAuthRead` | `cc_pub_` or `cc_prv_` with `commerce:read`, or JWT | org owns store |
| `storeAuthWrite` | `cc_prv_` with `commerce:write`, or JWT | org owns store |
| `storeAuthAdmin` | `cc_prv_` with `commerce:admin`, or JWT | org owns store |

For JWT auth: `storeExistsInOrg(storeId, orgId)` queries `stores` and verifies
the `organization_id` matches the JWT `org` claim. A cross-org JWT gets 404 (store
not found in that org).

For API-key auth: the cached key record carries `orgId`; the middleware fetches the
store's `organization_id` and rejects (401) if they differ. Key-level `store_id`
restrictions are also enforced.

### DB-layer enforcement (RLS via cartcrft_app role)

**Problem (verified):** The application connects to PostgreSQL as `neondb_owner`
which has `rolbypassrls = TRUE`. PostgreSQL's `FORCE ROW LEVEL SECURITY` is not
honoured by roles with `rolbypassrls = TRUE` — it only overrides the table-owner
bypass. The ~120 RLS policies defined in `0006_rls.sql` and `0007_booking.sql` were
silently skipped on every connection.

**Solution (H1.1):** Migration `0014_rls_enforce.sql` creates a `cartcrft_app` role
with `NOLOGIN NOBYPASSRLS NOINHERIT` and grants it access to all commerce tables.
`pool.ts/withTx` then uses `SET LOCAL ROLE` within every database transaction:

```sql
-- Inside every withTx() call that has an authenticated HTTP request context:
SET LOCAL ROLE cartcrft_app;           -- NOBYPASSRLS → policies evaluate
SELECT set_config('app.user_id', $userId, true);
SELECT set_config('app.org_id',  $orgId,  true);
-- ... fn(client) runs here with RLS active ...
-- COMMIT → role reverts to neondb_owner automatically (LOCAL scope)
```

The `cartcrft_app` role has `rolbypassrls = FALSE`, so all 120+ policies in
`0006_rls.sql` + `0007_booking.sql` evaluate correctly within the transaction.

**Context threading:** An `AsyncLocalStorage` store (`lib/request-ctx.ts`) carries
`{ userId, orgId }` from the auth middleware through the entire async request chain
without touching the 34 `withTx` call sites or the 394 `getPool().query()` calls.
The middleware calls `setRequestCtx()` after resolving auth. `withTx` calls
`getRequestCtx()` and sets the role+GUC only when a principal is present.

**Non-request contexts** (worker jobs, migration runner, test fixtures, background
tasks) have no entry in the AsyncLocalStorage store. `withTx` skips the role-switch
for these callers and runs as `neondb_owner` (BYPASSRLS) — correct behaviour: these
are trusted infrastructure operations that must not be gated by tenant policies.

**`is_store_member()` function** (defined in `0006_rls.sql`):
- Returns `TRUE` when `current_setting('app.user_id', true)` is non-empty
  AND the target `store_id` exists and `is_active = true`
- For API-key auth (no individual `userId`), a synthetic `apikey:<orgId>` string is
  used — non-empty, signals an authenticated connection, satisfies the policy check

**Direct reads** (`getPool().query()` without `withTx`) still run as `neondb_owner`
and bypass RLS. These are primarily auth-middleware lookups (API-key validation,
store org lookups) that must not be blocked. They are protected by the app-layer
checks described above.

### RLS policy structure

Policies are defined in `backend/migrations/0006_rls.sql` (commerce tables) and
`backend/migrations/0007_booking.sql` (booking tables). Every tenant table has:

- `USING (is_store_member(store_id))` — read gate
- `WITH CHECK (is_store_member(store_id))` — write gate

Shared catalogue tables (e.g. `integration_definitions`, `exchange_rates`) allow
reads from any authenticated connection (non-empty `app.user_id`) and prohibit writes
without superuser/BYPASSRLS (no `INSERT`/`UPDATE`/`DELETE` policies).

---

## IDOR sweep (H1.1)

`backend/tests/suites/tenant-isolation.test.ts` is the durable regression guard for
cross-tenant Insecure Direct Object Reference vulnerabilities. It creates two
completely independent org/store pairs (Org A / Store A and Org B / Store B), seeds
real data in Store A, then asserts that every JWT and API-key attempt by Org B to
read or mutate Store A's resources returns 401, 403, or 404 — never 200/201.

Modules covered:

| Module | Tests |
|---|---|
| Catalog | products (list, get, update, delete, create), variants, collections |
| Orders | list, get, cancel, create |
| Inventory | warehouses (list, get, create) |
| Discounts | list, get, create |
| Customers | list, get |
| B2B | companies (list, get, create), quotes (list, get) |
| Subscriptions | plans (list, get, create) |
| Returns | list, get |
| Agents | list, get, delete |
| Bookings | resources (list, get), bookings list |
| Wallet | customer credits (read, issue) |
| Shipping | zones (list, get, create) |
| Tax | zones (list, get, create) |
| Carts | bonus: cross-store cart read |

Both JWT (`Authorization: Bearer <jwt>`) and API-key (`Authorization: Bearer cc_prv_…`)
auth paths are tested for each module group. Run with:

```bash
pnpm suite tenant-isolation
```

---

## API key scopes

| Scope | Access |
|---|---|
| `commerce:read` | GET endpoints (products, orders, customers, etc.) |
| `commerce:write` | Mutating endpoints (create, update) |
| `commerce:admin` | Administrative endpoints (provider config, settings, agents) |

Public keys (`cc_pub_`) are restricted to `commerce:read` tier endpoints. Private
keys (`cc_prv_`) are required for write and admin tiers.

Keys can be restricted to a specific store via `store_id` on creation. The middleware
enforces this restriction in addition to the org-level check.

---

## Auth secrets encryption

Store JWT secrets and OAuth client secrets are stored AES-256-GCM encrypted when
`AUTH_SECRETS_KEY` is set (mandatory in production). The `encodeSecretValue` /
`decodeSecretValue` functions in `lib/secrets.ts` handle round-trips. All secret
columns written by `createStore`, `updateAuthSettings`, and `updatePaymentProvider`
use `encodeSecretValue`. Dev mode (`AUTH_SECRETS_KEY` unset) passes secrets through
as plaintext.

**H0.3 fix (2026-06-13):** `createStore` was writing `auth_jwt_secret` as plaintext
hex while `customer-auth/service.ts` decoded it via `decodeSecretValue`. Fixed to
call `encodeSecretValue` at write time, matching the decode path.

---

## Rate limiting

All store endpoints share an IP-based rate limiter: `IP_RATE_LIMIT_PER_MINUTE`
requests per 60-second window per IP (default 120). The limiter uses `MemoryKv` in
single-process deployments and `RedisKv` when `REDIS_URL` is configured. Responses
over the limit receive `429 RATE_LIMIT_EXCEEDED`.

---

## Known posture limitations (H1 scope)

These items are tracked in `tasks.md` for subsequent hardening waves:

- **Direct reads bypass RLS** — `getPool().query()` calls (auth lookups, route
  handlers that read without a transaction) still run as `neondb_owner` (BYPASSRLS).
  Mitigated by the app-layer org checks which run before any data access.
- **CORS + security headers** — `@fastify/cors` and `@fastify/helmet` not yet
  registered (H1.2).
- **MCP key hygiene** — `?key=` query-param auth fallback not yet removed (H1.3).
- **Super-admin timing** — super token comparison is not yet `timingSafeEqual` (H1.4).
- **Refund idempotency** — `POST .../refunds` not yet idempotency-keyed (H1.5).
