# Commerce Overview

The commerce engine underneath CartCrft's agent surface. Every capability here is
exposed over the same date-versioned REST API the admin dashboard and AI agents
use — there is no hidden internal API.

For the exhaustive, auth-tiered endpoint list see
[parity-endpoints.md](./parity-endpoints.md); for request/response conventions
(auth, error envelope, idempotency, money encoding) see
[api-overview.md](./api-overview.md); the machine-readable contract is
[openapi.json](./openapi.json).

---

## Catalog

Products in six shapes — **simple, bundle, configurable, digital, service,
subscription, rental** — with options, variants, media, and metafields. Organise
with collections (manual or smart/rule-based), tags, and SEO fields. Everything is
translatable (i18n) and supports CSV import/export.

## Inventory

Multi-warehouse stock with per-location levels, **FEFO lot tracking**, serial
numbers, reorder points, and suppliers. Inventory is decremented atomically at
checkout completion, never on cart add.

## Carts & checkout

Carts capture **price snapshots** so a price change mid-session can't surprise a
buyer. Checkout completion (`CompleteByID`) is a single transaction that
re-validates prices, decrements inventory, and burns discount usage together — it
either all succeeds or all rolls back. Abandoned-cart recovery and wishlists are
built in.

See also: [checkout-links.md](./checkout-links.md) for shareable hosted checkout,
and [quickstart-mcp.md](./quickstart-mcp.md) for an agent completing a purchase.

## Orders

Orders track financial status and fulfillment status independently. Transitions
emit signed outbound webhooks (order/payment/shipment) and, where configured, GA4
server-side purchase events.

## Payments

**Stripe, Paystack, Razorpay, Xendit** — bring your own keys, encrypted at rest with
AES-256-GCM. Inbound webhooks are signature-verified with replay protection and
routed per provider. Refunds call the provider's live refund API and reconcile the
local record. Configuration details: [byo-keys.md](./byo-keys.md).

## Discounts

Code-based discounts (%, fixed, free-shipping, BOGO, buy-X-get-Y) and automatic
discounts, with usage limits and **once-per-customer atomicity** enforced at burn
time.

## Tax & shipping

- **Tax** — categories, zones, and inclusive/exclusive rate tables.
- **Shipping** — zones and rates, live rates (BobGo), collection points
  (PUDO / click-and-collect), shipments, tracking events, and fulfillment orders.

## B2B

Companies with credit limits and net terms, a quotes/RFQ lifecycle, purchase
orders, and customer-group pricing.

## Subscriptions

Plans with intervals and trials; full lifecycle (pause / resume / cancel / bill) and
an automatic renewal scheduler.

## Returns & exchanges

RMA flows resolving to refund, exchange, store credit, or repair, with optional
restock back into inventory.

## Wallet

Gift-card issuance and redemption plus a per-customer store-credit ledger.

## Digital products

Time-limited, download-count-limited token delivery for digital goods.

## Bookings & rentals

Resources with availability calendars, price rules, iCal export, and OTA channel
linkage for time- and date-based inventory.

---

## Agent-native surface

Every store is also browsable and purchasable by AI agents out of the box — MCP
server, semantic search, signed mandates, and the ACP / UCP protocol adapters. That
layer is documented separately:

- [agent-native.md](./agent-native.md) — MCP, semantic search, mandates, spend limits
- [acp.md](./acp.md) — Agentic Commerce Protocol adapter
- [ucp.md](./ucp.md) — Universal Commerce Protocol adapter

---

## See also

- [api-overview.md](./api-overview.md) — auth, errors, idempotency, money encoding
- [parity-endpoints.md](./parity-endpoints.md) — full endpoint table with auth tiers
- [self-host.md](./self-host.md) — run the whole stack yourself
