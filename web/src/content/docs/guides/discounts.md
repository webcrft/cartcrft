---
title: "Run a discount or promotion"
description: "Create discount codes customers enter at checkout and automatic promotions that apply without a code — plus price lists for customer groups."
---

# Run a discount or promotion

CartCrft supports two types of discounts: **codes** (customers enter a code at checkout) and **automatic** promotions (applied without a code). Both live under **Operations → Discounts**.

![CartCrft discounts page](/screenshots/dashboard-discounts.png)

*The Discounts page — tabbed between Codes and Automatic promotions, with type, value, and status at a glance.*

---

## Discount types

| Type | What it does |
|------|-------------|
| **Percentage** | Reduces the order subtotal by a percentage, e.g. 20% off. |
| **Fixed Amount** | Deducts a fixed currency amount, e.g. $10 off. |
| **Free Shipping** | Waives the shipping charge. No value field required. |
| **Buy One Get One** | Adds a free item when a qualifying item is purchased. |
| **Buy X Get Y** | Adds Y items free when X items are purchased. |

---

## 1. Create a discount code

Discount codes are customer-entered codes at checkout.

1. Go to **Operations → Discounts**.
2. Make sure the **Codes** tab is selected.
3. Click **+ New Code**.
4. Fill in the modal:

| Field | Description |
|-------|-------------|
| **Code** (required) | The code customers type, e.g. `SAVE20`. Case-insensitive at checkout. |
| **Type** | See discount types above. |
| **Value (%)** or **Value** | Percentage or fixed amount. Not shown for Free Shipping. |
| **Min Order Total** | Minimum cart subtotal before the discount applies. Leave blank for no minimum. |
| **Max Uses** | Maximum number of redemptions in total. Leave blank for unlimited. |
| **Starts At** | Date/time the code becomes active. Leave blank to activate immediately. |
| **Ends At** | Expiry date/time. Leave blank for no expiry. |
| **Limit to one use per customer** | Tick to prevent the same customer redeeming the code more than once. |

5. Click **Create Code**.

The new code appears in the **Codes** tab with an **Active** badge.

### Deactivate or reactivate a code

Click **Deactivate** on the code row to disable it without deleting it. Click **Activate** to re-enable it. Deactivated codes are rejected at checkout.

---

## 2. Create an automatic discount

Automatic discounts apply to all qualifying orders without the customer entering a code. They are common for site-wide sales.

1. Go to **Operations → Discounts**.
2. Click the **Automatic** tab.
3. Click **+ New Auto-Discount**.
4. Fill in the modal:

| Field | Description |
|-------|-------------|
| **Title** (required) | Internal name, e.g. "Summer Sale". Displayed in the dashboard and order detail. |
| **Type** | Percentage, Fixed Amount, Free Shipping, BOGO, or Buy X Get Y. |
| **Value** | Amount or percentage — not needed for Free Shipping. |
| **Min Order Total** | Optional minimum cart value. |
| **Max Uses** | Total redemption limit across all customers. |
| **Starts At / Ends At** | Optional scheduling window. |
| **Limit to one use per customer** | Restrict to one redemption per customer account. |

5. Click **Create Auto-Discount**.

> **Tip:** An automatic discount's code is auto-generated from its title (uppercased and underscored). It will not be shown to customers — it is for internal tracking only.

---

## 3. Price lists for customer groups

For wholesale, VIP, or staff pricing — or any per-segment price tier — use **Price Lists** rather than discount codes.

Go to **Catalog → Price Lists**.

Price lists hold per-variant price overrides. A customer's active price list is matched at checkout based on their customer group membership. Named tiers include `retail`, `wholesale`, `vip`, `staff`, and `custom`.

This is an API-first feature — see [Products & catalog](../commerce/products.md#price-lists) for endpoint details and [Customer Groups](./customers.md#customer-groups) for how to assign customers to groups.

---

## Validating a code via the API

Your storefront can validate a code before the customer submits the checkout form:

```bash
POST /commerce/stores/:storeId/discounts/validate
{
  "code": "SAVE20",
  "subtotal": "89.00"
}
```

The response includes the calculated `discount_amount` and whether the code is valid.

---

## Further reading

- [Discounts reference](../commerce/discounts.md) — full API endpoint surface including BOGO rules and per-product targeting.
- [Price Lists reference](../commerce/products.md#price-lists) — per-variant price overrides by customer segment.
- [Customer Groups](./customers.md#customer-groups) — how to group customers for targeted pricing.
