/**
 * event-emission.test.ts — Wave 3.2 outbound event emission.
 *
 * Verifies domain services emit outbound notification events after their DB
 * write succeeds. Rather than registering a real webhook provider + mock HTTP
 * server (which the SSRF write/fetch-time guard now blocks for loopback URLs),
 * we spy on dispatchStoreEvent — the seam between domain services and the
 * delivery engine — and assert each domain action calls it with the right event
 * name + payload. The delivery engine itself is already covered by
 * notifications-dispatch.test.ts / notifications.test.ts.
 *
 * Covers (per task scope):
 *  - order.cancelled  — cancelOrder fires order.cancelled
 *  - order.updated    — updateOrder fires order.updated (newly wired)
 *  - customer.created — createCustomer fires customer.created (newly wired)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createCtx, type TestCtx } from "../shared/ctx.js";
import { insertStore, insertProduct, insertVariant } from "../shared/helpers.js";
import * as notifications from "../../src/modules/notifications/service.js";
import { createOrder, cancelOrder, updateOrder } from "../../src/modules/orders/service.js";
import { createCustomer } from "../../src/modules/customers/service.js";

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await createCtx();
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await ctx.teardown();
}, 30_000);

/** Spy on dispatchStoreEvent for the duration of a single action. */
function spyDispatch() {
  return vi.spyOn(notifications, "dispatchStoreEvent").mockImplementation(() => {
    /* swallow — we only assert the call, never deliver */
  });
}

/** Find the most recent dispatch call for a given event type. */
function lastCallFor(
  spy: ReturnType<typeof spyDispatch>,
  eventType: string
): { storeId: string; payload: Record<string, unknown> } | null {
  for (let i = spy.mock.calls.length - 1; i >= 0; i--) {
    const call = spy.mock.calls[i]!;
    if (call[1] === eventType) {
      return { storeId: call[0] as string, payload: call[2] as Record<string, unknown> };
    }
  }
  return null;
}

async function setupStore() {
  const orgId = randomUUID();
  const store = await insertStore(ctx.pool, { orgId });
  return { orgId, store };
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe("Wave 3.2 — order.cancelled emission", () => {
  it("cancelOrder emits order.cancelled with order_id + reason", async () => {
    const { store } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "12.00" });
    const { id: orderId } = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 1, title: "Thing" }],
    });

    const spy = spyDispatch();
    try {
      const cancelled = await cancelOrder(orderId, store.id, "out of stock");
      expect(cancelled).toBe(true);

      const call = lastCallFor(spy, "order.cancelled");
      expect(call).not.toBeNull();
      expect(call!.storeId).toBe(store.id);
      expect(call!.payload["order_id"]).toBe(orderId);
      expect(call!.payload["reason"]).toBe("out of stock");
    } finally {
      spy.mockRestore();
    }
  });

  it("cancelOrder does NOT emit when the order is not cancellable", async () => {
    const { store } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "5.00" });
    const { id: orderId } = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 1, title: "Once" }],
    });
    // First cancel succeeds.
    await cancelOrder(orderId, store.id, "first");

    const spy = spyDispatch();
    try {
      // Second cancel is a no-op (already cancelled) — must not emit.
      const cancelledAgain = await cancelOrder(orderId, store.id, "second");
      expect(cancelledAgain).toBe(false);
      expect(lastCallFor(spy, "order.cancelled")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Wave 3.2 — order.updated emission", () => {
  it("updateOrder emits order.updated with order_id", async () => {
    const { store } = await setupStore();
    const product = await insertProduct(ctx.pool, { storeId: store.id });
    const variant = await insertVariant(ctx.pool, { productId: product.id, price: "8.00" });
    const { id: orderId } = await createOrder(store.id, {
      currency: "USD",
      lines: [{ variant_id: variant.id, quantity: 1, title: "Widget" }],
    });

    const spy = spyDispatch();
    try {
      const updated = await updateOrder(orderId, store.id, { notes: "priority shipping" });
      expect(updated).toBe(true);

      const call = lastCallFor(spy, "order.updated");
      expect(call).not.toBeNull();
      expect(call!.storeId).toBe(store.id);
      expect(call!.payload["order_id"]).toBe(orderId);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Wave 3.2 — customer.created emission", () => {
  it("createCustomer emits customer.created with customer_id + normalized email", async () => {
    const { store } = await setupStore();

    const spy = spyDispatch();
    try {
      const email = `Buyer.${randomUUID().slice(0, 8)}@Example.com`;
      const customerId = await createCustomer(ctx.pool, store.id, {
        email,
        first_name: "Pat",
      });
      expect(customerId).toBeTruthy();

      const call = lastCallFor(spy, "customer.created");
      expect(call).not.toBeNull();
      expect(call!.storeId).toBe(store.id);
      expect(call!.payload["customer_id"]).toBe(customerId);
      // Email is normalized to lowercase on insert and in the emitted payload.
      expect(call!.payload["email"]).toBe(email.toLowerCase());
    } finally {
      spy.mockRestore();
    }
  });
});
