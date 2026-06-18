/**
 * inventory/service.ts — SQL + business logic for inventory management.
 *
 * Covers:
 *  - Warehouses CRUD
 *  - Inventory levels: list, set (upsert with initial_count adjustment), adjust (delta + audit row)
 *  - Inventory adjustments list
 *  - Inventory lots CRUD (FEFO ordering: expiry_date ASC NULLS LAST, received_at ASC)
 *  - Serial numbers: bulk-create, list, get, update
 *  - Suppliers CRUD
 *
 * Atomicity: set/adjust write the level AND the audit row in the SAME transaction
 * (mirrors webcrft-mono/backend/internal/handlers/commerce_inventory.go semantics).
 *
 * Negative-stock guard: adjust uses GREATEST(0, …) — quantity never goes below 0.
 * quantity_delta == 0 is rejected before DB (no-op adjustment clutters audit log).
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import { dispatchStoreEvent } from "../notifications/service.js";

// ── Reason enum ────────────────────────────────────────────────────────────────

export const ADJUSTMENT_REASONS = [
  "initial_count",
  "recount",
  "received",
  "sold",
  "returned",
  "damaged",
  "theft",
  "correction",
  "other",
] as const;
export type AdjustmentReason = typeof ADJUSTMENT_REASONS[number];

// ── Warehouses ────────────────────────────────────────────────────────────────

export async function listWarehouses(storeId: string) {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, name, code, address, is_active, is_default,
            fulfills_online, metadata, created_at, updated_at
     FROM warehouses WHERE store_id = $1::uuid ORDER BY is_default DESC, name`,
    [storeId]
  );
  return rows;
}

export async function createWarehouse(
  storeId: string,
  data: {
    name: string;
    code?: string | null | undefined;
    is_active?: boolean | undefined;
    is_default?: boolean | undefined;
    fulfills_online?: boolean | undefined;
    address?: Record<string, unknown> | null | undefined;
    metadata?: Record<string, unknown> | null | undefined;
  }
) {
  const pool = getPool();
  return withTx(async (client) => {
    if (data.is_default) {
      await client.query(
        `UPDATE warehouses SET is_default = false WHERE store_id = $1::uuid`,
        [storeId]
      );
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO warehouses (store_id, name, code, is_active, is_default, fulfills_online, address, metadata)
       VALUES ($1::uuid, $2, $3, COALESCE($4, true), COALESCE($5, false), COALESCE($6, true),
               $7::jsonb, COALESCE($8::jsonb, '{}'::jsonb))
       RETURNING id::text`,
      [
        storeId,
        data.name,
        data.code ?? null,
        data.is_active ?? null,
        data.is_default ?? null,
        data.fulfills_online ?? null,
        data.address ? JSON.stringify(data.address) : null,
        data.metadata ? JSON.stringify(data.metadata) : null,
      ]
    );
    return rows[0]!.id;
  });
}

export async function updateWarehouse(
  storeId: string,
  warehouseId: string,
  data: {
    name?: string | undefined;
    code?: string | null | undefined;
    is_active?: boolean | undefined;
    is_default?: boolean | undefined;
    fulfills_online?: boolean | undefined;
    address?: Record<string, unknown> | null | undefined;
    metadata?: Record<string, unknown> | null | undefined;
  }
) {
  const pool = getPool();
  return withTx(async (client) => {
    if (data.is_default === true) {
      await client.query(
        `UPDATE warehouses SET is_default = false WHERE store_id = $1::uuid AND id != $2::uuid`,
        [storeId, warehouseId]
      );
    }
    const { rowCount } = await client.query(
      `UPDATE warehouses SET
         name            = COALESCE($3, name),
         code            = COALESCE($4, code),
         is_active       = COALESCE($5, is_active),
         is_default      = COALESCE($6, is_default),
         fulfills_online = COALESCE($7, fulfills_online),
         address         = COALESCE($8::jsonb, address),
         metadata        = COALESCE($9::jsonb, metadata),
         updated_at      = now()
       WHERE id = $1::uuid AND store_id = $2::uuid`,
      [
        warehouseId,
        storeId,
        data.name ?? null,
        data.code !== undefined ? data.code : null,
        data.is_active !== undefined ? data.is_active : null,
        data.is_default !== undefined ? data.is_default : null,
        data.fulfills_online !== undefined ? data.fulfills_online : null,
        data.address !== undefined ? (data.address ? JSON.stringify(data.address) : null) : null,
        data.metadata !== undefined ? (data.metadata ? JSON.stringify(data.metadata) : null) : null,
      ]
    );
    return (rowCount ?? 0) > 0;
  });
}

export async function deleteWarehouse(storeId: string, warehouseId: string) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM warehouses WHERE id = $1::uuid AND store_id = $2::uuid`,
    [warehouseId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Inventory levels ──────────────────────────────────────────────────────────

export async function listInventoryLevels(
  storeId: string,
  opts: {
    variant_id?: string | undefined;
    warehouse_id?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
) {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const limit = Math.min(opts.limit ?? 100, 200);
  const offset = opts.offset ?? 0;

  let query = `
    SELECT il.id::text, il.variant_id::text, il.warehouse_id::text,
           il.quantity_on_hand, il.quantity_committed, il.quantity_incoming,
           (il.quantity_on_hand - il.quantity_committed) AS quantity_available,
           il.reorder_point, il.reorder_qty, il.updated_at,
           pv.sku, pv.title AS variant_title, p.title AS product_title,
           w.name AS warehouse_name
    FROM inventory_levels il
    JOIN product_variants pv ON pv.id = il.variant_id
    JOIN products p ON p.id = pv.product_id
    JOIN warehouses w ON w.id = il.warehouse_id
    WHERE p.store_id = $1::uuid`;
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.variant_id) {
    query += ` AND il.variant_id = $${argN}::uuid`;
    args.push(opts.variant_id);
    argN++;
  }
  if (opts.warehouse_id) {
    query += ` AND il.warehouse_id = $${argN}::uuid`;
    args.push(opts.warehouse_id);
    argN++;
  }
  query += ` ORDER BY p.title, pv.title, w.name LIMIT $${argN} OFFSET $${argN + 1}`;
  args.push(limit, offset);

  const { rows } = await pool.query(query, args);
  return rows;
}

export async function setInventoryLevel(
  storeId: string,
  data: {
    variant_id: string;
    warehouse_id: string;
    quantity: number;
    created_by: string | undefined;
  }
) {
  return withTx(async (client) => {
    await client.query(
      `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET quantity_on_hand = $3, updated_at = now()`,
      [data.variant_id, data.warehouse_id, data.quantity]
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_adjustments (variant_id, warehouse_id, quantity_delta, reason, reference_type, created_by)
       VALUES ($1::uuid, $2::uuid, $3, 'initial_count', 'manual', $4::uuid)
       RETURNING id::text`,
      [data.variant_id, data.warehouse_id, data.quantity, data.created_by]
    );
    return rows[0]?.id ?? null;
  });
}

export async function adjustInventory(
  storeId: string,
  data: {
    variant_id: string;
    warehouse_id: string;
    quantity_delta: number;
    reason: string;
    notes?: string | undefined;
    created_by: string | undefined;
  }
): Promise<{ id: string; quantity_available: number; reorder_point: number | null }> {
  return withTx(async (client) => {
    await client.query(
      `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
       VALUES ($1::uuid, $2::uuid, GREATEST(0, $3))
       ON CONFLICT (variant_id, warehouse_id) DO UPDATE
         SET quantity_on_hand = GREATEST(0, inventory_levels.quantity_on_hand + $3), updated_at = now()`,
      [data.variant_id, data.warehouse_id, data.quantity_delta]
    );

    const { rows: adjRows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_adjustments (variant_id, warehouse_id, quantity_delta, reason, notes, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid) RETURNING id::text`,
      [
        data.variant_id,
        data.warehouse_id,
        data.quantity_delta,
        data.reason,
        data.notes ?? null,
        data.created_by,
      ]
    );

    const { rows: lvlRows } = await client.query<{
      quantity_available: number;
      reorder_point: number | null;
    }>(
      `SELECT (quantity_on_hand - quantity_committed) AS quantity_available, reorder_point
       FROM inventory_levels WHERE variant_id = $1::uuid AND warehouse_id = $2::uuid`,
      [data.variant_id, data.warehouse_id]
    );

    return {
      id: adjRows[0]!.id,
      quantity_available: lvlRows[0]?.quantity_available ?? 0,
      reorder_point: lvlRows[0]?.reorder_point ?? null,
    };
  });
}

export async function listInventoryAdjustments(
  storeId: string,
  opts: {
    variant_id?: string | undefined;
    warehouse_id?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
) {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const limit = Math.min(opts.limit ?? 100, 200);
  const offset = opts.offset ?? 0;

  let query = `
    SELECT ia.id::text, ia.variant_id::text, ia.warehouse_id::text,
           ia.quantity_delta, ia.reason, ia.notes, ia.reference_type, ia.reference_id::text,
           ia.created_by::text, ia.created_at,
           pv.sku, p.title AS product_title, w.name AS warehouse_name
    FROM inventory_adjustments ia
    JOIN product_variants pv ON pv.id = ia.variant_id
    JOIN products p ON p.id = pv.product_id
    JOIN warehouses w ON w.id = ia.warehouse_id
    WHERE p.store_id = $1::uuid`;
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.variant_id) {
    query += ` AND ia.variant_id = $${argN}::uuid`;
    args.push(opts.variant_id);
    argN++;
  }
  if (opts.warehouse_id) {
    query += ` AND ia.warehouse_id = $${argN}::uuid`;
    args.push(opts.warehouse_id);
    argN++;
  }
  query += ` ORDER BY ia.created_at DESC LIMIT $${argN} OFFSET $${argN + 1}`;
  args.push(limit, offset);

  const { rows } = await pool.query(query, args);
  return rows;
}

// ── Inventory lots (FEFO) ─────────────────────────────────────────────────────

export async function listInventoryLots(
  storeId: string,
  opts: { variant_id?: string | undefined; warehouse_id?: string | undefined } = {}
) {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  let query = `
    SELECT il.id::text, il.variant_id::text, il.warehouse_id::text,
           il.lot_number, il.expiry_date, il.quantity, il.cost_price,
           il.received_at, il.created_at,
           pv.sku, p.title AS product_title, w.name AS warehouse_name
    FROM inventory_lots il
    JOIN product_variants pv ON pv.id = il.variant_id
    JOIN products p ON p.id = pv.product_id
    JOIN warehouses w ON w.id = il.warehouse_id
    WHERE w.store_id = $1::uuid`;
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.variant_id) {
    query += ` AND il.variant_id = $${argN}::uuid`;
    args.push(opts.variant_id);
    argN++;
  }
  if (opts.warehouse_id) {
    query += ` AND il.warehouse_id = $${argN}::uuid`;
    args.push(opts.warehouse_id);
    argN++;
  }
  // FEFO ordering: earliest expiry first; lots without expiry last
  query += ` ORDER BY il.expiry_date ASC NULLS LAST, il.received_at ASC`;

  const { rows } = await pool.query(query, args);
  return rows;
}

export async function createInventoryLot(
  storeId: string,
  data: {
    variant_id: string;
    warehouse_id: string;
    lot_number: string;
    quantity: number;
    expiry_date?: string | null | undefined;
    cost_price?: number | null | undefined;
    received_at?: string | null | undefined;
  }
) {
  return withTx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_lots (variant_id, warehouse_id, lot_number, expiry_date, quantity, cost_price, received_at)
       SELECT $1::uuid, $2::uuid, $3, $4, $5, $6, COALESCE($7, now())
       WHERE EXISTS (SELECT 1 FROM warehouses WHERE id = $2::uuid AND store_id = $8::uuid)
       RETURNING id::text`,
      [
        data.variant_id,
        data.warehouse_id,
        data.lot_number,
        data.expiry_date ?? null,
        data.quantity,
        data.cost_price ?? null,
        data.received_at ?? null,
        storeId,
      ]
    );
    if (!rows[0]) return null;
    // Bump inventory_levels
    await client.query(
      `INSERT INTO inventory_levels (variant_id, warehouse_id, quantity_on_hand)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (variant_id, warehouse_id) DO UPDATE
         SET quantity_on_hand = inventory_levels.quantity_on_hand + $3, updated_at = now()`,
      [data.variant_id, data.warehouse_id, data.quantity]
    );
    return rows[0].id;
  });
}

export async function updateInventoryLot(
  storeId: string,
  lotId: string,
  data: {
    expiry_date?: string | null | undefined;
    quantity?: number | undefined;
    cost_price?: number | null | undefined;
  }
) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE inventory_lots SET
       expiry_date = COALESCE($3, expiry_date),
       quantity    = COALESCE($4, quantity),
       cost_price  = COALESCE($5, cost_price)
     WHERE id = $1::uuid
       AND EXISTS (SELECT 1 FROM warehouses WHERE id = inventory_lots.warehouse_id AND store_id = $2::uuid)`,
    [
      lotId,
      storeId,
      data.expiry_date !== undefined ? data.expiry_date : null,
      data.quantity !== undefined ? data.quantity : null,
      data.cost_price !== undefined ? data.cost_price : null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteInventoryLot(storeId: string, lotId: string) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM inventory_lots WHERE id = $1::uuid
       AND EXISTS (SELECT 1 FROM warehouses WHERE id = inventory_lots.warehouse_id AND store_id = $2::uuid)`,
    [lotId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Serial numbers ────────────────────────────────────────────────────────────

export async function listSerialNumbers(
  storeId: string,
  opts: {
    variant_id?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
) {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const limit = Math.min(opts.limit ?? 100, 200);
  const offset = opts.offset ?? 0;

  let query = `
    SELECT sn.id::text, sn.variant_id::text, sn.warehouse_id::text,
           sn.serial_number, sn.status, sn.order_line_id::text, sn.lot_id::text,
           sn.created_at, sn.updated_at,
           pv.sku, p.title AS product_title
    FROM serial_numbers sn
    JOIN product_variants pv ON pv.id = sn.variant_id
    JOIN products p ON p.id = pv.product_id
    WHERE p.store_id = $1::uuid`;
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.variant_id) {
    query += ` AND sn.variant_id = $${argN}::uuid`;
    args.push(opts.variant_id);
    argN++;
  }
  if (opts.status) {
    query += ` AND sn.status = $${argN}`;
    args.push(opts.status);
    argN++;
  }
  query += ` ORDER BY sn.created_at DESC LIMIT $${argN} OFFSET $${argN + 1}`;
  args.push(limit, offset);

  const { rows } = await pool.query(query, args);
  return rows;
}

export async function bulkCreateSerialNumbers(
  storeId: string,
  data: {
    variant_id: string;
    warehouse_id?: string | undefined;
    serial_numbers: string[];
  }
): Promise<number> {
  return withTx(async (client) => {
    let created = 0;
    for (const sn of data.serial_numbers) {
      if (!sn) continue;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO serial_numbers (variant_id, warehouse_id, serial_number, status)
         SELECT $1::uuid, $2, $3, 'available'
         WHERE EXISTS (
           SELECT 1 FROM products p
           JOIN product_variants pv ON pv.product_id = p.id
           WHERE pv.id = $1::uuid AND p.store_id = $4::uuid
         )
         ON CONFLICT (variant_id, serial_number) DO NOTHING
         RETURNING id::text`,
        [data.variant_id, data.warehouse_id ?? null, sn, storeId]
      );
      if (rows[0]) created++;
    }
    return created;
  });
}

export async function getSerialNumber(storeId: string, serialId: string) {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<{ order_line_id: string | null } & Record<string, unknown>>(
    `SELECT sn.id::text, sn.variant_id::text, sn.warehouse_id::text,
            sn.serial_number, sn.status, sn.order_line_id::text, sn.lot_id::text,
            sn.created_at, sn.updated_at,
            pv.sku, p.title AS product_title
     FROM serial_numbers sn
     JOIN product_variants pv ON pv.id = sn.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE sn.id = $1::uuid AND p.store_id = $2::uuid`,
    [serialId, storeId]
  );
  const sn = rows[0] ?? null;
  if (!sn) return null;

  // Attach order history if sold
  if (sn.order_line_id) {
    const { rows: histRows } = await pool.query(
      `SELECT o.id::text AS order_id, o.order_number, o.created_at AS order_date,
              ol.quantity, ol.price
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
       WHERE ol.id = $1::uuid`,
      [sn.order_line_id]
    );
    if (histRows.length > 0) {
      (sn as Record<string, unknown>)["order_history"] = histRows;
    }
  }
  return sn;
}

export async function updateSerialNumber(
  storeId: string,
  serialId: string,
  data: { status?: string | undefined }
) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE serial_numbers SET
       status     = COALESCE($3, status),
       updated_at = now()
     WHERE id = $1::uuid
       AND EXISTS (
         SELECT 1 FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         WHERE pv.id = serial_numbers.variant_id AND p.store_id = $2::uuid
       )`,
    [serialId, storeId, data.status ?? null]
  );
  return (rowCount ?? 0) > 0;
}

// ── Suppliers ─────────────────────────────────────────────────────────────────

export async function listSuppliers(storeId: string) {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, name, email, phone, address,
            currency, notes, metadata, is_active,
            created_at, updated_at
     FROM suppliers WHERE store_id = $1::uuid ORDER BY name`,
    [storeId]
  );
  return rows;
}

export async function createSupplier(
  storeId: string,
  data: {
    name: string;
    email?: string | null | undefined;
    phone?: string | null | undefined;
    address?: Record<string, unknown> | null | undefined;
    currency?: string | null | undefined;
    notes?: string | null | undefined;
    is_active?: boolean | undefined;
  }
) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO suppliers (store_id, name, email, phone, address, currency, notes, is_active)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, COALESCE($8, true))
     RETURNING id::text`,
    [
      storeId,
      data.name,
      data.email ?? null,
      data.phone ?? null,
      data.address ? JSON.stringify(data.address) : null,
      data.currency ?? null,
      data.notes ?? null,
      data.is_active ?? null,
    ]
  );
  return rows[0]!.id;
}

export async function updateSupplier(
  storeId: string,
  supplierId: string,
  data: {
    name?: string | undefined;
    email?: string | null | undefined;
    phone?: string | null | undefined;
    address?: Record<string, unknown> | null | undefined;
    currency?: string | null | undefined;
    notes?: string | null | undefined;
    is_active?: boolean | undefined;
  }
) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE suppliers SET
       name       = COALESCE($3, name),
       email      = COALESCE($4, email),
       phone      = COALESCE($5, phone),
       address    = COALESCE($6::jsonb, address),
       currency   = COALESCE($7, currency),
       notes      = COALESCE($8, notes),
       is_active  = COALESCE($9, is_active),
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      supplierId,
      storeId,
      data.name ?? null,
      data.email !== undefined ? data.email : null,
      data.phone !== undefined ? data.phone : null,
      data.address !== undefined ? (data.address ? JSON.stringify(data.address) : null) : null,
      data.currency !== undefined ? data.currency : null,
      data.notes !== undefined ? data.notes : null,
      data.is_active !== undefined ? data.is_active : null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteSupplier(storeId: string, supplierId: string) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM suppliers WHERE id = $1::uuid AND store_id = $2::uuid`,
    [supplierId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Low-stock reorder-point alerts ──────────────────────────────────────────────
//
// A polling worker (inventory/worker.ts) calls detectLowStock() each tick. For
// every tracked variant whose quantity_on_hand has dropped to/below its
// reorder_point (reorder_point > 0), we decide whether this is a NEW transition
// into low and, if so, emit an `inventory.low` notification event. Per-(variant,
// warehouse) idempotency state lives in inventory_low_alerts so we don't re-alert
// every tick while stock stays low.
//
// dispatch is injectable so tests can assert without real webhook delivery.

/** Cooldown after which a still-low item re-alerts even without a recovery. */
export const LOW_STOCK_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface LowStockDeps {
  /** Notification dispatcher. Defaults to the real dispatchStoreEvent. */
  dispatch?: (
    storeId: string,
    eventType: string,
    payload: Record<string, unknown>
  ) => void;
  /** Cooldown override (ms) for re-alerting a still-low item. */
  cooldownMs?: number;
  /** Clock override for "now" — keeps SimClock parity in tests. */
  now?: () => Date;
}

interface LowStockRow {
  store_id: string;
  variant_id: string;
  warehouse_id: string;
  on_hand: number;
  reorder_point: number;
  sku: string | null;
  last_alerted_at: Date | null;
  last_on_hand: number | null;
}

/**
 * Detect low-stock variants and emit `inventory.low` on new transitions into low.
 *
 * Selection: inventory_levels rows for TRACKED variants (product_variants.track_inventory)
 * where quantity_on_hand <= reorder_point AND reorder_point > 0, scoped to the
 * owning store (via product → products.store_id). If storeId is provided, only
 * that store is evaluated; otherwise all stores are scanned (worker mode).
 *
 * Alert rule — fire only when it's a NEW transition into low:
 *   - no inventory_low_alerts row yet, OR
 *   - the prior alert's last_on_hand was ABOVE reorder_point (recovered, then
 *     dropped again), OR
 *   - the cooldown (default 24h) elapsed since last_alerted_at.
 * Otherwise we stay quiet but still refresh last_on_hand so a recovery is recorded.
 *
 * @returns the number of inventory.low events fired this run.
 */
export async function detectLowStock(
  storeId?: string,
  deps: LowStockDeps = {}
): Promise<number> {
  const dispatch = deps.dispatch ?? dispatchStoreEvent;
  const cooldownMs = deps.cooldownMs ?? LOW_STOCK_COOLDOWN_MS;
  const now = deps.now ? deps.now() : new Date();

  const pool = getPool();

  // LEFT JOIN the alert state so we get prior last_on_hand / last_alerted_at in
  // one round-trip. la.store_id is matched on (variant, warehouse) which is unique.
  const args: unknown[] = [];
  let storeFilter = "";
  if (storeId) {
    args.push(storeId);
    storeFilter = ` AND p.store_id = $1::uuid`;
  }
  const { rows } = await pool.query<LowStockRow>(
    `SELECT p.store_id::text       AS store_id,
            il.variant_id::text    AS variant_id,
            il.warehouse_id::text  AS warehouse_id,
            il.quantity_on_hand    AS on_hand,
            il.reorder_point       AS reorder_point,
            pv.sku                 AS sku,
            la.last_alerted_at     AS last_alerted_at,
            la.last_on_hand        AS last_on_hand
     FROM inventory_levels il
     JOIN product_variants pv ON pv.id = il.variant_id
     JOIN products p ON p.id = pv.product_id
     LEFT JOIN inventory_low_alerts la
       ON la.variant_id = il.variant_id AND la.warehouse_id = il.warehouse_id
     WHERE pv.track_inventory = true
       AND il.reorder_point IS NOT NULL
       AND il.reorder_point > 0
       AND il.quantity_on_hand <= il.reorder_point${storeFilter}`,
    args
  );

  let fired = 0;
  for (const row of rows) {
    const isNewRow = row.last_alerted_at === null && row.last_on_hand === null;
    const recoveredThenDropped =
      row.last_on_hand !== null && row.last_on_hand > row.reorder_point;
    const cooldownElapsed =
      row.last_alerted_at !== null &&
      now.getTime() - new Date(row.last_alerted_at).getTime() >= cooldownMs;

    const shouldAlert = isNewRow || recoveredThenDropped || cooldownElapsed;

    if (shouldAlert) {
      const payload: Record<string, unknown> = {
        variant_id: row.variant_id,
        warehouse_id: row.warehouse_id,
        on_hand: row.on_hand,
        reorder_point: row.reorder_point,
      };
      if (row.sku !== null) payload["sku"] = row.sku;
      dispatch(row.store_id, "inventory.low", payload);
      fired++;
      await upsertLowAlertState(pool, row.store_id, row.variant_id, row.warehouse_id, {
        last_alerted_at: now,
        last_on_hand: row.on_hand,
      });
    } else {
      // Still low but already alerted within cooldown — refresh last_on_hand only.
      await upsertLowAlertState(pool, row.store_id, row.variant_id, row.warehouse_id, {
        last_on_hand: row.on_hand,
      });
    }
  }

  // Record recovery: items that have a stale alert row but are now ABOVE reorder
  // point. Setting last_on_hand above reorder_point means a future drop re-alerts.
  const recoveryArgs: unknown[] = [];
  let recoveryStoreFilter = "";
  if (storeId) {
    recoveryArgs.push(storeId);
    recoveryStoreFilter = ` AND p.store_id = $1::uuid`;
  }
  await pool.query(
    `UPDATE inventory_low_alerts la
     SET last_on_hand = il.quantity_on_hand, updated_at = now()
     FROM inventory_levels il
     JOIN product_variants pv ON pv.id = il.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE la.variant_id = il.variant_id
       AND la.warehouse_id = il.warehouse_id
       AND (il.reorder_point IS NULL OR il.reorder_point <= 0
            OR il.quantity_on_hand > il.reorder_point)
       AND la.last_on_hand IS DISTINCT FROM il.quantity_on_hand${recoveryStoreFilter}`,
    recoveryArgs
  );

  return fired;
}

/** Upsert the per-(variant, warehouse) low-alert state row. */
async function upsertLowAlertState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg.Pool | PoolClient
  client: { query: (...a: any[]) => Promise<unknown> },
  storeId: string,
  variantId: string,
  warehouseId: string,
  data: { last_alerted_at?: Date; last_on_hand: number }
): Promise<void> {
  await client.query(
    `INSERT INTO inventory_low_alerts
       (store_id, variant_id, warehouse_id, last_alerted_at, last_on_hand)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)
     ON CONFLICT (variant_id, warehouse_id) DO UPDATE
       SET last_alerted_at = COALESCE($4, inventory_low_alerts.last_alerted_at),
           last_on_hand    = $5,
           updated_at      = now()`,
    [storeId, variantId, warehouseId, data.last_alerted_at ?? null, data.last_on_hand]
  );
}

/**
 * List current low-stock items for a store (dashboard view). RLS-enforced read
 * path. Returns tracked variants at/below their reorder_point.
 */
export async function listLowStockItems(storeId: string) {
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT il.variant_id::text, il.warehouse_id::text,
            il.quantity_on_hand AS on_hand, il.reorder_point, il.reorder_qty,
            pv.sku, pv.title AS variant_title, p.title AS product_title,
            w.name AS warehouse_name,
            la.last_alerted_at
     FROM inventory_levels il
     JOIN product_variants pv ON pv.id = il.variant_id
     JOIN products p ON p.id = pv.product_id
     JOIN warehouses w ON w.id = il.warehouse_id
     LEFT JOIN inventory_low_alerts la
       ON la.variant_id = il.variant_id AND la.warehouse_id = il.warehouse_id
     WHERE p.store_id = $1::uuid
       AND pv.track_inventory = true
       AND il.reorder_point IS NOT NULL
       AND il.reorder_point > 0
       AND il.quantity_on_hand <= il.reorder_point
     ORDER BY (il.reorder_point - il.quantity_on_hand) DESC, p.title, pv.title`,
    [storeId]
  );
  return rows;
}
