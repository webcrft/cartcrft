/**
 * checkout-links/service.ts — Shareable checkout / payment links.
 *
 * A checkout link encodes a prefilled cart snapshot behind an unguessable
 * public token (cl_<random>). The hosted /pay/<token> page resolves the link,
 * shows the items + computed totals, and starts a real checkout + provider
 * payment session — REUSING the existing carts + checkout + payment-session
 * machinery so the existing webhook path finalises the order.
 *
 * Security model:
 *  - The merchant create/list/void paths run under storeAuthWrite + RLS (the
 *    storeId comes from request.auth, never the URL alone), exactly like carts.
 *  - The public resolve/start-payment paths look the row up by TOKEN ONLY. They
 *    never accept a caller-supplied store_id, so they cannot leak or mutate
 *    cross-store data. The token is the capability.
 *  - Snapshot unit prices are validated against live variant prices at creation
 *    time (variants must belong to the store); the order itself re-fetches live
 *    prices at completion (see checkout/complete.ts invariant 2).
 *
 * Money: decimal strings in the API, numeric(15,2) in DB.
 */

import { randomBytes } from "node:crypto";
import { getPool, getReadDb } from "../../db/pool.js";
import { round2 } from "../../lib/money.js";
import { calcTax, extractAddressCodes } from "../../lib/tax.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckoutLinkLineInput {
  variant_id: string;
  quantity: number;
}

/** A snapshot line as persisted in line_items jsonb. */
export interface CheckoutLinkSnapshotLine {
  variant_id: string;
  qty: number;
  /** unit price (decimal string) snapshotted at creation. */
  unit_price: string;
  /** display-only enrichments (not part of the price contract). */
  title?: string;
  sku?: string;
}

export interface CreateCheckoutLinkInput {
  line_items: CheckoutLinkLineInput[];
  customer_email?: string;
  success_url?: string;
  cancel_url?: string;
  /** ISO timestamp; when present the link auto-expires. */
  expires_at?: string;
  created_by?: string;
}

export interface CheckoutLinkRow {
  id: string;
  store_id: string;
  token: string;
  line_items: CheckoutLinkSnapshotLine[];
  currency: string;
  customer_email: string | null;
  success_url: string | null;
  cancel_url: string | null;
  status: "open" | "completed" | "expired" | "void";
  expires_at: Date | null;
  completed_checkout_id: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Computed totals for a snapshot — decimal strings. */
export interface CheckoutLinkTotals {
  subtotal: string;
  tax_total: string;
  shipping_total: string;
  total: string;
  currency: string;
}

/** Public-facing payload for the hosted page (NO store_id / internal ids). */
export interface ResolvedCheckoutLink {
  token: string;
  status: "open" | "completed" | "expired" | "void";
  store: { name: string };
  line_items: Array<{
    variant_id: string;
    qty: number;
    unit_price: string;
    line_total: string;
    title: string;
    sku: string;
  }>;
  totals: CheckoutLinkTotals;
  customer_email: string | null;
  success_url: string | null;
  cancel_url: string | null;
  expires_at: Date | null;
}

// ── Error helper ───────────────────────────────────────────────────────────────

function err(message: string, code: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

// ── Token generation ───────────────────────────────────────────────────────────

function generateToken(): string {
  return "cl_" + randomBytes(24).toString("base64url");
}

// ── Snapshot pricing ────────────────────────────────────────────────────────────

/**
 * Compute totals from a snapshot. Tax is estimated using the store's default
 * tax config (no address → store-default zone). Shipping is estimated as 0 for
 * the link preview (the hosted page collects no address); the real order
 * recomputes shipping/tax at checkout time if an address is supplied.
 */
async function computeTotals(
  storeId: string,
  lines: CheckoutLinkSnapshotLine[],
  currency: string
): Promise<CheckoutLinkTotals> {
  const subtotal = round2(
    lines.reduce((acc, l) => acc + parseFloat(l.unit_price) * l.qty, 0)
  );

  // Tax estimate with no address → store-default zone (extractAddressCodes(null)).
  const { countryCode, provinceCode } = extractAddressCodes(null);
  const taxResult = await calcTax(getPool(), storeId, subtotal, countryCode, provinceCode);

  const shippingTotal = 0;
  const total = round2(subtotal + taxResult.taxTotal + shippingTotal);

  return {
    subtotal: subtotal.toFixed(2),
    tax_total: taxResult.taxTotal.toFixed(2),
    shipping_total: shippingTotal.toFixed(2),
    total: total.toFixed(2),
    currency,
  };
}

// ── Create ──────────────────────────────────────────────────────────────────────

/**
 * Create a checkout link for a store.
 *
 * Validates every variant belongs to the store and snapshots its current price.
 * Currency is derived from the store (carts/checkouts use the store currency).
 *
 * Throws { code: "VALIDATION_ERROR" } for empty/invalid line_items,
 *        { code: "NOT_FOUND" } if a variant is not in the store.
 */
export async function createCheckoutLink(
  storeId: string,
  input: CreateCheckoutLinkInput
): Promise<{ id: string; token: string }> {
  const pool = getPool();

  if (!input.line_items || input.line_items.length === 0) {
    throw err("line_items must contain at least one item", "VALIDATION_ERROR");
  }

  // Derive store currency.
  const { rows: storeRows } = await pool.query<{ currency: string }>(
    `SELECT currency FROM stores WHERE id = $1::uuid`,
    [storeId]
  );
  if (!storeRows[0]) {
    throw err("store not found", "NOT_FOUND");
  }
  const currency = storeRows[0].currency;

  // Snapshot each line: validate variant ∈ store, capture live price.
  const snapshot: CheckoutLinkSnapshotLine[] = [];
  for (const li of input.line_items) {
    const qty = Math.trunc(li.quantity);
    if (qty < 1) {
      throw err("quantity must be at least 1", "VALIDATION_ERROR");
    }
    const { rows } = await pool.query<{
      price: string;
      title: string;
      sku: string;
    }>(
      `SELECT pv.price::text,
              COALESCE(pv.title, p.title, 'Item') AS title,
              COALESCE(pv.sku, '') AS sku
       FROM product_variants pv
       JOIN products p ON p.id = pv.product_id
       WHERE pv.id = $1::uuid AND p.store_id = $2::uuid`,
      [li.variant_id, storeId]
    );
    if (!rows[0]) {
      throw err(`variant ${li.variant_id} not found in this store`, "NOT_FOUND");
    }
    snapshot.push({
      variant_id: li.variant_id,
      qty,
      unit_price: parseFloat(rows[0].price).toFixed(2),
      title: rows[0].title,
      sku: rows[0].sku,
    });
  }

  // expires_at validation
  let expiresAt: string | null = null;
  if (input.expires_at) {
    const d = new Date(input.expires_at);
    if (isNaN(d.getTime())) {
      throw err("expires_at must be a valid ISO timestamp", "VALIDATION_ERROR");
    }
    expiresAt = d.toISOString();
  }

  const token = generateToken();

  const { rows: insertRows } = await pool.query<{ id: string; token: string }>(
    `INSERT INTO checkout_links
       (store_id, token, line_items, currency, customer_email,
        success_url, cancel_url, expires_at, created_by)
     VALUES ($1::uuid, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
     RETURNING id::text, token`,
    [
      storeId,
      token,
      JSON.stringify(snapshot),
      currency,
      input.customer_email ?? null,
      input.success_url ?? null,
      input.cancel_url ?? null,
      expiresAt,
      input.created_by ?? null,
    ]
  );

  const row = insertRows[0];
  if (!row) throw new Error("createCheckoutLink: no row returned");
  return { id: row.id, token: row.token };
}

// ── Merchant list / void ─────────────────────────────────────────────────────────

export async function listCheckoutLinks(
  storeId: string,
  opts: { limit?: number; offset?: number; status?: string } = {}
): Promise<CheckoutLinkRow[]> {
  const pool = getReadDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const params: unknown[] = [storeId];
  let statusClause = "";
  if (opts.status) {
    params.push(opts.status);
    statusClause = ` AND status = $${params.length}::public.checkout_link_status`;
  }
  params.push(limit, offset);

  const { rows } = await pool.query<CheckoutLinkRow>(
    `SELECT id::text, store_id::text, token, line_items, currency,
            customer_email, success_url, cancel_url, status,
            expires_at, completed_checkout_id::text, created_by,
            created_at, updated_at
     FROM checkout_links
     WHERE store_id = $1::uuid${statusClause}
     ORDER BY created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

/**
 * Void a checkout link (merchant). Only 'open' links can be voided.
 * IDOR-safe: filters by store_id.
 */
export async function voidCheckoutLink(
  storeId: string,
  linkId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE checkout_links
     SET status = 'void', updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND status = 'open'`,
    [linkId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Public token resolution ──────────────────────────────────────────────────────

/**
 * Load a checkout link by its public token (no store context).
 * Returns the raw row or null. Uses the pool directly (owner role) because the
 * public path has no request context — the token is the capability.
 *
 * Lazily transitions 'open' → 'expired' when past expires_at.
 */
async function loadByToken(token: string): Promise<CheckoutLinkRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<CheckoutLinkRow>(
    `SELECT id::text, store_id::text, token, line_items, currency,
            customer_email, success_url, cancel_url, status,
            expires_at, completed_checkout_id::text, created_by,
            created_at, updated_at
     FROM checkout_links
     WHERE token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;

  // Lazy expiry: flip open → expired once past the deadline.
  if (
    row.status === "open" &&
    row.expires_at &&
    new Date(row.expires_at).getTime() <= Date.now()
  ) {
    await pool.query(
      `UPDATE checkout_links SET status = 'expired', updated_at = now()
       WHERE id = $1::uuid AND status = 'open'`,
      [row.id]
    );
    row.status = "expired";
  }

  return row;
}

/**
 * Resolve a checkout link for the public hosted page.
 * Returns the store display name + line items + computed totals + status.
 * Never exposes store_id or any internal id.
 *
 * Throws { code: "NOT_FOUND" } if the token is unknown.
 */
export async function resolveCheckoutLink(
  token: string
): Promise<ResolvedCheckoutLink> {
  const link = await loadByToken(token);
  if (!link) {
    throw err("checkout link not found", "NOT_FOUND");
  }

  const pool = getReadDb();
  const { rows: storeRows } = await pool.query<{ name: string }>(
    `SELECT name FROM stores WHERE id = $1::uuid`,
    [link.store_id]
  );
  const storeName = storeRows[0]?.name ?? "Store";

  const totals = await computeTotals(link.store_id, link.line_items, link.currency);

  const lineItems = link.line_items.map((l) => ({
    variant_id: l.variant_id,
    qty: l.qty,
    unit_price: parseFloat(l.unit_price).toFixed(2),
    line_total: (parseFloat(l.unit_price) * l.qty).toFixed(2),
    title: l.title ?? "Item",
    sku: l.sku ?? "",
  }));

  return {
    token: link.token,
    status: link.status,
    store: { name: storeName },
    line_items: lineItems,
    totals,
    customer_email: link.customer_email,
    success_url: link.success_url,
    cancel_url: link.cancel_url,
    expires_at: link.expires_at,
  };
}

/**
 * Build a real cart + checkout from a checkout link snapshot.
 *
 * Returns { checkoutId, total, currency, email, storeId } so the caller can
 * drive the existing payment-session creators. Marks NOTHING on the link yet —
 * the link transitions to 'completed' when its checkout completes (webhook
 * finalisation path, or markLinkCompletedByCheckout below).
 *
 * Throws:
 *   { code: "LINK_NOT_OPEN" }  — expired / void / completed
 *   { code: "NOT_FOUND" }      — unknown token
 *   { code: "VALIDATION_ERROR" } — snapshot has no valid lines
 */
export async function startCheckoutFromLink(
  token: string,
  opts: { email?: string } = {}
): Promise<{
  linkId: string;
  storeId: string;
  checkoutId: string;
  total: string;
  currency: string;
  email: string | null;
}> {
  const link = await loadByToken(token);
  if (!link) {
    throw err("checkout link not found", "NOT_FOUND");
  }
  if (link.status !== "open") {
    throw err(`checkout link is ${link.status}`, "LINK_NOT_OPEN");
  }
  if (!link.line_items || link.line_items.length === 0) {
    throw err("checkout link has no line items", "VALIDATION_ERROR");
  }

  const storeId = link.store_id;
  const email = opts.email?.trim() || link.customer_email || null;

  // Reuse the existing carts + checkout services so the order pipeline +
  // webhook finalisation behave identically to native checkout.
  const { createCart, addCartLine } = await import("../carts/service.js");
  const { createCheckout } = await import("../checkout/service.js");

  const cartId = await createCart(storeId, { currency: link.currency });

  // Add lines from the snapshot. addCartLine re-validates variant ∈ store and
  // re-snapshots the LIVE price (so a stale link can't lock in an old price).
  for (const li of link.line_items) {
    await addCartLine(storeId, cartId, li.variant_id, li.qty);
  }

  const checkout = await createCheckout(storeId, {
    cart_id: cartId,
    ...(email ? { email } : {}),
  });

  // Stamp the checkout id on the link NOW (still 'open'). When this checkout
  // completes — either via the storefront /complete call or the provider
  // webhook finalisation path — markLinkCompletedByCheckout(checkoutId) flips
  // the link to 'completed'. Stamping here (not at completion) keeps the link↔
  // checkout association even if the webhook is the only thing that fires.
  const pool = getPool();
  await pool.query(
    `UPDATE checkout_links
     SET completed_checkout_id = $2::uuid, updated_at = now()
     WHERE id = $1::uuid AND status = 'open'`,
    [link.id, checkout.id]
  );

  return {
    linkId: link.id,
    storeId,
    checkoutId: checkout.id,
    total: checkout.total.toFixed(2),
    currency: checkout.currency,
    email,
  };
}

/**
 * Mark a checkout link 'completed' and stamp the checkout id.
 * Idempotent: only transitions an 'open' link. Best-effort — never throws on
 * the no-row case (a webhook may fire for a checkout not backed by a link).
 */
export async function markLinkCompleted(
  linkId: string,
  checkoutId: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE checkout_links
     SET status = 'completed', completed_checkout_id = $2::uuid, updated_at = now()
     WHERE id = $1::uuid AND status = 'open'`,
    [linkId, checkoutId]
  );
}

/**
 * Mark the checkout link backing a given checkout 'completed'.
 * Called from the webhook finalisation path (which only knows the checkout id).
 * No-op when no link references the checkout.
 */
export async function markLinkCompletedByCheckout(
  checkoutId: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE checkout_links
     SET status = 'completed', updated_at = now()
     WHERE completed_checkout_id = $1::uuid AND status = 'open'`,
    [checkoutId]
  );
}
