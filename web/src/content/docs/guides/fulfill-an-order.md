---
title: "Process & fulfil an order"
description: "Walk through the Orders list, order detail page, payment capture, shipment tracking, refunds, cancellations, and the order event timeline."
---

# Process & fulfil an order

Orders land in Cartcrft as soon as a customer completes checkout. This guide covers the full lifecycle: finding the order, reviewing payment status, marking it shipped, and handling refunds or cancellations.

---

## 1. Find the order

In the sidebar, click **Sales → Orders**.

![Cartcrft orders list](/screenshots/dashboard-orders.png)

*The Orders list — order number, date, customer email, status badges, and total.*

The table shows up to 25 orders per page with columns:

| Column | What it shows |
|--------|--------------|
| **Order** | `#` order number in violet monospace |
| **Date** | Creation date |
| **Customer** | Customer email, or "Guest" for unauthenticated checkouts |
| **Status** | Overall order status (e.g. Open, Cancelled) |
| **Payment** | Financial status (Pending, Authorized, Captured, Refunded) |
| **Fulfillment** | Fulfillment status (Unfulfilled, Partial, Fulfilled) |
| **Total** | Currency + amount |

Use **Prev / Next** to page through large order volumes.

Click any row to open the order detail view.

---

## 2. Review the order detail

![Cartcrft order detail page](/screenshots/dashboard-order-detail.png)

*Order detail — line items, totals, payment card, shipment card, notes timeline, and customer sidebar.*

The detail view is laid out in two columns:

**Left column (main content):**
- **Line Items** — product title, quantity, and line total. Below the items: Subtotal, Shipping, Tax, Discount (if any), and Total.
- **Payments** — every payment record with provider name, status badge, amount, and action buttons.
- **Shipments** — current shipments with tracking number and carrier.
- **Notes & Timeline** — chronological event log plus a free-text note field.

**Right column (sidebar):**
- **Customer** — email and customer ID.
- **Shipping Address** — name, street, city/province/zip, country, phone.
- **Order Info** — creation and update timestamps; a "Test Order" badge if the order was placed in test mode.

---

## 3. Capture payment

A payment in `authorized` status means the card has been pre-authorised but funds have not yet been captured. This is common with Stripe's PaymentIntent API.

1. In the **Payments** card, locate the payment with status **authorized**.
2. Click **Capture**.
3. The payment status changes to **captured** and the financial status on the order updates.

> **Note:** If your payment provider is configured for automatic capture (charge immediately), payments arrive as `captured` and no manual step is needed.

---

## 4. Mark as shipped

Once the order is packed and handed to a carrier:

1. In the **Shipments** card, click **+ Add Shipment**.
2. Fill in:
   - **Carrier** — e.g. `FedEx`, `DHL`, `BobGo`. Optional but recommended.
   - **Tracking Number** (required) — the carrier tracking number.
   - **Tracking URL** — a deep link to the carrier's tracking page (optional; a "Track" link is shown to the customer if provided).
3. Click **Add Shipment**.

The order's fulfillment status updates to **Partial** (if some items remain) or **Fulfilled** (when all items are shipped). Additional shipments can be added for split fulfilments.

---

## 5. Add a note

Use the **Notes & Timeline** card to leave internal notes (visible only to your team, not customers):

1. Type a note in the text field at the bottom of the card.
2. Click **Add Note**.

All order events — payment captures, status changes, and notes — appear in chronological order in the event timeline above the note input.

---

## 6. Issue a refund

To refund a captured payment:

1. In the **Payments** card, locate the payment with status **captured**.
2. Click **Refund**.
3. The refund is initiated for the full payment amount. Partial refunds are supported via the API (`POST /payments/:paymentId/refund` with an `amount` field).

The payment status updates to `refunded` and the financial status on the order reflects the change.

---

## 7. Cancel an order

To cancel an open order:

1. Click **Cancel Order** in the top-right of the order detail view.
2. Confirm the cancellation in the browser dialog.

The order status changes to **Cancelled**. Cancellation does not automatically trigger a refund — issue one separately if payment was already captured.

> **Tip:** Once cancelled, the Cancel Order button disappears. Orders cannot be uncancelled from the dashboard; use the API to reopen if needed.

---

## Order status reference

| Status | Meaning |
|--------|---------|
| **open** | Active order, not yet fulfilled or cancelled |
| **cancelled** | Manually cancelled |
| **complete** | Fully fulfilled and payment captured |

**Financial status:**

| Status | Meaning |
|--------|---------|
| pending | Payment initiated but not yet confirmed |
| authorized | Funds reserved, not yet captured |
| captured | Funds collected |
| partially_refunded | Some amount refunded |
| refunded | Fully refunded |
| voided | Authorization voided |

**Fulfillment status:**

| Status | Meaning |
|--------|---------|
| unfulfilled | No shipments created |
| partial | Some items shipped |
| fulfilled | All items shipped |

---

## Further reading

- [Orders & checkout reference](../commerce/orders-checkout.md) — full API surface for orders, carts, and checkout links.
- [Returns](../commerce/returns.md) — return requests and RMA flow.
- [Payments reference](../commerce/payments.md) — payment provider configuration and webhook events.
