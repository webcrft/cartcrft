/**
 * returns/service.ts — SQL-backed Returns/RMA service.
 *
 * Status machine:
 *   requested → approved | rejected
 *   approved  → in_transit
 *   in_transit → received
 *   received  → inspected
 *   inspected → resolved
 *   resolved  → closed
 *
 * Resolution actions (on resolved transition):
 *   refund      — creates a refund row via direct SQL (mirrors payments service semantics)
 *   store_credit — auto-issues store credit to the customer wallet via the wallet
 *                 service (issueStoreCreditInTx). Atomic + idempotent: the issue and
 *                 the idempotency marker (return_requests.store_credit_issued_at) commit
 *                 together inside one withTx, so a retried resolution never double-credits.
 *   exchange    — creates a replacement order for each exchange_variant_id × quantity at
 *                 current variant price; links back via return_requests.replacement_order_id.
 *                 Restock applied per-line when restock=true.
 *   restock     — inventory adjustment for restock=true lines (applies to all resolution types)
 *
 * RMA number: uses sequence next_rma_number() or falls back to timestamp-based generation.
 *
 * Note: store_credit resolution calls issueStoreCreditInTx from the wallet service
 * (not direct SQL) inside the same transaction that records the idempotency marker.
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import { round2 } from "../../lib/money.js";
import type {
  ReturnWithLines,
  CreateReturnInput,
  UpdateReturnInput,
  AddReturnEventInput,
  ReturnEvent,
  ReturnLabel,
} from "./types.js";
import { issueStoreCreditInTx } from "../wallet/service.js";
import {
  newShippoClient,
  type ShippoClient,
  type ShippoAddress,
} from "../../providers/shipping/shippo.js";

// ── RMA number generation ─────────────────────────────────────────────────────

async function generateRmaNumber(storeId: string): Promise<string> {
  const pool = getPool();
  try {
    const { rows } = await pool.query<{ rma: string }>(
      `SELECT next_rma_number($1::uuid) AS rma`,
      [storeId]
    );
    if (rows[0]?.rma) return rows[0].rma;
  } catch {
    // Function may not exist — fall through to timestamp generation
  }
  // Fallback: RMA-<storeId prefix>-<timestamp>
  const ts = Date.now().toString(36).toUpperCase();
  return `RMA-${ts}`;
}

// ── List returns ──────────────────────────────────────────────────────────────

export async function listReturns(
  storeId: string,
  opts: {
    status?: string | undefined;
    order_id?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
): Promise<{ returns: unknown[]; total: number }> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions: string[] = ["rr.store_id = $1::uuid"];
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.status) {
    conditions.push(`rr.status = $${argN++}`);
    args.push(opts.status);
  }
  if (opts.order_id) {
    conditions.push(`rr.order_id = $${argN++}::uuid`);
    args.push(opts.order_id);
  }

  const where = conditions.join(" AND ");
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM return_requests rr
     JOIN orders o ON o.id = rr.order_id
     WHERE ${where}`,
    args
  );
  const total = parseInt(countRows[0]?.count ?? "0", 10);

  const { rows } = await pool.query(
    `SELECT rr.id::text, rr.store_id::text, rr.order_id::text, rr.customer_id::text,
            rr.rma_number, rr.status, rr.return_type, rr.notes, rr.metadata,
            rr.return_label_url, rr.return_tracking_number, rr.return_carrier,
            rr.return_label_purchased_at,
            rr.created_at, rr.updated_at, o.order_number
     FROM return_requests rr
     JOIN orders o ON o.id = rr.order_id
     WHERE ${where}
     ORDER BY rr.created_at DESC LIMIT $${argN} OFFSET $${argN + 1}`,
    [...args, limit, offset]
  );
  return { returns: rows, total };
}

// ── Get return ────────────────────────────────────────────────────────────────

export async function getReturn(
  storeId: string,
  returnId: string
): Promise<ReturnWithLines | null> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT rr.id::text, rr.store_id::text, rr.order_id::text, rr.customer_id::text,
            rr.rma_number, rr.status, rr.return_type, rr.notes, rr.metadata,
            rr.replacement_order_id::text,
            rr.return_label_url, rr.return_tracking_number, rr.return_carrier,
            rr.return_label_purchased_at,
            rr.created_at, rr.updated_at
     FROM return_requests rr
     WHERE rr.id = $1::uuid AND rr.store_id = $2::uuid`,
    [returnId, storeId]
  );
  if (!rows[0]) return null;
  const ret = rows[0] as ReturnWithLines;

  const { rows: lineRows } = await pool.query(
    `SELECT rrl.id::text, rrl.return_id::text, rrl.order_line_id::text,
            rrl.quantity, rrl.reason, rrl.condition, rrl.action,
            rrl.exchange_variant_id::text, rrl.restock, rrl.created_at,
            ol.title, ol.sku
     FROM return_request_lines rrl
     JOIN order_lines ol ON ol.id = rrl.order_line_id
     WHERE rrl.return_id = $1::uuid`,
    [returnId]
  );
  ret.lines = lineRows as ReturnWithLines["lines"];
  return ret;
}

// ── Prepaid return shipping label (Shippo) ─────────────────────────────────────

/**
 * A coded error for return-label generation failures. The `code` discriminates
 * the failure mode so routes can map it to an appropriate HTTP status.
 */
export class ReturnLabelError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "INVALID_STATE"
      | "NO_PROVIDER"
      | "NO_WAREHOUSE"
      | "NO_RATES"
      | "PROVIDER_ERROR",
    message: string
  ) {
    super(message);
    this.name = "ReturnLabelError";
  }
}

/** States in which generating a prepaid return label is meaningful. */
const LABEL_ELIGIBLE_STATUSES = new Set(["approved", "in_transit"]);

export interface GenerateReturnLabelDeps {
  /** Injectable Shippo client factory (defaults to the real client). Tests pass a fake. */
  makeShippoClient?: ((apiKey: string) => ShippoClient) | undefined;
}

/**
 * generateReturnLabel — buy a prepaid return shipping label via Shippo.
 *
 * The parcel ships FROM the customer (order.shipping_address) TO the store's
 * default warehouse (mirrors fetchShippoRates' warehouse + credential lookup).
 *
 * - Requires the return to be in an eligible state (approved / in_transit).
 * - IDEMPOTENT: if a label already exists on the return it is returned as-is,
 *   without purchasing again (no second Shippo call).
 * - Resolves the Shippo api_key from the active shippo shipping provider's
 *   config and the warehouse address the same way the rate-quote path does.
 * - Picks the cheapest rate, purchases the label, and persists
 *   return_label_url / tracking_number / carrier / purchased_at atomically.
 * - On any Shippo / configuration failure throws a ReturnLabelError with no
 *   partial DB state written.
 */
export async function generateReturnLabel(
  storeId: string,
  returnId: string,
  deps: GenerateReturnLabelDeps = {}
): Promise<ReturnLabel> {
  const pool = getPool();

  // Load the return (write pool — we may UPDATE it) with its order address.
  const { rows: retRows } = await pool.query<{
    status: string;
    shipping_address: Record<string, unknown> | null;
    return_label_url: string | null;
    return_tracking_number: string | null;
    return_carrier: string | null;
    return_label_purchased_at: Date | null;
  }>(
    `SELECT rr.status,
            o.shipping_address,
            rr.return_label_url,
            rr.return_tracking_number,
            rr.return_carrier,
            rr.return_label_purchased_at
     FROM return_requests rr
     JOIN orders o ON o.id = rr.order_id
     WHERE rr.id = $1::uuid AND rr.store_id = $2::uuid`,
    [returnId, storeId]
  );
  const ret = retRows[0];
  if (!ret) {
    throw new ReturnLabelError("NOT_FOUND", "return not found");
  }

  // Idempotency: a label already exists — return it without re-purchasing.
  if (ret.return_label_url) {
    return {
      return_label_url: ret.return_label_url,
      return_tracking_number: ret.return_tracking_number ?? "",
      return_carrier: ret.return_carrier,
      return_label_purchased_at:
        ret.return_label_purchased_at?.toISOString() ?? new Date().toISOString(),
      already_existed: true,
    };
  }

  if (!LABEL_ELIGIBLE_STATUSES.has(ret.status)) {
    throw new ReturnLabelError(
      "INVALID_STATE",
      `return label can only be generated for an approved return (status is '${ret.status}')`
    );
  }

  // Resolve the active shippo provider + api_key (mirrors fetchShippoRates).
  const { rows: provRows } = await pool.query<{ config: Record<string, unknown> }>(
    `SELECT COALESCE(config, '{}') AS config
     FROM shipping_providers
     WHERE store_id = $1::uuid
       AND (config->>'provider' = 'shippo' OR name ILIKE '%shippo%')
       AND is_active = true
     LIMIT 1`,
    [storeId]
  );
  const prov = provRows[0];
  if (!prov) {
    throw new ReturnLabelError("NO_PROVIDER", "no active shippo shipping provider configured");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config is jsonb
  const cfg = prov.config as Record<string, any>;
  const apiKey = typeof cfg["api_key"] === "string" ? cfg["api_key"] : "";
  if (!apiKey) {
    throw new ReturnLabelError("NO_PROVIDER", "shippo provider is missing an api_key");
  }

  // TO = store's default warehouse address (same lookup fetchShippoRates uses).
  const { rows: whRows } = await pool.query<{ address: Record<string, unknown> | null }>(
    `SELECT COALESCE(address, '{}') AS address
     FROM warehouses WHERE store_id = $1::uuid AND is_default = true LIMIT 1`,
    [storeId]
  );
  const warehouseAddr = whRows[0]?.address ?? {};
  if (!whRows[0] || !warehouseAddr["country_code"]) {
    throw new ReturnLabelError("NO_WAREHOUSE", "no default warehouse address configured");
  }

  // FROM = customer's address from the order's shipping_address jsonb.
  const from = ret.shipping_address ?? {};
  const addressFrom: ShippoAddress = {
    name: String(from["name"] ?? ""),
    street1: String(from["address1"] ?? from["street_address"] ?? ""),
    city: String(from["city"] ?? ""),
    state: String(from["province_code"] ?? from["state"] ?? ""),
    zip: String(from["zip"] ?? from["postal_code"] ?? ""),
    country: String(from["country_code"] ?? "US").toUpperCase(),
    ...(from["phone"] ? { phone: String(from["phone"]) } : {}),
    ...(from["email"] ? { email: String(from["email"]) } : {}),
  };
  const addressTo: ShippoAddress = {
    name: String(warehouseAddr["name"] ?? "Returns"),
    street1: String(warehouseAddr["street_address"] ?? ""),
    city: String(warehouseAddr["city"] ?? ""),
    state: String(warehouseAddr["province_code"] ?? warehouseAddr["zone"] ?? ""),
    zip: String(warehouseAddr["postal_code"] ?? ""),
    country: String(warehouseAddr["country_code"] ?? "US").toUpperCase(),
  };

  const makeClient = deps.makeShippoClient ?? newShippoClient;
  const client = makeClient(apiKey);

  let labelUrl: string;
  let trackingNumber: string;
  let carrier: string | null;
  try {
    const rates = await client.getRates({
      address_from: addressFrom,
      address_to: addressTo,
      parcels: [
        {
          length: 20,
          width: 15,
          height: 10,
          distance_unit: "cm",
          weight: 0.5,
          mass_unit: "kg",
        },
      ],
    });
    if (rates.length === 0) {
      throw new ReturnLabelError("NO_RATES", "shippo returned no rates for the return shipment");
    }
    // Pick the cheapest rate.
    const cheapest = rates.reduce((best, r) =>
      Number(r.amount) < Number(best.amount) ? r : best
    );
    const txn = await client.purchaseLabel(cheapest.object_id);
    if (!txn.label_url) {
      throw new ReturnLabelError("PROVIDER_ERROR", "shippo transaction returned no label_url");
    }
    labelUrl = txn.label_url;
    trackingNumber = txn.tracking_number ?? "";
    carrier = cheapest.provider ?? null;
  } catch (err) {
    if (err instanceof ReturnLabelError) throw err;
    throw new ReturnLabelError(
      "PROVIDER_ERROR",
      `shippo label purchase failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Persist atomically. Guard on return_label_url IS NULL so a concurrent
  // purchase can't be overwritten (idempotency at the SQL level too).
  const purchasedAt = new Date();
  const { rows: updRows } = await pool.query<{
    return_label_url: string;
    return_tracking_number: string | null;
    return_carrier: string | null;
    return_label_purchased_at: Date;
  }>(
    `UPDATE return_requests
        SET return_label_url          = COALESCE(return_label_url, $3),
            return_tracking_number    = COALESCE(return_tracking_number, $4),
            return_carrier            = COALESCE(return_carrier, $5),
            return_label_purchased_at = COALESCE(return_label_purchased_at, $6),
            updated_at                = now()
      WHERE id = $1::uuid AND store_id = $2::uuid
      RETURNING return_label_url, return_tracking_number, return_carrier,
                return_label_purchased_at`,
    [returnId, storeId, labelUrl, trackingNumber, carrier, purchasedAt.toISOString()]
  );
  const saved = updRows[0];
  if (!saved) {
    throw new ReturnLabelError("NOT_FOUND", "return not found");
  }

  await pool.query(
    `INSERT INTO return_events (return_id, type, data)
     VALUES ($1::uuid, 'return_label_purchased',
             jsonb_build_object('carrier', $2::text, 'tracking_number', $3::text))`,
    [returnId, saved.return_carrier ?? "", saved.return_tracking_number ?? ""]
  );

  return {
    return_label_url: saved.return_label_url,
    return_tracking_number: saved.return_tracking_number ?? "",
    return_carrier: saved.return_carrier,
    return_label_purchased_at: saved.return_label_purchased_at.toISOString(),
    already_existed: false,
  };
}

// ── Create return ─────────────────────────────────────────────────────────────

export async function createReturn(
  storeId: string,
  orderId: string,
  input: CreateReturnInput,
  createdBy: string
): Promise<string> {
  const pool = getPool();

  // Verify order belongs to store
  const { rows: orderRows } = await pool.query<{ customer_id: string | null }>(
    `SELECT customer_id::text FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [orderId, storeId]
  );
  if (!orderRows[0]) {
    const e = new Error("order not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }
  const customerId = orderRows[0].customer_id;
  const returnType = input.return_type ?? "refund";
  const rmaNumber = await generateRmaNumber(storeId);

  return withTx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO return_requests (store_id, order_id, customer_id, rma_number, status, return_type, notes)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'requested', $5, $6) RETURNING id::text`,
      [storeId, orderId, customerId, rmaNumber, returnType, input.notes ?? null]
    );
    if (!rows[0]) throw new Error("createReturn: no row returned");
    const returnId = rows[0].id;

    if (input.lines && input.lines.length > 0) {
      for (const line of input.lines) {
        if (!line.order_line_id) continue;
        const qty = Math.max(1, line.quantity ?? 1);
        const action = line.action ?? "refund";
        await client.query(
          `INSERT INTO return_request_lines
             (return_id, order_line_id, quantity, reason, condition, action, exchange_variant_id, restock)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, COALESCE($8, true))`,
          [
            returnId,
            line.order_line_id,
            qty,
            line.reason ?? null,
            line.condition ?? null,
            action,
            line.exchange_variant_id ?? null,
            line.restock ?? null,
          ]
        );
      }
    }

    await client.query(
      `INSERT INTO return_events (return_id, type, data, created_by)
       VALUES ($1::uuid, 'return_requested', '{}', $2::uuid)`,
      [returnId, createdBy]
    );

    return returnId;
  });
}

// ── Update return (status machine) ───────────────────────────────────────────

export async function updateReturn(
  storeId: string,
  returnId: string,
  input: UpdateReturnInput,
  updatedBy: string
): Promise<boolean> {
  const pool = getPool();

  const { rowCount } = await pool.query(
    `UPDATE return_requests SET
       status     = COALESCE($3, status),
       notes      = COALESCE($4, notes),
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [returnId, storeId, input.status ?? null, input.notes ?? null]
  );
  if ((rowCount ?? 0) === 0) return false;

  // Log the status change event
  if (input.status) {
    await pool.query(
      `INSERT INTO return_events (return_id, type, data, created_by)
       VALUES ($1::uuid, $2, '{}', $3::uuid)`,
      [returnId, `status_changed_to_${input.status}`, updatedBy]
    );
  }

  // Resolution actions when resolving
  if (input.status === "resolved") {
    await handleResolution(pool, storeId, returnId, input, updatedBy);
  }

  return true;
}

async function handleResolution(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg Pool
  pool: any,
  storeId: string,
  returnId: string,
  input: UpdateReturnInput,
  updatedBy: string
): Promise<void> {
  // Load return info
  const { rows: retRows } = await pool.query(
    `SELECT rr.customer_id::text, rr.order_id::text, rr.return_type,
            o.currency
     FROM return_requests rr JOIN orders o ON o.id = rr.order_id
     WHERE rr.id = $1::uuid`,
    [returnId]
  );
  if (!retRows[0]) return;
  const { customer_id: customerId, order_id: orderId, return_type: returnType, currency } = retRows[0] as {
    customer_id: string | null;
    order_id: string;
    return_type: string;
    currency: string;
  };

  // Determine effective return type
  const effectiveType = (input.return_type ?? returnType) as string;

  if (effectiveType === "store_credit" && customerId && input.credit_amount && input.credit_amount > 0) {
    // Auto-issue store credit ATOMICALLY + IDEMPOTENTLY (Wave-20).
    //
    // Everything below runs inside one withTx: we (1) claim the idempotency
    // marker on the return with a conditional UPDATE guarded on
    // store_credit_issued_at IS NULL, and (2) issue the credit via the wallet
    // in-tx primitive. If the credit issue throws, the whole transaction rolls
    // back and the marker is NOT set — so a retry re-attempts. If the marker is
    // already set (a prior resolution already issued), the UPDATE matches no row
    // and we skip — no double-credit.
    const amount = round2(input.credit_amount).toFixed(2);
    await withTx(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE return_requests
            SET store_credit_issued_at = now(), updated_at = now()
          WHERE id = $1::uuid
            AND store_id = $2::uuid
            AND store_credit_issued_at IS NULL`,
        [returnId, storeId]
      );
      if ((rowCount ?? 0) === 0) {
        // Already issued (idempotent no-op) — nothing more to do.
        return;
      }

      await issueStoreCreditInTx(client, storeId, {
        customer_id: customerId,
        amount,
        currency,
        order_id: orderId,
        notes: `Store credit for RMA return ${returnId}`,
        created_by: updatedBy,
      });
    });
  }

  if (effectiveType === "refund" && input.credit_amount && input.credit_amount > 0) {
    // Create a refund record directly (no payment to capture yet for returns — best-effort)
    try {
      const { rows: payRows } = await pool.query(
        `SELECT id::text FROM payments WHERE order_id = $1::uuid AND status = 'captured' LIMIT 1`,
        [orderId]
      );
      if (payRows[0]) {
        await pool.query(
          `INSERT INTO refunds (payment_id, order_id, amount, status, reason, notes, created_by)
           VALUES ($1::uuid, $2::uuid, $3::numeric, 'pending', 'customer_request', 'RMA refund', $4::uuid)
           ON CONFLICT DO NOTHING`,
          [payRows[0].id, orderId, input.credit_amount, updatedBy]
        );
      }
    } catch (err) {
      // Best-effort
      console.error("handleResolution: refund insert failed", err);
    }
  }

  // Exchange: create a replacement order for lines with action='exchange' and exchange_variant_id set.
  // One new order is created per return (all exchange lines are collected into it).
  // Runs inside its own transaction via withTx — isolated from the caller's pool.query path.
  if (effectiveType === "exchange") {
    try {
      // Collect exchange lines
      const { rows: exchangeLines } = await pool.query(
        `SELECT rrl.id::text AS line_id,
                rrl.exchange_variant_id::text AS exchange_variant_id,
                rrl.quantity,
                rrl.order_line_id::text,
                rrl.restock
         FROM return_request_lines rrl
         WHERE rrl.return_id = $1::uuid
           AND rrl.action = 'exchange'
           AND rrl.exchange_variant_id IS NOT NULL`,
        [returnId]
      ) as { rows: Array<{ line_id: string; exchange_variant_id: string; quantity: number; order_line_id: string; restock: boolean }> };

      if (exchangeLines.length > 0) {
        const replacementOrderId = await withTx(async (client) => {
          // Resolve store currency
          const { rows: storeRows } = await client.query<{ currency: string }>(
            `SELECT currency FROM stores WHERE id = $1::uuid`,
            [storeId]
          );
          const orderCurrency = storeRows[0]?.currency ?? currency;

          // Get atomic order number
          const { rows: seqRows } = await client.query<{ next_order_number: string }>(
            `SELECT next_order_number($1::uuid)`,
            [storeId]
          );
          const orderNumber = seqRows[0]?.next_order_number;
          if (!orderNumber) throw new Error("exchange: failed to generate order number");

          // Resolve original order's customer and shipping address for the replacement order
          const { rows: origOrderRows } = await client.query<{
            customer_id: string | null;
            shipping_address: unknown;
          }>(
            `SELECT customer_id::text, shipping_address FROM orders WHERE id = $1::uuid`,
            [orderId]
          );
          const origOrder = origOrderRows[0];

          // Insert replacement order (zero totals; recomputed after lines)
          const { rows: orderRows } = await client.query<{ id: string }>(
            `INSERT INTO orders
               (store_id, customer_id, order_number, status, financial_status,
                fulfillment_status, currency, subtotal, shipping_total, tax_total,
                discount_total, total, shipping_address, billing_address,
                source_name, notes, is_test)
             VALUES
               ($1::uuid, $2, $3, 'open', 'pending',
                'unfulfilled', $4, 0, 0, 0,
                0, 0, $5::jsonb, '{}'::jsonb,
                'exchange', $6, false)
             RETURNING id::text`,
            [
              storeId,
              origOrder?.customer_id ?? null,
              orderNumber,
              orderCurrency,
              JSON.stringify(origOrder?.shipping_address ?? {}),
              `Replacement order for RMA ${returnId}`,
            ]
          );
          const newOrderId = orderRows[0]?.id;
          if (!newOrderId) throw new Error("exchange: no order id returned");

          // Insert order lines — look up current variant price
          let computedSubtotal = 0;
          for (const eLine of exchangeLines) {
            const { rows: variantRows } = await client.query<{
              price: string;
              title: string;
              sku: string | null;
            }>(
              `SELECT pv.price::text, COALESCE(p.title, 'Exchange Item') AS title, pv.sku
               FROM product_variants pv
               JOIN products p ON p.id = pv.product_id
               WHERE pv.id = $1::uuid AND p.store_id = $2::uuid`,
              [eLine.exchange_variant_id, storeId]
            );
            if (!variantRows[0]) {
              // Variant not found in this store — skip this line (best-effort)
              console.warn(
                `[exchange] exchange_variant_id ${eLine.exchange_variant_id} not found in store ${storeId} — skipped`
              );
              continue;
            }
            const price = parseFloat(variantRows[0].price);
            const qty = Math.max(eLine.quantity, 1);
            const lineTotal = price * qty;
            computedSubtotal += lineTotal;

            await client.query(
              `INSERT INTO order_lines
                 (order_id, variant_id, title, sku, quantity, price, total)
               VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
              [
                newOrderId,
                eLine.exchange_variant_id,
                variantRows[0].title,
                variantRows[0].sku ?? null,
                qty,
                price,
                lineTotal,
              ]
            );
          }

          // Update replacement order totals
          const computedTotal = Math.max(computedSubtotal, 0);
          await client.query(
            `UPDATE orders SET subtotal = $2, total = $3 WHERE id = $1::uuid`,
            [newOrderId, computedSubtotal, computedTotal]
          );

          // Record order_created event
          await client.query(
            `INSERT INTO order_events (order_id, type, data, created_by)
             VALUES ($1::uuid, 'order_created',
                     jsonb_build_object('rma_return_id', $2::text),
                     $3)`,
            [newOrderId, returnId, updatedBy]
          );

          // Link replacement order back to the return request
          await client.query(
            `UPDATE return_requests SET replacement_order_id = $2::uuid WHERE id = $1::uuid`,
            [returnId, newOrderId]
          );

          return newOrderId;
        });

        console.info(
          `[exchange] replacement order ${replacementOrderId} created for return ${returnId}`
        );
      }
    } catch (err) {
      // Best-effort: log but don't fail the status update
      console.error("handleResolution: exchange order creation failed", err);
    }
  }

  // Restock: adjust inventory for lines with restock=true (applies to all resolution types).
  // For exchange lines the returned item is restocked when restock=true; the replacement order
  // ships the new variant separately.
  try {
    const { rows: lineRows } = await pool.query(
      `SELECT rrl.order_line_id::text, rrl.quantity
       FROM return_request_lines rrl
       WHERE rrl.return_id = $1::uuid AND rrl.restock = true`,
      [returnId]
    ) as { rows: Array<{ order_line_id: string; quantity: number }> };

    for (const line of lineRows) {
      // Get variant_id from order_line
      const { rows: olRows } = await pool.query(
        `SELECT variant_id::text FROM order_lines WHERE id = $1::uuid`,
        [line.order_line_id]
      ) as { rows: Array<{ variant_id: string }> };
      if (!olRows[0]) continue;
      const variantId = olRows[0].variant_id;

      // Get default warehouse for store
      const { rows: whRows } = await pool.query(
        `SELECT id::text FROM warehouses WHERE store_id = $1::uuid AND is_default = true LIMIT 1`,
        [storeId]
      ) as { rows: Array<{ id: string }> };
      if (!whRows[0]) continue;
      const warehouseId = whRows[0].id;

      // Adjust inventory: increment quantity_on_hand for restocked items
      await pool.query(
        `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand, quantity_committed, quantity_incoming)
         VALUES ($1::uuid, $2::uuid, $3, 0, 0)
         ON CONFLICT (variant_id, warehouse_id) DO UPDATE
           SET quantity_on_hand = inventory_levels.quantity_on_hand + $3, updated_at = now()`,
        [variantId, warehouseId, line.quantity]
      );

      await pool.query(
        `INSERT INTO inventory_adjustments
           (variant_id, warehouse_id, quantity_delta, reason, reference_type, reference_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3, 'returned', 'return', $4::uuid, $5::uuid)`,
        [variantId, warehouseId, line.quantity, returnId, updatedBy]
      );
    }
  } catch (err) {
    // Best-effort restock
    console.error("handleResolution: restock failed", err);
  }
}

// ── Return events ─────────────────────────────────────────────────────────────

export async function listReturnEvents(
  storeId: string,
  returnId: string
): Promise<ReturnEvent[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<ReturnEvent>(
    `SELECT re.id::text, re.return_id::text, re.type, re.data, re.created_by::text, re.created_at
     FROM return_events re
     JOIN return_requests rr ON rr.id = re.return_id
     WHERE re.return_id = $1::uuid AND rr.store_id = $2::uuid
     ORDER BY re.created_at ASC`,
    [returnId, storeId]
  );
  return rows;
}

export async function addReturnEvent(
  storeId: string,
  returnId: string,
  input: AddReturnEventInput,
  createdBy: string
): Promise<string> {
  const pool = getPool();
  const eventType = (input.type ?? "note_added").trim() || "note_added";
  const data = input.data ? JSON.stringify(input.data) : "{}";

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO return_events (return_id, type, data, created_by)
     SELECT $1::uuid, $2, $3::jsonb, $4::uuid
     WHERE EXISTS (SELECT 1 FROM return_requests WHERE id = $1::uuid AND store_id = $5::uuid)
     RETURNING id::text`,
    [returnId, eventType, data, createdBy, storeId]
  );
  if (!rows[0]) {
    const e = new Error("return not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }
  return rows[0].id;
}
