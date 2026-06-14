---
title: "OAuth apps — Connect with Cartcrft"
description: "Register an OAuth app, walk through the authorize → consent → token flow (auth-code + PKCE, refresh, client_credentials), manage scopes, and call the /commerce API with a scoped token."
---

# OAuth apps — Connect with Cartcrft

The OAuth module lets third-party applications act on a merchant's behalf with
scoped access to the Cartcrft commerce API. It implements OAuth 2.0
(RFC 6749) with PKCE (RFC 7636) and token revocation (RFC 7009).

The module is implemented in `backend/src/modules/oauth/`. Scope definitions
live in `backend/src/lib/oauth/scopes.ts`.

---

## Register an app

Merchants register OAuth apps through their dashboard (Settings → OAuth apps) or
via the management API. An app has a fixed list of `allowed_scopes`; customers
can only grant a subset of those.

### Via API

```bash
curl -s -X POST \
  -H "Authorization: Bearer <management-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Integration",
    "description": "Syncs orders to our ERP",
    "client_type": "confidential",
    "redirect_uris": ["https://myapp.example.com/oauth/callback"],
    "allowed_scopes": ["orders:read", "catalog:read"],
    "homepage_url": "https://myapp.example.com"
  }' \
  "http://localhost:8080/account/oauth-apps"
```

Response (201):

```json
{
  "id": "<app-uuid>",
  "client_id": "<client-id>",
  "client_secret": "<secret — shown ONCE>",
  "name": "My Integration",
  "client_type": "confidential",
  "redirect_uris": ["https://myapp.example.com/oauth/callback"],
  "allowed_scopes": ["orders:read", "catalog:read"],
  "status": "active",
  "created_at": "..."
}
```

The `client_secret` is returned **once** at creation time and never again. Store
it securely. To replace it, call `POST /account/oauth-apps/:id/rotate-secret`.

### Client types

| Type | Secret | PKCE | Typical use |
|------|--------|------|-------------|
| `confidential` | Required | Optional | Server-side apps with a secure backend |
| `public` | None | Required (S256) | SPAs, mobile apps, CLIs |

---

## App management endpoints

All require a management JWT (`Authorization: Bearer <jwt>`).

```
GET    /account/oauth-apps                       — list apps in your org
POST   /account/oauth-apps                       — register a new app
GET    /account/oauth-apps/:id                   — fetch one app
PATCH  /account/oauth-apps/:id                   — update name, URIs, scopes, status
POST   /account/oauth-apps/:id/rotate-secret     — rotate the client secret
DELETE /account/oauth-apps/:id                   — delete the app
```

App `status` can be `active` or `suspended` (suspended apps are rejected at the
authorize endpoint).

---

## Authorization code flow

### Step 1 — redirect to /oauth/authorize

Redirect the merchant's browser to:

```
GET /oauth/authorize
  ?client_id=<client_id>
  &redirect_uri=https://myapp.example.com/oauth/callback
  &response_type=code
  &scope=orders:read+catalog:read
  &state=<random-csrf-nonce>
  &code_challenge=<S256-challenge>          # required for public clients
  &code_challenge_method=S256              # required for public clients
```

**If the merchant is already logged in** and has previously granted these scopes,
the server auto-approves and returns:

```json
{
  "auto_approved": true,
  "redirect": "https://myapp.example.com/oauth/callback?code=<code>&state=<state>"
}
```

Navigate the browser to `redirect`.

**If consent is required**, the server returns a consent descriptor:

```json
{
  "consent_required": true,
  "app": { "name": "My Integration", "logo_url": null, "homepage_url": "..." },
  "organization_id": "<org-uuid>",
  "account": { "email": "merchant@example.com" },
  "scopes": [
    { "scope": "orders:read", "description": "View orders and fulfillment" },
    { "scope": "catalog:read", "description": "View products, variants, and collections" }
  ],
  "request": { "client_id": "...", "redirect_uri": "...", "scope": "...", "state": "..." }
}
```

Render a consent screen using these fields, then POST back to the consent
endpoint with the merchant's decision.

**If the merchant is not logged in**, the server returns:

```json
{ "error": { "code": "login_required", ... }, "login_required": true }
```

Send the merchant through `/account/login` first, then re-initiate the flow.

### Step 2 — post consent

```bash
POST /oauth/authorize/consent
Content-Type: application/json

{
  "client_id": "<client_id>",
  "redirect_uri": "https://myapp.example.com/oauth/callback",
  "scope": "orders:read catalog:read",
  "state": "<csrf-nonce>",
  "code_challenge": "<S256-challenge>",
  "code_challenge_method": "S256",
  "approve": true
}
```

On approval, returns `{ "redirect": "...?code=<code>&state=<state>" }`.
Navigate the browser to that URL.

On denial, returns `{ "redirect": "...?error=access_denied&state=<state>" }`.

### Step 3 — exchange code for tokens

```bash
POST /oauth/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "client_id": "<client_id>",
  "client_secret": "<client_secret>",   # confidential clients only
  "code": "<auth-code>",
  "redirect_uri": "https://myapp.example.com/oauth/callback",
  "code_verifier": "<PKCE-verifier>"    # public clients only
}
```

Confidential clients may also authenticate via HTTP Basic:
`Authorization: Basic base64(client_id:client_secret)`.

Response:

```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "<opaque>",
  "scope": "orders:read catalog:read"
}
```

---

## Refresh tokens

```bash
POST /oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "client_id": "<client_id>",
  "client_secret": "<client_secret>",
  "refresh_token": "<refresh_token>"
}
```

Returns a new `access_token` and `refresh_token` pair. The old refresh token is
immediately invalidated.

---

## Client credentials (machine-to-machine)

For server-to-server integrations that do not require a merchant consent screen:

```bash
POST /oauth/token
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "<client_id>",
  "client_secret": "<client_secret>",
  "scope": "catalog:read"
}
```

Only scopes within `allowed_scopes` can be requested. Returns
`{ "access_token", "token_type", "expires_in", "scope" }` — no refresh token
for this grant type.

---

## Token revocation

```bash
POST /oauth/revoke
Content-Type: application/json

{ "token": "<refresh_token>" }
```

Always returns `{ "ok": true }` per RFC 7009 (no information disclosure).

---

## Token introspection

```bash
GET /oauth/userinfo
Authorization: Bearer <access_token>
```

Returns the granted org, app, and scopes for an OAuth access token:

```json
{
  "active": true,
  "sub": "<platform-user-uuid>",
  "organization_id": "<org-uuid>",
  "oauth_app": "<app-uuid>",
  "scope": "orders:read catalog:read",
  "scopes": ["orders:read", "catalog:read"],
  "exp": 1750003600
}
```

---

## Scopes

| Scope | Grants |
|-------|--------|
| `catalog:read` | View products, variants, and collections |
| `catalog:write` | Create and modify products, variants, and collections |
| `orders:read` | View orders and fulfillment |
| `orders:write` | Create and modify orders and fulfillment |
| `customers:read` | View customer accounts |
| `customers:write` | Create and modify customer accounts |
| `checkout:write` | Create carts and complete checkouts |
| `inventory:read` | View inventory levels |
| `inventory:write` | Adjust inventory levels |
| `discounts:read` | View discounts |
| `discounts:write` | Create and modify discounts |

`:write` implies `:read` for the same resource — a token with `catalog:write`
satisfies any route that requires `catalog:read`.

---

## Calling the /commerce API with an OAuth token

OAuth access tokens are JWTs carrying the `oauth_app` claim. They are accepted
by the same store-auth middleware that accepts `cc_pub_` / `cc_prv_` / management
JWTs — with the additional constraint that the token must carry the scope the
route requires.

```bash
curl -s \
  -H "Authorization: Bearer <access_token>" \
  "http://localhost:8080/commerce/stores/<storeId>/orders"
```

The token is org-bound: it can only access stores belonging to the merchant's
organization. An OAuth token cannot be used to grant further OAuth consent
(the `/oauth/authorize` endpoint rejects tokens that carry the `oauth_app` claim
as the session credential).

---

## Further reading

- Customer-facing auth (register, magic-link, social login): [identity.md](./identity.md)
- API auth patterns and cc_ key types: [api-overview.md](./api-overview.md)
- Commerce API surface: [commerce.md](./commerce.md)
