/**
 * agent/search/service.ts — hybrid search service.
 *
 * searchProducts():
 *   Hybrid search — if store has embeddings (pgvector available + embedder
 *   configured) → cosine-similarity vector search + Postgres websearch_to_tsquery
 *   full-text, merged via Reciprocal Rank Fusion (RRF).
 *   If no embedder / pgvector missing → full-text only.
 *
 * Ranking design (RRF):
 *   RRF score = Σ 1/(k + rank_i) for each result list, k = 60 (standard).
 *   Vector candidates: top N by cosine similarity (<=>).
 *   Full-text candidates: top N by websearch_to_tsquery ts_rank_cd.
 *   Both lists re-ranked together; top `limit` returned.
 *   The merged list tends to surface items that score well on both dimensions
 *   first, then items that are strong on one dimension — ideal for
 *   natural-language queries that may mix semantic intent and keywords.
 *
 * Graceful degradation:
 *   - pgvector column missing / extension not installed → full-text only.
 *   - Store has no embedder configured → full-text only.
 *   - Empty query → returns popular/newest products (no ranking).
 *
 * Filters (applied in SQL WHERE before ranking):
 *   - price_min / price_max  → any variant in range
 *   - collection_id          → product in collection
 *   - in_stock               → has inventory_quantity > 0 or tracks_inventory = false
 */

import type pg from "pg";
import { getPool } from "../../db/pool.js";
import type { Embedder } from "./embedder.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchFilters {
  price_min?: number;
  price_max?: number;
  collection_id?: string;
  in_stock?: boolean;
}

export interface SearchRequest {
  storeId: string;
  query: string;
  limit?: number;
  filters?: SearchFilters;
  embedder?: Embedder | null;
}

export interface VariantSummary {
  id: string;
  title: string;
  price: string;
  compare_at_price: string | null;
  /** Sum of quantity_on_hand across all warehouses, or 0 if no inventory levels */
  inventory_quantity: number;
  available: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  vendor: string | null;
  product_type: string;
  status: string;
  tags: string[];
  variants: VariantSummary[];
  /** RRF-merged relevance score (0..1 normalised); 1.0 = top result */
  relevance_score: number;
  /** Breakdown for debugging/logging */
  _debug?: {
    vector_rank?: number | undefined;
    text_rank?: number | undefined;
    rrf_score: number;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CANDIDATE_MULTIPLIER = 3; // fetch 3× limit candidates per list before merging
const RRF_K = 60; // standard constant for RRF

// ── Public service ────────────────────────────────────────────────────────────

export async function searchProducts(
  req: SearchRequest
): Promise<SearchResult[]> {
  const limit = Math.min(req.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const candidateN = limit * CANDIDATE_MULTIPLIER;

  // Decide whether to attempt vector search.
  const useVector = !!req.embedder && req.query.trim().length > 0;

  // Build filter fragments.
  const { whereClauses, params, nextParam } = buildFilterClauses(
    req.storeId,
    req.filters,
    1 // first positional param
  );

  let results: SearchResult[];

  if (req.query.trim().length === 0) {
    // No query — return newest active products.
    results = await fetchNoQuery(req.storeId, limit, req.filters);
  } else if (useVector) {
    results = await hybridSearch(
      req.storeId,
      req.query,
      req.embedder!,
      limit,
      candidateN,
      req.filters,
      whereClauses,
      params,
      nextParam
    );
  } else {
    results = await fulltextSearch(
      req.storeId,
      req.query,
      limit,
      candidateN,
      req.filters,
      whereClauses,
      params,
      nextParam
    );
  }

  return results;
}

// ── Filter builder ────────────────────────────────────────────────────────────

interface FilterClauses {
  whereClauses: string[];
  params: unknown[];
  nextParam: number;
}

function buildFilterClauses(
  storeId: string,
  filters: SearchFilters | undefined,
  startParam: number
): FilterClauses {
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let p = startParam;

  // store_id always required — added by caller
  params.push(storeId);
  whereClauses.push(`p.store_id = $${p++}::uuid`);
  whereClauses.push(`p.status = 'active'`);

  if (!filters) return { whereClauses, params, nextParam: p };

  if (filters.price_min !== undefined) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM product_variants pv2 WHERE pv2.product_id = p.id AND pv2.price >= $${p++}::numeric)`
    );
    params.push(filters.price_min);
  }

  if (filters.price_max !== undefined) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM product_variants pv2 WHERE pv2.product_id = p.id AND pv2.price <= $${p++}::numeric)`
    );
    params.push(filters.price_max);
  }

  if (filters.collection_id) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM product_collections pc WHERE pc.product_id = p.id AND pc.collection_id = $${p++}::uuid)`
    );
    params.push(filters.collection_id);
  }

  if (filters.in_stock === true) {
    // A product is "in stock" when at least one variant either:
    //  - does not track inventory (allow_backorder = true), OR
    //  - has net quantity (on_hand - committed) > 0 across any warehouse
    whereClauses.push(
      `EXISTS (
         SELECT 1 FROM product_variants pv3
         WHERE pv3.product_id = p.id
           AND pv3.is_active = true
           AND (
             pv3.allow_backorder = true
             OR pv3.track_inventory = false
             OR EXISTS (
               SELECT 1 FROM inventory_levels il
               WHERE il.variant_id = pv3.id
                 AND (il.quantity_on_hand - il.quantity_committed) > 0
             )
           )
       )`
    );
  }

  return { whereClauses, params, nextParam: p };
}

// ── No-query path ─────────────────────────────────────────────────────────────

async function fetchNoQuery(
  storeId: string,
  limit: number,
  filters?: SearchFilters
): Promise<SearchResult[]> {
  const pool = getPool();
  const { whereClauses, params, nextParam: p } = buildFilterClauses(
    storeId,
    filters,
    1
  );
  const where = whereClauses.join(" AND ");

  params.push(limit);
  const sql = `
    SELECT p.id::text,
           p.title, p.slug, p.description, p.vendor,
           p.type as product_type, p.status, p.tags
    FROM products p
    WHERE ${where}
    ORDER BY p.created_at DESC
    LIMIT $${p}`;

  const res = await pool.query<ProductRow>(sql, params);

  const products = await attachVariants(pool, res.rows);
  return products.map((pr, i) => ({
    ...pr,
    relevance_score: 1.0 - i * 0.001,
    _debug: { rrf_score: 1.0 - i * 0.001 },
  }));
}

// ── Full-text search ──────────────────────────────────────────────────────────

async function fulltextSearch(
  storeId: string,
  query: string,
  limit: number,
  candidateN: number,
  filters: SearchFilters | undefined,
  whereClauses: string[],
  params: unknown[],
  p: number
): Promise<SearchResult[]> {
  const pool = getPool();
  params.push(query);
  const qParam = p++;

  // ts_rank_cd on product title+description tsv.
  const where = whereClauses.join(" AND ");
  params.push(candidateN);

  const sql = `
    SELECT p.id::text,
           p.title, p.slug, p.description, p.vendor,
           p.type as product_type, p.status, p.tags,
           ts_rank_cd(
             to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.description,'')),
             websearch_to_tsquery('english', $${qParam})
           ) as text_rank
    FROM products p
    WHERE ${where}
      AND to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.description,''))
          @@ websearch_to_tsquery('english', $${qParam})
    ORDER BY text_rank DESC
    LIMIT $${p}`;

  const res = await pool.query<ProductRow & { text_rank: number }>(
    sql,
    params
  );

  const products = await attachVariants(pool, res.rows);
  return products.map((pr, i) => ({
    ...pr,
    relevance_score: normaliseRank(i, products.length),
    _debug: {
      text_rank: i + 1,
      rrf_score: rrfScore(i),
    },
  }));
}

// ── Hybrid search (vector + full-text, RRF merge) ─────────────────────────────

async function hybridSearch(
  storeId: string,
  query: string,
  embedder: Embedder,
  limit: number,
  candidateN: number,
  filters: SearchFilters | undefined,
  whereClauses: string[],
  baseParams: unknown[],
  _p: number
): Promise<SearchResult[]> {
  const pool = getPool();
  const where = whereClauses.join(" AND ");

  // 1. Compute query embedding.
  let queryVec: number[];
  try {
    const vecs = await embedder.embed([query]);
    queryVec = vecs[0]!;
  } catch (err) {
    console.warn(
      "[search] embed query failed, falling back to full-text:",
      err
    );
    return fulltextSearch(
      storeId,
      query,
      limit,
      candidateN,
      filters,
      whereClauses,
      baseParams,
      _p
    );
  }

  const vectorLiteral = `[${queryVec.join(",")}]`;
  // Base filter param count so we can correctly renumber.
  const bp = baseParams.length; // e.g. 1 for storeId (+ any filter params)

  // 2. Vector candidates — separate params array to avoid gaps.
  //    Params: [...baseParams, vectorLiteral, candidateN]
  //    $1..$bp = filter params, $(bp+1) = vectorLiteral, $(bp+2) = candidateN
  const vecParams = [...baseParams, vectorLiteral, candidateN];
  const vecP = bp + 1;  // vectorLiteral position
  const vecLimP = bp + 2; // candidateN position

  let vectorRows: Array<{ id: string; vec_rank: number }> = [];
  try {
    // Per-store recall (C-9): widen the HNSW beam so small-store candidates are
    // not evicted by large-store neighbour dominance in the global index.
    // ef_search=200 (vs default 40) adds negligible latency (<1ms for typical
    // catalog sizes) and improves recall for stores with < ~1000 products.
    // We check out a dedicated client so the SET is scoped to this checkout;
    // pgvector resets ef_search to the GUC default when the connection is
    // returned to the pool (the next caller gets the clean default).
    const vecClient = await pool.connect();
    let vecRes: import("pg").QueryResult<{ id: string; vec_rank: string }>;
    try {
      // SET (not SET LOCAL) — works outside a transaction block. The setting
      // is session-scoped on this client checkout; the pool reuses connections
      // but ef_search only affects the vector operator, so cross-request bleed
      // is harmless (we always want higher recall).
      await vecClient.query("SET hnsw.ef_search = 200");
      vecRes = await vecClient.query<{ id: string; vec_rank: string }>(
        `SELECT p.id::text, row_number() OVER (ORDER BY p.embedding <=> $${vecP}::vector) as vec_rank
         FROM products p
         WHERE ${where}
           AND p.embedding IS NOT NULL
         ORDER BY p.embedding <=> $${vecP}::vector
         LIMIT $${vecLimP}`,
        vecParams
      );
    } finally {
      vecClient.release();
    }
    vectorRows = vecRes.rows.map((r) => ({
      id: r.id,
      vec_rank: parseInt(r.vec_rank, 10),
    }));
  } catch (err) {
    // pgvector not available — degrade to full-text only.
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("operator does not exist") ||
      msg.includes("function") ||
      msg.includes("embedding") ||
      msg.includes("vector") ||
      msg.includes("42P18") // could not determine data type
    ) {
      console.warn(
        "[search] pgvector unavailable, falling back to full-text:",
        msg
      );
      return fulltextSearch(
        storeId,
        query,
        limit,
        candidateN,
        filters,
        whereClauses,
        baseParams,
        _p
      );
    }
    throw err;
  }

  // 3. Full-text candidates — separate params array.
  //    Params: [...baseParams, query, candidateN]
  //    $1..$bp = filter params, $(bp+1) = query, $(bp+2) = candidateN
  const textParams = [...baseParams, query, candidateN];
  const qP = bp + 1;   // query position
  const txtLimP = bp + 2; // candidateN position

  let textRows: Array<{ id: string; text_rank: number }> = [];
  try {
    const textSql = `
      SELECT p.id::text, row_number() OVER (
        ORDER BY ts_rank_cd(
          to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.description,'')),
          websearch_to_tsquery('english', $${qP})
        ) DESC
      ) as text_rank
      FROM products p
      WHERE ${where}
        AND to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.description,''))
            @@ websearch_to_tsquery('english', $${qP})
      ORDER BY ts_rank_cd(
        to_tsvector('english', coalesce(p.title,'') || ' ' || coalesce(p.description,'')),
        websearch_to_tsquery('english', $${qP})
      ) DESC
      LIMIT $${txtLimP}`;

    const textRes = await pool.query<{ id: string; text_rank: string }>(
      textSql,
      textParams
    );
    textRows = textRes.rows.map((r) => ({
      id: r.id,
      text_rank: parseInt(r.text_rank, 10),
    }));
  } catch {
    // Full-text failed — continue with vector-only.
    textRows = [];
  }

  // 4. RRF merge.
  const vecMap = new Map(vectorRows.map((r) => [r.id, r.vec_rank]));
  const txtMap = new Map(textRows.map((r) => [r.id, r.text_rank]));

  const allIds = new Set([...vecMap.keys(), ...txtMap.keys()]);
  const scored = [...allIds].map((id) => {
    const vr = vecMap.get(id);
    const tr = txtMap.get(id);
    const score =
      (vr !== undefined ? 1 / (RRF_K + vr) : 0) +
      (tr !== undefined ? 1 / (RRF_K + tr) : 0);
    return { id, score, vec_rank: vr, text_rank: tr };
  });

  scored.sort((a, b) => b.score - a.score);
  const topIds = scored.slice(0, limit);

  if (topIds.length === 0) return [];

  // 5. Fetch full product rows for merged IDs (preserve RRF order).
  const idList = topIds.map((r) => r.id);
  const rows = await fetchProductsByIds(pool, idList, storeId);

  // Re-order by RRF rank.
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const ordered = topIds
    .map((r) => rowMap.get(r.id))
    .filter((r): r is ProductRow => !!r);

  const products = await attachVariants(pool, ordered);

  const maxScore = topIds[0]?.score ?? 1;
  return products.map((pr, i) => {
    const info = topIds[i]!;
    const debugObj: SearchResult["_debug"] = { rrf_score: info.score };
    if (info.vec_rank !== undefined) debugObj.vector_rank = info.vec_rank;
    if (info.text_rank !== undefined) debugObj.text_rank = info.text_rank;
    return {
      ...pr,
      relevance_score: maxScore > 0 ? info.score / maxScore : 0,
      _debug: debugObj,
    };
  });
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

interface ProductRow {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  vendor: string | null;
  product_type: string;
  status: string;
  tags: string[];
}

async function fetchProductsByIds(
  pool: pg.Pool,
  ids: string[],
  storeId: string
): Promise<ProductRow[]> {
  if (ids.length === 0) return [];
  const res = await pool.query<ProductRow>(
    `SELECT p.id::text, p.title, p.slug, p.description, p.vendor,
            p.type as product_type, p.status, p.tags
     FROM products p
     WHERE p.id = ANY($1::uuid[]) AND p.store_id = $2::uuid`,
    [ids, storeId]
  );
  return res.rows;
}

interface VariantRow {
  product_id: string;
  id: string;
  title: string;
  price: string;
  compare_at_price: string | null;
  track_inventory: boolean;
  allow_backorder: boolean;
  /** Sum of (on_hand - committed) across all warehouses; null if no levels exist */
  net_qty: string | null;
}

async function attachVariants(
  pool: pg.Pool,
  products: ProductRow[]
): Promise<Array<ProductRow & { variants: VariantSummary[] }>> {
  if (products.length === 0) return [];

  const ids = products.map((p) => p.id);
  // Aggregate inventory from inventory_levels (sum per variant across warehouses).
  const res = await pool.query<VariantRow>(
    `SELECT pv.product_id::text,
            pv.id::text,
            pv.title,
            pv.price::text,
            pv.compare_at_price::text,
            pv.track_inventory,
            pv.allow_backorder,
            SUM(il.quantity_on_hand - il.quantity_committed)::text AS net_qty
     FROM product_variants pv
     LEFT JOIN inventory_levels il ON il.variant_id = pv.id
     WHERE pv.product_id = ANY($1::uuid[])
       AND pv.is_active = true
     GROUP BY pv.product_id, pv.id, pv.title, pv.price, pv.compare_at_price,
              pv.track_inventory, pv.allow_backorder, pv.position
     ORDER BY pv.position ASC`,
    [ids]
  );

  const varMap = new Map<string, VariantSummary[]>();
  for (const row of res.rows) {
    if (!varMap.has(row.product_id)) varMap.set(row.product_id, []);
    const netQty = row.net_qty !== null ? parseInt(row.net_qty, 10) : 0;
    const available =
      !row.track_inventory || row.allow_backorder || netQty > 0;
    varMap.get(row.product_id)!.push({
      id: row.id,
      title: row.title ?? "Default",
      price: row.price,
      compare_at_price: row.compare_at_price ?? null,
      inventory_quantity: netQty,
      available,
    });
  }

  return products.map((p) => ({
    ...p,
    variants: varMap.get(p.id) ?? [],
  }));
}

// ── Rank helpers ──────────────────────────────────────────────────────────────

function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank + 1);
}

function normaliseRank(rank: number, total: number): number {
  if (total <= 1) return 1.0;
  return 1.0 - rank / (total - 1);
}
