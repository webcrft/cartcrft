---
title: "Bookings & rentals"
description: "Booking resources, availability calendars, price rules, iCal export, OTA channel linkage, and the booking lifecycle."
---

# Bookings & rentals

The bookings module handles time-based commerce: service slots, equipment rentals,
rooms, and any resource that needs an availability calendar. Resources expose iCal
feeds and can be linked to OTA (online travel agency) channels.

---

## Booking policies

Policies define cancellation windows, modification rules, and penalties.

```
GET/POST/PUT/DELETE  /commerce/stores/:storeId/booking-policies
```

---

## Resources

A booking resource is anything that can be reserved: a room, a piece of equipment,
a service slot.

```
GET/POST/PUT/DELETE  /commerce/stores/:storeId/booking-resources
GET/POST             /booking-resources/:resourceId/availability
GET/POST/PUT/DELETE  /booking-resources/:resourceId/price-rules
GET/POST/PUT/DELETE  /booking-resources/:resourceId/ical-feeds
GET                  /storefront/:storeId/booking-resources/:resourceId/ical.ics
```

### Create a resource

```bash
curl -s -X POST \
  -H "Authorization: Bearer <cc_prv_>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mountain Bike — Large",
    "resource_type": "rental",
    "max_concurrent": 1,
    "booking_policy_id": "<uuid>"
  }' \
  "http://localhost:3000/commerce/stores/<STORE_ID>/booking-resources"
```

---

## Bookings

```
GET/POST   /commerce/stores/:storeId/bookings
GET        /commerce/stores/:storeId/bookings/:bookingId
POST       /commerce/stores/:storeId/bookings/:bookingId/confirm
POST       /commerce/stores/:storeId/bookings/:bookingId/check-in
POST       /commerce/stores/:storeId/bookings/:bookingId/check-out
POST       /commerce/stores/:storeId/bookings/:bookingId/cancel
GET/POST   /commerce/stores/:storeId/bookings/:bookingId/messages
GET/POST   /commerce/stores/:storeId/bookings/:bookingId/damage-claims
```

### Booking lifecycle

```
pending → confirmed → checked_in → checked_out → cancelled
```

---

## iCal feeds

The public iCal endpoint at `/storefront/:storeId/booking-resources/:resourceId/ical.ics`
exports availability in standard iCalendar format — import into Google Calendar,
Airbnb, or any calendar app.

---

## Further reading

- [Products & catalog](./products.md) — `service` and `rental` product types
- [Payments](./payments.md) — charging deposits and balances
