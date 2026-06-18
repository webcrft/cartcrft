/**
 * b2b/service.ts — SQL-backed B2B commerce service.
 *
 * Covers: companies CRUD, company_customers, customer groups, quotes lifecycle,
 * purchase orders.
 *
 * H2.5 — B2B credit enforcement:
 *   checkCreditAndConsume(client, companyId, amount): call inside the same
 *     transaction as order creation; throws CREDIT_LIMIT_EXCEEDED if the
 *     company's remaining credit (credit_limit - credit_used) < amount.
 *     On success, atomically increments credit_used.  Acquires a FOR UPDATE
 *     row lock to serialise concurrent checkouts against the same company.
 *     Only applies when credit_limit IS NOT NULL.
 *   releaseCredit(companyId, amount): decrement credit_used by amount,
 *     guarded against going below zero; call from cancelOrder and createRefund.
 *
 * Money: prices stored as numeric(15,2) in DB; returned as strings in API.
 * Quote→order conversion uses next_order_number() and mirrors checkout complete.
 */

import type pg from "pg";
import { getPool, getReadDb, withTx } from "../../db/pool.js";
import type {
  Company,
  CreateCompanyInput,
  UpdateCompanyInput,
  CompanyCustomer,
  CompanyCatalogAccess,
  GrantCatalogAccessInput,
  CustomerGroup,
  CreateCustomerGroupInput,
  UpdateCustomerGroupInput,
  QuoteWithLines,
  CreateQuoteInput,
  UpdateQuoteInput,
  AcceptQuoteResult,
  PurchaseOrder,
  AttachPurchaseOrderInput,
  UpdatePurchaseOrderInput,
} from "./types.js";

// ── Companies ──────────────────────────────────────────────────────────────────

const COMPANY_COLS = `
  id::text, store_id::text, name,
  tax_number AS tax_id, notes,
  credit_limit::text, credit_used::text, payment_terms_days,
  price_list_id::text, billing_address, metadata, created_at, updated_at
`;

export async function listCompanies(storeId: string): Promise<Company[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<Company>(
    `SELECT ${COMPANY_COLS} FROM companies WHERE store_id = $1::uuid ORDER BY name`,
    [storeId]
  );
  return rows;
}

export async function getCompany(
  storeId: string,
  companyId: string
): Promise<Company | null> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<Company>(
    `SELECT ${COMPANY_COLS} FROM companies WHERE id = $1::uuid AND store_id = $2::uuid`,
    [companyId, storeId]
  );
  return rows[0] ?? null;
}

export async function createCompany(
  storeId: string,
  input: CreateCompanyInput
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO companies
       (store_id, name, tax_number, credit_limit, payment_terms_days, price_list_id, metadata)
     VALUES ($1::uuid, $2, $3, $4::numeric, COALESCE($5, 0), $6::uuid, COALESCE($7::jsonb, '{}'))
     RETURNING id::text`,
    [
      storeId,
      input.name,
      input.tax_id ?? null,
      input.credit_limit ?? null,
      input.payment_terms_days ?? null,
      input.price_list_id ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]
  );
  if (!rows[0]) throw new Error("createCompany: no row returned");
  return rows[0].id;
}

export async function updateCompany(
  storeId: string,
  companyId: string,
  input: UpdateCompanyInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE companies SET
       name               = COALESCE($3, name),
       tax_number         = COALESCE($4, tax_number),
       credit_limit       = COALESCE($5::numeric, credit_limit),
       payment_terms_days = COALESCE($6, payment_terms_days),
       price_list_id      = COALESCE($7::uuid, price_list_id),
       updated_at         = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      companyId,
      storeId,
      input.name ?? null,
      input.tax_id ?? null,
      input.credit_limit ?? null,
      input.payment_terms_days ?? null,
      input.price_list_id ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteCompany(
  storeId: string,
  companyId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM companies WHERE id = $1::uuid AND store_id = $2::uuid`,
    [companyId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── H2.5 Credit enforcement ────────────────────────────────────────────────────

/**
 * checkCreditAndConsume — must be called inside the same pg transaction as
 * order creation (checkout/complete.ts).
 *
 * Semantics (parity with webcrft-mono companies.credit_limit/credit_used):
 *  1. SELECT … FOR UPDATE to serialise concurrent checkouts for the same company.
 *  2. If credit_limit IS NULL → no cap, skip the check.
 *  3. If credit_limit - credit_used < amount → throw CREDIT_LIMIT_EXCEEDED.
 *  4. Otherwise increment credit_used by amount inside the same transaction.
 *
 * The caller is responsible for rolling back the transaction on any error —
 * withTx() in checkout/complete.ts handles that automatically.
 *
 * @param client  Transaction client (must be inside an active transaction)
 * @param companyId  UUID of the company to check/update
 * @param amount  Order total (numeric, same currency as credit_limit)
 */
export async function checkCreditAndConsume(
  client: pg.PoolClient,
  companyId: string,
  amount: number
): Promise<void> {
  // Row-lock the company row to prevent concurrent oversell
  const { rows } = await client.query<{
    credit_limit: string | null;
    credit_used: string;
  }>(
    `SELECT credit_limit::text, credit_used::text
     FROM companies
     WHERE id = $1::uuid
     FOR UPDATE`,
    [companyId]
  );

  if (!rows[0]) {
    // Company not found — do nothing; foreign-key constraint will handle it
    return;
  }

  const { credit_limit, credit_used } = rows[0];

  // NULL credit_limit means no cap — pass through
  if (credit_limit === null) return;

  const limit = parseFloat(credit_limit);
  const used = parseFloat(credit_used);
  const remaining = limit - used;

  if (remaining < amount - 0.001) {
    const e = new Error(
      `credit limit exceeded: remaining credit ${remaining.toFixed(2)} < order total ${amount.toFixed(2)}`
    );
    (e as NodeJS.ErrnoException).code = "CREDIT_LIMIT_EXCEEDED";
    throw e;
  }

  // Atomically consume the credit inside the transaction
  await client.query(
    `UPDATE companies
     SET credit_used = credit_used + $1::numeric,
         updated_at  = now()
     WHERE id = $2::uuid`,
    [amount, companyId]
  );
}

/**
 * releaseCredit — reverse a previous credit consumption when an order is
 * cancelled or refunded.  Decrements credit_used by `amount`, guarded
 * against going below zero (GREATEST guard).  Uses the pool directly
 * (no transaction required; reversal races are safe because credit_used
 * is monotone — can only be released once per order event).
 *
 * Parity note: webcrft-mono does not implement this (credit reversal was
 * not in the Go codebase) — this is a forward-parity improvement.
 */
export async function releaseCredit(
  companyId: string,
  amount: number
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE companies
     SET credit_used = GREATEST(0, credit_used - $1::numeric),
         updated_at  = now()
     WHERE id = $2::uuid`,
    [amount, companyId]
  );
}

// ── Company customers ──────────────────────────────────────────────────────────

export async function listCompanyCustomers(
  storeId: string,
  companyId: string
): Promise<CompanyCustomer[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<CompanyCustomer>(
    `SELECT cc.company_id::text AS id, cc.company_id::text, cc.customer_id::text, cc.role, cc.created_at
     FROM company_customers cc
     JOIN companies c ON c.id = cc.company_id
     WHERE cc.company_id = $1::uuid AND c.store_id = $2::uuid`,
    [companyId, storeId]
  );
  return rows;
}

export async function addCompanyCustomer(
  storeId: string,
  companyId: string,
  customerId: string,
  role: string
): Promise<boolean> {
  const pool = getPool();
  // Check store ownership, then upsert
  const { rows: check } = await pool.query<{ id: string }>(
    `SELECT id::text FROM companies WHERE id = $1::uuid AND store_id = $2::uuid`,
    [companyId, storeId]
  );
  if (!check[0]) {
    const e = new Error("company not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }
  await pool.query(
    `INSERT INTO company_customers (company_id, customer_id, role)
     VALUES ($1::uuid, $2::uuid, $3)
     ON CONFLICT (company_id, customer_id) DO UPDATE SET role = EXCLUDED.role`,
    [companyId, customerId, role]
  );
  return true;
}

export async function removeCompanyCustomer(
  storeId: string,
  companyId: string,
  customerId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM company_customers cc
     USING companies c
     WHERE cc.company_id = $1::uuid AND cc.customer_id = $2::uuid
       AND c.id = cc.company_id AND c.store_id = $3::uuid`,
    [companyId, customerId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Company catalog access (Wave-17: per-company catalog gating) ────────────────
//
// Model: an OPT-IN allow-list. A company with NO company_catalog_access rows
// sees the FULL catalog (no restriction). Once a company has at least one
// 'allow' row it sees ONLY the products it is directly allowed plus every
// product belonging to an allowed collection. This is the single source of
// truth for catalog gating — catalog/service.ts consults the same model via
// companyAllowedProductIds() / companyHasCatalogAccess().

/**
 * companyHasCatalogAccess — true iff the company has at least one allow row.
 * When false the company is UNRESTRICTED (sees the full catalog). Uses the
 * RLS-enforced read path; harmless when no request context (owner role).
 */
export async function companyHasCatalogAccess(
  storeId: string,
  companyId: string
): Promise<boolean> {
  const pool = getReadDb();
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM company_catalog_access
       WHERE store_id = $1::uuid AND company_id = $2::uuid
     ) AS exists`,
    [storeId, companyId]
  );
  return rows[0]?.exists ?? false;
}

/**
 * companyAllowedProductIds — the full set of product UUIDs a company may see:
 * directly-allowed products UNION every product in an allowed collection.
 * Returns null when the company has NO access rows (meaning: unrestricted —
 * the caller MUST NOT filter). Returns a (possibly empty) array otherwise.
 */
export async function companyAllowedProductIds(
  storeId: string,
  companyId: string
): Promise<string[] | null> {
  const pool = getReadDb();
  // One round-trip: count of access rows (to tell "unrestricted" apart from
  // "restricted but matches nothing") plus the matching product ids.
  const { rows } = await pool.query<{ rule_count: string; product_ids: string[] }>(
    `SELECT
       (SELECT COUNT(*)::text
          FROM company_catalog_access a
         WHERE a.store_id = $1::uuid AND a.company_id = $2::uuid) AS rule_count,
       COALESCE(
         (SELECT array_agg(p.id::text)
            FROM products p
           WHERE p.store_id = $1::uuid
             AND (
               EXISTS (
                 SELECT 1 FROM company_catalog_access a
                  WHERE a.store_id = $1::uuid AND a.company_id = $2::uuid
                    AND a.product_id = p.id
               )
               OR EXISTS (
                 SELECT 1 FROM company_catalog_access a
                   JOIN product_collections pc ON pc.collection_id = a.collection_id
                  WHERE a.store_id = $1::uuid AND a.company_id = $2::uuid
                    AND a.collection_id IS NOT NULL
                    AND pc.product_id = p.id
               )
             )),
         ARRAY[]::text[]
       ) AS product_ids`,
    [storeId, companyId]
  );
  const row = rows[0];
  // No rules → unrestricted; the caller MUST NOT filter.
  if (!row || parseInt(row.rule_count, 10) === 0) return null;
  return row.product_ids;
}

export async function listCompanyCatalogAccess(
  storeId: string,
  companyId: string
): Promise<CompanyCatalogAccess[]> {
  const pool = getReadDb();
  const { rows } = await pool.query<CompanyCatalogAccess>(
    `SELECT id::text, store_id::text, company_id::text, access_type,
            product_id::text, collection_id::text, created_at
       FROM company_catalog_access
      WHERE store_id = $1::uuid AND company_id = $2::uuid
      ORDER BY created_at`,
    [storeId, companyId]
  );
  return rows;
}

/**
 * grantCatalogAccess — add an 'allow' row for a product OR a collection.
 * Exactly one of product_id / collection_id must be provided. Idempotent
 * (ON CONFLICT DO NOTHING via the partial unique indexes). Verifies the
 * company belongs to the store first.
 */
export async function grantCatalogAccess(
  storeId: string,
  companyId: string,
  input: GrantCatalogAccessInput
): Promise<string | null> {
  const productId = input.product_id ?? null;
  const collectionId = input.collection_id ?? null;
  if ((productId === null) === (collectionId === null)) {
    const e = new Error("exactly one of product_id or collection_id is required");
    (e as NodeJS.ErrnoException).code = "INVALID_INPUT";
    throw e;
  }

  const pool = getPool();
  const { rows: check } = await pool.query<{ id: string }>(
    `SELECT id::text FROM companies WHERE id = $1::uuid AND store_id = $2::uuid`,
    [companyId, storeId]
  );
  if (!check[0]) {
    const e = new Error("company not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }

  const conflict = productId !== null ? "(company_id, product_id) WHERE product_id IS NOT NULL"
    : "(company_id, collection_id) WHERE collection_id IS NOT NULL";
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO company_catalog_access (store_id, company_id, access_type, product_id, collection_id)
     VALUES ($1::uuid, $2::uuid, 'allow', $3::uuid, $4::uuid)
     ON CONFLICT ${conflict} DO NOTHING
     RETURNING id::text`,
    [storeId, companyId, productId, collectionId]
  );
  return rows[0]?.id ?? null;
}

/**
 * revokeCatalogAccess — remove an allow row by its id, scoped to the company
 * and store. Returns true when a row was deleted.
 */
export async function revokeCatalogAccess(
  storeId: string,
  companyId: string,
  accessId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM company_catalog_access
      WHERE id = $1::uuid AND company_id = $2::uuid AND store_id = $3::uuid`,
    [accessId, companyId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * assignPriceList — assign (or clear, with null) the company's price list.
 * Reuses the existing companies.price_list_id mechanism. Returns true when
 * the company exists in the store.
 */
export async function assignPriceList(
  storeId: string,
  companyId: string,
  priceListId: string | null
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE companies
        SET price_list_id = $3::uuid, updated_at = now()
      WHERE id = $1::uuid AND store_id = $2::uuid`,
    [companyId, storeId, priceListId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * assertCompanyCanPurchase — checkout-time guard. Throws CATALOG_RESTRICTED if
 * the company (when catalog-gated) tries to buy a variant whose product it is
 * not allowed to see. NO-OP when the company has no access rows (unrestricted)
 * or when variantIds is empty. Safe to call from the API layer; the gating
 * model is identical to the read path so reads and checkout stay consistent.
 */
export async function assertCompanyCanPurchase(
  storeId: string,
  companyId: string,
  variantIds: string[]
): Promise<void> {
  if (variantIds.length === 0) return;
  const allowed = await companyAllowedProductIds(storeId, companyId);
  if (allowed === null) return; // unrestricted company

  const pool = getReadDb();
  // Find the product each variant belongs to (scoped to this store), then
  // reject any whose product is not in the allowed set.
  const { rows } = await pool.query<{ variant_id: string; product_id: string }>(
    `SELECT v.id::text AS variant_id, v.product_id::text AS product_id
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
      WHERE p.store_id = $1::uuid AND v.id = ANY($2::uuid[])`,
    [storeId, variantIds]
  );
  const allowedSet = new Set(allowed);
  const found = new Set(rows.map((r) => r.variant_id));
  for (const vid of variantIds) {
    const row = rows.find((r) => r.variant_id === vid);
    // A variant not found in this store, or whose product is not allowed, is
    // rejected — a gated company may not purchase outside its allow-list.
    if (!row || !allowedSet.has(row.product_id) || !found.has(vid)) {
      const e = new Error(
        `variant ${vid} is not available to this company's catalog`
      );
      (e as NodeJS.ErrnoException).code = "CATALOG_RESTRICTED";
      throw e;
    }
  }
}

// ── Customer groups ────────────────────────────────────────────────────────────

export async function listCustomerGroups(storeId: string): Promise<CustomerGroup[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<CustomerGroup>(
    `SELECT id::text, store_id::text, name, description, price_list_id::text, created_at
     FROM customer_groups WHERE store_id = $1::uuid ORDER BY name`,
    [storeId]
  );
  return rows;
}

export async function createCustomerGroup(
  storeId: string,
  input: CreateCustomerGroupInput
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customer_groups (store_id, name, description, price_list_id)
     VALUES ($1::uuid, $2, $3, $4::uuid) RETURNING id::text`,
    [storeId, input.name, input.description ?? null, input.price_list_id ?? null]
  );
  if (!rows[0]) throw new Error("createCustomerGroup: no row returned");
  return rows[0].id;
}

export async function updateCustomerGroup(
  storeId: string,
  groupId: string,
  input: UpdateCustomerGroupInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE customer_groups SET
       name          = COALESCE($3, name),
       description   = COALESCE($4, description),
       price_list_id = COALESCE($5::uuid, price_list_id)
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [groupId, storeId, input.name ?? null, input.description ?? null, input.price_list_id ?? null]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteCustomerGroup(
  storeId: string,
  groupId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM customer_groups WHERE id = $1::uuid AND store_id = $2::uuid`,
    [groupId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

export async function addGroupMember(
  storeId: string,
  groupId: string,
  customerId: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO customer_group_members (group_id, customer_id)
     SELECT $1::uuid, $2::uuid
     WHERE EXISTS (SELECT 1 FROM customer_groups WHERE id = $1::uuid AND store_id = $3::uuid)
     ON CONFLICT DO NOTHING`,
    [groupId, customerId, storeId]
  );
}

export async function removeGroupMember(
  storeId: string,
  groupId: string,
  customerId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM customer_group_members
     WHERE group_id = $1::uuid AND customer_id = $2::uuid
       AND EXISTS (SELECT 1 FROM customer_groups WHERE id = $1::uuid AND store_id = $3::uuid)`,
    [groupId, customerId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Quotes ─────────────────────────────────────────────────────────────────────

export async function listQuotes(
  storeId: string,
  opts: {
    status?: string | undefined;
    company_id?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  } = {}
): Promise<{ quotes: unknown[]; total: number }> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  const conditions: string[] = ["store_id = $1::uuid"];
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.status) {
    conditions.push(`status = $${argN++}`);
    args.push(opts.status);
  }
  if (opts.company_id) {
    conditions.push(`company_id = $${argN++}::uuid`);
    args.push(opts.company_id);
  }

  const where = conditions.join(" AND ");
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM quotes WHERE ${where}`,
    args
  );
  const total = parseInt(countRows[0]?.count ?? "0", 10);

  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, company_id::text, customer_id::text,
            status, expires_at, notes, converted_order_id::text,
            created_by::text, created_at, updated_at
     FROM quotes WHERE ${where}
     ORDER BY created_at DESC LIMIT $${argN} OFFSET $${argN + 1}`,
    [...args, limit, offset]
  );
  return { quotes: rows, total };
}

export async function getQuote(
  storeId: string,
  quoteId: string
): Promise<QuoteWithLines | null> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, company_id::text, customer_id::text,
            status, expires_at, notes, converted_order_id::text,
            created_by::text, created_at, updated_at
     FROM quotes WHERE id = $1::uuid AND store_id = $2::uuid`,
    [quoteId, storeId]
  );
  if (!rows[0]) return null;
  const quote = rows[0] as QuoteWithLines;

  const { rows: lineRows } = await pool.query(
    `SELECT id::text, quote_id::text, variant_id::text, title, quantity, price::text, notes, created_at
     FROM quote_lines WHERE quote_id = $1::uuid ORDER BY created_at`,
    [quoteId]
  );
  quote.lines = lineRows as QuoteWithLines["lines"];
  return quote;
}

export async function createQuote(
  storeId: string,
  input: CreateQuoteInput,
  createdBy: string
): Promise<string> {
  return withTx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO quotes (store_id, company_id, customer_id, status, expires_at, notes, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'draft', $4::timestamptz, $5, $6::uuid) RETURNING id::text`,
      [
        storeId,
        input.company_id ?? null,
        input.customer_id ?? null,
        input.expires_at ?? null,
        input.notes ?? null,
        createdBy,
      ]
    );
    if (!rows[0]) throw new Error("createQuote: no row returned");
    const quoteId = rows[0].id;

    if (input.lines && input.lines.length > 0) {
      for (const line of input.lines) {
        const title = (line.title ?? "Item").trim() || "Item";
        const qty = Math.max(1, line.quantity ?? 1);
        await client.query(
          `INSERT INTO quote_lines (quote_id, variant_id, title, quantity, price, notes)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6)`,
          [quoteId, line.variant_id ?? null, title, qty, line.price, line.notes ?? null]
        );
      }
    }
    return quoteId;
  });
}

export async function updateQuote(
  storeId: string,
  quoteId: string,
  input: UpdateQuoteInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE quotes SET
       status     = COALESCE($3, status),
       expires_at = COALESCE($4::timestamptz, expires_at),
       notes      = COALESCE($5, notes),
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [quoteId, storeId, input.status ?? null, input.expires_at ?? null, input.notes ?? null]
  );
  return (rowCount ?? 0) > 0;
}

export async function sendQuote(
  storeId: string,
  quoteId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE quotes SET status = 'sent', updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND status = 'draft'`,
    [quoteId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

export async function acceptQuote(
  storeId: string,
  quoteId: string
): Promise<AcceptQuoteResult> {
  return withTx(async (client) => {
    // Load quote with row lock
    const { rows: qRows } = await client.query<{
      company_id: string | null;
      customer_id: string | null;
      status: string;
      expires_at: Date | null;
    }>(
      `SELECT company_id::text, customer_id::text, status, expires_at
       FROM quotes WHERE id = $1::uuid AND store_id = $2::uuid FOR UPDATE`,
      [quoteId, storeId]
    );
    if (!qRows[0]) {
      const e = new Error("quote not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }
    const q = qRows[0];
    if (q.status === "expired" || q.status === "converted" || q.status === "rejected") {
      const e = new Error(`quote cannot be accepted in status "${q.status}"`);
      (e as NodeJS.ErrnoException).code = "INVALID_TRANSITION";
      throw e;
    }
    if (q.expires_at && new Date() > q.expires_at) {
      const e = new Error("quote has expired");
      (e as NodeJS.ErrnoException).code = "QUOTE_EXPIRED";
      throw e;
    }

    // Sum quote lines for subtotal
    const { rows: sumRows } = await client.query<{ subtotal: string }>(
      `SELECT COALESCE(SUM(price * quantity), 0)::text AS subtotal
       FROM quote_lines WHERE quote_id = $1::uuid`,
      [quoteId]
    );
    const subtotal = sumRows[0]?.subtotal ?? "0";

    // Get store currency
    const { rows: storeRows } = await client.query<{ currency: string }>(
      `SELECT currency FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    const currency = storeRows[0]?.currency ?? "USD";

    // Next order number
    const { rows: numRows } = await client.query<{ next_order_number: string }>(
      `SELECT next_order_number($1::uuid)`,
      [storeId]
    );
    const orderNumber = numRows[0]?.next_order_number ?? "ORDER-1";

    // Create order from quote
    const { rows: orderRows } = await client.query<{ id: string }>(
      `INSERT INTO orders
         (store_id, customer_id, company_id, order_number,
          status, financial_status, fulfillment_status,
          currency, subtotal, total, source_name)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'open', 'pending', 'unfulfilled', $5, $6::numeric, $6::numeric, 'quote')
       RETURNING id::text`,
      [storeId, q.customer_id, q.company_id, orderNumber, currency, subtotal]
    );
    if (!orderRows[0]) throw new Error("acceptQuote: failed to create order");
    const orderId = orderRows[0].id;

    // Copy quote lines → order lines
    await client.query(
      `INSERT INTO order_lines (order_id, variant_id, title, quantity, price, total)
       SELECT $1::uuid, variant_id, title, quantity, price, price * quantity
       FROM quote_lines WHERE quote_id = $2::uuid`,
      [orderId, quoteId]
    );

    // Mark quote converted
    await client.query(
      `UPDATE quotes SET status = 'converted', converted_order_id = $2::uuid, updated_at = now()
       WHERE id = $1::uuid`,
      [quoteId, orderId]
    );

    return { order_id: orderId, order_number: orderNumber };
  });
}

export async function rejectQuote(
  storeId: string,
  quoteId: string
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE quotes SET status = 'rejected', updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid AND status NOT IN ('converted', 'rejected')`,
    [quoteId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Purchase orders ────────────────────────────────────────────────────────────

export async function listPurchaseOrders(storeId: string): Promise<PurchaseOrder[]> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<PurchaseOrder>(
    `SELECT id::text, store_id::text, company_id::text, order_id::text,
            po_number, status, notes, created_at, updated_at
     FROM purchase_orders WHERE store_id = $1::uuid ORDER BY created_at DESC`,
    [storeId]
  );
  return rows;
}

export async function getPurchaseOrder(
  storeId: string,
  poId: string
): Promise<PurchaseOrder | null> {
  // RLS-enforced read path (P4/item-2).
  const pool = getReadDb();
  const { rows } = await pool.query<PurchaseOrder>(
    `SELECT id::text, store_id::text, company_id::text, order_id::text,
            po_number, status, notes, created_at, updated_at
     FROM purchase_orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [poId, storeId]
  );
  return rows[0] ?? null;
}

export async function attachPurchaseOrder(
  storeId: string,
  orderId: string,
  input: AttachPurchaseOrderInput
): Promise<string> {
  const pool = getPool();

  // Verify order belongs to store and get company_id
  const { rows: orderRows } = await pool.query<{ company_id: string | null }>(
    `SELECT company_id::text FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [orderId, storeId]
  );
  if (!orderRows[0]) {
    const e = new Error("order not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }
  const companyId = orderRows[0].company_id;

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO purchase_orders (store_id, company_id, order_id, po_number, status, notes)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'pending', $5) RETURNING id::text`,
      [storeId, companyId, orderId, input.po_number, input.notes ?? null]
    );
    if (!rows[0]) throw new Error("attachPurchaseOrder: no row returned");

    // Update po_number on the order
    await pool.query(
      `UPDATE orders SET po_number = $2, updated_at = now() WHERE id = $1::uuid`,
      [orderId, input.po_number]
    );

    return rows[0].id;
  } catch (err) {
    if (err instanceof Error && err.message.includes("unique")) {
      const e = new Error("a purchase order with that number already exists");
      (e as NodeJS.ErrnoException).code = "DUPLICATE_PO";
      throw e;
    }
    throw err;
  }
}

export async function updatePurchaseOrder(
  storeId: string,
  poId: string,
  input: UpdatePurchaseOrderInput
): Promise<boolean> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE purchase_orders SET
       status     = COALESCE($3, status),
       notes      = COALESCE($4, notes),
       updated_at = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [poId, storeId, input.status ?? null, input.notes ?? null]
  );
  return (rowCount ?? 0) > 0;
}
