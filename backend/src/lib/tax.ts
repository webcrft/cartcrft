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
