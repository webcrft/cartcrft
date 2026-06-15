---
title: "Set up your store"
description: "Create an account, create a store, tour the dashboard, connect your own payment keys, and configure shipping and tax basics."
---

# Set up your store

This guide walks you through the first-time setup of a Cartcrft store: signing in, creating a store, touring the dashboard, and wiring up payments and shipping before you take your first order.

---

## 1. Sign in to the dashboard

Navigate to your Cartcrft dashboard URL (cloud: `app.cartcrft.io`; self-hosted: wherever you deployed the admin).

The login screen has two modes:

- **Email & Password** — standard account sign-in.
- **Advanced / CI** — paste a `cc_prv_` private API key directly (useful for automation; the key is held in memory only, never written to `localStorage`).

Enter your email and password and click **Sign in**.

> **Note:** Account registration is handled by your platform admin or organisation owner. If you do not have credentials, contact whoever provisioned your Cartcrft instance.

---

## 2. Create your first store

After sign-in, if no stores exist you will see a prompt: **"No stores yet — Create your first store to get started."**

1. Click **Create Store**.
2. In the **Create New Store** modal, fill in:
   - **Store Name** (required) — e.g. "Crft Goods". A URL-safe slug is auto-suggested from the name.
   - **Slug** — auto-filled; edit if you want a specific identifier.
   - **Default Currency** — USD, EUR, GBP, ZAR, AUD, CAD, NGN, KES. Currency cannot be changed after creation.
   - **Store Email** — the reply-to address for order emails.
3. Click **Create Store**.

The new store is immediately active. You can create additional stores from the **store switcher** in the top of the sidebar at any time.

> **Tip:** If you already have stores, use the store switcher (the pill showing your store name in the left sidebar) to create new ones or jump between them.

---

## 3. Tour the dashboard

![Cartcrft admin dashboard — Overview](/screenshots/dashboard-overview.png)

*The Overview page: revenue, orders, average order value, and customers — plus recent orders at a glance.*

The sidebar is divided into five sections:

| Section | Pages |
|---------|-------|
| *(unlabelled)* | Overview |
| **Catalog** | Products, Collections, Price Lists, Digital Files |
| **Sales** | Orders, Customers, Wallet, Subscriptions, B2B, Customer Groups, Reviews, Wishlists, Abandoned Carts |
| **Operations** | Inventory, Discounts, Shipping, Tax, Returns, Fulfillment |
| **Store** | Settings, Integrations, Notifications, Webhook Log, Payments, Customer Auth, Agents, API Keys |

The **Overview** page (the home icon) shows four metric cards (Revenue, Orders, Avg Order Value, Customers) drawn live from your store's analytics, plus a recent-orders table.

---

## 4. Configure store settings

Go to **Store → Settings**.

Fill in or confirm:

- **Store Name**, **Email**, **Phone**
- **Country** — used for tax origin and default shipping rules.
- **Timezone** — affects order timestamps and scheduled discounts.
- **Currency** — shown read-only; set at store creation.

Click **Save Settings**.

![Cartcrft settings page](/screenshots/dashboard-settings.png)

*Store Settings — name, contact details, country, and timezone.*

---

## 5. Connect your payment provider

Cartcrft is **bring-your-own-keys**. Transactions go directly through your own Stripe, Paystack, Razorpay, or Xendit account. Cartcrft never touches payment money and charges 0% transaction rake.

Go to **Store → Payments**.

1. Click **+ Add Provider**.
2. In the modal, set:
   - **Display Name** — any label (e.g. "Stripe Live").
   - **Provider Type** — Stripe, Paystack, Razorpay, Xendit, or Custom Webhook.
   - **Mode** — **Live** for real transactions; **Test / Dev** for sandbox keys.
   - **Secret Key** — write-only field. For Stripe: `sk_live_...`; Paystack: `sk_live_...`; Razorpay: your Key Secret; Xendit: your API Key.
   - **Publishable Key** (Stripe / Paystack / Razorpay) — the public-facing key your storefront uses.
   - **Webhook Secret** — for signature verification on inbound webhook events.
3. Click **Save**.

After saving, a **Webhook URL** is shown next to the provider — copy it and paste it into your payment provider's webhook dashboard so Cartcrft receives payment events.

> **Note:** Secret fields are write-only. Leave them blank when editing to keep the existing value.

---

## 6. Set up shipping zones and rates

Go to **Operations → Shipping**, then the **Zones & Rates** tab.

### Create a zone

1. Click **+ Add Zone**.
2. Enter a **Zone Name** (e.g. "Domestic" or "Worldwide").
3. Enter **Countries (CSV)** — comma-separated ISO codes like `ZA, NG, KE`, or use `*` for all countries.
4. Click **Create**.

### Add rates to a zone

1. Click the zone row to expand it.
2. Click **+ Add Rate**.
3. Fill in:
   - **Name** — e.g. "Standard Shipping".
   - **Price** — flat rate amount in your store currency.
   - **Min / Max Weight (g)** — optional; leave blank for any weight.
   - **Min / Max Order Total** — optional; useful for free-shipping thresholds.
4. Click **Add Rate**.

Repeat for as many rate tiers as you need (e.g. Express, Overnight).

### Connect a live shipping provider (optional)

Switch to the **Providers** tab and click **+ Add BobGo** to connect [BobGo](https://app.bobgo.co.za) for live rates and label generation. You will need your BobGo **API Key** and **Account ID**.

---

## 7. Basic tax setup

Go to **Operations → Tax**. Tax configuration is managed through the Tax page — create tax zones, rates, and exemption rules for your regions.

> **Note:** Tax configuration is currently API-driven beyond the dashboard basics. See [Tax reference](../commerce/tax.md) for the full endpoint surface.

---

## Next steps

- [Add your first product](./add-a-product.md) — create products, variants, and collections.
- [Process & fulfil an order](./fulfill-an-order.md) — understand order lifecycle and fulfilment.
- [Run a discount or promotion](./discounts.md) — discount codes and automatic promotions.
- [Launch checklist](./go-live.md) — pre-launch verification steps.
