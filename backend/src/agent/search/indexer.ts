/**
 * agent/search/indexer.ts — product document builder + embedding writer.
 *
 * buildProductDocument(product) — concatenates title, description, variant
 *   titles, option values, tags, attributes into a single indexable text.
 *
 * reindexProduct(productId) — fetch product + variants from DB, embed,
 *   write to products.embedding + embedding_updated_at.
 *
 * embeddingWorkerJob(embedder) — poll products where updated_at >
 *   embedding_updated_at (or embedding_updated_at IS NULL) for stores whose
 *   metadata has a llm_provider configured; batch-embed in groups of 16.
 */

import { getPool } from "../../db/pool.js";
import type { Embedder } from "./embedder.js";
import { buildEmbedder } from "./embedder.js";

// ── Document builder ──────────────────────────────────────────────────────────

interface ProductDoc {
  id: string;
  storeId: string;
  title: string;
  description: string | null;
  vendor: string | null;
  tags: string[];
  variantTitles: string[];
  attributes: string[];
}

/**
 * Concatenate all text fields into a single document string for embedding.
 *
 * Layout (newline-separated sections):
 *   title
 *   description (if present)
 *   vendor (if present)
 *   tags: tag1, tag2, …
 *   variants: variant1, variant2, …
 *   attributes: attr1, attr2, …
 *
 * We keep it brief but representative — typically 200-800 tokens.
 */
export function buildProductDocument(product: ProductDoc): string {
  const parts: string[] = [product.title];

  if (product.description) {
    // Strip HTML tags for cleaner text.
    const stripped = product.description.replace(/<[^>]*>/g, " ").trim();
    if (stripped) parts.push(stripped);
  }

  if (product.vendor) parts.push(`Brand: ${product.vendor}`);

  if (product.tags.length > 0) {
    parts.push(`Tags: ${product.tags.join(", ")}`);
  }

  if (product.variantTitles.length > 0) {
    const vt = product.variantTitles.filter((t) => t && t !== "Default Title");
    if (vt.length > 0) parts.push(`Options: ${vt.join(", ")}`);
  }

  if (product.attributes.length > 0) {
    parts.push(product.attributes.join(". "));
  }

  return parts.join("\n");
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

interface ProductRow {
  id: string;
  store_id: string;
  title: string;
  description: string | null;
  vendor: string | null;
  tags: string[];
}

interface VariantRow {
  title: string;
}

/** Fetch one product with its variant titles for embedding. */
async function fetchProductForIndexing(
  productId: string
): Promise<{ doc: ProductDoc } | null> {
  const pool = getPool();

  const pRes = await pool.query<ProductRow>(
    `SELECT id::text, store_id::text, title, description, vendor, tags
     FROM products
     WHERE id = $1::uuid`,
    [productId]
  );
  if (pRes.rows.length === 0) return null;
  const p = pRes.rows[0]!;

  const vRes = await pool.query<VariantRow>(
    `SELECT title FROM product_variants WHERE product_id = $1::uuid ORDER BY position`,
    [productId]
  );

  return {
    doc: {
      id: p.id,
      storeId: p.store_id,
      title: p.title,
      description: p.description,
      vendor: p.vendor,
      tags: p.tags ?? [],
      variantTitles: vRes.rows.map((r) => r.title),
      attributes: [], // future: pull from metafields
    },
  };
}

/** Write the embedding vector back to the products table. */
async function writeEmbedding(
  productId: string,
  vector: number[]
): Promise<void> {
  const pool = getPool();
  // Cast to vector type.  pgvector accepts '[1,2,…]' string format.
  const vectorLiteral = `[${vector.join(",")}]`;
  await pool.query(
    `UPDATE products
     SET embedding = $1::vector, embedding_updated_at = now()
     WHERE id = $2::uuid`,
    [vectorLiteral, productId]
  );
}

// ── Public service: reindexProduct ────────────────────────────────────────────

/**
 * Embed a single product and write the vector back.
 *
 * Requires an Embedder (caller is responsible for providing one).
 * Throws if product not found, embedder fails, or pgvector write fails.
 *
 * Graceful degradation: if the embedding column doesn't exist (pgvector not
 * installed) the UPDATE will throw; callers catch and log.
 */
export async function reindexProduct(
  productId: string,
  embedder: Embedder
): Promise<void> {
  const result = await fetchProductForIndexing(productId);
  if (!result) {
    throw new Error(`reindexProduct: product ${productId} not found`);
  }

  const text = buildProductDocument(result.doc);
  const [vector] = await embedder.embed([text]);
  if (!vector) throw new Error("reindexProduct: embedder returned empty result");

  await writeEmbedding(productId, vector);
}

// ── Worker job: embeddingWorkerJob ────────────────────────────────────────────

const BATCH_SIZE = 16;
const POLL_INTERVAL_MS = 30_000;

interface StoreWithProvider {
  id: string;
  metadata: Record<string, unknown>;
}

/**
 * Background polling job.
 *
 * Each tick:
 *  1. Find stores with metadata.llm_provider configured.
 *  2. For each such store, find products where updated_at > embedding_updated_at
 *     (or embedding_updated_at IS NULL).
 *  3. Build product document text, batch-embed (BATCH_SIZE at a time), write back.
 *
 * Errors per-product are logged and skipped (don't abort the batch).
 * Column-missing errors (pgvector not installed) short-circuit the store loop.
 *
 * @returns a stop function that cancels the polling interval.
 */
export function startEmbeddingWorkerJob(): () => void {
  let running = false;

  const tick = async () => {
    if (running) return; // skip overlap
    running = true;
    try {
      await runEmbeddingPass();
    } catch (err) {
      console.error("[embedding-worker] pass error:", err);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void tick(), POLL_INTERVAL_MS);
  // Run one pass immediately.
  void tick();

  return () => clearInterval(handle);
}

async function runEmbeddingPass(): Promise<void> {
  const pool = getPool();

  // Find stores with llm_provider.api_key configured.
  let storeRows: StoreWithProvider[];
  try {
    const res = await pool.query<{ id: string; metadata: Record<string, unknown> }>(
      `SELECT id::text, metadata
       FROM stores
       WHERE metadata->'llm_provider'->>'api_key' IS NOT NULL
         AND is_active = true`
    );
    storeRows = res.rows;
  } catch (err) {
    console.error("[embedding-worker] failed to query stores:", err);
    return;
  }

  for (const store of storeRows) {
    const embedder = buildEmbedder(store.metadata);
    if (!embedder) continue;

    await embedStoreProducts(store.id, embedder);
  }
}

async function embedStoreProducts(
  storeId: string,
  embedder: Embedder
): Promise<void> {
  const pool = getPool();

  // Find products needing (re)indexing.
  let productIds: string[];
  try {
    const res = await pool.query<{ id: string }>(
      `SELECT id::text
       FROM products
       WHERE store_id = $1::uuid
         AND (embedding_updated_at IS NULL OR updated_at > embedding_updated_at)
       ORDER BY updated_at ASC
       LIMIT 100`,
      [storeId]
    );
    productIds = res.rows.map((r) => r.id);
  } catch (err) {
    // If embedding column missing (pgvector not installed), skip store.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("embedding") || msg.includes("vector")) {
      console.warn(
        `[embedding-worker] store ${storeId}: embedding column missing (pgvector not installed?); skipping`
      );
    } else {
      console.error(`[embedding-worker] store ${storeId}: query error:`, err);
    }
    return;
  }

  if (productIds.length === 0) return;

  // Process in batches.
  for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
    const batch = productIds.slice(i, i + BATCH_SIZE);

    // Fetch all product docs for this batch.
    const docs: Array<{ id: string; text: string }> = [];
    for (const pid of batch) {
      try {
        const result = await fetchProductForIndexing(pid);
        if (result) {
          docs.push({ id: pid, text: buildProductDocument(result.doc) });
        }
      } catch (err) {
        console.error(
          `[embedding-worker] fetch product ${pid} failed:`,
          err
        );
      }
    }

    if (docs.length === 0) continue;

    // Embed the batch.
    let vectors: number[][];
    try {
      vectors = await embedder.embed(docs.map((d) => d.text));
    } catch (err) {
      console.error(
        `[embedding-worker] embed batch for store ${storeId} failed:`,
        err
      );
      continue;
    }

    // Write each vector.
    for (let j = 0; j < docs.length; j++) {
      const doc = docs[j]!;
      const vec = vectors[j];
      if (!vec) continue;
      try {
        await writeEmbedding(doc.id, vec);
      } catch (err) {
        // If vector column missing, abort this store.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("embedding") || msg.includes("vector")) {
          console.warn(
            `[embedding-worker] store ${storeId}: write failed (pgvector missing?); skipping store`
          );
          return;
        }
        console.error(
          `[embedding-worker] write embedding for ${doc.id} failed:`,
          err
        );
      }
    }
  }
}
