/**
 * agent/search/routes.ts — POST /commerce/stores/:storeId/search
 *
 * Auth: storeAuthRead (cc_pub_ or cc_prv_ commerce:read / JWT org member).
 *
 * Request body:
 *   { query: string, limit?: number, filters?: { price_min?, price_max?,
 *     collection_id?, in_stock? } }
 *
 * Response:
 *   { results: SearchResult[], query: string, total: number }
 *
 * Behaviour:
 *   - Loads store metadata to determine if an LLM provider is configured.
 *   - If configured → hybrid pgvector + full-text search (RRF merge).
 *   - If not → full-text only.
 *   - Graceful degradation when pgvector extension is missing.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthRead } from "../../lib/auth/middleware.js";
import { getPool } from "../../db/pool.js";
import { buildEmbedder } from "./embedder.js";
import { searchProducts } from "./service.js";

// ── Schemas ────────────────────────────────────────────────────────────────────

const SearchParams = z.object({
  storeId: z.string().uuid(),
});

const SearchFiltersSchema = z.object({
  price_min: z.number().nonnegative().optional(),
  price_max: z.number().nonnegative().optional(),
  collection_id: z.string().uuid().optional(),
  in_stock: z.boolean().optional(),
});

const SearchBody = z.object({
  query: z.string().max(1000).default(""),
  limit: z.number().int().min(1).max(100).optional(),
  filters: SearchFiltersSchema.optional(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const searchPlugin: FastifyPluginAsync = async (app) => {
  /**
   * POST /commerce/stores/:storeId/search
   * Hybrid semantic + full-text product search.
   */
  app.post(
    "/commerce/stores/:storeId/search",
    {
      preHandler: storeAuthRead,
      schema: {
        params: SearchParams,
        body: SearchBody,
      },
    },
    async (request, reply) => {
      const { storeId } = request.params as z.infer<typeof SearchParams>;
      const { query, limit, filters } = request.body as z.infer<
        typeof SearchBody
      >;

      // Load store metadata to check LLM provider config.
      const pool = getPool();
      const storeRes = await pool.query<{
        metadata: Record<string, unknown>;
      }>(
        `SELECT metadata FROM stores WHERE id = $1::uuid AND is_active = true`,
        [storeId]
      );

      if (storeRes.rows.length === 0) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Store not found" },
        });
      }

      const metadata = storeRes.rows[0]!.metadata ?? {};
      const embedder = buildEmbedder(metadata);

      // Build a clean SearchRequest object (exactOptionalPropertyTypes-safe).
      const searchReq: import("./service.js").SearchRequest = {
        storeId,
        query,
        embedder,
      };
      if (limit !== undefined) searchReq.limit = limit;
      if (filters) {
        const sf: import("./service.js").SearchFilters = {};
        if (filters.price_min !== undefined) sf.price_min = filters.price_min;
        if (filters.price_max !== undefined) sf.price_max = filters.price_max;
        if (filters.collection_id !== undefined)
          sf.collection_id = filters.collection_id;
        if (filters.in_stock !== undefined) sf.in_stock = filters.in_stock;
        searchReq.filters = sf;
      }

      const results = await searchProducts(searchReq);

      return reply.status(200).send({
        query,
        total: results.length,
        results,
      });
    }
  );
};
