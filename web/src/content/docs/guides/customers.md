---
title: "Manage customers & accounts"
description: "Browse and search customers, view order history and addresses, manage tags, block accounts, configure customer auth (social login, magic link), and set up customer groups and B2B companies."
---

# Manage customers & accounts

The **Customers** section covers every person who has placed an order or registered an account. This guide explains how to find and manage customer records, configure authentication methods, organise customers into groups, and set up B2B companies with credit limits.

---

## 1. Browse and search customers

Go to **Sales → Customers**.

![CartCrft customers page](/screenshots/dashboard-customers.png)

*The Customers list — name, email, status (Active / Blocked), and join date.*

The table shows up to 25 customers per page. Use the **search bar** to filter by name or email. Click any row to open the customer detail view.

---

## 2. Customer detail view

Clicking a customer row opens a two-column detail layout:

**Left column:**
- **Recent Orders** — last 10 orders with order number, date, payment status, and total. Click an order number to view it in the Orders section.
- **Addresses** — saved shipping and billing addresses (name, street, city/province/zip, country).

**Right column:**
- **Contact Info** — email, phone, and join date.
- **Tags** — freeform labels you can add or remove to segment customers (e.g. `vip`, `wholesale`, `newsletter`).

### Add or remove tags

1. In the **Tags** card, type a tag name and click **Add** (or press Enter).
2. Click the × next to an existing tag to remove it.

Tags can be used with the API to filter customers and assign them to price lists.

---

## 3. Block or unblock a customer

If a customer account needs to be suspended:

1. Open the customer detail view.
2. Click **Block Customer** (top-right, red button).
3. Confirm in the browser dialog.

The customer's status shows a **Blocked** badge. A blocked customer cannot sign in or complete purchases.

To re-enable: click **Unblock Customer** (which appears in place of the block button for blocked accounts).

---

## 4. Configure customer authentication

Go to **Store → Customer Auth**.

This page controls how customers register and sign in to your storefront. It has four tabs:

### Auth Config tab

**Master toggle — "Customer auth enabled"**: turn this on to allow customers to register and sign in.

**Sign-in Methods** — toggle each method independently:

| Method | Notes |
|--------|-------|
| Email + Password | Standard credential-based login |
| Magic Link | Passwordless email link |
| Google OAuth | Requires a Google Cloud app Client ID |
| Microsoft OAuth | Requires an Azure/Entra Application (client) ID |
| Discord OAuth | Requires a Discord app Client ID |

For OAuth providers, after enabling the toggle an additional card appears to enter your **Client ID** (the Client Secret is stored server-side and is write-only).

**Registration settings:**
- **Require email verification** — customers must verify their email before their account is active.
- **Allow self-registration** — uncheck to make registration invite-only.

**Token lifetimes:**
- **JWT expiry (minutes)** — how long access tokens remain valid (default 60).
- **Session duration (days)** — how long the refresh cookie persists (default 30).

**Branding:**
- **Redirect URL** — where customers land after signing in (e.g. `https://yourstore.com/account`).
- **Logo URL** — shown on the hosted auth page.
- **Brand Color** — hex colour for buttons and accents on the auth page.

**Allowed Origins** — add each origin URL that is permitted to make auth requests (e.g. `https://yourstore.com`).

Click **Save Auth Config** when done.

### Sessions tab

Lists active customer sessions with device, IP address, creation date, and expiry. Click **Revoke** on any session to force sign-out for that session.

### Email tab

Shows a log of auth-related emails (verification, password reset, magic link). Use the **Test Email** field to send a test auth email to any address and confirm your email provider is working.

### Audit Log tab

A chronological log of auth events (login, register, logout, password reset, OAuth) including the customer ID and IP address.

---

## 5. Customer groups

Customer groups let you segment customers for targeted pricing (via Price Lists) and marketing.

Go to **Sales → Customer Groups**.

### Create a group

1. Click **+ New Group** (or the create prompt if no groups exist).
2. Enter a **Name** (e.g. "Wholesale Buyers") and optional **Description**.
3. Click **Create**.

### Add members to a group

Expand a group row and use the **Add Member** field to paste a customer ID, then click **Add**. Members are listed with their email and name.

Assign a [Price List](../commerce/products.md#price-lists) to this group via the API to give members automatic pricing overrides at checkout.

---

## 6. B2B companies

For business-to-business selling — net terms, credit limits, and purchase orders — go to **Sales → B2B**.

The B2B page has three tabs:

### Companies tab

Create and manage company accounts with:
- **Company Name**
- **Credit Limit** — maximum outstanding balance before orders are blocked.
- **Net Terms** — payment days (e.g. 30 for Net 30).
- **PO Number Required** — require customers from this company to supply a purchase order number at checkout.

### Quotes tab

Send and track quotes to B2B companies. Quote statuses: Draft, Sent, Accepted, Rejected, Converted, Expired.

### Purchase Orders tab

Manage inbound purchase orders from companies, including PO numbers, status, and totals.

> **Note:** B2B company creation and full management is API-driven. The dashboard provides visibility and status tracking. See [B2B reference](../commerce/b2b.md) for endpoints.

---

## Further reading

- [Identity & auth reference](../identity.md) — token formats, OAuth flows, and the Customer UCP.
- [B2B reference](../commerce/b2b.md) — companies, quotes, and purchase orders API.
- [Price Lists](../commerce/products.md#price-lists) — per-customer-group pricing.
- [Customer Groups API](../commerce/customers.md) — group management endpoints.
