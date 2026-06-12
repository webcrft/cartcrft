/**
 * digital/service.ts — SQL-backed digital product delivery service.
 *
 * Behaviors:
 *  - generateDownloadLinks: for each digital order line in an order, create a
 *    tokenized download link (token = UUID, stored in digital_download_links).
 *    Only creates links for order lines with digital_product_files.
 *  - validateToken: checks expiry + max_downloads; increments download_count;
 *    returns file_url for redirect.
 *  - listDownloadLinks: admin list per order.
 *
 * Note: digital_product_files CRUD is already in catalog module (T2.2).
 * This module handles download link generation + token validation only.
 */

import { getPool, withTx } from "../../db/pool.js";
import type { DigitalDownloadLink, GenerateDownloadLinksInput, DownloadTokenInfo } from "./types.js";

// ── Generate download links for an order ─────────────────────────────────────

/**
 * Generate tokenized download links for all digital files in an order.
 * Only creates links for order lines whose variant has digital_product_files.
 * Returns the count of links created.
 */
export async function generateDownloadLinks(
  storeId: string,
  orderId: string,
  input: GenerateDownloadLinksInput = {}
): Promise<{ links: DigitalDownloadLink[]; count: number }> {
  const pool = getPool();

  // Verify order belongs to store
  const { rows: orderRows } = await pool.query<{ customer_id: string | null }>(
    `SELECT customer_id::text FROM orders WHERE id = $1::uuid AND store_id = $2::uuid`,
    [orderId, storeId]
  );
  if (!orderRows[0]) {
    const e = new Error("order not found");
    (e as NodeJS.ErrnoException).code = "NOT_FOUND";
    throw e;
  }
  const customerId = orderRows[0].customer_id;

  // Find digital files linked to order lines (via variant_id)
  const { rows: digitalRows } = await pool.query<{
    order_line_id: string;
    file_id: string;
  }>(
    `SELECT ol.id::text AS order_line_id, dpf.id::text AS file_id
     FROM order_lines ol
     JOIN digital_product_files dpf ON dpf.variant_id = ol.variant_id
     WHERE ol.order_id = $1::uuid AND dpf.store_id = $2::uuid AND dpf.is_active = true`,
    [orderId, storeId]
  );

  if (digitalRows.length === 0) {
    return { links: [], count: 0 };
  }

  const expiresAt = input.expires_at ? new Date(input.expires_at) : null;
  const links: DigitalDownloadLink[] = [];

  for (const row of digitalRows) {
    const { rows: insertedRows } = await pool.query<DigitalDownloadLink>(
      `INSERT INTO digital_download_links
         (store_id, order_id, order_line_id, file_id, customer_id, max_downloads, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::timestamptz)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        storeId,
        orderId,
        row.order_line_id,
        row.file_id,
        customerId,
        input.max_downloads ?? null,
        expiresAt,
      ]
    );
    if (insertedRows[0]) links.push(insertedRows[0]);
  }

  return { links, count: links.length };
}

// ── List download links for an order (admin) ──────────────────────────────────

export async function listDownloadLinks(
  storeId: string,
  orderId: string
): Promise<DigitalDownloadLink[]> {
  const pool = getPool();
  const { rows } = await pool.query<DigitalDownloadLink>(
    `SELECT dl.id::text, dl.order_id::text, dl.file_id::text, dl.customer_id::text,
            dl.token::text, dl.download_count, dl.max_downloads,
            dl.expires_at, dl.last_downloaded_at, dl.created_at,
            f.name AS file_name
     FROM digital_download_links dl
     JOIN digital_product_files f ON f.id = dl.file_id
     WHERE dl.store_id = $1::uuid AND dl.order_id = $2::uuid
     ORDER BY dl.created_at`,
    [storeId, orderId]
  );
  return rows;
}

// ── Validate token and return file_url for redirect ───────────────────────────

/**
 * Validate a download token:
 *  1. Look up the link by token.
 *  2. Check expiry (if expires_at is set).
 *  3. Check max_downloads (if set).
 *  4. Increment download_count and update last_downloaded_at.
 *  5. Return file_url.
 *
 * Throws with code:
 *  - NOT_FOUND: token not found
 *  - LINK_EXPIRED: link has expired
 *  - DOWNLOAD_LIMIT_EXCEEDED: max downloads reached
 */
export async function validateAndRedeemToken(
  token: string,
  storeId?: string
): Promise<DownloadTokenInfo> {
  return withTx(async (client) => {
    // Lock the row for update
    const query = storeId
      ? `SELECT dl.id::text, dl.store_id::text, dl.order_id::text, dl.file_id::text,
                dl.download_count, dl.max_downloads, dl.expires_at,
                f.file_url, f.name AS file_name
         FROM digital_download_links dl
         JOIN digital_product_files f ON f.id = dl.file_id
         WHERE dl.token = $1 AND dl.store_id = $2::uuid
         FOR UPDATE`
      : `SELECT dl.id::text, dl.store_id::text, dl.order_id::text, dl.file_id::text,
                dl.download_count, dl.max_downloads, dl.expires_at,
                f.file_url, f.name AS file_name
         FROM digital_download_links dl
         JOIN digital_product_files f ON f.id = dl.file_id
         WHERE dl.token = $1
         FOR UPDATE`;

    const params = storeId ? [token, storeId] : [token];
    const { rows } = await client.query<{
      id: string;
      store_id: string;
      order_id: string;
      download_count: number;
      max_downloads: number | null;
      expires_at: Date | null;
      file_url: string;
      file_name: string;
    }>(query, params);

    if (!rows[0]) {
      const e = new Error("download link not found");
      (e as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw e;
    }

    const link = rows[0];

    // Check expiry
    if (link.expires_at && new Date() > link.expires_at) {
      const e = new Error("download link has expired");
      (e as NodeJS.ErrnoException).code = "LINK_EXPIRED";
      throw e;
    }

    // Check max downloads
    if (link.max_downloads !== null && link.download_count >= link.max_downloads) {
      const e = new Error("maximum downloads reached");
      (e as NodeJS.ErrnoException).code = "DOWNLOAD_LIMIT_EXCEEDED";
      throw e;
    }

    // Increment count
    await client.query(
      `UPDATE digital_download_links
       SET download_count = download_count + 1, last_downloaded_at = now()
       WHERE id = $1::uuid`,
      [link.id]
    );

    return {
      file_url: link.file_url,
      file_name: link.file_name,
      order_id: link.order_id,
      download_count: link.download_count + 1,
      max_downloads: link.max_downloads,
      expires_at: link.expires_at,
    };
  });
}
