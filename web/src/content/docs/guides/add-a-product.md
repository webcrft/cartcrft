---
title: "Add your first product"
description: "Step-by-step: create a product in the dashboard — type, pricing, variants, inventory tracking, collections, and media."
---

# Add your first product

This guide walks through creating a product in the Cartcrft dashboard from blank to ready-to-sell — covering product type, pricing, the default variant, inventory tracking, and assigning it to a collection.

---

## 1. Open the Products page

In the sidebar, click **Catalog → Products**.

![Cartcrft products list](/screenshots/dashboard-products.png)

*The Products list — search, paginate, and jump into any product to edit.*

The page shows a searchable, paginated table of all products with columns for **Product**, **Type**, **Status**, and **Price**. Use the search bar to filter by title.

---

## 2. Open the New Product form

Click **+ New Product** in the top-right corner. A modal opens.

![Cartcrft new product form](/screenshots/dashboard-product-new.png)

*The New Product modal — title, type, status, pricing, and inventory fields.*

---

## 3. Fill in product details

### Title and description

- **Title** (required) — the product name customers see, e.g. "Merino Hoodie".
- **Description** — a free-text body. Supports plain text; rich HTML can be set via the API.

### Type

Choose one of:

| Type | When to use |
|------|-------------|
| **Simple** | Single SKU, one price |
| **Configurable** | Multiple option axes (size, colour) each mapping to a variant |
| **Bundle** | Fixed set of variant SKUs sold together |
| **Digital** | Downloadable file — see [Digital Files](../commerce/digital-products.md) |
| **Service** | Bookable or appointable product |
| **Subscription** | Recurring billing |

> **Tip:** Start with **Simple** for your first product. You can change the type later.

### Status

- **Draft** — not visible to buyers, safe to edit.
- **Active** — live and purchasable.
- **Archived** — hidden from buyers; data retained.

Leave as **Draft** until the product is ready.

### Vendor and tags

- **Vendor** — brand name, e.g. "Nike". Optional.
- **Tags** — comma-separated list, e.g. `sale, new-arrivals, tops`. Tags drive smart collection rules and can be used to filter products via the API.

---

## 4. Set pricing

Scroll to the **Default Variant Pricing** section.

| Field | Description |
|-------|-------------|
| **Price** | The selling price in your store currency. |
| **Compare at Price** | Original / strikethrough price — shown as a sale indicator at checkout. |
| **SKU** | Stock-keeping unit identifier. |
| **Weight (g)** | Used for carrier-calculated shipping rates. |
| **Track inventory** | Tick to enable stock-level tracking for this variant. |

> **Note:** Pricing and inventory are stored on the *variant*, not the product. For a Simple product the dashboard creates a single "Default" variant. For Configurable products, add more variants via the API or edit them in the variants section shown when editing an existing product.

---

## 5. Save the product

Click **Create Product**. On success you will see "Product created" and the modal closes. The new product appears in the table with a **Draft** badge.

When you are ready to publish, click **Edit** on the product row, change **Status** to **Active**, and click **Save Changes**.

---

## 6. Add the product to a collection

Collections group products for storefronts, navigation, and feeds.

1. In the sidebar, click **Catalog → Collections**.
2. Click **+ New Collection**.
3. Fill in:
   - **Title** — e.g. "New Arrivals".
   - **Description** — optional.
   - **Collection Type**:
     - **Manual** — you explicitly add products one by one.
     - **Smart** — products are matched automatically by rules (e.g. `tag contains "sale"`, `price < 50`).
4. Click **Create Collection**.

For a **Manual** collection, add products via the API (`POST /collections/:collectionId/products/:productId`) or the SDK. Smart collections auto-populate when products match their rules — no extra step needed.

---

## 7. Managing multiple variants

When you edit an existing Configurable product that already has more than one variant, the **All Variants** section appears at the bottom of the edit modal listing each variant's title and price. Use the Commerce API to create or update individual variants:

```
POST   /commerce/stores/:storeId/products/:productId/variants
PUT    /commerce/stores/:storeId/products/:productId/variants/:variantId
```

See [Products & catalog reference](../commerce/products.md) for the full variant and option endpoint surface.

---

## 8. Manage inventory levels

Once a variant has **Track inventory** enabled, go to **Operations → Inventory** to:

- View current stock levels per warehouse.
- Adjust levels with a delta (e.g. `+50` for a stock receipt, `-3` for a manual write-off) and an optional reason string.
- Track lot numbers and expiry dates (**Lots** tab).
- Manage serialised items (**Serials** tab).

---

## Further reading

- [Products & catalog reference](../commerce/products.md) — full API endpoint listing.
- [Inventory](../commerce/inventory.md) — warehouses, lots, serial numbers.
- [Digital products](../commerce/digital-products.md) — attaching downloadable files.
- [Discounts](./discounts.md) — how to discount specific products or collections.
