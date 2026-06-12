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
 *   store_credit — adjusts store credit balance via wallet service (issueStoreCredit)
 *   exchange    — (order line creation — best-effort, placeholder)
 *   restock     — inventory adjustment for restock=true lines
 *
 * RMA number: uses sequence next_rma_number() or falls back to timestamp-based generation.
 *
 * Note: store_credit resolution calls issueStoreCredit from wallet service (not direct SQL).
 * This is noted in the implementation where relevant.
 */

import { getPool, withTx } from "../../db/pool.js";
import type {
  ReturnWithLines,
  CreateReturnInput,
  UpdateReturnInput,
  AddReturnEventInput,
  ReturnEvent,
} from "./types.js";
import { issueStoreCredit } from "../wallet/service.js";

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
  const pool = getPool();
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
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT rr.id::text, rr.store_id::text, rr.order_id::text, rr.customer_id::text,
            rr.rma_number, rr.status, rr.return_type, rr.notes, rr.metadata,
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
  const { customer_id: customerId, order_id: orderId, return_type: returnType, currency } = retRows[0];

  // Determine effective return type
  const effectiveType = (input.return_type ?? returnType) as string;

  if (effectiveType === "store_credit" && customerId && input.credit_amount && input.credit_amount > 0) {
    // Issue store credit via wallet service (import not direct SQL)
    // wallet/service.ts:issueStoreCredit handles UPSERT + FOR UPDATE + ledger atomically
    try {
      await issueStoreCredit(storeId, {
        customer_id: customerId,
        amount: input.credit_amount.toFixed(2),
        currency,
        order_id: orderId,
        notes: `Store credit for RMA return ${returnId}`,
        created_by: updatedBy,
      });
    } catch (err) {
      // Best-effort: log but don't fail the status update
      console.error("handleResolution: issueStoreCredit failed", err);
    }
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
          `INSERT INTO refunds (payment_id, order_id, store_id, amount, status, reason, notes, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, 'pending', 'customer_request', 'RMA refund', $5::uuid)
           ON CONFLICT DO NOTHING`,
          [payRows[0].id, orderId, storeId, input.credit_amount, updatedBy]
        );
      }
    } catch (err) {
      // Best-effort
      console.error("handleResolution: refund insert failed", err);
    }
  }

  // Restock: adjust inventory for lines with restock=true
  try {
    const { rows: lineRows } = await pool.query(
      `SELECT rrl.order_line_id::text, rrl.quantity
       FROM return_request_lines rrl
       WHERE rrl.return_id = $1::uuid AND rrl.restock = true`,
      [returnId]
    );
    for (const line of lineRows) {
      // Get variant_id from order_line
      const { rows: olRows } = await pool.query(
        `SELECT variant_id::text FROM order_lines WHERE id = $1::uuid`,
        [line.order_line_id]
      );
      if (!olRows[0]) continue;
      const variantId = olRows[0].variant_id;

      // Get default warehouse for store
      const { rows: whRows } = await pool.query(
        `SELECT id::text FROM warehouses WHERE store_id = $1::uuid AND is_default = true LIMIT 1`,
        [storeId]
      );
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
  const pool = getPool();
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
