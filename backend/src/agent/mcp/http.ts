/**
 * agent/mcp/http.ts — Fastify plugin for the Streamable HTTP MCP transport.
 *
 * Mounts at /mcp/:storeId (POST + GET + DELETE per MCP streamable HTTP spec).
 *
 * Auth: API key required via `Authorization: Bearer <key>` header ONLY.
 * The ?key= query-param path has been removed — query strings appear in access
 * logs, reverse-proxy logs, and browser Referer headers, which would leak
 * privileged cc_prv_ keys. Use the Authorization header exclusively.
 *
 * Stateless transport (no sessionIdGenerator) — simple and horizontally scalable.
 * Each request is a fresh MCP exchange. For persistent SSE sessions, a session
 * manager would be needed (out of scope for T3.1).
 *
 * Node.js StreamableHTTPServerTransport wraps the Web Standard transport internally.
 * We pass request.raw/reply.raw to handleRequest.
 */

import type { FastifyPluginAsync } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { lookupApiKey, hasScope } from "../../modules/apikeys/service.js";
import { getPool } from "../../db/pool.js";
import { buildMcpServer } from "./server.js";

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Extract the raw API key from Authorization: Bearer <key> header only.
 * The ?key= query-param path has been intentionally removed (H1.3) — keys in
 * query strings leak into access logs, reverse-proxy logs, and Referer headers.
 */
function extractKey(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const auth = headers["authorization"];
  const bearerStr = typeof auth === "string" ? auth : undefined;
  if (bearerStr?.startsWith("Bearer ")) {
    const k = bearerStr.slice(7).trim();
    if (k) return k;
  }
  return null;
}

// ── Fastify plugin ────────────────────────────────────────────────────────────

export const mcpHttpPlugin: FastifyPluginAsync = async (app) => {
  // Handler for POST, GET, DELETE on /mcp/:storeId
  // The MCP Streamable HTTP transport expects all three methods on the same endpoint.
  const handleMcp = async (
    request: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply
  ) => {
    const { storeId } = request.params as { storeId: string };

    // ── Auth ───────────────────────────────────────────────────────────────
    const rawKey = extractKey(request.headers as Record<string, string | string[] | undefined>);
    if (!rawKey) {
      return reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "API key required (Authorization: Bearer <key>)",
        },
      });
    }

    const cached = await lookupApiKey(rawKey);
    if (!cached) {
      return reply.status(401).send({
        error: { code: "UNAUTHORIZED", message: "Invalid or expired API key" },
      });
    }

    // Verify key is scoped to this store (or is a global org key)
    if (cached.storeRestriction && cached.storeRestriction !== storeId) {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "API key is not authorized for this store",
        },
      });
    }

    // Require at least commerce:read scope
    if (!hasScope(cached.scopes, "commerce:read")) {
      return reply.status(403).send({
        error: {
          code: "FORBIDDEN",
          message: "API key requires commerce:read scope",
        },
      });
    }

    // Verify store exists and is active
    const pool = getPool();
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM stores WHERE id = $1::uuid AND is_active = true) AS exists`,
      [storeId]
    );
    if (!rows[0]?.exists) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Store not found" },
      });
    }

    // ── Build per-request transport + server ───────────────────────────────
    // Stateless mode: omit sessionIdGenerator entirely.
    // The transport will operate without session tracking — suitable for
    // single-request MCP exchanges and horizontally-scaled deployments.
    const transport = new StreamableHTTPServerTransport({});

    const mcpServer = buildMcpServer(storeId);

    try {
      // Connect the MCP server to this transport instance.
      await mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]);

      // Delegate to the transport's Node.js handleRequest adapter.
      // Passing the parsed body for POST so the transport doesn't attempt to re-read
      // a stream that Fastify has already consumed.
      await transport.handleRequest(
        request.raw,
        reply.raw,
        request.method === "POST" ? request.body : undefined
      );
    } finally {
      // Close server after each stateless request.
      try {
        await mcpServer.close();
      } catch {
        // Ignore close errors
      }
    }
  };

  // Register all three HTTP methods the MCP spec uses on the same endpoint.
  app.post<{ Params: { storeId: string } }>("/mcp/:storeId", handleMcp);
  app.get<{ Params: { storeId: string } }>("/mcp/:storeId", handleMcp);
  app.delete<{ Params: { storeId: string } }>("/mcp/:storeId", handleMcp);
};
