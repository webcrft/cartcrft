/**
 * lib/agent-auth.ts — Agent request attribution middleware.
 *
 * Requests from autonomous agents carry:
 *   X-Cartcrft-Agent:     <agent UUID>
 *   X-Cartcrft-Signature: <hex-encoded ed25519 signature>
 *   X-Cartcrft-Timestamp: <unix seconds>
 *
 * Signature scheme (ed25519, node:crypto):
 *   message = METHOD + "\n" + path + "\n" + sha256Hex(rawBody) + "\n" + timestamp
 *
 * Verification:
 *   1. Check timestamp is within ±5 minutes of server time (replay window)
 *   2. Look up agent by ID from X-Cartcrft-Agent header
 *   3. Agent must be active
 *   4. Verify ed25519 signature against agent's stored public key
 *   5. Attach AgentHeaderCtx to request.agentCtx
 *   6. Write agent_audit_log row for mutating (non-GET/HEAD) calls (fire-and-forget)
 *
 * Route integration:
 *   The middleware is exported as `agentAttributionHook` (Fastify preHandler).
 *   It is OPTIONAL per route (not globally applied) — routes that want to accept
 *   agent attribution import and add it to their preHandler array.
 *
 *   It also runs as an addHook('preHandler') registered via `agentAttributionPlugin`
 *   for routes that carry both headers but don't explicitly declare the hook.
 *   The plugin checks for both headers and short-circuits if absent — safe to mount globally.
 *
 * Error codes:
 *   AGENT_SIGNATURE_EXPIRED   — timestamp outside 5-minute window
 *   AGENT_SIGNATURE_INVALID   — signature does not verify
 *   AGENT_NOT_FOUND           — unknown agent ID
 *   AGENT_INACTIVE            — agent is not active
 */

import { createHash, verify as cryptoVerify } from "node:crypto";
import type {
  FastifyRequest,
  FastifyReply,
  FastifyPluginAsync,
  preHandlerHookHandler,
} from "fastify";
import { getAgentById, insertAuditLog } from "../modules/agents/service.js";
import type { AgentHeaderCtx } from "../modules/agents/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum age of a request timestamp in seconds (5 minutes). */
const SIGNATURE_WINDOW_SECONDS = 5 * 60;

// ── Request decoration ────────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    agentCtx?: AgentHeaderCtx | undefined;
  }
}

// ── Signature helpers ─────────────────────────────────────────────────────────

/**
 * Build the canonical signing message for a request.
 *
 * Layout:
 *   METHOD\n
 *   /path?query\n
 *   sha256hex(rawBody or "")\n
 *   timestamp
 */
export function buildSigningMessage(
  method: string,
  path: string,
  bodyHash: string,
  timestamp: string
): string {
  return `${method.toUpperCase()}\n${path}\n${bodyHash}\n${timestamp}`;
}

/**
 * Compute SHA-256 hex of a string (body content).
 */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Verify an ed25519 request signature.
 *
 * Note: ed25519 uses one-shot verify — no hash algorithm parameter.
 *
 * @param message      The canonical signing message
 * @param signatureHex Hex-encoded ed25519 signature from header
 * @param publicKeyHex Hex-encoded DER (spki) ed25519 public key from agent record
 */
export function verifyRequestSignature(
  message: string,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const pubKeyBuf = Buffer.from(publicKeyHex, "hex");
    const msgBuf = Buffer.from(message, "utf8");
    const sigBuf = Buffer.from(signatureHex, "hex");
    return cryptoVerify(
      null,
      msgBuf,
      { key: pubKeyBuf, format: "der", type: "spki" },
      sigBuf
    );
  } catch {
    return false;
  }
}

// ── Core attribution logic ────────────────────────────────────────────────────

/**
 * Attempt to resolve and verify an agent attribution from request headers.
 *
 * Returns the AgentHeaderCtx on success.
 * Returns null if agent headers are absent (not an agent request — caller should skip).
 * Throws an error with `.code` set on failure (agent inactive, bad sig, expired timestamp).
 */
export async function resolveAgentAttribution(
  request: FastifyRequest
): Promise<AgentHeaderCtx | null> {
  const agentId = request.headers["x-cartcrft-agent"];
  const signature = request.headers["x-cartcrft-signature"];
  const timestampStr = request.headers["x-cartcrft-timestamp"];

  // Not an agent request — pass through
  if (!agentId && !signature) return null;

  // Headers present but incomplete
  if (!agentId || typeof agentId !== "string") {
    const err = new Error("X-Cartcrft-Agent header missing or invalid") as NodeJS.ErrnoException;
    err.code = "AGENT_SIGNATURE_INVALID";
    throw err;
  }
  if (!signature || typeof signature !== "string") {
    const err = new Error("X-Cartcrft-Signature header missing") as NodeJS.ErrnoException;
    err.code = "AGENT_SIGNATURE_INVALID";
    throw err;
  }
  if (!timestampStr || typeof timestampStr !== "string") {
    const err = new Error("X-Cartcrft-Timestamp header missing") as NodeJS.ErrnoException;
    err.code = "AGENT_SIGNATURE_INVALID";
    throw err;
  }

  // Timestamp window check
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) {
    const err = new Error("X-Cartcrft-Timestamp is not a valid unix timestamp") as NodeJS.ErrnoException;
    err.code = "AGENT_SIGNATURE_EXPIRED";
    throw err;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_WINDOW_SECONDS) {
    const err = new Error(
      `agent request timestamp is stale (delta: ${nowSeconds - timestamp}s, max: ${SIGNATURE_WINDOW_SECONDS}s)`
    ) as NodeJS.ErrnoException;
    err.code = "AGENT_SIGNATURE_EXPIRED";
    throw err;
  }

  // Load agent
  const agent = await getAgentById(agentId);
  if (!agent) {
    const err = new Error(`agent not found: ${agentId}`) as NodeJS.ErrnoException;
    err.code = "AGENT_NOT_FOUND";
    throw err;
  }
  if (agent.status !== "active") {
    const err = new Error(`agent is ${agent.status}`) as NodeJS.ErrnoException;
    err.code = "AGENT_INACTIVE";
    throw err;
  }
  if (!agent.public_key) {
    const err = new Error("agent has no public key configured") as NodeJS.ErrnoException;
    err.code = "AGENT_SIGNATURE_INVALID";
    throw err;
  }

  // Build the signing message from request data
  // Body: use raw body string if available, else empty string
  const rawBody: string =
    typeof request.body === "string"
      ? request.body
      : request.body !== undefined && request.body !== null
        ? JSON.stringify(request.body)
        : "";
  const bodyHash = sha256Hex(rawBody);
  const path = request.url; // includes query string
  const method = request.method;
  const message = buildSigningMessage(method, path, bodyHash, timestampStr);

  // Verify signature
  const valid = verifyRequestSignature(message, signature, agent.public_key);
  if (!valid) {
    const err = new Error("agent request signature verification failed") as NodeJS.ErrnoException;
    err.code = "AGENT_SIGNATURE_INVALID";
    throw err;
  }

  return {
    agentId,
    storeId: agent.store_id,
    signature,
    timestamp,
  };
}

// ── Fastify preHandler hook ───────────────────────────────────────────────────

/**
 * agentAttributionHook — Fastify preHandler for agent request attribution.
 *
 * - If agent headers are absent, passes through (no-op).
 * - If present, verifies and attaches agentCtx to the request.
 * - For mutating requests (non-GET, non-HEAD), writes an audit log row.
 *
 * Responds 401 on any attribution failure.
 */
export const agentAttributionHook: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  try {
    const ctx = await resolveAgentAttribution(request);
    if (!ctx) return; // Not an agent request — pass through

    request.agentCtx = ctx;

    // Write audit log for mutating calls (fire-and-forget — never block request)
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const params = request.params as Record<string, string>;
      const storeId = ctx.storeId;
      void insertAuditLog({
        agent_id: ctx.agentId,
        store_id: storeId,
        action: `${method} ${request.routeOptions?.url ?? request.url}`,
        request_payload: {
          method,
          path: request.url,
          params,
        },
        status: "success",
        ip_address: getClientIp(request),
        correlation_id: request.id,
      }).catch(() => {
        // Audit log failures must never interrupt the request
      });
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? "AGENT_SIGNATURE_INVALID";
    const message = err instanceof Error ? err.message : "agent attribution failed";

    const statusCode =
      code === "AGENT_SIGNATURE_EXPIRED" ? 401 :
      code === "AGENT_NOT_FOUND" ? 401 :
      code === "AGENT_INACTIVE" ? 403 :
      401;

    await reply.status(statusCode).send({
      error: { code, message },
    });
  }
};

function getClientIp(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string") {
    return xff.split(",")[0]?.trim() ?? request.ip;
  }
  return request.ip;
}

// ── Fastify plugin ─────────────────────────────────────────────────────────────

/**
 * agentAttributionPlugin — registers the agentCtx request decoration
 * and a global preHandler that attempts agent attribution on every request.
 *
 * Safe to mount globally — only processes requests that carry agent headers.
 */
export const agentAttributionPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("agentCtx", undefined);
  app.addHook("preHandler", agentAttributionHook);
};
