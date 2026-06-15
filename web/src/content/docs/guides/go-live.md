---
title: "Launch checklist"
description: "Everything to verify before going live: payment keys in live mode, shipping and tax configured, a successful test order, merchant feeds, and self-host vs cloud deployment."
---

# Launch checklist

Run through this checklist before switching your store to production traffic. Each item links to the relevant guide or reference page.

---

## Payment provider in live mode

1. Go to **Store → Payments**.
2. Confirm your provider shows **Mode: Live** (not Test / Dev).
3. If you only have a test provider, click **+ Add Provider**, select the same type, and enter your live credentials.
4. Copy the **Webhook URL** shown next to the provider and paste it into your payment provider's webhook dashboard.
5. In your payment provider dashboard, confirm the webhook is active and sending events.

**Checklist:**
- [ ] Provider Mode = **Live**
- [ ] Secret Key and Publishable Key are live credentials (not `_test_` or `_sandbox_`)
- [ ] Webhook URL registered with the payment provider
- [ ] Webhook signature secret entered in Cartcrft

> **Reminder:** Cartcrft never touches payment money. All transactions process through your own account — 0% rake.

See [Set up your store — payment provider](./getting-started.md#5-connect-your-payment-provider) and [BYO Keys](../byo-keys.md) for full details.

---

## Shipping zones and rates

1. Go to **Operations → Shipping → Zones & Rates**.
2. Confirm at least one zone exists and covers your target markets.
3. Confirm each zone has at least one rate.
4. If you are using BobGo for live rates, go to the **Providers** tab and confirm your BobGo API key is set.

**Checklist:**
- [ ] At least one shipping zone covering your target countries
- [ ] At least one shipping rate per zone
- [ ] Live carrier provider configured (if using BobGo)

See [Set up your store — shipping](./getting-started.md#6-set-up-shipping-zones-and-rates).

---

## Tax configuration

1. Go to **Operations → Tax**.
2. Confirm tax zones, rates, and any exemptions are configured for the countries/regions you sell to.
3. Verify tax is being calculated correctly on test orders (see below).

**Checklist:**
- [ ] Tax zones created for all required regions
- [ ] Rates and inclusion rules configured

See [Tax reference](../commerce/tax.md).

---

## Store settings

1. Go to **Store → Settings**.
2. Confirm **Store Name**, **Email**, **Phone**, **Country**, and **Timezone** are correct.
3. Confirm **Currency** is what you intend — it cannot be changed after creation.

**Checklist:**
- [ ] Store name and email are production values
- [ ] Country and timezone are correct
- [ ] Currency confirmed

---

## Place a test order

Before going live, place an end-to-end test order using your payment provider's test credentials (temporarily switch a provider to **Test / Dev** mode):

1. Create or identify a test product (status **Active**).
2. Use the API or your storefront to add it to a cart and complete checkout with a test card number.
3. In **Sales → Orders**, find the order — it will show a **Test Order** badge.
4. Confirm payment status is `captured` (or `authorized` if using manual capture).
5. Add a shipment to mark it fulfilled.
6. Optionally issue a refund to test the refund flow.

**Checklist:**
- [ ] Test order placed and visible in Orders
- [ ] Payment captured successfully
- [ ] Shipment created
- [ ] Refund flow tested

See [Process & fulfil an order](./fulfill-an-order.md).

---

## Customer authentication

If your storefront has customer accounts:

1. Go to **Store → Customer Auth → Auth Config**.
2. Confirm **Customer auth enabled** is on.
3. Confirm the correct sign-in methods are enabled.
4. Confirm **Redirect URL** points to your production storefront account page.
5. Add your production storefront origin to **Allowed Origins**.
6. Send a test auth email from the **Email** tab.

**Checklist:**
- [ ] Auth enabled and methods configured
- [ ] Redirect URL is production URL
- [ ] Production origin added to Allowed Origins
- [ ] Test email delivered successfully

See [Manage customers — configure auth](./customers.md#4-configure-customer-authentication).

---

## Merchant feeds (Google Shopping / Facebook catalog)

To list products on Google Shopping or Facebook:

1. Go to **Store → Integrations**.
2. Click the **Merchant Feeds** tab.
3. Merchant feed entries with `feed_type` of `google_shopping` or `facebook` will appear here if configured via the API.
4. Retrieve the feed URL via the API and submit it to Google Merchant Center or Facebook Commerce Manager.

> **Note:** Feed creation is currently API-driven. Use `POST /commerce/stores/:storeId/merchant-feeds` to create a feed and `GET` the same endpoint to retrieve the URL. The dashboard Merchant Feeds tab shows the status of existing feeds.

**Checklist:**
- [ ] Product data (titles, descriptions, prices, images) accurate and complete
- [ ] Feed URL retrieved and submitted to Google Merchant Center / Facebook Commerce Manager

---

## Tracking pixels

1. Go to **Store → Integrations → Pixels** tab.
2. Add any tracking pixels you need:
   - **Google Analytics 4** — paste your Measurement ID (`G-XXXXXXXXXX`).
   - **Facebook Pixel** — paste your Pixel ID.
   - **Google Tag Manager** — paste your GTM Container ID.
   - **TikTok Pixel** — paste your Pixel ID.
3. Pixels marked **Active** are fired by your storefront SDK on relevant events.

**Checklist:**
- [ ] GA4 / GTM configured (if used)
- [ ] Facebook Pixel configured (if used)

---

## Self-host vs cloud

| | Cloud (`app.cartcrft.io`) | Self-hosted |
|---|---|---|
| Infrastructure | Managed by Cartcrft | Your own servers / cloud provider |
| SSL, backups, updates | Automatic | Your responsibility |
| `AUTH_SECRETS_KEY` | Managed | Required in production — 64-char hex; server refuses to start without it |
| Billing | Cloud subscription | None (MIT licence) |

**Self-host production checklist:**
- [ ] `APP_ENV=production` set
- [ ] `JWT_SECRET` set to a strong random value (at least 32 bytes)
- [ ] `AUTH_SECRETS_KEY` set to a 64-char hex (run `openssl rand -hex 32`)
- [ ] `DATABASE_URL` points to a production Postgres 16+ instance with pgvector
- [ ] HTTPS/TLS configured on your reverse proxy
- [ ] Backups configured for the database

See [Self-host guide](../self-host.md) and [Cloud vs Self-host](../cloud-vs-selfhost.md).

---

## Final sign-off

- [ ] Payment provider live and webhooks verified
- [ ] Shipping zones and rates cover all target markets
- [ ] Tax configured for all required regions
- [ ] Store settings (name, email, currency, timezone) confirmed
- [ ] Successful test order placed, fulfilled, and refunded
- [ ] Customer auth configured and test email sent (if using accounts)
- [ ] Google Shopping / Facebook feeds submitted (if applicable)
- [ ] Tracking pixels active (if applicable)
- [ ] Production infrastructure hardened (self-host) or cloud account confirmed (cloud)

You are ready to go live. Remove any test providers, set your storefront to production mode, and start selling.
