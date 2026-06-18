/**
 * orders/service.ts — SQL-backed orders service.
 *
 * All business logic lives here; routes.ts is a thin Fastify plugin.
 * Uses pg.PoolClient for transactions, getPool for single queries.
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import { dispatchStoreEvent } from "../notifications/service.js";
import { calcTaxAuto, extractAddressCodes } from "../../lib/tax.js";
import { round2 } from "../../lib/money.js";
import type pg from "pg";
import type {
  Order,
  OrderLine,
  OrderEvent,
  CreateOrderInput,
  CreateOrderResult,
  UpdateOrderInput,
} from "./types.js";

// ── Domain errors ───────────────────────────────────────────────────────────────
// Service functions throw plain Error with a `.code` so routes can map to HTTP
// status codes (matching the existing VALIDATION_ERROR / NOT_FOUND convention).

function svcError(message: string, code: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

// ── Column helpers ─────────────────────────────────────────────────────────────

const ORDER_COLS = `
  id::text, store_id::text, customer_id::text, company_id::text, checkout_id::text,
  order_number, status, financial_status, fulfillment_status,
  currency, subtotal::text, shipping_total::text, tax_total::text,
  discount_total::text, total::text, total_refunded::text,
  shipping_address, billing_address,
  po_number, payment_terms_days, due_date,
  source_name, notes, tags,
  cancelled_at, cancel_reason, is_test,
  created_at, updated_at
`;

// ── List orders ────────────────────────────────────────────────────────────────

export interface ListOrdersOpts {
  status?: string | undefined;
  financial_status?: string | undefined;
  fulfillment_status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listOrders(
  storeId: string,
  opts: ListOrdersOpts = {}
): Promise<{ orders: Order[]; total: number }> {
  // RLS-enforced read path (P4/item-2): role-switched + GUC-scoped in a request
  // context, owner-role no-op otherwise.
  const pool = getReadDb();

  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  // Build dynamic WHERE clause
  const whereConditions = ["store_id = $1::uuid"];
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.status) {
    whereConditions.push(`status = $${argN++}`);
    args.push(opts.status);
  }
  if (opts.financial_status) {
    whereConditions.push(`financial_status = $${argN++}`);
    args.push(opts.financial_status);
  }
  if (opts.fulfillment_status) {
    whereConditions.push(`fulfillment_status = $${argN++}`);
    args.push(opts.fulfillment_status);
  }

  const where = whereConditions.join(" AND ");

  const [ordersResult, countResult] = await Promise.all([
    pool.query<Order>(
      `SELECT ${ORDER_COLS}
       FROM orders
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${argN} OFFSET $${argN + 1}`,
      [...args, limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM orders WHERE ${where}`,
      args
    ),
  ]);

  return {
    orders: ordersResult.rows,
    total: parseInt(countResult.rows[0]?.count ?? "0", 10),
  };
}

// ── Get order ──────────────────────────────────────────────────────────────────

export interface OrderDetail extends Order {
  lines: OrderLine[];
  payments: Record<string, unknown>[];
  shipments: Record<string, unknown>[];
  events: OrderEvent[];
}

export async function getOrder(
  orderId: string,
  storeId: string
): Promise<OrderDetail | null> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();

  const { rows } = await pool.query<{ row_to_json: string }>(
    `SELECT row_to_json(q) FROM (
      SELECT
        o.id::text, o.store_id::text, o.customer_id::text, o.company_id::text, o.checkout_id::text,
        o.order_number, o.status, o.financial_status, o.fulfillment_status,
        o.currency, o.subtotal::text, o.shipping_total::text, o.tax_total::text,
        o.discount_total::text, o.total::text, o.total_refunded::text,
        o.shipping_address, o.billing_address,
        o.po_number, o.payment_terms_days, o.due_date,
        o.source_name, o.notes, o.tags, o.tax_lines, o.shipping_lines, o.discount_lines,
        o.metadata, o.cancelled_at, o.cancel_reason, o.is_test,
        o.created_at, o.updated_at,
        COALESCE((
          SELECT json_agg(l ORDER BY l.created_at)
          FROM (
            SELECT id::text, order_id::text, variant_id::text, title, sku, quantity,
                   quantity_fulfilled, quantity_returned, price::text, total::text,
                   discount_total::text, tax_total::text, fulfillment_status,
                   requires_shipping, is_digital, is_gift_card, metadata, created_at
            FROM order_lines WHERE order_id = o.id
          ) l
        ), '[]') AS lines,
        COALESCE((
          SELECT json_agg(p ORDER BY p.created_at)
          FROM (
            SELECT id::text, order_id::text, provider_id::text, amount::text, currency,
                   status, provider_reference, captured_at, is_test, mode, created_at, updated_at
            FROM payments WHERE order_id = o.id
          ) p
        ), '[]') AS payments,
        COALESCE((
          SELECT json_agg(s ORDER BY s.created_at)
          FROM (
            SELECT id::text, order_id::text, status, tracking_number, tracking_url,
                   carrier, service_level, label_url, shipped_at, estimated_delivery,
                   delivered_at, created_at, updated_at
            FROM shipments WHERE order_id = o.id
          ) s
        ), '[]') AS shipments,
        COALESCE((
          SELECT json_agg(e ORDER BY e.created_at DESC)
          FROM (
            SELECT id::text, order_id::text, type, data, created_by::text, created_at
            FROM order_events WHERE order_id = o.id
            ORDER BY created_at DESC LIMIT 50
          ) e
        ), '[]') AS events
      FROM orders o
      WHERE o.id = $1::uuid AND o.store_id = $2::uuid
    ) q`,
    [orderId, storeId]
  );

  if (!rows[0]) return null;

  // row_to_json returns the JSON as a string from pg
  const raw = rows[0]["row_to_json"];
  if (!raw) return null;

  return (typeof raw === "string" ? JSON.parse(raw) : raw) as OrderDetail;
}

// ── Create order ───────────────────────────────────────────────────────────────

export async function createOrder(
  storeId: string,
  input: CreateOrderInput,
  userId?: string | undefined
): Promise<CreateOrderResult> {
  return withTx(async (client) => {
    // Resolve currency from store if not provided
    let currency = input.currency?.trim() ?? "";
    if (!currency) {
      const { rows } = await client.query<{ currency: string }>(
        `SELECT currency FROM stores WHERE id = $1::uuid`,
        [storeId]
      );
      currency = rows[0]?.currency ?? "USD";
    }

    // Validate customer_id belongs to this store
    if (input.customer_id) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM customers WHERE id = $1::uuid AND store_id = $2::uuid
         ) AS exists`,
        [input.customer_id, storeId]
      );
      if (!rows[0]?.exists) {
        const e = new Error("customer_id does not belong to this store");
        (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
        throw e;
      }
    }

    // Require lines
    if (!input.lines || input.lines.length === 0) {
      const e = new Error("lines is required and must be a non-empty array");
      (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
      throw e;
    }

    const orderMode = input.mode === "dev" ? "dev" : "live";
    const isTest = orderMode === "dev";

    // Get atomic order number
    const { rows: seqRows } = await client.query<{ next_order_number: string }>(
      `SELECT next_order_number($1::uuid)`,
      [storeId]
    );
    const orderNumber = seqRows[0]?.next_order_number;
    if (!orderNumber) {
      throw new Error("failed to generate order number");
    }

    const shippingTotal = parseFloat(input.shipping_total ?? "0") || 0;
    const taxTotal = parseFloat(input.tax_total ?? "0") || 0;
    const discountTotal = parseFloat(input.discount_total ?? "0") || 0;

    if (shippingTotal > 0 || taxTotal > 0 || discountTotal > 0) {
      console.warn(
        "[CreateOrder] accepting client-supplied shipping/tax/discount totals",
        { storeId, shipping: shippingTotal, tax: taxTotal, discount: discountTotal }
      );
    }

    // Insert order with zero totals (recomputed after lines)
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, order_number, status, financial_status, fulfillment_status,
          currency, subtotal, shipping_total, tax_total, discount_total, total,
          shipping_address, billing_address, po_number, payment_terms_days, source_name,
          notes, is_test)
       VALUES
         ($1::uuid, $2, $3, 'open', 'pending', 'unfulfilled',
          $4, 0, $5, $6, $7, 0,
          $8, $9, $10, $11, $12, $13, $14)
       RETURNING id::text`,
      [
        storeId,
        input.customer_id ?? null,
        orderNumber,
        currency,
        shippingTotal,
        taxTotal,
        discountTotal,
        JSON.stringify(input.shipping_address ?? {}),
        JSON.stringify(input.billing_address ?? {}),
        input.po_number ?? null,
        input.payment_terms_days ?? 0,
        input.source_name ?? null,
        input.notes ?? null,
        isTest,
      ]
    );

    const orderId = orderRows[0]?.id;
    if (!orderId) throw new Error("createOrder: no id returned");

    // Insert lines — server-side price lookup
    let computedSubtotal = 0;

    for (const line of input.lines) {
      const title = line.title?.trim() || "Item";
      const qty = Math.max(line.quantity ?? 1, 1);
      let price = 0;

      if (line.variant_id) {
        const { rows: priceRows } = await client.query<{ price: string }>(
          `SELECT pv.price::text
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE pv.id = $1::uuid AND p.store_id = $2::uuid`,
          [line.variant_id, storeId]
        );
        if (!priceRows[0]) {
          const e = new Error(`invalid variant_id: ${line.variant_id}`);
          (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
          throw e;
        }
        price = parseFloat(priceRows[0].price);
      }

      const lineTotal = price * qty;
      computedSubtotal += lineTotal;

      await client.query(
        `INSERT INTO order_lines
           (order_id, variant_id, title, sku, quantity, price, total)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
        [
          orderId,
          line.variant_id ?? null,
          title,
          line.sku ?? null,
          qty,
          price,
          lineTotal,
        ]
      );
    }

    // Recompute total
    let computedTotal = computedSubtotal + shippingTotal + taxTotal - discountTotal;
    if (computedTotal < 0) computedTotal = 0;

    // Reject zero-total unless all lines are gift cards
    if (computedTotal <= 0) {
      const { rows: giftRows } = await client.query<{ all_gift: boolean }>(
        `SELECT bool_and(is_gift_card) AS all_gift FROM order_lines WHERE order_id = $1::uuid`,
        [orderId]
      );
      if (!giftRows[0]?.all_gift) {
        const e = new Error("computed order total must be > 0");
        (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
        throw e;
      }
    }

    // Update totals
    await client.query(
      `UPDATE orders SET subtotal = $2, total = $3 WHERE id = $1::uuid`,
      [orderId, computedSubtotal, computedTotal]
    );

    // Insert order_created event
    await client.query(
      `INSERT INTO order_events (order_id, type, data, created_by)
       VALUES ($1::uuid, 'order_created', '{}', $2)`,
      [orderId, userId ?? null]
    );

    const result = { id: orderId, order_number: orderNumber, mode: orderMode, is_test: isTest };

    // Fire-and-forget outbound notification (H2.1)
    dispatchStoreEvent(storeId, "order.created", {
      order_id: orderId,
      order_number: orderNumber,
      currency,
      total: String(computedTotal),
    });

    return result;
  });
}

// ── Update order ───────────────────────────────────────────────────────────────

export async function updateOrder(
  orderId: string,
  storeId: string,
  input: UpdateOrderInput,
  userId?: string | undefined
): Promise<boolean> {
  const pool = getPool();

  const { rowCount } = await pool.query(
    `UPDATE orders SET
       notes      = COALESCE($3, notes),
       tags       = COALESCE($4, tags),
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      orderId,
      storeId,
      input.notes !== undefined ? input.notes : null,
      input.tags !== undefined ? input.tags : null,
    ]
  );

  if ((rowCount ?? 0) > 0) {
    // Insert update event (best-effort)
    await pool
      .query(
        `INSERT INTO order_events (order_id, type, data, created_by)
         VALUES ($1::uuid, 'order_updated', '{}', $2)`,
        [orderId, userId ?? null]
      )
      .catch(() => undefined);

    // Fire-and-forget outbound notification (H2.1)
    dispatchStoreEvent(storeId, "order.updated", {
      order_id: orderId,
    });
  }

  return (rowCount ?? 0) > 0;
}

// ── Cancel order ───────────────────────────────────────────────────────────────

export async function cancelOrder(
  orderId: string,
  storeId: string,
  reason?: string | undefined,
  userId?: string | undefined
): Promise<boolean> {
  const pool = getPool();

  const { rowCount } = await pool.query(
    `UPDATE orders SET
       status = 'cancelled',
       cancelled_at = now(),
       cancel_reason = $3,
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid
       AND status NOT IN ('cancelled', 'shipped', 'delivered')
       AND fulfillment_status = 'unfulfilled'`,
    [orderId, storeId, reason ?? null]
  );

  if ((rowCount ?? 0) > 0) {
    await pool
      .query(
        `INSERT INTO order_events (order_id, type, data, created_by)
         VALUES ($1::uuid, 'order_cancelled',
                 jsonb_build_object('reason', $2::text),
                 $3)`,
        [orderId, reason ?? "", userId ?? null]
      )
      .catch(() => undefined);

    // Fire-and-forget outbound notification (H2.1)
    dispatchStoreEvent(storeId, "order.cancelled", {
      order_id: orderId,
      reason: reason ?? "",
    });

    // H2.5: Release B2B credit on cancel.
    // Look up the order's company_id and the company's payment_terms_days.
    // Only net-terms orders (company.payment_terms_days > 0) consumed credit
    // at checkout — those are the only ones that need credit reversal.
    // Best-effort: do not fail the cancel if the credit release errors.
    try {
      const { rows: orderRows } = await pool.query<{
        company_id: string | null;
        total: string;
        company_payment_terms_days: number | null;
      }>(
        `SELECT o.company_id::text, o.total::text,
                c.payment_terms_days AS company_payment_terms_days
         FROM orders o
         LEFT JOIN companies c ON c.id = o.company_id
         WHERE o.id = $1::uuid`,
        [orderId]
      );
      const ord = orderRows[0];
      if (ord?.company_id && (ord.company_payment_terms_days ?? 0) > 0) {
        const { releaseCredit } = await import("../b2b/service.js");
        await releaseCredit(ord.company_id, parseFloat(ord.total));
      }
    } catch (creditErr) {
      console.warn("[cancelOrder] credit release failed (non-fatal):", creditErr);
    }
  }

  return (rowCount ?? 0) > 0;
}

// ── Add order note ─────────────────────────────────────────────────────────────

export async function addOrderNote(
  orderId: string,
  storeId: string,
  note: string,
  userId: string
): Promise<string> {
  // SEC: run the existence-check + INSERT inside withTx() so RLS (which is
  // applied on the request-scoped connection) backstops the org-scoping of the
  // store/order — the owner-role getPool() path bypasses RLS, so a bare query
  // here would not catch a cross-tenant :storeId.
  return withTx(async (client) => {
    // Verify order belongs to store
    const { rows: orderRows } = await client.query<{ id: string }>(
      `SELECT id::text FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
      [orderId, storeId]
    );
    if (!orderRows[0]) {
      const e = new Error("order not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO order_events (order_id, type, data, created_by)
       VALUES ($1::uuid, 'note_added',
               jsonb_build_object('note', $2::text),
               $3::uuid)
       RETURNING id::text`,
      [orderId, note, userId]
    );

    const id = rows[0]?.id;
    if (!id) throw new Error("addOrderNote: no id returned");
    return id;
  });
}

// ── List events ────────────────────────────────────────────────────────────────

export async function listOrderEvents(
  orderId: string,
  storeId: string
): Promise<OrderEvent[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();

  // Verify order belongs to store first
  const { rows: orderRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [orderId, storeId]
  );
  if (!orderRows[0]) return [];

  const { rows } = await pool.query<OrderEvent>(
    `SELECT id::text, order_id::text, type, data, created_by::text, created_at
     FROM order_events
     WHERE order_id = $1::uuid
     ORDER BY created_at DESC`,
    [orderId]
  );

  return rows;
}

// ── Shared internals: fulfillment-status + re-pricing + inventory ───────────────

interface OrderLineRow {
  id: string;
  variant_id: string | null;
  quantity: number;
  quantity_fulfilled: number;
  price: string;
  total: string;
}

/**
 * Recompute the order's fulfillment_status from its line quantities and persist
 * it (both on each line and on the order). Returns the rolled-up status.
 *
 *   - every line fully fulfilled              → 'fulfilled'
 *   - at least one unit fulfilled, not all    → 'partial'
 *   - nothing fulfilled                       → 'unfulfilled'
 *
 * Line-level fulfillment_status is recomputed from quantity_fulfilled vs
 * quantity so the two stay consistent.
 */
async function recomputeFulfillmentStatus(
  client: pg.PoolClient,
  orderId: string
): Promise<"unfulfilled" | "partial" | "fulfilled"> {
  const { rows } = await client.query<{ quantity: number; quantity_fulfilled: number }>(
    `SELECT quantity, quantity_fulfilled FROM order_lines WHERE order_id = $1::uuid`,
    [orderId]
  );

  let totalQty = 0;
  let totalFulfilled = 0;
  for (const r of rows) {
    totalQty += r.quantity;
    totalFulfilled += r.quantity_fulfilled;
  }

  let status: "unfulfilled" | "partial" | "fulfilled";
  if (totalFulfilled <= 0) status = "unfulfilled";
  else if (totalFulfilled >= totalQty) status = "fulfilled";
  else status = "partial";

  // Keep per-line status consistent with its own quantities.
  await client.query(
    `UPDATE order_lines SET fulfillment_status =
       CASE
         WHEN quantity_fulfilled <= 0 THEN 'unfulfilled'
         WHEN quantity_fulfilled >= quantity THEN 'fulfilled'
         ELSE 'partial'
       END
     WHERE order_id = $1::uuid`,
    [orderId]
  );

  await client.query(
    `UPDATE orders SET fulfillment_status = $2, updated_at = now() WHERE id = $1::uuid`,
    [orderId, status]
  );

  return status;
}

/**
 * Adjust held inventory for a variant by `delta` units inside the current
 * transaction, mirroring the checkout deduction model (checkout/complete.ts):
 * orders HOLD stock by decrementing inventory_levels.quantity_on_hand at order
 * time (there is no separate reservation/committed step in this codebase).
 *
 *   delta < 0  → reserve more stock (line qty increased): verify availability
 *                across the variant's inventory_levels rows (locked in id order
 *                to avoid deadlocks) and decrement, spreading across rows.
 *   delta > 0  → release stock (line qty decreased/removed): increment back onto
 *                the variant's first inventory_levels row (or create one if none
 *                exists, matching adjustInventory()'s upsert behaviour).
 *
 * Only acts on variants whose product has track_inventory = true; untracked
 * variants are a no-op (matching checkout). Writes an inventory_adjustments
 * audit row referencing the order.
 *
 * Throws code INSUFFICIENT_INVENTORY when a reservation cannot be satisfied.
 */
async function adjustHeldInventory(
  client: pg.PoolClient,
  orderId: string,
  variantId: string,
  delta: number
): Promise<void> {
  if (delta === 0) return;

  const { rows: trackRows } = await client.query<{ track_inventory: boolean }>(
    `SELECT track_inventory FROM product_variants WHERE id = $1::uuid`,
    [variantId]
  );
  if (!trackRows[0] || !trackRows[0].track_inventory) return; // untracked → no-op

  // Lock all inventory_levels rows for this variant in stable id order.
  const { rows: invRows } = await client.query<{
    id: string;
    warehouse_id: string;
    quantity_on_hand: number;
  }>(
    `SELECT id::text, warehouse_id::text, quantity_on_hand
     FROM inventory_levels
     WHERE variant_id = $1::uuid
     ORDER BY id
     FOR UPDATE`,
    [variantId]
  );

  if (delta < 0) {
    // Reserve |delta| more units.
    const need = -delta;
    const available = invRows.reduce((sum, r) => sum + r.quantity_on_hand, 0);
    if (available < need) {
      throw svcError(
        `insufficient inventory for variant ${variantId}`,
        "INSUFFICIENT_INVENTORY"
      );
    }
    let remaining = need;
    for (const r of invRows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, r.quantity_on_hand);
      if (take <= 0) continue;
      await client.query(
        `UPDATE inventory_levels SET quantity_on_hand = quantity_on_hand - $1, updated_at = now()
         WHERE id = $2::uuid`,
        [take, r.id]
      );
      await client.query(
        `INSERT INTO inventory_adjustments
           (variant_id, warehouse_id, quantity_delta, reason, reference_type, reference_id)
         VALUES ($1::uuid, $2::uuid, $3, 'sold', 'order', $4::uuid)`,
        [variantId, r.warehouse_id, -take, orderId]
      );
      remaining -= take;
    }
  } else {
    // Release `delta` units back to stock.
    const target = invRows[0];
    if (target) {
      await client.query(
        `UPDATE inventory_levels SET quantity_on_hand = quantity_on_hand + $1, updated_at = now()
         WHERE id = $2::uuid`,
        [delta, target.id]
      );
      await client.query(
        `INSERT INTO inventory_adjustments
           (variant_id, warehouse_id, quantity_delta, reason, reference_type, reference_id)
         VALUES ($1::uuid, $2::uuid, $3, 'returned', 'order', $4::uuid)`,
        [variantId, target.warehouse_id, delta, orderId]
      );
    }
    // If the variant has no inventory_levels row we simply skip — there is no
    // warehouse context to credit on a manual order, matching checkout which
    // only ever decrements existing rows.
  }
}

/**
 * Re-price an order the same way createOrder() priced it: subtotal is the sum of
 * line totals; shipping/discount are the scalars already stored on the order;
 * tax is RECOMPUTED from the shipping address via calcTaxAuto() against the new
 * taxable base (subtotal − discount) so a quantity change flows through to tax.
 * total = subtotal + shipping + tax − discount (floored at 0). Persists the new
 * subtotal/tax_total/total and returns them.
 *
 * NOTE on tax fidelity: when no shipping address country is present (common for
 * manual draft orders) calcTaxAuto returns zero and we preserve no tax — this
 * matches createOrder(), which never computed tax server-side for manual orders
 * and only stored a client-supplied scalar. We re-derive tax from rates rather
 * than blindly trusting the old scalar so the money math stays internally
 * consistent after an edit.
 */
async function repriceOrder(
  client: pg.PoolClient,
  storeId: string,
  orderId: string
): Promise<{ subtotal: number; tax_total: number; discount_total: number; shipping_total: number; total: number }> {
  const { rows: ordRows } = await client.query<{
    shipping_total: string;
    discount_total: string;
    tax_total: string;
    shipping_address: Record<string, unknown> | null;
  }>(
    `SELECT shipping_total::text, discount_total::text, tax_total::text, shipping_address
     FROM orders WHERE id = $1::uuid`,
    [orderId]
  );
  const ord = ordRows[0];
  if (!ord) throw svcError("order not found", "NOT_FOUND");

  const { rows: lineRows } = await client.query<{ total: string }>(
    `SELECT total::text FROM order_lines WHERE order_id = $1::uuid`,
    [orderId]
  );
  const subtotal = round2(lineRows.reduce((s, l) => s + parseFloat(l.total), 0));

  const shippingTotal = parseFloat(ord.shipping_total) || 0;
  const discountTotal = parseFloat(ord.discount_total) || 0;

  // Recompute tax from the shipping address against the new taxable base.
  const { countryCode, provinceCode } = extractAddressCodes(ord.shipping_address);
  const taxableBase = Math.max(subtotal - discountTotal, 0);
  let taxTotal = parseFloat(ord.tax_total) || 0;
  if (countryCode) {
    const taxRes = await calcTaxAuto(client, storeId, taxableBase, countryCode, provinceCode);
    taxTotal = taxRes.taxTotal;
  }

  let total = round2(subtotal + shippingTotal + taxTotal - discountTotal);
  if (total < 0) total = 0;

  await client.query(
    `UPDATE orders SET subtotal = $2, tax_total = $3, total = $4, updated_at = now()
     WHERE id = $1::uuid`,
    [orderId, subtotal, taxTotal, total]
  );

  return { subtotal, tax_total: taxTotal, discount_total: discountTotal, shipping_total: shippingTotal, total };
}

// ── Line-level fulfillment ──────────────────────────────────────────────────────

export interface FulfillLineInput {
  order_line_id: string;
  quantity: number;
}

export interface FulfillResult {
  fulfillment_order_id: string;
  fulfillment_status: "unfulfilled" | "partial" | "fulfilled";
}

/**
 * Incrementally fulfill specific order lines by (order_line_id, quantity),
 * supporting PARTIAL fulfillment. Atomic in a transaction:
 *
 *  1. Verify the order belongs to the store and is not cancelled/closed.
 *  2. For each requested line: lock it, validate it belongs to the order, and
 *     reject over-fulfillment (quantity_fulfilled + qty > quantity).
 *  3. Bump order_lines.quantity_fulfilled.
 *  4. Record the fulfilled units in the existing fulfillment_orders /
 *     fulfillment_order_lines model (one fulfillment_order per call).
 *  5. Recompute + persist the order's fulfillment_status from line quantities.
 *  6. Emit `order.updated` and write an order_event.
 *
 * Returns null when the order is not found.
 */
export async function fulfillOrderLines(
  storeId: string,
  orderId: string,
  lines: FulfillLineInput[],
  userId?: string | undefined
): Promise<FulfillResult | null> {
  return withTx(async (client) => {
    const { rows: ordRows } = await client.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1::uuid AND store_id = $2::uuid FOR UPDATE`,
      [orderId, storeId]
    );
    const ord = ordRows[0];
    if (!ord) return null;
    if (ord.status !== "open") {
      throw svcError(
        `cannot fulfill an order with status '${ord.status}'`,
        "CONFLICT"
      );
    }

    if (!lines || lines.length === 0) {
      throw svcError("lines is required and must be a non-empty array", "VALIDATION_ERROR");
    }

    // Create the fulfillment order shell for this fulfillment event.
    const { rows: foRows } = await client.query<{ id: string }>(
      `INSERT INTO fulfillment_orders (store_id, order_id, status, fulfilled_at)
       VALUES ($1::uuid, $2::uuid, 'fulfilled', now())
       RETURNING id::text`,
      [storeId, orderId]
    );
    const foId = foRows[0]!.id;

    for (const req of lines) {
      const qty = req.quantity;
      if (!Number.isInteger(qty) || qty <= 0) {
        throw svcError("fulfillment quantity must be a positive integer", "VALIDATION_ERROR");
      }

      const { rows: lineRows } = await client.query<OrderLineRow>(
        `SELECT id::text, variant_id::text, quantity, quantity_fulfilled,
                price::text, total::text
         FROM order_lines
         WHERE id = $1::uuid AND order_id = $2::uuid
         FOR UPDATE`,
        [req.order_line_id, orderId]
      );
      const line = lineRows[0];
      if (!line) {
        throw svcError(`order line ${req.order_line_id} not found on this order`, "VALIDATION_ERROR");
      }

      if (line.quantity_fulfilled + qty > line.quantity) {
        throw svcError(
          `cannot fulfill ${qty} of line ${line.id}: only ${line.quantity - line.quantity_fulfilled} unfulfilled (qty ${line.quantity}, already fulfilled ${line.quantity_fulfilled})`,
          "VALIDATION_ERROR"
        );
      }

      await client.query(
        `UPDATE order_lines SET quantity_fulfilled = quantity_fulfilled + $2 WHERE id = $1::uuid`,
        [line.id, qty]
      );

      await client.query(
        `INSERT INTO fulfillment_order_lines (fulfillment_order_id, order_line_id, quantity, quantity_fulfilled)
         VALUES ($1::uuid, $2::uuid, $3, $3)`,
        [foId, line.id, qty]
      );
    }

    const fulfillmentStatus = await recomputeFulfillmentStatus(client, orderId);

    await client
      .query(
        `INSERT INTO order_events (order_id, type, data, created_by)
         VALUES ($1::uuid, 'fulfillment_created',
                 jsonb_build_object('fulfillment_order_id', $2::text, 'fulfillment_status', $3::text),
                 $4)`,
        [orderId, foId, fulfillmentStatus, userId ?? null]
      )
      .catch(() => undefined);

    // Fire-and-forget outbound notification — reuse the existing order.updated event.
    dispatchStoreEvent(storeId, "order.updated", {
      order_id: orderId,
      fulfillment_status: fulfillmentStatus,
    });

    return { fulfillment_order_id: foId, fulfillment_status: fulfillmentStatus };
  });
}

// ── Safe order line edits (UNFULFILLED orders only) ─────────────────────────────

export interface EditLineOp {
  op: "update_quantity" | "add" | "remove";
  order_line_id?: string | undefined; // required for update_quantity / remove
  variant_id?: string | undefined; // required for add
  quantity?: number | undefined; // required for update_quantity / add
}

export interface EditLinesResult {
  subtotal: string;
  tax_total: string;
  discount_total: string;
  shipping_total: string;
  total: string;
}

/**
 * Apply a batch of safe line edits to an UNFULFILLED, open order. Atomic in a
 * transaction. Supported ops: update_quantity, add (variant_id + quantity),
 * remove. Server-side re-pricing (repriceOrder) and inventory adjustment
 * (adjustHeldInventory) are performed; client totals are never trusted.
 *
 * Guard: refuses the edit if the order is not 'open', or if ANY line has been
 * (partially or fully) fulfilled — fulfillment makes the line composition a
 * shipped commitment, so we lock edits at that point.
 *
 * PAYMENT DELTA (charging/refunding the difference between the old and new
 * total) is OUT OF SCOPE — see follow-up note below. We persist the new totals
 * and write an order_event recording the old/new total and the balance
 * owed/owing so ops can reconcile manually.
 *
 * Returns null when the order is not found.
 */
export async function editOrderLines(
  storeId: string,
  orderId: string,
  ops: EditLineOp[],
  userId?: string | undefined
): Promise<EditLinesResult | null> {
  return withTx(async (client) => {
    const { rows: ordRows } = await client.query<{
      status: string;
      total: string;
      currency: string;
    }>(
      `SELECT status, total::text, currency
       FROM orders WHERE id = $1::uuid AND store_id = $2::uuid FOR UPDATE`,
      [orderId, storeId]
    );
    const ord = ordRows[0];
    if (!ord) return null;

    if (ord.status !== "open") {
      throw svcError(`cannot edit an order with status '${ord.status}'`, "CONFLICT");
    }

    // Refuse if any line has been fulfilled (partial or full).
    const { rows: fulfRows } = await client.query<{ any_fulfilled: boolean }>(
      `SELECT bool_or(quantity_fulfilled > 0) AS any_fulfilled
       FROM order_lines WHERE order_id = $1::uuid`,
      [orderId]
    );
    if (fulfRows[0]?.any_fulfilled) {
      throw svcError("cannot edit lines once any line has been fulfilled", "CONFLICT");
    }

    if (!ops || ops.length === 0) {
      throw svcError("ops is required and must be a non-empty array", "VALIDATION_ERROR");
    }

    const oldTotal = parseFloat(ord.total) || 0;

    for (const op of ops) {
      if (op.op === "remove") {
        if (!op.order_line_id) throw svcError("order_line_id is required for remove", "VALIDATION_ERROR");
        const { rows: lr } = await client.query<OrderLineRow>(
          `SELECT id::text, variant_id::text, quantity, quantity_fulfilled, price::text, total::text
           FROM order_lines WHERE id = $1::uuid AND order_id = $2::uuid FOR UPDATE`,
          [op.order_line_id, orderId]
        );
        const line = lr[0];
        if (!line) throw svcError(`order line ${op.order_line_id} not found on this order`, "VALIDATION_ERROR");
        // Release all held inventory for this line, then delete it.
        if (line.variant_id) {
          await adjustHeldInventory(client, orderId, line.variant_id, line.quantity);
        }
        await client.query(`DELETE FROM order_lines WHERE id = $1::uuid`, [line.id]);
      } else if (op.op === "update_quantity") {
        if (!op.order_line_id) throw svcError("order_line_id is required for update_quantity", "VALIDATION_ERROR");
        const newQty = op.quantity;
        if (!Number.isInteger(newQty) || (newQty as number) <= 0) {
          throw svcError("quantity must be a positive integer for update_quantity", "VALIDATION_ERROR");
        }
        const { rows: lr } = await client.query<OrderLineRow>(
          `SELECT id::text, variant_id::text, quantity, quantity_fulfilled, price::text, total::text
           FROM order_lines WHERE id = $1::uuid AND order_id = $2::uuid FOR UPDATE`,
          [op.order_line_id, orderId]
        );
        const line = lr[0];
        if (!line) throw svcError(`order line ${op.order_line_id} not found on this order`, "VALIDATION_ERROR");

        const delta = (newQty as number) - line.quantity;
        if (delta !== 0) {
          // Inventory: increasing qty reserves more (delta<0 to inventory),
          // decreasing releases (delta>0 to inventory).
          if (line.variant_id) {
            await adjustHeldInventory(client, orderId, line.variant_id, -delta);
          }
          const price = parseFloat(line.price);
          const newLineTotal = round2(price * (newQty as number));
          await client.query(
            `UPDATE order_lines SET quantity = $2, total = $3 WHERE id = $1::uuid`,
            [line.id, newQty, newLineTotal]
          );
        }
      } else if (op.op === "add") {
        if (!op.variant_id) throw svcError("variant_id is required for add", "VALIDATION_ERROR");
        const qty = op.quantity ?? 1;
        if (!Number.isInteger(qty) || qty <= 0) {
          throw svcError("quantity must be a positive integer for add", "VALIDATION_ERROR");
        }
        // Server-side price + title lookup (mirrors createOrder).
        const { rows: pv } = await client.query<{ price: string; title: string; sku: string | null }>(
          `SELECT pv.price::text, pv.title, pv.sku
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE pv.id = $1::uuid AND p.store_id = $2::uuid`,
          [op.variant_id, storeId]
        );
        if (!pv[0]) throw svcError(`invalid variant_id: ${op.variant_id}`, "VALIDATION_ERROR");
        const price = parseFloat(pv[0].price);
        const lineTotal = round2(price * qty);

        // Reserve inventory for the new units (delta<0 to inventory).
        await adjustHeldInventory(client, orderId, op.variant_id, -qty);

        await client.query(
          `INSERT INTO order_lines (order_id, variant_id, title, sku, quantity, price, total)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
          [orderId, op.variant_id, pv[0].title || "Item", pv[0].sku ?? null, qty, price, lineTotal]
        );
      } else {
        throw svcError(`unknown edit op: ${(op as { op: string }).op}`, "VALIDATION_ERROR");
      }
    }

    // Re-price the whole order from the new line set.
    const priced = await repriceOrder(client, storeId, orderId);

    // PAYMENT DELTA — OUT OF SCOPE (follow-up): we do not charge/refund the
    // difference here. Record the balance change on an order_event so the new
    // total is reconciled against any captured payment downstream.
    const balanceDelta = round2(priced.total - oldTotal);
    await client
      .query(
        `INSERT INTO order_events (order_id, type, data, created_by)
         VALUES ($1::uuid, 'order_lines_edited',
                 jsonb_build_object(
                   'old_total', $2::text,
                   'new_total', $3::text,
                   'balance_delta', $4::text,
                   'balance_note', $5::text
                 ),
                 $6)`,
        [
          orderId,
          oldTotal.toFixed(2),
          priced.total.toFixed(2),
          balanceDelta.toFixed(2),
          balanceDelta > 0
            ? "additional balance owed by customer"
            : balanceDelta < 0
              ? "balance owing to customer (refund)"
              : "no balance change",
          userId ?? null,
        ]
      )
      .catch(() => undefined);

    dispatchStoreEvent(storeId, "order.updated", {
      order_id: orderId,
      total: priced.total.toFixed(2),
    });

    return {
      subtotal: priced.subtotal.toFixed(2),
      tax_total: priced.tax_total.toFixed(2),
      discount_total: priced.discount_total.toFixed(2),
      shipping_total: priced.shipping_total.toFixed(2),
      total: priced.total.toFixed(2),
    };
  });
}
