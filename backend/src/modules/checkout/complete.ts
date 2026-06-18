/**
 * checkout/complete.ts — Atomic cart-to-order conversion.
 *
 * Ported faithfully from:
 *   webcrft-mono/backend/internal/commerce/checkout/complete.go (CompleteByID)
 *   webcrft-mono/backend/internal/handlers/commerce_checkout.go (burnCheckoutDiscount)
 *
 * Go invariants preserved (numbered to match the critical notes):
 *
 *  1. Single transaction (withTx) wrapping ALL mutations — the caller wraps
 *     this function inside a withTx; or callers BEGIN externally and pass a client.
 *     completeCheckout() opens its own transaction via withTx for the HTTP handler path.
 *
 *  2. Re-fetch variant prices inside the transaction (guard price drift) — done
 *     via SELECT cart_lines JOIN product_variants inside the tx, updating cart_lines
 *     and checkouts if prices changed.
 *
 *  3. Row-lock variants in consistent ID order to avoid deadlocks — inventory_levels
 *     are selected FOR UPDATE with ORDER BY id so concurrent checkouts serialise
 *     on the same rows without deadlock.
 *
 *  4. Use next_order_number(store_id) SQL function for sequential order numbers —
 *     SELECT next_order_number($1::uuid) inside the tx.
 *
 *  5. Create order row first, then order_lines — order INSERT RETURNING id, then
 *     INSERT INTO order_lines.
 *
 *  6. Decrement inventory_levels with per-row verification — query on-hand > 0,
 *     validate in TS, then UPDATE. Returns INSUFFICIENT_INVENTORY error if any
 *     tracked variant is out of stock.
 *
 *  7. Record discount_usages with INSERT…ON CONFLICT DO NOTHING (race-safe
 *     once-per-customer) — mirrors Go's M6 invariant exactly.
 *
 *  8. Mark checkout.status = 'completed', cart.status = 'converted' atomically
 *     inside the same transaction.
 *
 *  9. Return error if checkout already completed (idempotency) — the initial
 *     SELECT filters WHERE status = 'pending'; pgx.ErrNoRows surfaces as 404.
 */

import type pg from "pg";
import { withTx } from "../../db/pool.js";
import { round2 } from "../../lib/money.js";
import type { AgentHeaderCtx } from "../agents/types.js";
import { dispatchStoreEvent } from "../notifications/service.js";
import { earnPointsForOrder } from "../loyalty/service.js";
import { computeDiscounts, type DiscountCartLine } from "../discounts/service.js";

// ── Result type ───────────────────────────────────────────────────────────────

export interface CompleteResult {
  orderId: string;
  orderNumber: string;
  currency: string;
  total: number;
  itemCount: number;
}

// ── Custom error codes ────────────────────────────────────────────────────────

export class CheckoutError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** A single discount to burn (already resolved to a row) inside the tx. */
interface BurnTarget {
  discountId: string;
  /** "code" → discount_codes, "auto" → automatic_discounts. */
  table: "code" | "auto";
  oncePerCustomer: boolean;
  amount: number;
}

/**
 * Burn a resolved set of discounts atomically inside the checkout transaction.
 *
 * For EACH target (explicit code and/or automatic discounts that were applied):
 *  - Atomically increments uses_count WHERE max_uses IS NULL OR uses_count < max_uses
 *  - Inserts discount_usages ON CONFLICT DO NOTHING for once_per_customer rows
 *  - Throws DISCOUNT_EXHAUSTED or DISCOUNT_ALREADY_USED on failure
 *
 * Note: discount_usages.discount_id FKs discount_codes(id); automatic-discount
 * once_per_customer enforcement therefore relies on the uses_count cap (we do
 * not write a usages row for automatic discounts, since the FK target differs).
 * The percentage/fixed code path retains the full ON-CONFLICT burn (M6).
 */
async function burnDiscounts(
  client: pg.PoolClient,
  targets: BurnTarget[],
  customerId: string | null
): Promise<void> {
  for (const t of targets) {
    const table = t.table === "code" ? "discount_codes" : "automatic_discounts";

    // Atomic increment with cap check — mirrors Go's UPDATE … RETURNING uses_count
    const { rows: incRows } = await client.query<{ uses_count: number }>(
      `UPDATE ${table}
       SET uses_count = uses_count + 1
       WHERE id = $1::uuid AND (max_uses IS NULL OR uses_count < max_uses)
       RETURNING uses_count`,
      [t.discountId]
    );
    if (incRows.length === 0) {
      throw new CheckoutError("discount code exhausted", "DISCOUNT_EXHAUSTED");
    }

    // Per-customer usage record — M6 invariant: INSERT ON CONFLICT DO NOTHING.
    // discount_usages.discount_id FKs discount_codes, so only burn usages for
    // explicit codes; automatic once_per_customer is gated pre-flight + cap.
    if (t.table === "code" && t.oncePerCustomer && customerId) {
      const { rows: usageRows } = await client.query<{ one: number }>(
        `INSERT INTO discount_usages (discount_id, customer_id, amount_saved)
         VALUES ($1::uuid, $2::uuid, $3)
         ON CONFLICT (discount_id, customer_id) WHERE customer_id IS NOT NULL
         DO NOTHING
         RETURNING 1 AS one`,
        [t.discountId, customerId, t.amount]
      );
      if (usageRows.length === 0) {
        // Race lost — another concurrent completion for same (discount, customer)
        throw new CheckoutError(
          "discount code already used by this customer",
          "DISCOUNT_ALREADY_USED"
        );
      }
    }
  }
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * CompleteCheckout — converts a pending checkout into an open order.
 *
 * Opens its own withTx wrapper. Both the discount burn and the
 * cart→order conversion happen in the single transaction.
 *
 * @param agentCtx Optional agent attribution context from the request layer.
 *                 When present, verifyAgentCheckout() is called after the
 *                 FOR UPDATE checkout row lock (inside the transaction) to
 *                 enforce spend limits and mandate chain requirements.
 *
 * Returns CompleteResult on success.
 * Throws CheckoutError with code:
 *   NOT_FOUND                   — checkout not pending / not found
 *   DISCOUNT_EXHAUSTED          — cap reached between checkout and completion
 *   DISCOUNT_ALREADY_USED       — once_per_customer race lost
 *   INSUFFICIENT_INVENTORY      — variant out of stock
 *   MANDATE_SPEND_LIMIT_EXCEEDED — agent spend window exceeded
 *   MANDATE_REQUIRED            — mandate required but absent or invalid
 */
export async function completeCheckout(
  storeId: string,
  checkoutId: string,
  agentCtx?: AgentHeaderCtx | undefined
): Promise<CompleteResult> {
  const result = await withTx(async (client) => {
    // ── Step 2: Fetch checkout (must be pending) ──────────────────────────
    // (The discount burn moved to Step 4c, AFTER the authoritative discount
    //  recompute, so we only burn the discounts that actually applied.)
    // Invariant 9: status = 'pending' filter — errors on already-completed
    // FOR UPDATE: serialize concurrent completes on the same checkout row.
    // Without this, two concurrent transactions can both read 'pending' and
    // both proceed, creating duplicate orders (no oversell guard for
    // untracked-inventory checkouts).
    const { rows: chRows } = await client.query<{
      cart_id: string;
      customer_id: string | null;
      company_id: string | null;
      shipping_address: string | null;
      billing_address: string | null;
      shipping_rate: string | null;
      tax_lines: string | null;
      discount_lines: string | null;
      subtotal: string;
      shipping_total: string;
      tax_total: string;
      discount_total: string;
      total: string;
      currency: string;
    }>(
      `SELECT cart_id::text, customer_id::text, company_id::text,
              shipping_address::text, billing_address::text,
              shipping_rate::text, tax_lines::text, discount_lines::text,
              subtotal::text, shipping_total::text, tax_total::text,
              discount_total::text, total::text, currency
       FROM checkouts
       WHERE id = $1::uuid AND store_id = $2::uuid AND status = 'pending'
       FOR UPDATE`,
      [checkoutId, storeId]
    );
    if (chRows.length === 0) {
      throw new CheckoutError(
        "checkout not found or already completed",
        "NOT_FOUND"
      );
    }

    // ── Step 2b: Agent spend + mandate enforcement (after FOR UPDATE lock) ──
    // Only runs when the request carries agent attribution (agentCtx present).
    // Placed inside the transaction after the row lock so the spend-window
    // sum is serialised: no concurrent agent checkout can slip through between
    // the sum query and the eventual order INSERT.
    // Mandate id resolved by verifyAgentCheckout (when a payment mandate is
    // attached to this checkout). Stamped onto order.metadata.mandate_id below
    // so there is an auditable order → mandate → intent chain.
    let verifiedMandateId: string | null = null;
    if (agentCtx) {
      const checkoutTotal = parseFloat(chRows[0]!.total);

      // Fetch the store's agents_require_mandate flag.
      const { rows: storeRows } = await client.query<{ agents_require_mandate: boolean }>(
        `SELECT agents_require_mandate FROM stores WHERE id = $1::uuid`,
        [storeId]
      );
      const storeRequiresMandate = storeRows[0]?.agents_require_mandate ?? false;

      // Dynamic import keeps the agents module tree-shaken on non-agent code paths
      // (avoids circular-import risk; also reads naturally as "optional feature").
      const { verifyAgentCheckout } = await import("../agents/service.js");
      try {
        verifiedMandateId = await verifyAgentCheckout(
          agentCtx.agentId,
          storeId,
          checkoutId,
          checkoutTotal,
          storeRequiresMandate
        );
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "MANDATE_SPEND_LIMIT_EXCEEDED" || code === "MANDATE_REQUIRED") {
          throw new CheckoutError((err as Error).message, code);
        }
        throw err;
      }
    }

    const ch = chRows[0]!;
    const cartId = ch.cart_id;
    const customerId = ch.customer_id;
    let subtotal = parseFloat(ch.subtotal);
    const baseShipping = parseFloat(ch.shipping_total);
    let shippingTotal = baseShipping;
    const taxTotal = parseFloat(ch.tax_total);
    let discountTotal = parseFloat(ch.discount_total);
    let total = parseFloat(ch.total);
    const currency = ch.currency;

    // Resolve the explicit discount code (if any) from the stored discount_lines.
    // Automatic discounts carry an empty code; we re-derive them server-side.
    let storedCode = "";
    if (ch.discount_lines && ch.discount_lines !== "null") {
      try {
        const dls = JSON.parse(ch.discount_lines) as Array<Record<string, unknown>>;
        for (const dl of dls) {
          if (typeof dl["code"] === "string" && dl["code"]) {
            storedCode = dl["code"];
            break;
          }
        }
      } catch {
        /* malformed discount_lines → treat as no code */
      }
    }

    // ── Step 3: next_order_number (Invariant 4) ───────────────────────────
    const { rows: numRows } = await client.query<{ next_order_number: string }>(
      `SELECT next_order_number($1::uuid)`,
      [storeId]
    );
    const orderNumber = numRows[0]!.next_order_number;

    // ── Step 4: Re-fetch variant prices (Invariant 2) ─────────────────────
    // Guard against price drift between checkout creation and completion.
    // Also loads product_id so the discount engine can evaluate product/
    // collection-scoped rules (Step 4a).
    const { rows: priceRows } = await client.query<{
      variant_id: string;
      product_id: string;
      quantity: number;
      cart_price: string;
      current_price: string;
    }>(
      `SELECT cl.variant_id::text, pv.product_id::text, cl.quantity,
              cl.price::text AS cart_price, pv.price::text AS current_price
       FROM cart_lines cl
       JOIN product_variants pv ON pv.id = cl.variant_id
       WHERE cl.cart_id = $1::uuid`,
      [cartId]
    );

    let recomputedSubtotal = 0;
    let priceChanged = false;
    const engineLines: DiscountCartLine[] = [];

    for (const pr of priceRows) {
      const cartPrice = parseFloat(pr.cart_price);
      const currentPrice = parseFloat(pr.current_price);
      if (cartPrice !== currentPrice) {
        priceChanged = true;
        await client.query(
          `UPDATE cart_lines SET price = $1, updated_at = now()
           WHERE cart_id = $2::uuid AND variant_id = $3::uuid`,
          [currentPrice, cartId, pr.variant_id]
        );
      }
      recomputedSubtotal += currentPrice * pr.quantity;
      engineLines.push({
        variant_id: pr.variant_id,
        product_id: pr.product_id,
        qty: pr.quantity,
        price: currentPrice,
      });
    }

    subtotal = round2(recomputedSubtotal);

    // ── Step 4a: Authoritative discount recompute (server-side, in-tx) ────
    // Re-evaluate the explicit code + all eligible automatic discounts against
    // the CURRENT prices. This is the source of truth for discount_total and
    // free-shipping; the checkout-time values are a non-authoritative preview.
    // Domain carts never receive discounts.
    const cartHasDomain = await (async (): Promise<boolean> => {
      const { rows } = await client.query<{ found: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM cart_lines cl
           JOIN product_variants pv ON pv.id = cl.variant_id
           JOIN products p ON p.id = pv.product_id
           WHERE cl.cart_id = $1::uuid AND p.type = 'domain'
         ) AS found`,
        [cartId]
      );
      return rows[0]?.found === true;
    })();

    const burnTargets: BurnTarget[] = [];
    if (!cartHasDomain) {
      const disc = await computeDiscounts(client, {
        storeId,
        lines: engineLines,
        subtotal,
        shippingTotal: baseShipping,
        customerId,
        code: storedCode || null,
      });
      // A code that validated at checkout time but is now invalid (expired,
      // exhausted, once-per-customer race) surfaces as an error here.
      if (disc.error) {
        throw new CheckoutError("discount code exhausted", "DISCOUNT_EXHAUSTED");
      }
      discountTotal = disc.discountTotal;
      shippingTotal = disc.shippingTotal;

      // Resolve burn targets for every applied discount that carries a cap or
      // once-per-customer rule.  Resolve ids by code (codes) / title+type+amount
      // is not unique, so re-query automatic rows by their defining attributes.
      for (const line of disc.lines) {
        if (line.code) {
          const { rows } = await client.query<{ id: string; once_per_customer: boolean }>(
            `SELECT id::text, once_per_customer FROM discount_codes
             WHERE store_id = $1::uuid AND code = $2`,
            [storeId, line.code]
          );
          if (rows.length === 0) {
            throw new CheckoutError("discount code exhausted", "DISCOUNT_EXHAUSTED");
          }
          burnTargets.push({
            discountId: rows[0]!.id,
            table: "code",
            oncePerCustomer: rows[0]!.once_per_customer,
            amount: line.amount,
          });
        }
        // Automatic discounts: resolved + burned in Step 4c via a dedicated
        // re-evaluation (id is needed; computeDiscounts intentionally returns a
        // display-shaped line). We re-resolve below.
      }

      // Re-resolve automatic discount ids for burning (cap enforcement). We
      // mirror loadAutomaticRules' eligibility window so only currently-active
      // automatic rows that produced an applied line are burned.
      const autoLinesApplied = disc.lines.filter((l) => l.automatic);
      if (autoLinesApplied.length > 0) {
        const titles = autoLinesApplied.map((l) => l.title);
        const { rows: autoRows } = await client.query<{
          id: string;
          title: string;
          once_per_customer: boolean;
        }>(
          `SELECT id::text, title, once_per_customer
           FROM automatic_discounts
           WHERE store_id = $1::uuid
             AND title = ANY($2::text[])
             AND is_active = true
             AND (starts_at IS NULL OR starts_at <= now())
             AND (ends_at   IS NULL OR ends_at   >  now())`,
          [storeId, titles]
        );
        // Match each applied automatic line to its row by title (first match).
        const usedIds = new Set<string>();
        for (const line of autoLinesApplied) {
          const match = autoRows.find((r) => r.title === line.title && !usedIds.has(r.id));
          if (match) {
            usedIds.add(match.id);
            burnTargets.push({
              discountId: match.id,
              table: "auto",
              oncePerCustomer: match.once_per_customer,
              amount: line.amount,
            });
          }
        }
      }
    }

    // Persist recomputed totals (subtotal/discount/shipping/total) so the order
    // copy below reads correct values regardless of price/discount drift.
    total = round2(subtotal + shippingTotal + taxTotal - discountTotal);
    if (priceChanged || discountTotal !== parseFloat(ch.discount_total) || shippingTotal !== baseShipping) {
      await client.query(
        `UPDATE checkouts
         SET subtotal = $1, shipping_total = $2, discount_total = $3, total = $4,
             updated_at = now()
         WHERE id = $5::uuid`,
        [subtotal, shippingTotal, discountTotal, total, checkoutId]
      );
    }

    // ── Step 4c: Burn redemptions atomically (caps + once-per-customer) ───
    await burnDiscounts(client, burnTargets, customerId);

    // ── Step 4b: B2B credit check + consume (H2.5) ───────────────────────
    // When the checkout carries a company_id, look up the company's
    // payment_terms_days.  A net-terms order (payment_terms_days > 0) is
    // invoiced and not collected immediately, so it draws on the company's
    // credit line.  If the remaining credit is insufficient we reject with
    // CREDIT_LIMIT_EXCEEDED before the order row is created so the entire
    // transaction rolls back atomically.
    // The credit increment is inside the same withTx transaction as the
    // order INSERT — no race window between check and update.
    if (ch.company_id) {
      const { rows: companyRows } = await client.query<{
        payment_terms_days: number;
      }>(
        `SELECT payment_terms_days FROM companies WHERE id = $1::uuid`,
        [ch.company_id]
      );
      const paymentTermsDays = companyRows[0]?.payment_terms_days ?? 0;

      // Only consume credit for net-terms (invoiced / unpaid) orders.
      // Immediate-payment company orders (terms = 0) do not draw credit.
      if (paymentTermsDays > 0) {
        const { checkCreditAndConsume } = await import("../b2b/service.js");
        try {
          await checkCreditAndConsume(client, ch.company_id, total);
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "CREDIT_LIMIT_EXCEEDED") {
            throw new CheckoutError((err as Error).message, "CREDIT_LIMIT_EXCEEDED");
          }
          throw err;
        }
      }
    }

    // ── Step 5: Create order row (Invariant 5) ────────────────────────────
    // Stamp metadata.agent_id when request is agent-attributed so the
    // spend-window aggregation query in verifyAgentCheckout can count this order.
    // FIX 2: also stamp metadata.mandate_id when a payment mandate was verified
    // for this checkout, giving an auditable order → mandate → intent chain.
    const orderMetadata: Record<string, unknown> = {};
    if (agentCtx) {
      orderMetadata["agent_id"] = agentCtx.agentId;
      if (verifiedMandateId) {
        orderMetadata["mandate_id"] = verifiedMandateId;
      }
    }

    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, company_id, checkout_id, order_number,
          status, financial_status, fulfillment_status,
          currency, subtotal, shipping_total, tax_total, discount_total, total,
          shipping_address, billing_address,
          tax_lines, shipping_lines, discount_lines,
          source_name, metadata)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5,
               'open', 'pending', 'unfulfilled',
               $6, $7, $8, $9, $10, $11,
               COALESCE($12::jsonb, '{}'), COALESCE($13::jsonb, '{}'),
               COALESCE($14::jsonb, '[]'::jsonb), COALESCE($15::jsonb, 'null'::jsonb), COALESCE($16::jsonb, '[]'::jsonb),
               'web', $17::jsonb)
       RETURNING id::text`,
      [
        storeId,
        ch.customer_id,
        ch.company_id,
        checkoutId,
        orderNumber,
        currency,
        subtotal,
        shippingTotal,
        taxTotal,
        discountTotal,
        total,
        ch.shipping_address,
        ch.billing_address,
        ch.tax_lines ?? null,
        ch.shipping_rate ?? null,
        ch.discount_lines ?? null,
        JSON.stringify(orderMetadata),
      ]
    );
    const orderId = orderRows[0]!.id;

    // ── Step 6: Copy cart lines → order_lines (Invariant 5) ──────────────
    // Apportion tax/discount proportionally per line (mirrors Go M8)
    const { rows: lineRows } = await client.query<{
      id: string;
      total: string;
    }>(
      `INSERT INTO order_lines (order_id, variant_id, title, sku, quantity, price, total)
       SELECT $1::uuid, cl.variant_id,
              COALESCE(pv.title, p.title, 'Item'),
              COALESCE(pv.sku, ''),
              cl.quantity, cl.price, cl.price * cl.quantity
       FROM cart_lines cl
       JOIN product_variants pv ON pv.id = cl.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE cl.cart_id = $2::uuid
       RETURNING id::text, total::text`,
      [orderId, cartId]
    );

    const itemCount = lineRows.length;

    // Apportion tax_total + discount_total across order_lines proportionally
    // (Go M8: round2; last line absorbs rounding remainder)
    if (itemCount > 0 && subtotal > 0 && (taxTotal !== 0 || discountTotal !== 0)) {
      let taxAcc = 0;
      let discAcc = 0;
      for (let i = 0; i < lineRows.length; i++) {
        const lineRow = lineRows[i]!;
        const lineSubtotal = parseFloat(lineRow.total);
        let lineTax: number;
        let lineDisc: number;
        if (i === lineRows.length - 1) {
          // Last line absorbs remainder
          lineTax = round2(taxTotal - taxAcc);
          lineDisc = round2(discountTotal - discAcc);
        } else {
          lineTax = round2(taxTotal * (lineSubtotal / subtotal));
          lineDisc = round2(discountTotal * (lineSubtotal / subtotal));
          taxAcc += lineTax;
          discAcc += lineDisc;
        }
        await client.query(
          `UPDATE order_lines SET tax_total = $1, discount_total = $2 WHERE id = $3::uuid`,
          [lineTax, lineDisc, lineRow.id]
        );
      }
    }

    // ── Step 7: Inventory decrement (Invariant 3 + 6) ────────────────────
    // Load cart lines + track_inventory flag
    const { rows: invLineRows } = await client.query<{
      variant_id: string;
      quantity: number;
      track_inventory: boolean;
    }>(
      `SELECT cl.variant_id::text, cl.quantity, pv.track_inventory
       FROM cart_lines cl
       JOIN product_variants pv ON pv.id = cl.variant_id
       WHERE cl.cart_id = $1::uuid`,
      [cartId]
    );

    // Build demand map for tracked variants only
    const trackedVariants: string[] = [];
    const demand = new Map<string, number>();
    for (const l of invLineRows) {
      if (!l.track_inventory) continue;
      if (!demand.has(l.variant_id)) {
        trackedVariants.push(l.variant_id);
      }
      demand.set(l.variant_id, (demand.get(l.variant_id) ?? 0) + l.quantity);
    }

    if (trackedVariants.length > 0) {
      // Lock inventory rows in stable id order (Invariant 3 — prevents deadlocks)
      const { rows: invRows } = await client.query<{
        id: string;
        variant_id: string;
        quantity_on_hand: number;
      }>(
        `SELECT id::text, variant_id::text, quantity_on_hand
         FROM inventory_levels
         WHERE variant_id = ANY($1::uuid[])
         ORDER BY id
         FOR UPDATE`,
        [trackedVariants]
      );

      // Aggregate on-hand per variant
      const onHand = new Map<string, number>();
      for (const r of invRows) {
        onHand.set(r.variant_id, (onHand.get(r.variant_id) ?? 0) + r.quantity_on_hand);
      }

      // Verify sufficient stock (Invariant 6)
      for (const variantId of trackedVariants) {
        const need = demand.get(variantId) ?? 0;
        const have = onHand.get(variantId);
        if (have === undefined) {
          throw new CheckoutError(
            `insufficient inventory for variant ${variantId}`,
            "INSUFFICIENT_INVENTORY"
          );
        }
        if (have < need) {
          throw new CheckoutError(
            `insufficient inventory for variant ${variantId}`,
            "INSUFFICIENT_INVENTORY"
          );
        }
      }

      // Safe to deduct — per-row, spreading across multiple inventory_levels rows
      // (e.g. multiple warehouses) in stable id order
      const remaining = new Map(demand);
      for (const r of invRows) {
        const need = remaining.get(r.variant_id) ?? 0;
        if (need <= 0) continue;
        const take = Math.min(need, r.quantity_on_hand);
        await client.query(
          `UPDATE inventory_levels
           SET quantity_on_hand = quantity_on_hand - $1,
               updated_at = now()
           WHERE id = $2::uuid`,
          [take, r.id]
        );
        remaining.set(r.variant_id, need - take);
      }
    }

    // ── Step 8: Mark checkout completed + cart converted (Invariant 8) ───
    await client.query(
      `UPDATE checkouts
       SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1::uuid`,
      [checkoutId]
    );
    await client.query(
      `UPDATE carts SET status = 'converted', updated_at = now() WHERE id = $1::uuid`,
      [cartId]
    );

    // Insert order_created event
    await client.query(
      `INSERT INTO order_events (order_id, type, data) VALUES ($1::uuid, 'order_created', '{}')`,
      [orderId]
    );

    return {
      orderId,
      orderNumber,
      currency,
      total,
      itemCount,
      customerId,
    };
  });

  // Fire-and-forget outbound notification (H2.1 audit fix).
  // Called AFTER the transaction commits so a notification failure cannot
  // roll back the order.
  dispatchStoreEvent(storeId, "order.created", {
    order_id: result.orderId,
    order_number: result.orderNumber,
    currency: result.currency,
    total: String(result.total),
  });

  // Award loyalty points for a registered customer. Awaited (request context is
  // still active so RLS resolves) but errors are swallowed — loyalty must never
  // roll back a committed order. earnPointsForOrder is idempotent per order_id,
  // is a no-op when the program is inactive, and skips guest checkouts.
  if (result.customerId) {
    try {
      await earnPointsForOrder(storeId, result.customerId, result.orderId, String(result.total));
    } catch (err) {
      console.warn("loyalty: earn failed (order already committed)", { orderId: result.orderId, err });
    }
  }

  return result;
}
