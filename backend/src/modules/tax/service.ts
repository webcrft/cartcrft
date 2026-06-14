/**
 * tax/service.ts — Tax categories, zones, regions, and rates CRUD.
 *
 * Ported from webcrft-mono/backend/internal/handlers/commerce_tax.go.
 *
 * Rate computation is handled by backend/src/lib/tax.ts (T2.3 helper, reused).
 * This module only manages the configuration tables.
 *
 * Constraints:
 *  - rate_pct validated [0, 100] at service level (mirrors Go handler)
 *  - zone create/update with regions uses a single transaction
 *  - category code must be unique per store (DB UNIQUE constraint enforced)
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";

// ── Tax categories ────────────────────────────────────────────────────────────

export async function listTaxCategories(storeId: string) {
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, name, code, created_at
     FROM tax_categories WHERE store_id = $1::uuid ORDER BY name`,
    [storeId]
  );
  return rows;
}

export async function createTaxCategory(
  storeId: string,
  data: { name: string; code: string }
) {
  const pool = getPool();
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tax_categories (store_id, name, code) VALUES ($1::uuid, $2, $3) RETURNING id::text`,
      [storeId, data.name.trim(), data.code.trim()]
    );
    return { id: rows[0]!.id, duplicate: false };
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("unique")) {
      return { id: null, duplicate: true };
    }
    throw err;
  }
}

export async function deleteTaxCategory(storeId: string, categoryId: string) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM tax_categories WHERE id = $1::uuid AND store_id = $2::uuid`,
    [categoryId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Tax zones ─────────────────────────────────────────────────────────────────

export async function listTaxZones(storeId: string) {
  const pool = getReadDb();
  const { rows: zones } = await pool.query<{ id: string }>(
    `SELECT id::text, store_id::text, name, created_at
     FROM tax_zones WHERE store_id = $1::uuid ORDER BY name`,
    [storeId]
  );
  for (const zone of zones) {
    const { rows: regions } = await pool.query(
      `SELECT id::text, zone_id::text, country_code, province_code
       FROM tax_zone_regions WHERE zone_id = $1::uuid ORDER BY country_code, province_code`,
      [zone.id]
    );
    (zone as Record<string, unknown>)["regions"] = regions;
  }
  return zones;
}

export async function createTaxZone(
  storeId: string,
  data: {
    name: string;
    regions?: Array<{ country_code: string; province_code?: string | null | undefined }> | undefined;
  }
) {
  return withTx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO tax_zones (store_id, name) VALUES ($1::uuid, $2) RETURNING id::text`,
      [storeId, data.name.trim()]
    );
    const zoneId = rows[0]!.id;
    for (const reg of data.regions ?? []) {
      const cc = reg.country_code.toUpperCase().trim();
      if (!cc) continue;
      await client.query(
        `INSERT INTO tax_zone_regions (zone_id, country_code, province_code) VALUES ($1::uuid, $2, $3)`,
        [zoneId, cc, reg.province_code ?? null]
      );
    }
    return zoneId;
  });
}

export async function updateTaxZone(
  storeId: string,
  zoneId: string,
  data: {
    name?: string | undefined;
    regions?: Array<{ country_code: string; province_code?: string | null | undefined }> | undefined;
  }
) {
  const pool = getPool();
  if (data.name?.trim()) {
    await pool.query(
      `UPDATE tax_zones SET name = $2 WHERE id = $1::uuid AND store_id = $3::uuid`,
      [zoneId, data.name.trim(), storeId]
    );
  }
  if (data.regions !== undefined) {
    await withTx(async (client) => {
      await client.query(`DELETE FROM tax_zone_regions WHERE zone_id = $1::uuid`, [zoneId]);
      for (const reg of data.regions!) {
        const cc = reg.country_code.toUpperCase().trim();
        if (!cc) continue;
        await client.query(
          `INSERT INTO tax_zone_regions (zone_id, country_code, province_code) VALUES ($1::uuid, $2, $3)`,
          [zoneId, cc, reg.province_code ?? null]
        );
      }
    });
  }
  return true;
}

export async function deleteTaxZone(storeId: string, zoneId: string) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM tax_zones WHERE id = $1::uuid AND store_id = $2::uuid`,
    [zoneId, storeId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Tax rates ─────────────────────────────────────────────────────────────────

export async function listTaxRates(storeId: string, zoneId: string) {
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT tr.id::text, tr.zone_id::text, tr.category_id::text, tr.name,
            tr.rate_pct, tr.is_inclusive, tr.is_active, tr.created_at,
            tc.code AS category_code, tc.name AS category_name
     FROM tax_rates tr
     LEFT JOIN tax_categories tc ON tc.id = tr.category_id
     WHERE tr.zone_id = $1::uuid
       AND EXISTS (SELECT 1 FROM tax_zones tz WHERE tz.id = tr.zone_id AND tz.store_id = $2::uuid)
     ORDER BY tr.name`,
    [zoneId, storeId]
  );
  return rows;
}

export async function createTaxRate(
  storeId: string,
  zoneId: string,
  data: {
    name: string;
    rate_pct: number;
    category_id?: string | null | undefined;
    is_inclusive?: boolean | undefined;
    is_active?: boolean | undefined;
  }
) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tax_rates (zone_id, category_id, name, rate_pct, is_inclusive, is_active)
     SELECT $1::uuid, $2, $3, $4, COALESCE($5, false), COALESCE($6, true)
     WHERE EXISTS (SELECT 1 FROM tax_zones WHERE id = $1::uuid AND store_id = $7::uuid)
     RETURNING id::text`,
    [
      zoneId,
      data.category_id ?? null,
      data.name.trim(),
      data.rate_pct,
      data.is_inclusive ?? null,
      data.is_active ?? null,
      storeId,
    ]
  );
  return rows[0]?.id ?? null;
}

export async function updateTaxRate(
  storeId: string,
  zoneId: string,
  rateId: string,
  data: {
    name?: string | null | undefined;
    rate_pct?: number | null | undefined;
    is_inclusive?: boolean | null | undefined;
    is_active?: boolean | null | undefined;
    category_id?: string | null | undefined;
  }
) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE tax_rates SET
       name         = COALESCE($3, name),
       rate_pct     = COALESCE($4, rate_pct),
       is_inclusive = COALESCE($5, is_inclusive),
       is_active    = COALESCE($6, is_active),
       category_id  = COALESCE($7, category_id)
     WHERE id = $1::uuid AND zone_id = $2::uuid
       AND EXISTS (SELECT 1 FROM tax_zones WHERE id = $2::uuid AND store_id = $8::uuid)`,
    [
      rateId, zoneId,
      data.name ?? null,
      data.rate_pct ?? null,
      data.is_inclusive ?? null,
      data.is_active ?? null,
      data.category_id ?? null,
      storeId,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteTaxRate(storeId: string, zoneId: string, rateId: string) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM tax_rates WHERE id = $1::uuid AND zone_id = $2::uuid
       AND EXISTS (SELECT 1 FROM tax_zones WHERE id = $2::uuid AND store_id = $3::uuid)`,
    [rateId, zoneId, storeId]
  );
  return (rowCount ?? 0) > 0;
}
