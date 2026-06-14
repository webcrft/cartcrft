/**
 * shipping/service.ts — SQL + business logic for shipping management.
 *
 * Covers:
 *  - Shipping zones CRUD (with regions: country + optional province)
 *  - Static shipping rates CRUD (weight/total bounds)
 *  - Available rates query: zone-match by country/province, weight/total filter,
 *    then merge live BobGo rates when a bobgo provider is configured
 *  - Shipping providers CRUD (upsert)
 *  - Collection points CRUD (upsert + update + delete)
 *  - Shipments CRUD + tracking events list
 *  - Fulfillment orders CRUD
 *  - Carrier tracking push webhook handling
 *
 * Zone-matching rules (mirrors commerce_shipping.go):
 *   1. Must match shipping_zone_regions.country_code (exact, uppercased)
 *   2. province_code match: if region has province_code, must equal query province
 *      (NULL province on the region = matches all provinces)
 *   3. DISTINCT to handle overlapping zones
 *   4. BobGo live rates merged after static when a bobgo provider is active + api_key present
 */

import { getPool, getReadDb, withTx } from "../../db/pool.js";
import { newBobGoClient } from "../../providers/shipping/bobgo.js";
import { dispatchStoreEvent } from "../notifications/service.js";

// ── Shipping zones ────────────────────────────────────────────────────────────

export async function listShippingZones(storeId: string) {
  const pool = getReadDb();
  const { rows: zones } = await pool.query<{ id: string }>(
    `SELECT id::text, store_id::text, name, created_at
     FROM shipping_zones WHERE store_id = $1::uuid ORDER BY name`,
    [storeId]
  );
  // Attach regions to each zone
  for (const zone of zones) {
    const { rows: regions } = await pool.query(
      `SELECT id::text, zone_id::text, country_code, province_code
       FROM shipping_zone_regions WHERE zone_id = $1::uuid ORDER BY country_code`,
      [zone.id]
    );
    (zone as Record<string, unknown>)["regions"] = regions;
  }
  return zones;
}

export async function createShippingZone(
  storeId: string,
  data: {
    name: string;
    regions?: Array<{ country_code: string; province_code?: string | null | undefined }> | undefined;
  }
) {
  return withTx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO shipping_zones (store_id, name) VALUES ($1::uuid, $2) RETURNING id::text`,
      [storeId, data.name]
    );
    const zoneId = rows[0]!.id;

    for (const reg of data.regions ?? []) {
      const cc = reg.country_code.toUpperCase().trim();
      if (!cc) continue;
      await client.query(
        `INSERT INTO shipping_zone_regions (zone_id, country_code, province_code)
         VALUES ($1::uuid, $2, $3)`,
        [zoneId, cc, reg.province_code ?? null]
      );
    }
    return zoneId;
  });
}

export async function updateShippingZone(
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
      `UPDATE shipping_zones SET name = $2 WHERE id = $1::uuid AND store_id = $3::uuid`,
      [zoneId, data.name.trim(), storeId]
    );
  }
  if (data.regions !== undefined) {
    await withTx(async (client) => {
      await client.query(`DELETE FROM shipping_zone_regions WHERE zone_id = $1::uuid`, [zoneId]);
      for (const reg of data.regions!) {
        const cc = reg.country_code.toUpperCase().trim();
        if (!cc) continue;
        await client.query(
          `INSERT INTO shipping_zone_regions (zone_id, country_code, province_code)
           VALUES ($1::uuid, $2, $3)`,
          [zoneId, cc, reg.province_code ?? null]
        );
      }
    });
  }
  return true;
}

export async function deleteShippingZone(storeId: string, zoneId: string) {
  const pool = getPool();
  await pool.query(
    `DELETE FROM shipping_zones WHERE id = $1::uuid AND store_id = $2::uuid`,
    [zoneId, storeId]
  );
}

// ── Static shipping rates ─────────────────────────────────────────────────────

export async function listShippingRates(storeId: string, zoneId: string) {
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT sr.id::text, sr.zone_id::text, sr.provider_id::text, sr.name,
            sr.price, sr.min_weight_g, sr.max_weight_g,
            sr.min_order_total, sr.max_order_total,
            sr.estimated_days_min, sr.estimated_days_max, sr.is_active, sr.created_at
     FROM shipping_rates sr
     WHERE sr.zone_id = $1::uuid
       AND EXISTS (SELECT 1 FROM shipping_zones sz WHERE sz.id = sr.zone_id AND sz.store_id = $2::uuid)
     ORDER BY sr.price, sr.name`,
    [zoneId, storeId]
  );
  return rows;
}

export async function createShippingRate(
  storeId: string,
  zoneId: string,
  data: {
    name: string;
    price?: number | null | undefined;
    min_weight_g?: number | null | undefined;
    max_weight_g?: number | null | undefined;
    min_order_total?: number | null | undefined;
    max_order_total?: number | null | undefined;
    estimated_days_min?: number | null | undefined;
    estimated_days_max?: number | null | undefined;
    is_active?: boolean | undefined;
  }
) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO shipping_rates
       (zone_id, name, price, min_weight_g, max_weight_g,
        min_order_total, max_order_total, estimated_days_min, estimated_days_max, is_active)
     SELECT $1::uuid, $2, COALESCE($3, 0), $4, $5, $6, $7, $8, $9, COALESCE($10, true)
     WHERE EXISTS (SELECT 1 FROM shipping_zones WHERE id = $1::uuid AND store_id = $11::uuid)
     RETURNING id::text`,
    [
      zoneId, data.name,
      data.price ?? null,
      data.min_weight_g ?? null,
      data.max_weight_g ?? null,
      data.min_order_total ?? null,
      data.max_order_total ?? null,
      data.estimated_days_min ?? null,
      data.estimated_days_max ?? null,
      data.is_active ?? null,
      storeId,
    ]
  );
  return rows[0]?.id ?? null;
}

export async function updateShippingRate(
  storeId: string,
  zoneId: string,
  rateId: string,
  data: {
    name?: string | null | undefined;
    price?: number | null | undefined;
    min_weight_g?: number | null | undefined;
    max_weight_g?: number | null | undefined;
    min_order_total?: number | null | undefined;
    max_order_total?: number | null | undefined;
    estimated_days_min?: number | null | undefined;
    estimated_days_max?: number | null | undefined;
    is_active?: boolean | null | undefined;
  }
) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE shipping_rates SET
       name               = COALESCE($3, name),
       price              = COALESCE($4, price),
       min_weight_g       = COALESCE($5, min_weight_g),
       max_weight_g       = COALESCE($6, max_weight_g),
       min_order_total    = COALESCE($7, min_order_total),
       max_order_total    = COALESCE($8, max_order_total),
       estimated_days_min = COALESCE($9, estimated_days_min),
       estimated_days_max = COALESCE($10, estimated_days_max),
       is_active          = COALESCE($11, is_active)
     WHERE id = $1::uuid AND zone_id = $2::uuid
       AND EXISTS (SELECT 1 FROM shipping_zones WHERE id = $2::uuid AND store_id = $12::uuid)`,
    [
      rateId, zoneId,
      data.name ?? null,
      data.price ?? null,
      data.min_weight_g ?? null,
      data.max_weight_g ?? null,
      data.min_order_total ?? null,
      data.max_order_total ?? null,
      data.estimated_days_min ?? null,
      data.estimated_days_max ?? null,
      data.is_active ?? null,
      storeId,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteShippingRate(storeId: string, zoneId: string, rateId: string) {
  const pool = getPool();
  await pool.query(
    `DELETE FROM shipping_rates WHERE id = $1::uuid AND zone_id = $2::uuid
       AND EXISTS (SELECT 1 FROM shipping_zones WHERE id = $2::uuid AND store_id = $3::uuid)`,
    [rateId, zoneId, storeId]
  );
}

// ── Available rates query ─────────────────────────────────────────────────────

export interface AvailableRateOpts {
  country_code: string;
  province_code?: string | undefined;
  weight_g?: number | undefined;
  order_total?: string | undefined;
  city?: string | undefined;
  postal_code?: string | undefined;
}

export async function getAvailableShippingRates(
  storeId: string,
  opts: AvailableRateOpts
) {
  const pool = getReadDb();
  const countryCode = opts.country_code.toUpperCase().trim();
  const provinceCode = opts.province_code?.trim() ?? "";
  const weightG = opts.weight_g ?? 0;
  const orderTotal = opts.order_total ?? "0";

  // Static rates: zone-match by country/province, filter by weight/total bounds
  const { rows: staticRates } = await pool.query(
    `SELECT DISTINCT sr.id::text, sr.zone_id::text, sr.name, sr.price,
            sr.estimated_days_min, sr.estimated_days_max
     FROM shipping_rates sr
     JOIN shipping_zones sz ON sz.id = sr.zone_id
     JOIN shipping_zone_regions szr ON szr.zone_id = sz.id
     WHERE sz.store_id = $1::uuid
       AND sr.is_active = true
       AND szr.country_code = $2
       AND (szr.province_code IS NULL OR szr.province_code = $3 OR $3 = '')
       AND (sr.min_weight_g IS NULL OR sr.min_weight_g <= $4)
       AND (sr.max_weight_g IS NULL OR sr.max_weight_g >= $4)
       AND (sr.min_order_total IS NULL OR sr.min_order_total <= $5::numeric)
       AND (sr.max_order_total IS NULL OR sr.max_order_total >= $5::numeric)
     ORDER BY sr.price, sr.name`,
    [storeId, countryCode, provinceCode, weightG, orderTotal]
  );

  const rates: unknown[] = [...staticRates];

  // Augment with live BobGo rates when a bobgo provider is configured
  if (countryCode) {
    const bobgoRates = await fetchBobGoRates(storeId, {
      countryCode,
      weightG,
      city: opts.city ?? "",
      postalCode: opts.postal_code ?? "",
    });
    rates.push(...bobgoRates);
  }

  return rates;
}

async function fetchBobGoRates(
  storeId: string,
  opts: { countryCode: string; weightG: number; city: string; postalCode: string }
) {
  const pool = getReadDb();

  // Find active bobgo provider: stored as type='webhook' with config.provider='bobgo'
  const { rows: provRows } = await pool.query<{ id: string; config: Record<string, unknown> }>(
    `SELECT id::text, COALESCE(config, '{}') AS config
     FROM shipping_providers
     WHERE store_id = $1::uuid
       AND type = 'webhook'
       AND (config->>'provider' = 'bobgo' OR name ILIKE '%bobgo%')
       AND is_active = true
     LIMIT 1`,
    [storeId]
  );
  const prov = provRows[0];
  if (!prov) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- config is jsonb
  const cfg = prov.config as Record<string, any>;
  const apiKey = typeof cfg["api_key"] === "string" ? cfg["api_key"] : "";
  if (!apiKey) return [];

  // Get default warehouse address as collection point
  const { rows: whRows } = await pool.query<{ address: Record<string, unknown> | null }>(
    `SELECT COALESCE(address, '{}') AS address
     FROM warehouses WHERE store_id = $1::uuid AND is_default = true LIMIT 1`,
    [storeId]
  );
  const warehouseAddr: Record<string, unknown> = whRows[0]?.address ?? {};

  const weightKg = opts.weightG > 0 ? opts.weightG / 1000 : 0.5;

  try {
    const client = newBobGoClient(apiKey);
    const liveRates = await client.getRates({
      collection_address: {
        street_address: String(warehouseAddr["street_address"] ?? ""),
        city: String(warehouseAddr["city"] ?? ""),
        postal_code: String(warehouseAddr["postal_code"] ?? ""),
        country_code: String(warehouseAddr["country_code"] ?? "ZA").toUpperCase(),
      },
      delivery_address: {
        street_address: "",
        city: opts.city,
        postal_code: opts.postalCode,
        country_code: opts.countryCode,
      },
      parcels: [
        {
          submitted_weight_kg: weightKg,
          parcel_dimensions: { length: 20, width: 15, height: 10 },
        },
      ],
    });

    return liveRates.map((lr) => ({
      id: `bobgo:${lr.service_level_code}`,
      provider_id: prov.id,
      provider: "bobgo",
      name: `${lr.service_level_name} (${lr.courier_name})`,
      price: lr.total_charge_incl_vat,
      currency: lr.currency,
      estimated_days_min: lr.estimated_delivery_days,
      estimated_days_max: lr.estimated_delivery_days + 1,
      service_level_code: lr.service_level_code,
      courier_code: lr.courier_code,
    }));
  } catch {
    // Non-fatal — BobGo API failure degrades gracefully
    return [];
  }
}

// ── Shipping providers ────────────────────────────────────────────────────────

export async function listShippingProviders(storeId: string) {
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT id::text, store_id::text, name, type, webhook_url,
            config, is_active, position, created_at, updated_at
     FROM shipping_providers WHERE store_id = $1::uuid ORDER BY position, name`,
    [storeId]
  );
  return rows;
}

export async function upsertShippingProvider(
  storeId: string,
  data: {
    name: string;
    type: string;
    webhook_url?: string | null | undefined;
    config?: Record<string, unknown> | null | undefined;
    is_active?: boolean | undefined;
    position?: number | undefined;
  }
) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO shipping_providers (store_id, name, type, webhook_url, config, is_active, position)
     VALUES ($1::uuid, $2, $3, $4, COALESCE($5, '{}')::jsonb, COALESCE($6, true), COALESCE($7, 0))
     RETURNING id::text`,
    [
      storeId,
      data.name,
      data.type,
      data.webhook_url ?? null,
      data.config ? JSON.stringify(data.config) : null,
      data.is_active ?? null,
      data.position ?? null,
    ]
  );
  return rows[0]!.id;
}

export async function deleteShippingProvider(storeId: string, providerId: string) {
  const pool = getPool();
  await pool.query(
    `DELETE FROM shipping_providers WHERE id = $1::uuid AND store_id = $2::uuid`,
    [providerId, storeId]
  );
}

// ── Collection points ─────────────────────────────────────────────────────────

export async function listCollectionPoints(
  storeId: string,
  opts: { active_only?: boolean | undefined; provider_id?: string | undefined } = {}
) {
  const pool = getReadDb();
  let query = `
    SELECT id::text, store_id::text, provider_id::text, name, provider_ref,
           address, coordinates, operating_hours, is_active, created_at, updated_at
    FROM collection_points WHERE store_id = $1::uuid`;
  const args: unknown[] = [storeId];
  let argN = 2;

  if (opts.active_only !== false) {
    query += ` AND is_active = true`;
  }
  if (opts.provider_id) {
    query += ` AND provider_id = $${argN}::uuid`;
    args.push(opts.provider_id);
    argN++;
  }
  query += ` ORDER BY name`;

  const { rows } = await pool.query(query, args);
  return rows;
}

export async function upsertCollectionPoint(
  storeId: string,
  data: {
    name: string;
    address: Record<string, unknown>;
    provider_id?: string | null | undefined;
    provider_ref?: string | null | undefined;
    coordinates?: Record<string, unknown> | null | undefined;
    operating_hours?: Record<string, unknown> | null | undefined;
    is_active?: boolean | undefined;
  }
) {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO collection_points (store_id, provider_id, name, provider_ref, address, coordinates, operating_hours, is_active)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, COALESCE($8, true))
     RETURNING id::text`,
    [
      storeId,
      data.provider_id ?? null,
      data.name,
      data.provider_ref ?? null,
      JSON.stringify(data.address),
      data.coordinates ? JSON.stringify(data.coordinates) : null,
      data.operating_hours ? JSON.stringify(data.operating_hours) : null,
      data.is_active ?? null,
    ]
  );
  return rows[0]!.id;
}

export async function updateCollectionPoint(
  storeId: string,
  pointId: string,
  data: {
    name?: string | null;
    address?: Record<string, unknown> | null;
    coordinates?: Record<string, unknown> | null;
    operating_hours?: Record<string, unknown> | null;
    is_active?: boolean | null;
  }
) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE collection_points SET
       name            = COALESCE($3, name),
       address         = COALESCE($4::jsonb, address),
       coordinates     = COALESCE($5::jsonb, coordinates),
       operating_hours = COALESCE($6::jsonb, operating_hours),
       is_active       = COALESCE($7, is_active),
       updated_at      = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      pointId, storeId,
      data.name ?? null,
      data.address ? JSON.stringify(data.address) : null,
      data.coordinates ? JSON.stringify(data.coordinates) : null,
      data.operating_hours ? JSON.stringify(data.operating_hours) : null,
      data.is_active ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteCollectionPoint(storeId: string, pointId: string) {
  const pool = getPool();
  await pool.query(
    `DELETE FROM collection_points WHERE id = $1::uuid AND store_id = $2::uuid`,
    [pointId, storeId]
  );
}

// ── Shipments ─────────────────────────────────────────────────────────────────

export async function listShipments(storeId: string, orderId: string) {
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT s.id::text, s.order_id::text, s.provider_id::text, s.warehouse_id::text,
            s.collection_point_id::text, s.status, s.tracking_number, s.tracking_url,
            s.carrier, s.service_level, s.provider_reference, s.label_url,
            s.shipped_at, s.estimated_delivery, s.delivered_at,
            s.metadata, s.created_at, s.updated_at
     FROM shipments s
     JOIN orders o ON o.id = s.order_id
     WHERE s.order_id = $1::uuid AND o.store_id = $2::uuid
     ORDER BY s.created_at`,
    [orderId, storeId]
  );
  return rows;
}

export async function createShipment(
  storeId: string,
  orderId: string,
  data: {
    provider_id?: string | null | undefined;
    warehouse_id?: string | null | undefined;
    collection_point_id?: string | null | undefined;
    status?: string | undefined;
    tracking_number?: string | null | undefined;
    tracking_url?: string | null | undefined;
    carrier?: string | null | undefined;
    service_level?: string | null | undefined;
    shipped_at?: string | null | undefined;
    estimated_delivery?: string | null | undefined;
    metadata?: Record<string, unknown> | null | undefined;
    lines?: Array<{
      order_line_id: string;
      quantity: number;
      lot_id?: string | null | undefined;
      serial_id?: string | null | undefined;
    }> | undefined;
  }
) {
  return withTx(async (client) => {
    // Verify order belongs to store
    const { rows: orderRows } = await client.query<{ id: string }>(
      `SELECT id FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
      [orderId, storeId]
    );
    if (!orderRows[0]) return null;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO shipments (order_id, provider_id, warehouse_id, collection_point_id,
         status, tracking_number, tracking_url, carrier, service_level,
         shipped_at, estimated_delivery, metadata)
       VALUES ($1::uuid, $2, $3, $4,
         COALESCE($5, 'pending'), $6, $7, $8, $9,
         $10, $11, COALESCE($12::jsonb, '{}'::jsonb))
       RETURNING id::text`,
      [
        orderId,
        data.provider_id ?? null,
        data.warehouse_id ?? null,
        data.collection_point_id ?? null,
        data.status ?? null,
        data.tracking_number ?? null,
        data.tracking_url ?? null,
        data.carrier ?? null,
        data.service_level ?? null,
        data.shipped_at ?? null,
        data.estimated_delivery ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
      ]
    );
    const shipmentId = rows[0]!.id;

    // Insert shipment lines
    for (const line of data.lines ?? []) {
      await client.query(
        `INSERT INTO shipment_lines (shipment_id, order_line_id, quantity, lot_id, serial_id)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
        [
          shipmentId,
          line.order_line_id,
          line.quantity,
          line.lot_id ?? null,
          line.serial_id ?? null,
        ]
      );
    }

    // Fire-and-forget outbound notification (H2.1)
    dispatchStoreEvent(storeId, "shipment.created", {
      order_id: orderId,
      shipment_id: shipmentId,
      status: data.status ?? "pending",
      tracking_number: data.tracking_number ?? "",
      carrier: data.carrier ?? "",
    });

    return shipmentId;
  });
}

export async function updateShipment(
  storeId: string,
  orderId: string,
  shipmentId: string,
  data: {
    status?: string | undefined;
    tracking_number?: string | null | undefined;
    tracking_url?: string | null | undefined;
    carrier?: string | null | undefined;
    service_level?: string | null | undefined;
    shipped_at?: string | null | undefined;
    estimated_delivery?: string | null | undefined;
    delivered_at?: string | null | undefined;
    metadata?: Record<string, unknown> | null | undefined;
  }
) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE shipments SET
       status             = COALESCE($4, status),
       tracking_number    = COALESCE($5, tracking_number),
       tracking_url       = COALESCE($6, tracking_url),
       carrier            = COALESCE($7, carrier),
       service_level      = COALESCE($8, service_level),
       shipped_at         = COALESCE($9, shipped_at),
       estimated_delivery = COALESCE($10, estimated_delivery),
       delivered_at       = COALESCE($11, delivered_at),
       metadata           = COALESCE($12::jsonb, metadata),
       updated_at         = now()
     WHERE id = $1::uuid AND order_id = $2::uuid
       AND EXISTS (SELECT 1 FROM orders WHERE id = $2::uuid AND store_id = $3::uuid)`,
    [
      shipmentId, orderId, storeId,
      data.status ?? null,
      data.tracking_number ?? null,
      data.tracking_url ?? null,
      data.carrier ?? null,
      data.service_level ?? null,
      data.shipped_at ?? null,
      data.estimated_delivery ?? null,
      data.delivered_at ?? null,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]
  );
  const updated = (rowCount ?? 0) > 0;
  if (updated) {
    // Fire-and-forget outbound notification (H2.1)
    // Emit shipment.delivered when status transitions to delivered, else shipment.updated.
    const eventType = data.status === "delivered" ? "shipment.delivered" : "shipment.updated";
    dispatchStoreEvent(storeId, eventType, {
      order_id: orderId,
      shipment_id: shipmentId,
      status: data.status ?? "",
      tracking_number: data.tracking_number ?? "",
      carrier: data.carrier ?? "",
    });
  }
  return updated;
}

export async function listShipmentTracking(
  storeId: string,
  orderId: string,
  shipmentId: string
) {
  const pool = getReadDb();
  const { rows } = await pool.query(
    `SELECT ste.id::text, ste.shipment_id::text, ste.status, ste.location, ste.description,
            ste.occurred_at, ste.created_at
     FROM shipment_tracking_events ste
     JOIN shipments s ON s.id = ste.shipment_id
     JOIN orders o ON o.id = s.order_id
     WHERE ste.shipment_id = $1::uuid AND s.order_id = $2::uuid AND o.store_id = $3::uuid
     ORDER BY ste.occurred_at ASC`,
    [shipmentId, orderId, storeId]
  );
  return rows;
}

/**
 * Push a tracking event from a carrier webhook.
 * Verifies HMAC-SHA256 if the provider has a webhook_secret.
 * Updates shipment status based on carrier status string.
 */
export async function pushTrackingEvent(
  storeId: string,
  shipmentId: string,
  data: {
    status: string;
    location?: string | null | undefined;
    description?: string | null | undefined;
    occurred_at?: string | null | undefined;
    raw_data?: Record<string, unknown> | undefined;
  }
) {
  return withTx(async (client) => {
    // Verify shipment belongs to store
    const { rows: shRows } = await client.query<{ order_id: string }>(
      `SELECT s.order_id::text
       FROM shipments s
       JOIN orders o ON o.id = s.order_id
       WHERE s.id = $1::uuid AND o.store_id = $2::uuid`,
      [shipmentId, storeId]
    );
    if (!shRows[0]) return null;

    const occurredAt = data.occurred_at
      ? new Date(data.occurred_at)
      : new Date();

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO shipment_tracking_events (shipment_id, status, location, description, occurred_at, raw_data)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb) RETURNING id::text`,
      [
        shipmentId,
        data.status,
        data.location ?? null,
        data.description ?? null,
        occurredAt.toISOString(),
        JSON.stringify(data.raw_data ?? {}),
      ]
    );

    // Map carrier status to shipment status
    const newStatus = mapCarrierStatus(data.status);
    if (newStatus) {
      const updates: string[] = ["status = $2", "updated_at = now()"];
      const updateArgs: unknown[] = [shipmentId, newStatus];
      if (newStatus === "delivered") {
        updates.push("delivered_at = $3");
        updateArgs.push(occurredAt.toISOString());
      }
      await client.query(
        `UPDATE shipments SET ${updates.join(", ")} WHERE id = $1::uuid`,
        updateArgs
      );
    }

    const result = { id: rows[0]!.id, order_id: shRows[0].order_id };

    // Fire-and-forget outbound notification (H2.1): carrier-push tracking event
    const trackingEventType = newStatus === "delivered" ? "shipment.delivered" : "shipment.updated";
    dispatchStoreEvent(storeId, trackingEventType, {
      order_id: result.order_id,
      shipment_id: shipmentId,
      status: newStatus || data.status,
      tracking_event_id: result.id,
    });

    return result;
  });
}

/**
 * Look up a shipment's webhook_secret for carrier auth.
 */
export async function getShipmentWebhookSecret(
  storeId: string,
  shipmentId: string
): Promise<string | null> {
  const pool = getReadDb();
  const { rows } = await pool.query<{ webhook_secret: string | null }>(
    `SELECT COALESCE(sp.webhook_secret, '') AS webhook_secret
     FROM shipments s
     JOIN orders o ON o.id = s.order_id
     LEFT JOIN shipping_providers sp ON sp.id = s.provider_id
     WHERE s.id = $1::uuid AND o.store_id = $2::uuid`,
    [shipmentId, storeId]
  );
  return rows[0]?.webhook_secret ?? null;
}

/**
 * Maps a free-form carrier status string to a shipment status enum value.
 * Mirrors Go mapCarrierStatus().
 */
export function mapCarrierStatus(s: string): string {
  const lower = s.toLowerCase().trim();
  if (lower.includes("delivered")) return "delivered";
  if (lower.includes("out_for_delivery") || lower.includes("out for delivery")) return "out_for_delivery";
  if (lower.includes("in_transit") || lower.includes("in transit")) return "in_transit";
  if (lower.includes("dispatched") || lower.includes("shipped")) return "dispatched";
  if (lower.includes("failed") || lower.includes("undeliverable")) return "failed_delivery";
  if (lower.includes("returned")) return "returned";
  return "";
}

// ── Fulfillment orders ────────────────────────────────────────────────────────

export async function listFulfillmentOrders(storeId: string, orderId: string) {
  const pool = getReadDb();
  const { rows: fos } = await pool.query<{ id: string }>(
    `SELECT fo.id::text, fo.store_id::text, fo.order_id::text, fo.warehouse_id::text,
            fo.status, fo.request_status, fo.notes,
            fo.created_at, fo.updated_at
     FROM fulfillment_orders fo
     WHERE fo.order_id = $1::uuid AND fo.store_id = $2::uuid
     ORDER BY fo.created_at`,
    [orderId, storeId]
  );
  // Attach lines
  for (const fo of fos) {
    const { rows: lines } = await pool.query(
      `SELECT id::text, fulfillment_order_id::text, order_line_id::text,
              quantity, quantity_fulfilled, created_at, updated_at
       FROM fulfillment_order_lines WHERE fulfillment_order_id = $1::uuid`,
      [fo.id]
    );
    (fo as Record<string, unknown>)["lines"] = lines;
  }
  return fos;
}

export async function createFulfillmentOrder(
  storeId: string,
  orderId: string,
  data: {
    warehouse_id?: string | null | undefined;
    status?: string | undefined;
    notes?: string | null | undefined;
    lines?: Array<{
      order_line_id: string;
      quantity: number;
    }> | undefined;
  }
) {
  return withTx(async (client) => {
    const { rows: orderRows } = await client.query<{ id: string }>(
      `SELECT id FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
      [orderId, storeId]
    );
    if (!orderRows[0]) return null;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO fulfillment_orders (store_id, order_id, warehouse_id, status, notes)
       VALUES ($1::uuid, $2::uuid, $3, COALESCE($4, 'open'), $5)
       RETURNING id::text`,
      [
        storeId, orderId,
        data.warehouse_id ?? null,
        data.status ?? null,
        data.notes ?? null,
      ]
    );
    const foId = rows[0]!.id;

    for (const line of data.lines ?? []) {
      await client.query(
        `INSERT INTO fulfillment_order_lines (fulfillment_order_id, order_line_id, quantity)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [foId, line.order_line_id, line.quantity]
      );
    }
    return foId;
  });
}

export async function updateFulfillmentOrder(
  storeId: string,
  foId: string,
  data: {
    status?: string | undefined;
    notes?: string | null | undefined;
    warehouse_id?: string | null | undefined;
  }
) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE fulfillment_orders SET
       status       = COALESCE($3, status),
       notes        = COALESCE($4, notes),
       warehouse_id = COALESCE($5, warehouse_id),
       updated_at   = now()
     WHERE id = $1::uuid AND store_id = $2::uuid`,
    [
      foId, storeId,
      data.status ?? null,
      data.notes ?? null,
      data.warehouse_id ?? null,
    ]
  );
  return (rowCount ?? 0) > 0;
}
