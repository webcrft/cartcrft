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
