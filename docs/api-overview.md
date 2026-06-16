# API Overview

Reference for authentication, error handling, idempotency, pagination, and
money encoding conventions. See [parity-endpoints.md](./parity-endpoints.md)
for the full endpoint table and [openapi.json](./openapi.json) for the machine-
readable spec.

---

## Base URL

```
http(s)://<host>/
```

All commerce endpoints are under `/commerce/stores/:storeId/...`. Agent
endpoints are under `/mcp/:storeId` (MCP) and `/acp/:storeId/...` (ACP). The
inbound webhook router is at `/webhooks/:storeId/...`.

---

## Authentication

CartCrft has two independent auth systems that cover different callers.

### Management JWTs (dashboard / server-side)

HS256 tokens signed with `JWT_SECRET`. Used by the admin dashboard and
server-side integrations that need full org-level access.

**Claim shape:**

```json
{
  "sub":   "<userId UUID>",
  "org":   "<orgId UUID>",
  "email": "<user email>  (optional)",
  "jti":   "<random UUID>",
  "iat":   1749999999,
  "exp":   1750003599
}
```

The `org` claim is embedded in the token. Every store endpoint verifies that
`org` matches `stores.organization_id` — no org-members join required.

**Header:**

```
Authorization: Bearer <jwt>
```

### Platform API keys (cc_ keys)

Opaque keys issued per store, stored as SHA-256 hashes. Returned in full **once
on creation** and never again.

| Prefix | Scopes | Typical use |
|--------|--------|-------------|
| `cc_pub_` | `commerce:read` | Storefront, MCP browser/search, browser-safe |
| `cc_prv_` | `commerce:read commerce:write` (optionally `commerce:admin`) | Server-side, checkout, admin |

`cc_prv_` with `commerce:admin` scope is required for destructive operations
(delete product, revoke key, configure providers).

**Header:**

```
Authorization: Bearer cc_pub_<key>
Authorization: Bearer cc_prv_<key>
```

**Scope enforcement** — the middleware enforces:
- `storeAuthRead` — accepts `cc_pub_`, `cc_prv_`, or JWT
- `storeAuthWrite` — accepts `cc_prv_` (any scope) or JWT
- `storeAuthAdmin` — accepts `cc_prv_` with `commerce:admin` scope, or JWT

**Create a key via API:**

```bash
curl -s -X POST \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Storefront Key","key_type":"public"}' \
  "http://localhost:3000/api-keys"
```

---

## Error envelope

All errors — validation, auth, not-found, server — use a single envelope:

```json
{
  "error": {
    "code":    "NOT_FOUND",
    "message": "product not found",
    "details": {}
  }
}
```

`code` is a stable machine-readable string. `message` is human-readable and may
change between versions. `details` is optional structured data (e.g. zod
validation issues).

### Error code reference

The following codes are defined in the backend source
(`backend/src/**/*.ts`):

| Code | HTTP | Source / meaning |
|------|------|-----------------|
| `UNAUTHORIZED` | 401 | Missing, invalid, or expired credentials |
| `FORBIDDEN` | 403 | Valid credentials, insufficient scope or cross-org access |
| `NOT_FOUND` | 404 | Resource does not exist or is not visible to the caller |
| `VALIDATION_ERROR` | 400 | Request body / query string fails zod schema |
| `BAD_REQUEST` | 400 | Semantically invalid request (not a schema error) |
| `CONFLICT` | 409 | Generic write conflict |
| `DUPLICATE_SLUG` | 409 | Store slug already taken |
| `DUPLICATE_CODE` | 409 | Discount code already exists in this store |
| `CURRENCY_LOCKED` | 409 | Store currency cannot change after orders exist |
| `INVALID_SCOPES` | 400 | Unknown scope string in key create request |
| `INVALID_KEY_TYPE` | 400 | `key_type` not `"public"` or `"private"` |
| `INVALID_AMOUNT` | 400 | Payment or credit amount is not a valid positive decimal |
| `INVALID_EXPIRES_AT` | 400 | Expiry timestamp is in the past or invalid |
| `RATE_LIMIT_EXCEEDED` | 429 | IP rate limit hit (`IP_RATE_LIMIT_PER_MINUTE`, default 60) |
| `INSUFFICIENT_INVENTORY` | 422 | Not enough stock to fulfil the order |
| `INSUFFICIENT_CREDIT` | 422 | Store credit balance too low |
| `WALLET_NOT_FOUND` | 404 | Store credit wallet does not exist |
| `DISCOUNT_EXHAUSTED` | 422 | Discount code has reached its usage cap |
| `DISCOUNT_ALREADY_USED` | 422 | Once-per-customer code already redeemed by this customer |
| `DOWNLOAD_LIMIT_EXCEEDED` | 422 | Digital file download token has hit its limit |
| `LINK_EXPIRED` | 410 | Download or auth link has expired |
| `PROVIDER_NOT_CONFIGURED` | 501 | No payment provider configured for this store |
| `AGENT_INACTIVE` | 403 | Requested agent is paused or disabled |
| `MANDATE_CHAIN_INVALID` | 422 | Mandate chain integrity check failed |
| `SIGNATURE_INVALID` | 401 | ed25519 or HMAC signature verification failed |
| `TOOL_ERROR` | 500 | MCP tool execution error (see `message` for detail) |
| `INTERNAL_ERROR` | 500 | Unhandled server error |

---

## Idempotency keys

Provide an `Idempotency-Key` header on mutating requests to make them safe to
retry:

```
Idempotency-Key: <uuid-v4>
```

The first response for a given key is stored and replayed for subsequent
requests with the same key (within the TTL window). Supported on:

- `POST /commerce/stores/:storeId/checkouts` (create checkout)
- `POST /commerce/stores/:storeId/checkouts/:checkoutId/complete`
- `POST /acp/:storeId/checkout_sessions` (ACP session create)
- `POST /acp/:storeId/checkout_sessions/:id/complete`

The checkout complete endpoint additionally uses a DB-level `UNIQUE` constraint
on `(checkout_id, order_id)` as a hard idempotency backstop — a second
concurrent complete call blocks on the row lock and then returns the existing
order rather than creating a duplicate.

---

## Pagination

Most list endpoints accept `limit` and `offset` query parameters.

```
GET /commerce/stores/:storeId/products?limit=50&offset=100
```

| Parameter | Default | Max |
|-----------|---------|-----|
| `limit` | 50 | 200 |
| `offset` | 0 | — |

List responses include a `total` count:

```json
{
  "products": [...],
  "total": 247,
  "limit": 50,
  "offset": 100
}
```

The ACP product feed uses cursor-based pagination instead:

```
GET /acp/:storeId/feed?limit=100&cursor=<opaque>
```

Response includes `{ items, total, cursor, has_more }`. The cursor is an opaque
base64url-encoded offset — pass it as `cursor` in the next request.

---

## Money encoding

Amounts are **always strings** in API payloads. Never floats.

```json
{ "price": "89.00", "total": "88.09" }
```

- DB column: `numeric(15,2)` — exact decimal arithmetic.
- API serialisation: `price::text` in SELECT → string in JSON.
- Minimum precision: two decimal places (e.g. `"10.00"` not `"10"`).
- Provider clients (Stripe, Paystack) receive integer cents internally — the
  conversion (`round(amount * 100)`) is inside each provider client, not exposed
  in the API.
- Weights and dimensions use integer grams (`weight_g`) and millimetres (`dim_*`).
- Currency codes are `char(3)` ISO-4217 (e.g. `"USD"`, `"ZAR"`).

---

## API versioning

The API is date-versioned at the OpenAPI spec level (`2026-06-12`). Routes
themselves do not carry a version prefix — the `/commerce/` prefix is a
namespace, not a version. Breaking changes will get a new date-stamped spec and
migration guide.

ACP endpoints carry an explicit version in the path:
`/acp/v2026-04/:storeId/...` and an `ACP-Version: 2026-04` response header.

---

## Further reading

- Full endpoint table: [parity-endpoints.md](./parity-endpoints.md)
- Machine-readable spec: [openapi.json](./openapi.json)
- Agent / MCP auth: [agent-native.md](./agent-native.md)
- Payment provider setup: [byo-keys.md](./byo-keys.md)
