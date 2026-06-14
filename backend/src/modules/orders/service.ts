/**
 * orders/service.ts — SQL-backed orders service.
 *
 * All business logic lives here; routes.ts is a thin Fastify plugin.
 * Uses pg.PoolClient for transactions, getPool for single queries.
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import { dispatchStoreEvent } from "../notifications/service.js";
import type {
  Order,
  OrderLine,
  OrderEvent,
  CreateOrderInput,
  CreateOrderResult,
  UpdateOrderInput,
} from "./types.js";

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
  const pool = getPool();

  // Verify order belongs to store
  const { rows: orderRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [orderId, storeId]
  );
  if (!orderRows[0]) {
    const e = new Error("order not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }

  const { rows } = await pool.query<{ id: string }>(
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
