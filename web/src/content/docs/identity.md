---
title: "Customer identity & accounts"
description: "Storefront customer auth: register, login, magic-link, social sign-in (Google, Microsoft, Discord), sessions, JWT access tokens, saved addresses, and customer groups."
---

# Customer identity & accounts

Cartcrft ships a full per-store customer authentication system. Each store has
its own isolated customer namespace — customers registered on Store A cannot sign
in to Store B. Auth configuration (enabled methods, OAuth credentials, JWT
expiry, branding) is managed per store through the admin tier and stored
encrypted at rest.

All auth routes are under `/commerce/stores/:storeId/auth/...`. The module is
implemented in `backend/src/modules/customer-auth/`.

---

## Auth config

A store's auth behaviour is controlled by a config object. Retrieve and update
it with admin credentials:

```
GET  /commerce/stores/:storeId/auth/config    (storeAuthAdmin)
PUT  /commerce/stores/:storeId/auth/config    (storeAuthAdmin)
```

The public info endpoint exposes only the fields needed to render a login UI
(no secrets):

```
GET  /commerce/stores/:storeId/auth/info     (no auth required)
```

Response shape:

```json
{
  "email_password_enabled": true,
  "magic_link_enabled": true,
  "google_enabled": false,
  "microsoft_enabled": false,
  "discord_enabled": false,
  "allow_self_registration": true,
  "require_email_verification": false,
  "logo_url": null,
  "brand_color": null
}
```

Key config fields (sent via `PUT /auth/config`):

| Field | Type | Description |
|-------|------|-------------|
| `auth_email_password_enabled` | boolean | Enable/disable password login |
| `auth_magic_link_enabled` | boolean | Enable email magic links |
| `auth_google_enabled` | boolean | Enable Google OAuth |
| `auth_google_client_id` | string | Your Google OAuth client ID |
| `auth_google_client_secret` | string | Your Google OAuth client secret (encrypted) |
| `auth_microsoft_enabled` | boolean | Enable Microsoft OAuth |
| `auth_ms_client_id` | string | Azure AD app client ID |
| `auth_ms_client_secret` | string | Azure AD app client secret (encrypted) |
| `auth_discord_enabled` | boolean | Enable Discord OAuth |
| `auth_discord_client_id` | string | Discord application ID |
| `auth_discord_client_secret` | string | Discord application secret (encrypted) |
| `auth_allow_self_registration` | boolean | Whether customers can register themselves |
| `auth_require_email_verification` | boolean | Block login until email is verified |
| `auth_jwt_expiry_mins` | integer | Access token lifetime in minutes |
| `auth_session_duration_days` | integer | Refresh token lifetime in days |
| `auth_max_sessions` | integer | Maximum concurrent sessions per customer |
| `auth_redirect_url` | string | Default OAuth callback base URL |
| `auth_allowed_origins` | string[] | CORS origins permitted for auth endpoints |

---

## Registration

```bash
POST /commerce/stores/:storeId/auth/register
Content-Type: application/json

{
  "email": "alice@example.com",
  "password": "correct-horse-battery",
  "first_name": "Alice",
  "last_name": "Example"
}
```

If `auth_require_email_verification` is enabled, the response is:

```json
{
  "customer_id": "<uuid>",
  "requires_verification": true,
  "message": "Check your email to verify your account."
}
```

Otherwise, registration immediately issues a session:

```json
{
  "customer_id": "<uuid>",
  "requires_verification": false,
  "session_token": "<opaque-refresh-token>",
  "access_token": "<jwt>"
}
```

### Email verification

```
POST /commerce/stores/:storeId/auth/verify-email
{ "token": "<token-from-email>" }

POST /commerce/stores/:storeId/auth/verify-email/resend
{ "email": "alice@example.com" }
```

### Invitation flow

Admins can create customers with an invite. The invited customer sets their
password via the accept endpoint:

```
POST /commerce/stores/:storeId/auth/invite/accept
{ "token": "<invite-token>", "password": "...", "first_name": "..." }
```

---

## Login — password

```bash
POST /commerce/stores/:storeId/auth/login
Content-Type: application/json

{ "email": "alice@example.com", "password": "correct-horse-battery" }
```

Response:

```json
{
  "session_token": "<opaque-refresh-token>",
  "access_token": "<jwt>"
}
```

The `access_token` is a short-lived HS256 JWT. Use it in the
`Authorization: Bearer <token>` header for customer-scoped requests.

---

## Login — magic link

Magic links do not require a password. The email contains a one-time token that
completes the login:

```bash
# Step 1: request the link
POST /commerce/stores/:storeId/auth/magic-link
{ "email": "alice@example.com" }

# Step 2: exchange the token from the email
POST /commerce/stores/:storeId/auth/magic-link/verify
{ "token": "<token-from-email>" }
```

Returns the same `{ session_token, access_token }` pair as password login.

---

## Social sign-in — Google, Microsoft, Discord

Cartcrft implements the OAuth2 authorization code flow for all three providers.
Provider credentials are set in the store's auth config (see above) and stored
encrypted with `AUTH_SECRETS_KEY`.

### Step 1: get the provider authorization URL

```bash
GET /commerce/stores/:storeId/auth/google/url?redirect_uri=https://yourapp.com/auth/google/callback
GET /commerce/stores/:storeId/auth/microsoft/url?redirect_uri=...
GET /commerce/stores/:storeId/auth/discord/url?redirect_uri=...
```

Response: `{ "url": "<provider-auth-url>", "state": "<nonce>" }`. Redirect the
browser to `url`.

### Step 2: exchange the callback code

```bash
POST /commerce/stores/:storeId/auth/google/callback
{ "code": "<code-from-provider>", "state": "<nonce>" }

POST /commerce/stores/:storeId/auth/microsoft/callback
POST /commerce/stores/:storeId/auth/discord/callback
```

The backend verifies the state nonce, exchanges the code with the provider for
an access token, fetches the user profile (email, name, avatar), then upserts
the customer record and issues a session:

```json
{
  "session_token": "<opaque-refresh-token>",
  "access_token": "<jwt>",
  "customer_id": "<uuid>"
}
```

Customers are matched by provider ID first; if no match is found, the email is
used to link to an existing password account or create a new customer.

| Provider | Scope requested | User info source |
|----------|-----------------|------------------|
| Google | `openid email profile` | `https://www.googleapis.com/oauth2/v3/userinfo` |
| Microsoft | `openid email profile` | `https://graph.microsoft.com/v1.0/me` |
| Discord | `identify email` | `https://discord.com/api/users/@me` |

---

## Token refresh & logout

```bash
# Refresh — exchange session_token for a new access_token
POST /commerce/stores/:storeId/auth/token
{ "refresh_token": "<session_token>" }

# Logout — revoke the refresh token
POST /commerce/stores/:storeId/auth/logout
{ "refresh_token": "<session_token>" }   # optional; omit to logout without token
```

---

## Password reset

```bash
# Request a reset link (always returns 200 to prevent enumeration)
POST /commerce/stores/:storeId/auth/password-reset/request
{ "email": "alice@example.com" }

# Complete with the token from the email
POST /commerce/stores/:storeId/auth/password-reset/complete
{ "token": "<reset-token>", "password": "new-password-min-8-chars" }
```

---

## Customer profile (Bearer-auth)

Endpoints that require a valid customer `access_token`:

```
GET  /commerce/stores/:storeId/auth/me              — fetch profile
PUT  /commerce/stores/:storeId/auth/me              — update name / phone
PUT  /commerce/stores/:storeId/auth/me/password     — change password
GET  /commerce/stores/:storeId/auth/sessions        — list active sessions
DELETE /commerce/stores/:storeId/auth/sessions/:sessionId — revoke a session
```

Profile update fields: `first_name`, `last_name`, `display_name`, `phone`.

Password change requires `current_password` to be correct; on success, all
other sessions are invalidated.

---

## Saved addresses

Addresses are managed through the customers admin module:

```
POST    /commerce/stores/:storeId/customers/:customerId/addresses
DELETE  /commerce/stores/:storeId/customers/:customerId/addresses/:addressId
```

---

## Customer groups

Customer groups enable segment-specific price lists, discounts, and B2B access
rules. Groups are managed through the B2B module:

```
GET/POST         /commerce/stores/:storeId/customer-groups
GET/PUT/DELETE   /commerce/stores/:storeId/customer-groups/:groupId
POST/DELETE      /commerce/stores/:storeId/customer-groups/:groupId/members/:customerId
```

---

## Admin customer management

The admin tier provides full CRUD plus tagging, blocking, audit log, and invite
dispatch:

```
GET/POST         /commerce/stores/:storeId/customers
GET/PUT/DELETE   /commerce/stores/:storeId/customers/:customerId
POST             /commerce/stores/:storeId/customers/:customerId/block
POST             /commerce/stores/:storeId/customers/:customerId/unblock
GET/PUT          /commerce/stores/:storeId/customers/:customerId/tags
GET              /commerce/stores/:storeId/customers/:customerId/audit-log
POST             /commerce/stores/:storeId/customers/:customerId/invite
```

---

## Further reading

- Commerce capabilities overview: [commerce.md](./commerce.md)
- OAuth apps for third-party integrations: [oauth-apps.md](./oauth-apps.md)
- Shareable checkout links: [checkout-links.md](./checkout-links.md)
- Payment provider setup: [byo-keys.md](./byo-keys.md)
