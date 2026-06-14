/**
 * carts/service.ts — Cart CRUD service.
 *
 * Business rules (ported from webcrft-mono):
 *  - Cart currency defaults to store's currency.
 *  - Cart expires 7 days after creation (expires_at).
 *  - Price is snapshotted from product_variants.price at add time.
 *  - If the same variant is already in the cart, quantity is incremented.
 *  - IDOR protection: all queries filter by store_id from request.auth.
 *  - maxCartLineQuantity = 1000.
 */

import { getPool, getReadDb } from "../../db/pool.js";

export const MAX_CART_LINE_QUANTITY = 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CartLine {
  id: string;
  cart_id: string;
  variant_id: string;
  quantity: number;
  price: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  sku?: string;
  variant_title?: string;
  product_title?: string;
}

export interface Cart {
  id: string;
  store_id: string;
  customer_id: string | null;
  currency: string;
  status: string;
  metadata: Record<string, unknown> | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  lines?: CartLine[];
}

// ── Service functions ─────────────────────────────────────────────────────────

/**
 * Create a new cart, deriving currency from the store.
 * Returns the new cart id.
 */
export async function createCart(
  storeId: string,
  opts: {
    currency?: string;
    customerId?: string;
  } = {}
): Promise<string> {
  const pool = getPool();

  let currency = opts.currency ?? "";
  if (!currency) {
    const { rows } = await pool.query<{ currency: string }>(
      `SELECT currency FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    currency = rows[0]?.currency ?? "ZAR";
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO carts (store_id, customer_id, currency, expires_at)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id::text`,
    [storeId, opts.customerId ?? null, currency, expiresAt]
  );
  const row = rows[0];
  if (!row) throw new Error("createCart: no row returned");
  return row.id;
}

/**
 * Get a cart with its lines. Returns null if not found or doesn't belong to store.
 */
export async function getCart(storeId: string, cartId: string): Promise<Cart | null> {
  const pool = getReadDb();

  const { rows: cartRows } = await pool.query<Cart>(
    `SELECT id::text, store_id::text, customer_id::text, currency, status,
            metadata, expires_at, created_at, updated_at
     FROM carts
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [cartId, storeId]
  );
  if (cartRows.length === 0) return null;

  const cart = cartRows[0]!;

  const { rows: lineRows } = await pool.query<CartLine>(
    `SELECT cl.id::text, cl.cart_id::text, cl.variant_id::text,
            cl.quantity, cl.price::text, cl.metadata, cl.created_at, cl.updated_at,
            pv.sku, pv.title AS variant_title, p.title AS product_title
     FROM cart_lines cl
     JOIN product_variants pv ON pv.id = cl.variant_id
     JOIN products p ON p.id = pv.product_id
     WHERE cl.cart_id = $1::uuid
     ORDER BY cl.created_at`,
    [cartId]
  );

  cart.lines = lineRows;
  return cart;
}

/**
 * Add a line to a cart. If the same variant already exists, increments qty.
 * Snapshots the price from product_variants at add time.
 * Returns the line id.
 *
 * Throws { code: "NOT_FOUND" } if cart or variant not in store.
 * Throws { code: "VALIDATION_ERROR" } for bad quantity.
 */
export async function addCartLine(
  storeId: string,
  cartId: string,
  variantId: string,
  quantity: number
): Promise<string> {
  const pool = getPool();

  if (quantity < 1) {
    const e = new Error("quantity must be at least 1");
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }
  if (quantity > MAX_CART_LINE_QUANTITY) {
    const e = new Error(`quantity exceeds maximum (${MAX_CART_LINE_QUANTITY})`);
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  // Verify cart belongs to store
  const { rows: cartRows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM carts WHERE id = $1::uuid AND store_id = $2::uuid) AS exists`,
    [cartId, storeId]
  );
  if (!cartRows[0]?.exists) {
    const e = new Error("cart not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }

  // Fetch current price snapshot — verify variant belongs to this store
  const { rows: varRows } = await pool.query<{ price: string }>(
    `SELECT pv.price::text FROM product_variants pv
     JOIN products p ON p.id = pv.product_id
     WHERE pv.id = $1::uuid AND p.store_id = $2::uuid`,
    [variantId, storeId]
  );
  if (varRows.length === 0) {
    const e = new Error("variant not found in this store");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }
  const price = varRows[0]!.price;

  // Upsert: increment if line exists, else insert
  const { rows: existRows } = await pool.query<{ id: string }>(
    `SELECT cl.id::text FROM cart_lines cl
     JOIN carts c ON c.id = cl.cart_id AND c.store_id = $3::uuid
     WHERE cl.cart_id = $1::uuid AND cl.variant_id = $2::uuid`,
    [cartId, variantId, storeId]
  );

  let lineId: string;
  if (existRows.length > 0 && existRows[0]) {
    lineId = existRows[0].id;
    await pool.query(
      `UPDATE cart_lines SET quantity = quantity + $2, updated_at = now() WHERE id = $1::uuid`,
      [lineId, quantity]
    );
  } else {
    const { rows: insertRows } = await pool.query<{ id: string }>(
      `INSERT INTO cart_lines (cart_id, variant_id, quantity, price)
       VALUES ($1::uuid, $2::uuid, $3, $4::numeric)
       RETURNING id::text`,
      [cartId, variantId, quantity, price]
    );
    lineId = insertRows[0]!.id;
  }

  // Touch cart updated_at
  await pool.query(
    `UPDATE carts SET updated_at = now() WHERE id = $1::uuid`,
    [cartId]
  );

  return lineId;
}

/**
 * Update a cart line quantity.
 * qty <= 0 deletes the line.
 * IDOR-safe: joins through carts.store_id.
 */
export async function updateCartLine(
  storeId: string,
  cartId: string,
  lineId: string,
  quantity: number
): Promise<void> {
  const pool = getPool();

  if (quantity > MAX_CART_LINE_QUANTITY) {
    const e = new Error(`quantity exceeds maximum (${MAX_CART_LINE_QUANTITY})`);
    (e as NodeJS.ErrnoException).code = "VALIDATION_ERROR";
    throw e;
  }

  if (quantity <= 0) {
    // Delete the line
    const { rowCount } = await pool.query(
      `DELETE FROM cart_lines USING carts c
       WHERE cart_lines.id = $1::uuid AND cart_lines.cart_id = $2::uuid
         AND c.id = cart_lines.cart_id AND c.store_id = $3::uuid`,
      [lineId, cartId, storeId]
    );
    if ((rowCount ?? 0) === 0) {
      const e = new Error("cart line not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }
  } else {
    // Update quantity
    const { rowCount } = await pool.query(
      `UPDATE cart_lines SET quantity = $3, updated_at = now()
       FROM carts c
       WHERE cart_lines.id = $1::uuid AND cart_lines.cart_id = $2::uuid
         AND c.id = cart_lines.cart_id AND c.store_id = $4::uuid`,
      [lineId, cartId, quantity, storeId]
    );
    if ((rowCount ?? 0) === 0) {
      const e = new Error("cart line not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }
  }

  await pool.query(
    `UPDATE carts SET updated_at = now() WHERE id = $1::uuid AND store_id = $2::uuid`,
    [cartId, storeId]
  );
}

/**
 * Remove a cart line.
 * IDOR-safe: joins through carts.store_id.
 */
export async function removeCartLine(
  storeId: string,
  cartId: string,
  lineId: string
): Promise<void> {
  const pool = getPool();

  const { rowCount } = await pool.query(
    `DELETE FROM cart_lines USING carts c
     WHERE cart_lines.id = $1::uuid AND cart_lines.cart_id = $2::uuid
       AND c.id = cart_lines.cart_id AND c.store_id = $3::uuid`,
    [lineId, cartId, storeId]
  );
  if ((rowCount ?? 0) === 0) {
    const e = new Error("cart line not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }

  await pool.query(
    `UPDATE carts SET updated_at = now() WHERE id = $1::uuid AND store_id = $2::uuid`,
    [cartId, storeId]
  );
}

/**
 * List abandoned carts for a store.
 * Abandoned = status = 'abandoned'.
 */
export async function listAbandonedCarts(
  storeId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<Cart[]> {
  const pool = getReadDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const { rows } = await pool.query<Cart>(
    `SELECT id::text, store_id::text, customer_id::text, currency, status,
            metadata, expires_at, created_at, updated_at
     FROM carts
     WHERE store_id = $1::uuid AND status = 'abandoned'
     ORDER BY updated_at DESC
     LIMIT $2 OFFSET $3`,
    [storeId, limit, offset]
  );
  return rows;
}

/**
 * Mark a cart as abandoned, generate a recovery_token.
 * Returns the recovery token.
 */
export async function markCartAbandoned(
  storeId: string,
  cartId: string
): Promise<string> {
  const pool = getPool();
  const { randomBytes } = await import("node:crypto");
  const recoveryToken = randomBytes(24).toString("hex");

  const { rowCount } = await pool.query(
    `UPDATE carts
     SET status = 'abandoned', recovery_token = $3, updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND status = 'active'`,
    [cartId, storeId, recoveryToken]
  );
  if ((rowCount ?? 0) === 0) {
    const e = new Error("cart not found or not active");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }
  return recoveryToken;
}
