/**
 * engagement/service.ts — SQL-backed wishlists and abandoned carts service.
 *
 * Wishlists:
 *  - CRUD with share_token (UUID auto-generated on creation)
 *  - Public GET by share_token (no auth required)
 *  - Items: upsert (product_id + variant_id unique within wishlist)
 *  - IDOR protection: customer JWT limits scope to own wishlists
 *
 * Abandoned carts:
 *  - List abandoned carts for admin
 *  - Mark cart abandoned (upsert by cart_id)
 *  - Mark recovered
 *
 * Note: product reviews are in catalog module; abandoned cart MARK endpoint
 * is in carts module (T2.3). This module provides the admin listing.
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import type {
  Wishlist,
  WishlistItem,
  CreateWishlistInput,
  AddWishlistItemInput,
  AbandonedCart,
} from "./types.js";

// ── Wishlists ─────────────────────────────────────────────────────────────────

export async function listWishlists(
  storeId: string,
  customerId?: string | null
): Promise<Wishlist[]> {
  const pool = getReadDb();
  if (customerId) {
    const { rows } = await pool.query<Wishlist>(
      `SELECT * FROM wishlists WHERE store_id = $1::uuid AND customer_id = $2::uuid ORDER BY created_at DESC`,
      [storeId, customerId]
    );
    return rows;
  }
  const { rows } = await pool.query<Wishlist>(
    `SELECT * FROM wishlists WHERE store_id = $1::uuid ORDER BY created_at DESC`,
    [storeId]
  );
  return rows;
}

export async function getWishlist(
  storeId: string,
  wishlistId: string
): Promise<Wishlist | null> {
  const pool = getReadDb();
  const { rows } = await pool.query<Wishlist>(
    `SELECT * FROM wishlists WHERE id = $1::uuid AND store_id = $2::uuid`,
    [wishlistId, storeId]
  );
  if (!rows[0]) return null;
  const wl = rows[0];

  const { rows: itemRows } = await pool.query<WishlistItem>(
    `SELECT wi.*, p.title AS product_title, p.slug AS product_slug
     FROM wishlist_items wi JOIN products p ON p.id = wi.product_id
     WHERE wi.wishlist_id = $1::uuid ORDER BY wi.added_at`,
    [wishlistId]
  );
  wl.items = itemRows;
  return wl;
}

/**
 * Get a wishlist by its public share_token (no auth required).
 * Returns null if not found or share_token is null.
 */
export async function getWishlistByShareToken(
  storeId: string,
  shareToken: string
): Promise<Wishlist | null> {
  const pool = getPool();
  const { rows } = await pool.query<Wishlist>(
    `SELECT * FROM wishlists
     WHERE store_id = $1::uuid AND share_token = $2`,
    [storeId, shareToken]
  );
  if (!rows[0]) return null;
  const wl = rows[0];

  const { rows: itemRows } = await pool.query<WishlistItem>(
    `SELECT wi.*, p.title AS product_title, p.slug AS product_slug
     FROM wishlist_items wi JOIN products p ON p.id = wi.product_id
     WHERE wi.wishlist_id = $1::uuid ORDER BY wi.added_at`,
    [wl.id]
  );
  wl.items = itemRows;
  return wl;
}

export async function createWishlist(
  storeId: string,
  input: CreateWishlistInput
): Promise<Wishlist | null> {
  const pool = getPool();
  const name = (input.name ?? "My Wishlist").trim() || "My Wishlist";

  const { rows } = await pool.query<Wishlist>(
    `INSERT INTO wishlists (store_id, customer_id, session_id, name)
     VALUES ($1::uuid, $2::uuid, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [storeId, input.customer_id ?? null, input.session_id ?? null, name]
  );
  if (rows[0]) return rows[0];

  // ON CONFLICT DO NOTHING — already exists: fetch it
  if (input.customer_id) {
    const { rows: existing } = await pool.query<Wishlist>(
      `SELECT * FROM wishlists WHERE store_id = $1::uuid AND customer_id = $2::uuid LIMIT 1`,
      [storeId, input.customer_id]
    );
    return existing[0] ?? null;
  }
  if (input.session_id) {
    const { rows: existing } = await pool.query<Wishlist>(
      `SELECT * FROM wishlists WHERE store_id = $1::uuid AND session_id = $2 LIMIT 1`,
      [storeId, input.session_id]
    );
    return existing[0] ?? null;
  }
  return null;
}

export async function deleteWishlist(
  storeId: string,
  wishlistId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM wishlists WHERE id = $1::uuid AND store_id = $2::uuid`,
    [wishlistId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

export async function addWishlistItem(
  storeId: string,
  wishlistId: string,
  input: AddWishlistItemInput
): Promise<WishlistItem | null> {
  const pool = getPool();

  // Verify wishlist exists and belongs to store
  const { rows: wlRows } = await pool.query<{ id: string }>(
    `SELECT id::text FROM wishlists WHERE id = $1::uuid AND store_id = $2::uuid`,
    [wishlistId, storeId]
  );
  if (!wlRows[0]) return null;

  const variantArg = input.variant_id ?? null;
  const noteArg = input.note ?? null;

  // Upsert: find existing item with same product+variant, update or insert
  const { rows } = await pool.query<WishlistItem>(
    `WITH existing AS (
       SELECT id FROM wishlist_items
       WHERE wishlist_id = $1::uuid
         AND product_id  = $2::uuid
         AND variant_id IS NOT DISTINCT FROM $3::uuid
       LIMIT 1
     ),
     upd AS (
       UPDATE wishlist_items SET note = $4
       WHERE id = (SELECT id FROM existing)
       RETURNING *
     ),
     ins AS (
       INSERT INTO wishlist_items (wishlist_id, product_id, variant_id, note)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4
       WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING *
     )
     SELECT * FROM upd UNION ALL SELECT * FROM ins`,
    [wishlistId, input.product_id, variantArg, noteArg]
  );
  return rows[0] ?? null;
}

export async function removeWishlistItem(
  storeId: string,
  wishlistId: string,
  itemId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM wishlist_items wi
     USING wishlists wl
     WHERE wi.id = $1::uuid AND wi.wishlist_id = wl.id
       AND wl.id = $2::uuid AND wl.store_id = $3::uuid`,
    [itemId, wishlistId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Abandoned carts ───────────────────────────────────────────────────────────

export async function listAbandonedCarts(storeId: string): Promise<AbandonedCart[]> {
  const pool = getReadDb();
  const { rows } = await pool.query<AbandonedCart>(
    `SELECT ac.id::text, ac.store_id::text, ac.cart_id::text, ac.customer_id::text,
            ac.email, ac.abandoned_at, ac.recovered_at, ac.recovery_order_id::text,
            ac.last_notified_at, ac.notification_count, ac.created_at
     FROM abandoned_carts ac
     WHERE ac.store_id = $1::uuid
     ORDER BY ac.abandoned_at DESC
     LIMIT 100`,
    [storeId]
  );
  return rows;
}

export async function markCartRecovered(
  storeId: string,
  cartId: string,
  orderId?: string
): Promise<{ recovered_at: string; recovery_order_id: string | null } | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ recovered_at: string; recovery_order_id: string | null }>(
    `UPDATE abandoned_carts
     SET recovered_at = now(),
         recovery_order_id = $3::uuid,
         updated_at = now()
     WHERE cart_id = $1::uuid AND store_id = $2::uuid AND recovered_at IS NULL
     RETURNING recovered_at, recovery_order_id::text`,
    [cartId, storeId, orderId ?? null]
  );
  return rows[0] ?? null;
}
