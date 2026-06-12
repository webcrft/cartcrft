/**
 * engagement/types.ts — TypeScript types for wishlists and abandoned carts.
 *
 * Note: product reviews are implemented in catalog module (T2.2).
 * This module covers wishlists (with share tokens) + abandoned carts.
 */

export interface Wishlist {
  id: string;
  store_id: string;
  customer_id: string | null;
  session_id: string | null;
  name: string;
  share_token: string | null;
  created_at: Date;
  updated_at: Date;
  items?: WishlistItem[];
}

export interface WishlistItem {
  id: string;
  wishlist_id: string;
  product_id: string;
  variant_id: string | null;
  note: string | null;
  added_at: Date;
  product_title?: string;
  product_slug?: string;
}

export interface CreateWishlistInput {
  customer_id?: string | null | undefined;
  session_id?: string | null | undefined;
  name?: string | null | undefined;
}

export interface AddWishlistItemInput {
  product_id: string;
  variant_id?: string | null | undefined;
  note?: string | null | undefined;
}

export interface AbandonedCart {
  id: string;
  store_id: string;
  cart_id: string;
  customer_id: string | null;
  email: string | null;
  abandoned_at: Date;
  recovered_at: Date | null;
  recovery_order_id: string | null;
  last_notified_at: Date | null;
  notification_count: number;
  created_at: Date;
}
