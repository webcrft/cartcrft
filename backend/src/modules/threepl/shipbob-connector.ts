/**
 * threepl/shipbob-connector.ts — FulfillmentProvider backed by the ShipBob
 * client (providers/fulfillment/shipbob.ts).
 *
 * Translates the provider-agnostic FulfillmentContext (order view + credentials +
 * config) into ShipBob create-order / get-status / cancel calls, then folds the
 * response back into a SubmitResult / StatusResult the service persists onto
 * threepl_fulfillments.
 *
 * Errors are surfaced as thrown ShipBobAPIError (or generic Error) — the SERVICE
 * catches them and records last_error so the worker never crashes.
 */

import {
  newShipBobClient,
  toShipBobOrder,
  extractShipBobStatus,
  type FulfillmentOrderInput,
  type ThreePlStatus,
} from "../../providers/fulfillment/shipbob.js";
import type {
  FulfillmentProvider,
  FulfillmentContext,
  SubmitResult,
  StatusResult,
} from "./connector.js";
import type { ThreePlFulfillmentStatus } from "./types.js";

/**
 * Collapse the provider's normalized status (which has an "exception" variant)
 * onto the threepl_fulfillments DB enum (which uses "error" for failures).
 */
function toFulfillmentStatus(s: ThreePlStatus): ThreePlFulfillmentStatus {
  return s === "exception" ? "error" : s;
}

function inputFor(ctx: FulfillmentContext): FulfillmentOrderInput {
  const order = ctx.order;
  if (!order) {
    throw new Error("shipbob: submit called without an order view");
  }
  const input: FulfillmentOrderInput = {
    referenceId: order.orderId,
    orderNumber: order.orderNumber,
    recipientName: order.recipientName,
    address1: order.address1,
    city: order.city,
    state: order.state,
    country: order.country,
    zip: order.zip,
    lines: order.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
  };
  if (order.address2) input.address2 = order.address2;
  if (order.email) input.email = order.email;
  if (order.phone) input.phone = order.phone;
  if (ctx.config.shipping_method) input.shippingMethod = ctx.config.shipping_method;
  return input;
}

export class ShipBobConnector implements FulfillmentProvider {
  async submit(ctx: FulfillmentContext): Promise<SubmitResult> {
    if (!ctx.accessToken) {
      throw new Error("shipbob: access token missing (configure the integration)");
    }
    const client = newShipBobClient(ctx.accessToken);
    const res = await client.createFulfillmentOrder(toShipBobOrder(inputFor(ctx)), ctx.signal);
    const { status, trackingNumber, trackingUrl } = extractShipBobStatus(res);
    const out: SubmitResult = {
      externalId: String(res.id),
      status: toFulfillmentStatus(status),
    };
    if (trackingNumber) out.trackingNumber = trackingNumber;
    if (trackingUrl) out.trackingUrl = trackingUrl;
    return out;
  }

  async getStatus(externalId: string, ctx: FulfillmentContext): Promise<StatusResult> {
    if (!ctx.accessToken) {
      throw new Error("shipbob: access token missing (configure the integration)");
    }
    const client = newShipBobClient(ctx.accessToken);
    const res = await client.getFulfillmentStatus(externalId, ctx.signal);
    const { status, trackingNumber, trackingUrl } = extractShipBobStatus(res);
    const out: StatusResult = { status: toFulfillmentStatus(status) };
    if (trackingNumber) out.trackingNumber = trackingNumber;
    if (trackingUrl) out.trackingUrl = trackingUrl;
    return out;
  }

  async cancel(externalId: string, ctx: FulfillmentContext): Promise<void> {
    if (!ctx.accessToken) {
      throw new Error("shipbob: access token missing (configure the integration)");
    }
    const client = newShipBobClient(ctx.accessToken);
    await client.cancelFulfillmentOrder(externalId, ctx.signal);
  }
}

export function newShipBobConnector(): FulfillmentProvider {
  return new ShipBobConnector();
}
