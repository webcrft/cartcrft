/**
 * lib/tax.ts — Tax zone/rate computation helper.
 *
 * Ported from webcrft-mono/backend/internal/handlers/commerce_checkout.go
 * (checkoutCalcTax function).
 *
 * Zone/rate lookup:
 *   1. Match tax_zone_regions by country_code (and optionally province_code).
 *   2. Apply all active tax rates for matched zones (category_id IS NULL for
 *      general rates; category-specific rates applied when variant has a
 *      tax_category — T2.6 will extend this).
 *   3. Inclusive tax: price already includes tax; extract the tax portion.
 *      exclusive tax: add tax on top of the taxable amount.
 *
 * Returns (taxTotal, taxLines[]) where taxTotal is the SUM of exclusive
 * amounts only — inclusive tax is already baked into the subtotal.
 */

import type pg from "pg";
import { round2 } from "./money.js";
import { config } from "../config/config.js";
import { newTaxJarClient, type TaxJarCalcParams } from "../providers/tax/taxjar.js";

export interface TaxLine {
  name: string;
  rate_pct: number;
  amount: number;
  is_inclusive: boolean;
}

export interface TaxResult {
  taxTotal: number;
  taxLines: TaxLine[];
}

/**
 * Compute tax for a given store, taxable amount, and shipping address codes.
 *
 * @param pool        pg pool (or client inside a transaction)
 * @param storeId     Store UUID
 * @param taxableAmount  Subtotal minus any discount (exclusive base)
 * @param countryCode ISO 3166-1 alpha-2 e.g. "ZA"
 * @param provinceCode  Province/state code e.g. "GP" (may be empty string)
 *
 * Returns empty result when countryCode is empty (no address provided yet).
 *
 * Mirrors Go checkoutCalcTax() faithfully:
 *   - Queries tax_rates JOIN tax_zones JOIN tax_zone_regions
 *   - Filters by store, active, country, province (NULL = all provinces)
 *   - category_id IS NULL (general rates; category-specific = T2.6)
 *   - Limit 10 rates per zone match
 *   - Inclusive: amount = taxable - (taxable / (1 + rate/100))
 *   - Exclusive: amount = taxable * rate / 100
 *   - taxTotal only sums exclusive amounts
 */
export async function calcTax(
  pool: pg.Pool | pg.PoolClient,
  storeId: string,
  taxableAmount: number,
  countryCode: string,
  provinceCode: string
): Promise<TaxResult> {
  if (!countryCode) {
    return { taxTotal: 0, taxLines: [] };
  }

  let rows: { rows: Array<{ name: string; rate_pct: string; is_inclusive: boolean }> };
  try {
    rows = await pool.query<{ name: string; rate_pct: string; is_inclusive: boolean }>(
      `SELECT tr.name, tr.rate_pct, tr.is_inclusive
       FROM tax_rates tr
       JOIN tax_zones tz ON tz.id = tr.zone_id
       JOIN tax_zone_regions tzr ON tzr.zone_id = tz.id
       WHERE tz.store_id = $1::uuid
         AND tr.is_active = true
         AND tzr.country_code = $2
         AND (tzr.province_code IS NULL OR tzr.province_code = $3 OR $3 = '')
         AND tr.category_id IS NULL
       LIMIT 10`,
      [storeId, countryCode.toUpperCase(), provinceCode]
    );
  } catch {
    return { taxTotal: 0, taxLines: [] };
  }

  const taxLines: TaxLine[] = [];
  let taxTotal = 0;

  for (const row of rows.rows) {
    const ratePct = parseFloat(row.rate_pct);
    let amount: number;
    if (row.is_inclusive) {
      amount = taxableAmount - taxableAmount / (1 + ratePct / 100);
    } else {
      amount = taxableAmount * ratePct / 100;
    }
    amount = round2(amount);

    taxLines.push({
      name: row.name,
      rate_pct: ratePct,
      amount,
      is_inclusive: row.is_inclusive,
    });

    if (!row.is_inclusive) {
      taxTotal += amount;
    }
  }

  return { taxTotal: round2(taxTotal), taxLines };
}

/**
 * Extract country_code and province_code from a shipping address JSON object.
 * Returns empty strings if address is null/invalid.
 * Mirrors Go extractAddressCodes().
 */
export function extractAddressCodes(
  addrJson: Record<string, unknown> | null | undefined
): { countryCode: string; provinceCode: string } {
  if (!addrJson) return { countryCode: "", provinceCode: "" };
  return {
    countryCode: (typeof addrJson["country_code"] === "string"
      ? addrJson["country_code"]
      : "").toUpperCase(),
    provinceCode: typeof addrJson["province_code"] === "string"
      ? addrJson["province_code"]
      : "",
  };
}

// ── Tax exemption (Wave-18.1) ───────────────────────────────────────────────────
//
// Additive helper. Resolves whether a checkout/order is tax-exempt because the
// customer OR the company it is placed under is flagged tax_exempt=true (see
// migration 0043_tax_exempt). When this returns true, callers SKIP the tax
// engine entirely (tax_total = 0, tax_lines = []). Independent of the
// calcTax / calcTaxAuto path above — those signatures are unchanged.

/**
 * Whether the given customer and/or company is tax-exempt for this store.
 *
 * Returns true when EITHER the customer row OR the company row has
 * tax_exempt = true. Returns false when neither id is supplied, or when no
 * matching row is found. Every query is scoped by storeId (tenant isolation)
 * and parameterized.
 *
 * Never throws — degrades to false (i.e. "charge tax as normal") on any error,
 * so a transient lookup failure can never silently zero out tax for a
 * non-exempt customer.
 *
 * @param pool    pg pool (or client inside a transaction)
 * @param storeId Store UUID
 * @param ids     { customerId?, companyId? } — either/both may be null/omitted
 */
export async function isTaxExempt(
  pool: pg.Pool | pg.PoolClient,
  storeId: string,
  ids: { customerId?: string | null | undefined; companyId?: string | null | undefined }
): Promise<boolean> {
  const customerId = ids.customerId ?? null;
  const companyId = ids.companyId ?? null;
  if (!customerId && !companyId) return false;

  try {
    if (customerId) {
      const { rows } = await pool.query<{ tax_exempt: boolean }>(
        `SELECT tax_exempt FROM customers
         WHERE id = $1::uuid AND store_id = $2::uuid`,
        [customerId, storeId]
      );
      if (rows[0]?.tax_exempt === true) return true;
    }
    if (companyId) {
      const { rows } = await pool.query<{ tax_exempt: boolean }>(
        `SELECT tax_exempt FROM companies
         WHERE id = $1::uuid AND store_id = $2::uuid`,
        [companyId, storeId]
      );
      if (rows[0]?.tax_exempt === true) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ── Tax-automation provider (env-resolved singleton) ────────────────────────────
//
// Mirrors the notifications mailer pattern (modules/notifications/service.ts):
// a module-level singleton resolved from env at module load, overridable via
// setTaxProvider() for tests / explicit wiring. When TAXJAR_API_KEY is set the
// singleton is a TaxJar-backed provider; otherwise it is null and calcTaxAuto
// falls back to the DB-rate calcTax() path.

/** Parameters passed to a TaxProvider.calc() call. */
export interface TaxProviderParams {
  taxableAmount: number;
  countryCode: string;
  provinceCode: string;
  zip?: string | undefined;
  city?: string | undefined;
}

/** Minimal swappable tax-automation provider interface. */
export interface TaxProvider {
  calc(params: TaxProviderParams): Promise<TaxResult>;
}

/**
 * Build a TaxProvider from config when TAXJAR_API_KEY is set, else null.
 * Mirrors buildMailerFromConfig() in notifications/service.ts.
 */
function buildTaxProviderFromConfig(): TaxProvider | null {
  if (!config.TAXJAR_API_KEY) return null;
  const client = newTaxJarClient(config.TAXJAR_API_KEY, config.TAXJAR_SANDBOX);
  return {
    async calc(params: TaxProviderParams): Promise<TaxResult> {
      const body: TaxJarCalcParams = {
        to_country: params.countryCode.toUpperCase(),
        amount: params.taxableAmount,
        shipping: 0,
        ...(params.provinceCode ? { to_state: params.provinceCode } : {}),
        ...(params.zip ? { to_zip: params.zip } : {}),
        ...(params.city ? { to_city: params.city } : {}),
      };
      const tax = await client.calcTax(body);
      const amount = round2(tax.amount_to_collect);
      const line: TaxLine = {
        name: "Sales tax",
        rate_pct: round2(tax.rate * 100),
        amount,
        is_inclusive: false,
      };
      return { taxTotal: amount, taxLines: [line] };
    },
  };
}

let _taxProvider: TaxProvider | null = buildTaxProviderFromConfig();

/**
 * Override the tax-automation provider (tests / explicit wiring).
 * Pass null to force the DB-rate fallback path.
 */
export function setTaxProvider(p: TaxProvider | null): void {
  _taxProvider = p;
}

/**
 * Compute tax via the configured automation provider, falling back to the
 * DB-rate calcTax() path on any provider error or when no provider is set.
 *
 * Never throws — degrades gracefully to the DB path.
 */
export async function calcTaxAuto(
  pool: pg.Pool | pg.PoolClient,
  storeId: string,
  taxableAmount: number,
  countryCode: string,
  provinceCode: string,
  opts?: { zip?: string | undefined; city?: string | undefined }
): Promise<TaxResult> {
  if (_taxProvider && countryCode) {
    try {
      return await _taxProvider.calc({
        taxableAmount,
        countryCode,
        provinceCode,
        ...(opts?.zip !== undefined ? { zip: opts.zip } : {}),
        ...(opts?.city !== undefined ? { city: opts.city } : {}),
      });
    } catch (err) {
      console.warn("tax: automation provider failed, falling back to DB rates", err);
    }
  }
  return calcTax(pool, storeId, taxableAmount, countryCode, provinceCode);
}

// ── Import duties / landed cost (DDP) ───────────────────────────────────────────
//
// Additive helper (T11.1). Independent of the calcTax / calcTaxAuto path above.
// A store sells from its base country (stores.country_code) and configures duty
// it collects when shipping cross-border into a destination country. Wiring this
// into the actual order total at checkout/complete is a follow-up owned elsewhere.

/** A single matched import-duty line. */
export interface DutyLine {
  name: string;
  rate_pct: number;
  amount: number;
  country: string;
}

/** Result of a duty computation: total + per-rate breakdown. */
export interface DutyResult {
  dutyTotal: number;
  dutyLines: DutyLine[];
}

/**
 * Compute import duty for a cross-border order.
 *
 * @param pool               pg pool (or client inside a transaction)
 * @param storeId            Store UUID
 * @param declaredValue      Declared / order value duty is assessed on
 * @param destinationCountry ISO 3166-1 alpha-2 ship-to country
 * @param opts.originCountry ISO 3166-1 alpha-2 origin (store base country). When
 *                           omitted, duty is treated as applicable (no same-country
 *                           guard); when equal to destination, duty is zero.
 * @param opts.categories    Product categories / HS chapters present in the order.
 *                           A duty rate with a non-NULL category only applies when
 *                           it matches one of these; NULL-category rates always apply.
 *
 * Behaviour:
 *   - Applies only when destinationCountry is set AND (no originCountry OR
 *     destinationCountry !== originCountry). Same-country → zero.
 *   - For each active duty_rates row for (store, destination):
 *       • category filter: NULL-category rates always apply; a set category only
 *         applies when opts.categories includes it.
 *       • de_minimis: if declaredValue <= de_minimis_value, that rate → amount 0.
 *       • amount = declaredValue × rate_pct / 100, rounded to 2dp.
 *   - dutyTotal is the rounded sum of line amounts.
 *
 * Never throws — degrades to a zero result on any error.
 */
export async function calcDuties(
  pool: pg.Pool | pg.PoolClient,
  storeId: string,
  declaredValue: number,
  destinationCountry: string,
  opts?: { originCountry?: string | undefined; categories?: string[] | undefined }
): Promise<DutyResult> {
  const dest = (destinationCountry ?? "").toUpperCase();
  if (!dest) return { dutyTotal: 0, dutyLines: [] };

  const origin = (opts?.originCountry ?? "").toUpperCase();
  // Cross-border only: same-country (origin known and equal) → zero.
  if (origin && origin === dest) return { dutyTotal: 0, dutyLines: [] };

  let rows: {
    rows: Array<{
      destination_country: string;
      category: string | null;
      rate_pct: string;
      de_minimis_value: string | null;
    }>;
  };
  try {
    rows = await pool.query<{
      destination_country: string;
      category: string | null;
      rate_pct: string;
      de_minimis_value: string | null;
    }>(
      `SELECT destination_country, category, rate_pct, de_minimis_value
       FROM duty_rates
       WHERE store_id = $1::uuid
         AND is_active = true
         AND destination_country = $2
       LIMIT 50`,
      [storeId, dest]
    );
  } catch {
    return { dutyTotal: 0, dutyLines: [] };
  }

  const categories = opts?.categories;
  const dutyLines: DutyLine[] = [];
  let dutyTotal = 0;

  for (const row of rows.rows) {
    // Category filter: NULL applies to all; a set category must be present in opts.categories.
    if (row.category !== null) {
      if (!categories || !categories.includes(row.category)) continue;
    }

    const ratePct = parseFloat(row.rate_pct);
    if (!Number.isFinite(ratePct)) continue;

    let amount = 0;
    const deMinimis =
      row.de_minimis_value !== null ? parseFloat(row.de_minimis_value) : null;
    const waived =
      deMinimis !== null && Number.isFinite(deMinimis) && declaredValue <= deMinimis;
    if (!waived) {
      amount = round2(declaredValue * ratePct / 100);
    }

    dutyLines.push({
      name: row.category ? `Import duty (${row.category})` : "Import duty",
      rate_pct: ratePct,
      amount,
      country: row.destination_country,
    });
    dutyTotal += amount;
  }

  return { dutyTotal: round2(dutyTotal), dutyLines };
}
