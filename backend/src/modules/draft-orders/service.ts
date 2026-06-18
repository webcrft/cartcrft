/**
 * draft-orders/service.ts — SQL-backed draft-orders / invoicing service.
 *
 * A merchant builds a DRAFT order (line-item snapshot + computed/echoed totals)
 * WITHOUT touching inventory, optionally sends the customer an invoice (a
 * shareable payment link emailed to them), then CONVERTS the draft into a real
 * order via the existing orders pipeline (orders/service.createOrder).
 *
 * Money: decimal strings in the API, numeric(15,2) in DB. Totals are computed
 * via integer-cents helpers (round2) so the math stays drift-free.
 *
 * All SQL is parameterized and store-scoped. RLS backstops tenant isolation.
 */

import { getPool, getReadDb } from "../../db/pool.js";
import { round2 } from "../../lib/money.js";
import { config } from "../../config/config.js";
import { createOrder } from "../orders/service.js";
import { createCheckoutLink } from "../checkout-links/service.js";
import { ConsoleMailer } from "../../lib/mailer/console.js";
import { SesMailer } from "../../lib/mailer/ses.js";
import type { Mailer } from "../../lib/mailer/index.js";
import type {
  DraftOrder,
  DraftOrderLine,
  CreateDraftInput,
  UpdateDraftInput,
  ConvertResult,
} from "./types.js";

// ── Domain errors ───────────────────────────────────────────────────────────
// Service functions throw plain Error with a `.code` so routes can map to HTTP
// status codes (matching the orders VALIDATION_ERROR / NOT_FOUND convention).

function svcError(message: string, code: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

// ── Column projection ─────────────────────────────────────────────────────────

const DRAFT_COLS = `
  id::text, store_id::text, customer_id::text, email, currency, line_items,
  subtotal::text, discount_total::text, tax_total::text, shipping_total::text, total::text,
  note, status, invoice_url, converted_order_id::text, created_at, updated_at
`;

// ── Mailer / link-gen dependency wiring (injectable for tests) ────────────────

/** Generates a shareable payment-link URL for an invoice. */
export type InvoiceLinkGenerator = (
  storeId: string,
  draft: DraftOrder
) => Promise<string>;

export interface SendInvoiceDeps {
  mailer?: Mailer | undefined;
  generateLink?: InvoiceLinkGenerator | undefined;
}

/** Build a mailer from env, mirroring notifications/service.buildMailerFromConfig. */
function buildMailerFromConfig(): Mailer {
  if (
    config.AWS_SES_REGION &&
    config.AWS_SES_ACCESS_KEY_ID &&
    config.AWS_SES_SECRET_ACCESS_KEY &&
    config.EMAIL_FROM
  ) {
    return new SesMailer({
      region: config.AWS_SES_REGION,
      accessKeyId: config.AWS_SES_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SES_SECRET_ACCESS_KEY,
      fromAddress: config.EMAIL_FROM,
    });
  }
  return new ConsoleMailer();
}

/**
 * Default invoice-link generator. When EVERY line is variant-backed we reuse the
 * existing checkout-links machinery to mint a real, payable /pay/<token> link
 * (the hosted page drives the normal checkout + webhook order pipeline). For
 * drafts containing custom (variant-less) lines — which checkout-links cannot
 * represent — we fall back to a stable placeholder URL keyed by the draft id so
 * sendInvoice always yields an invoice_url.
 */
async function defaultGenerateLink(
  storeId: string,
  draft: DraftOrder
): Promise<string> {
  const frontend = config.FRONTEND_URL.replace(/\/+$/, "");
  const allVariantBacked =
    draft.line_items.length > 0 &&
    draft.line_items.every((l) => !!l.variant_id);

  if (allVariantBacked) {
    const email = draft.email ?? undefined;
    const link = await createCheckoutLink(storeId, {
      line_items: draft.line_items.map((l) => ({
        variant_id: l.variant_id as string,
        quantity: l.quantity,
      })),
      ...(email ? { customer_email: email } : {}),
    });
    return `${frontend}/pay/${link.token}`;
  }

  // Placeholder for custom-line drafts (no payable checkout-link representation).
  return `${frontend}/invoice/${draft.id}`;
}

// ── Total computation ─────────────────────────────────────────────────────────

interface ComputedTotals {
  subtotal: number;
  discount_total: number;
  tax_total: number;
  shipping_total: number;
  total: number;
}

/**
 * Compute totals for a set of draft lines + echoed scalar adjustments.
 * subtotal = Σ(price × quantity); total = subtotal − discount + tax + shipping
 * (floored at 0). No inventory or live re-pricing is done — the draft echoes the
 * merchant-supplied prices/scalars faithfully (this is a quote, not an order).
 */
function computeTotals(
  lines: DraftOrderLine[],
  discountTotal: number,
  taxTotal: number,
  shippingTotal: number
): ComputedTotals {
  const subtotal = round2(
    lines.reduce((acc, l) => acc + parseFloat(l.price) * l.quantity, 0)
  );
  let total = round2(subtotal - discountTotal + taxTotal + shippingTotal);
  if (total < 0) total = 0;
  return {
    subtotal,
    discount_total: round2(discountTotal),
    tax_total: round2(taxTotal),
    shipping_total: round2(shippingTotal),
    total,
  };
}

/** Normalise merchant-supplied lines into the persisted snapshot shape. */
function normalizeLines(input: CreateDraftInput["line_items"]): DraftOrderLine[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw svcError("line_items is required and must be a non-empty array", "VALIDATION_ERROR");
  }
  return input.map((l) => {
    const quantity = Math.max(Math.trunc(l.quantity ?? 1), 1);
    const price = round2(parseFloat(l.price ?? "0") || 0);
    if (price < 0) {
      throw svcError("line price must be >= 0", "VALIDATION_ERROR");
    }
    return {
      variant_id: l.variant_id ?? null,
      title: (l.title ?? "").trim() || "Item",
      quantity,
      price: price.toFixed(2),
    };
  });
}

function parseScalar(v: string | undefined): number {
  const n = parseFloat(v ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

interface DraftRow {
  id: string;
  store_id: string;
  customer_id: string | null;
  email: string | null;
  currency: string;
  line_items: DraftOrderLine[];
  subtotal: string;
  discount_total: string;
  tax_total: string;
  shipping_total: string;
  total: string;
  note: string | null;
  status: DraftOrder["status"];
  invoice_url: string | null;
  converted_order_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(r: DraftRow): DraftOrder {
  return {
    id: r.id,
    store_id: r.store_id,
    customer_id: r.customer_id,
    email: r.email,
    currency: r.currency,
    line_items: Array.isArray(r.line_items) ? r.line_items : [],
    subtotal: r.subtotal,
    discount_total: r.discount_total,
    tax_total: r.tax_total,
    shipping_total: r.shipping_total,
    total: r.total,
    note: r.note,
    status: r.status,
    invoice_url: r.invoice_url,
    converted_order_id: r.converted_order_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createDraft(
  storeId: string,
  input: CreateDraftInput
): Promise<DraftOrder> {
  const pool = getPool();

  const lines = normalizeLines(input.line_items);

  // Resolve currency: explicit → else store default.
  let currency = input.currency?.trim() ?? "";
  if (!currency) {
    const { rows } = await pool.query<{ currency: string }>(
      `SELECT currency FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    currency = rows[0]?.currency ?? "USD";
  }

  // Validate customer_id belongs to this store, if supplied.
  if (input.customer_id) {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM customers WHERE id = $1::uuid AND store_id = $2::uuid
       ) AS exists`,
      [input.customer_id, storeId]
    );
    if (!rows[0]?.exists) {
      throw svcError("customer_id does not belong to this store", "VALIDATION_ERROR");
    }
  }

  const totals = computeTotals(
    lines,
    parseScalar(input.discount_total),
    parseScalar(input.tax_total),
    parseScalar(input.shipping_total)
  );

  const { rows } = await pool.query<DraftRow>(
    `INSERT INTO draft_orders
       (store_id, customer_id, email, currency, line_items,
        subtotal, discount_total, tax_total, shipping_total, total, note)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
     RETURNING ${DRAFT_COLS}`,
    [
      storeId,
      input.customer_id ?? null,
      input.email ?? null,
      currency,
      JSON.stringify(lines),
      totals.subtotal,
      totals.discount_total,
      totals.tax_total,
      totals.shipping_total,
      totals.total,
      input.note ?? null,
    ]
  );

  const row = rows[0];
  if (!row) throw new Error("createDraft: no row returned");
  return mapRow(row);
}

// ── List ──────────────────────────────────────────────────────────────────────

export interface ListDraftsOpts {
  status?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listDrafts(
  storeId: string,
  opts: ListDraftsOpts = {}
): Promise<{ drafts: DraftOrder[]; total: number }> {
  const pool = getReadDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const where = ["store_id = $1::uuid"];
  const args: unknown[] = [storeId];
  let argN = 2;
  if (opts.status) {
    where.push(`status = $${argN++}`);
    args.push(opts.status);
  }
  const whereSql = where.join(" AND ");

  const [draftsRes, countRes] = await Promise.all([
    pool.query<DraftRow>(
      `SELECT ${DRAFT_COLS}
       FROM draft_orders
       WHERE ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${argN} OFFSET $${argN + 1}`,
      [...args, limit, offset]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM draft_orders WHERE ${whereSql}`,
      args
    ),
  ]);

  return {
    drafts: draftsRes.rows.map(mapRow),
    total: parseInt(countRes.rows[0]?.count ?? "0", 10),
  };
}

// ── Get ─────────────────────────────────────────────────────────────────────

export async function getDraft(
  storeId: string,
  draftId: string
): Promise<DraftOrder | null> {
  const pool = getReadDb();
  const { rows } = await pool.query<DraftRow>(
    `SELECT ${DRAFT_COLS} FROM draft_orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [draftId, storeId]
  );
  const row = rows[0];
  return row ? mapRow(row) : null;
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateDraft(
  storeId: string,
  draftId: string,
  input: UpdateDraftInput
): Promise<DraftOrder | null> {
  const pool = getPool();

  // Load the current draft (RLS/store-scoped) to merge + recompute totals.
  const current = await getDraft(storeId, draftId);
  if (!current) return null;
  if (current.status === "converted" || current.status === "cancelled") {
    throw svcError(
      `cannot edit a draft with status '${current.status}'`,
      "CONFLICT"
    );
  }

  // Validate customer_id belongs to this store if it is being set.
  if (input.customer_id) {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM customers WHERE id = $1::uuid AND store_id = $2::uuid
       ) AS exists`,
      [input.customer_id, storeId]
    );
    if (!rows[0]?.exists) {
      throw svcError("customer_id does not belong to this store", "VALIDATION_ERROR");
    }
  }

  const lines =
    input.line_items !== undefined
      ? normalizeLines(input.line_items)
      : current.line_items;

  const discount =
    input.discount_total !== undefined
      ? parseScalar(input.discount_total)
      : parseFloat(current.discount_total);
  const tax =
    input.tax_total !== undefined
      ? parseScalar(input.tax_total)
      : parseFloat(current.tax_total);
  const shipping =
    input.shipping_total !== undefined
      ? parseScalar(input.shipping_total)
      : parseFloat(current.shipping_total);

  const totals = computeTotals(lines, discount, tax, shipping);

  const { rows } = await pool.query<DraftRow>(
    `UPDATE draft_orders SET
       customer_id    = COALESCE($3, customer_id),
       email          = COALESCE($4, email),
       currency       = COALESCE($5, currency),
       line_items     = $6::jsonb,
       subtotal       = $7,
       discount_total = $8,
       tax_total      = $9,
       shipping_total = $10,
       total          = $11,
       note           = COALESCE($12, note),
       updated_at     = now()
     WHERE id = $1::uuid AND store_id = $2::uuid
     RETURNING ${DRAFT_COLS}`,
    [
      draftId,
      storeId,
      input.customer_id ?? null,
      input.email ?? null,
      input.currency?.trim() || null,
      JSON.stringify(lines),
      totals.subtotal,
      totals.discount_total,
      totals.tax_total,
      totals.shipping_total,
      totals.total,
      input.note ?? null,
    ]
  );

  const row = rows[0];
  return row ? mapRow(row) : null;
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteDraft(
  storeId: string,
  draftId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM draft_orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [draftId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Send invoice ──────────────────────────────────────────────────────────────

/**
 * Generate a shareable payment link for the draft and email it to the draft's
 * recipient (email, falling back to the linked customer's email), then mark the
 * draft 'invoice_sent' and stamp invoice_url. Mailer + link generator are
 * injectable via `deps` for tests; defaults build from env / checkout-links.
 *
 * Throws:
 *   { code: "NOT_FOUND" }    — unknown draft for this store.
 *   { code: "CONFLICT" }     — draft already converted/cancelled.
 *   { code: "VALIDATION_ERROR" } — no recipient email resolvable.
 */
export async function sendInvoice(
  storeId: string,
  draftId: string,
  deps: SendInvoiceDeps = {}
): Promise<DraftOrder> {
  const draft = await getDraft(storeId, draftId);
  if (!draft) throw svcError("draft order not found", "NOT_FOUND");
  if (draft.status === "converted" || draft.status === "cancelled") {
    throw svcError(
      `cannot send an invoice for a draft with status '${draft.status}'`,
      "CONFLICT"
    );
  }

  // Resolve the recipient email: explicit draft email → linked customer email.
  let recipient = draft.email?.trim() || "";
  if (!recipient && draft.customer_id) {
    const { rows } = await getReadDb().query<{ email: string | null }>(
      `SELECT email FROM customers WHERE id = $1::uuid AND store_id = $2::uuid`,
      [draft.customer_id, storeId]
    );
    recipient = rows[0]?.email?.trim() || "";
  }
  if (!recipient) {
    throw svcError(
      "draft has no recipient email (set email or customer_id with an email)",
      "VALIDATION_ERROR"
    );
  }

  const generateLink = deps.generateLink ?? defaultGenerateLink;
  const invoiceUrl = await generateLink(storeId, draft);

  const mailer = deps.mailer ?? buildMailerFromConfig();
  const fromEmail = config.EMAIL_FROM ?? "hello@cartcrft.dev";
  const amount = `${draft.currency} ${draft.total}`;
  await mailer.send({
    to: recipient,
    fromName: "CartCrft",
    fromEmail,
    subject: `Invoice from CartCrft — ${amount} due`,
    bodyHtml: `<p>You have a new invoice for <strong>${amount}</strong>.</p>` +
      `<p><a href="${invoiceUrl}">Pay your invoice</a></p>`,
    bodyText: `You have a new invoice for ${amount}. Pay it here: ${invoiceUrl}`,
  });

  const pool = getPool();
  const { rows } = await pool.query<DraftRow>(
    `UPDATE draft_orders
       SET status = 'invoice_sent', invoice_url = $3, updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid
     RETURNING ${DRAFT_COLS}`,
    [draftId, storeId, invoiceUrl]
  );

  const row = rows[0];
  if (!row) throw svcError("draft order not found", "NOT_FOUND");
  return mapRow(row);
}

// ── Convert to a real order ─────────────────────────────────────────────────

/**
 * Convert a draft into a REAL order via orders/service.createOrder, then mark
 * the draft 'converted' and stamp converted_order_id. Idempotency: only a
 * draft/invoice_sent draft can be converted (converted/cancelled → CONFLICT).
 *
 * MONEY FIDELITY NOTE: createOrder re-derives line prices server-side from the
 * variant (it ignores any client price) and accepts shipping/tax/discount as
 * echoed scalar strings. We therefore pass the draft's variant_id + quantity per
 * line and forward the draft's discount/tax/shipping scalars so the resulting
 * order total matches the draft for variant-backed drafts. LIMITATION: custom
 * (variant-less) draft lines cannot carry a price through createOrder (which
 * only prices variant-backed lines), so a draft containing any variant-less line
 * is rejected with VALIDATION_ERROR rather than silently dropping its value.
 */
export async function convertToOrder(
  storeId: string,
  draftId: string,
  userId?: string | undefined
): Promise<ConvertResult> {
  const draft = await getDraft(storeId, draftId);
  if (!draft) throw svcError("draft order not found", "NOT_FOUND");
  if (draft.status === "converted" || draft.status === "cancelled") {
    throw svcError(
      `cannot convert a draft with status '${draft.status}'`,
      "CONFLICT"
    );
  }
  if (draft.line_items.length === 0) {
    throw svcError("cannot convert a draft with no line items", "VALIDATION_ERROR");
  }

  // createOrder only prices variant-backed lines; refuse to silently drop the
  // value of a custom line rather than produce a wrong order total.
  const customLine = draft.line_items.find((l) => !l.variant_id);
  if (customLine) {
    throw svcError(
      "cannot convert a draft containing custom (variant-less) line items",
      "VALIDATION_ERROR"
    );
  }

  const result = await createOrder(
    storeId,
    {
      currency: draft.currency,
      ...(draft.customer_id ? { customer_id: draft.customer_id } : {}),
      ...(draft.note ? { notes: draft.note } : {}),
      source_name: "draft_order",
      discount_total: draft.discount_total,
      tax_total: draft.tax_total,
      shipping_total: draft.shipping_total,
      lines: draft.line_items.map((l) => ({
        variant_id: l.variant_id as string,
        title: l.title,
        quantity: l.quantity,
      })),
    },
    userId
  );

  // Mark the draft converted + stamp the order id. Guard the status transition
  // so a concurrent convert cannot double-stamp.
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE draft_orders
       SET status = 'converted', converted_order_id = $3::uuid, updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid
       AND status IN ('draft', 'invoice_sent')`,
    [draftId, storeId, result.id]
  );
  if ((rowCount ?? 0) === 0) {
    throw svcError("draft order could not be marked converted", "CONFLICT");
  }

  return { order_id: result.id, order_number: result.order_number };
}
