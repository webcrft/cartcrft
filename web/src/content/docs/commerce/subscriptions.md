---
title: "Subscriptions"
description: "Subscription plans, billing cadence, lifecycle management (pause, resume, cancel, bill), and the renewal scheduler."
---

# Subscriptions

Cartcrft supports recurring billing through subscription plans and subscriber
lifecycle management. The renewal scheduler runs as part of the background worker
(`pnpm dev worker`) and automatically bills subscriptions on their renewal date.

---

## Plans

A subscription plan defines billing cadence (interval, trial) and price.

```
GET/POST         /commerce/stores/:storeId/subscription-plans
GET/PUT/DELETE   /commerce/stores/:storeId/subscription-plans/:planId
```

### Create a plan

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Monthly Coffee Box",
    "interval": "month",
    "interval_count": 1,
    "price": "24.99",
    "trial_days": 14
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/subscription-plans"
```

---

## Subscriptions

A subscription tracks a customer's active plan, billing state, and next renewal.

```
GET/POST   /commerce/stores/:storeId/subscriptions
GET        /commerce/stores/:storeId/subscriptions/:subId
POST       /commerce/stores/:storeId/subscriptions/:subId/pause
POST       /commerce/stores/:storeId/subscriptions/:subId/resume
POST       /commerce/stores/:storeId/subscriptions/:subId/cancel
POST       /commerce/stores/:storeId/subscriptions/:subId/bill
```

### Subscribe a customer

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": "<uuid>",
    "plan_id": "<uuid>"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/subscriptions"
```

### Subscription lifecycle

| Status | Description |
|--------|-------------|
| `active` | Billing normally |
| `trialing` | In free trial period |
| `paused` | Billing paused by merchant or customer |
| `cancelled` | Ended; no further charges |
| `past_due` | Renewal billing failed |

---

## Manual billing

The `POST .../bill` endpoint triggers an immediate renewal charge — useful for
dunning or test billing outside the scheduler cycle.

---

## Scheduler

The renewal scheduler lives at `backend/src/modules/subscriptions/scheduler.ts`.
It polls on every worker tick and creates orders for due subscriptions using the
same payment flow as a regular checkout.

Start the worker:

```bash
pnpm dev worker
```

---

## Further reading

- [Payments](./payments.md) — configure the payment provider subscriptions charge against
- [Products & catalog](./products.md) — `subscription` product type
