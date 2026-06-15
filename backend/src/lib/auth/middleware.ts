/**
 * lib/auth/middleware.ts — Fastify auth decorators + hooks.
 *
 * Three auth tiers as Fastify preHandler hooks:
 *
 *   storeAuthRead  — cc_pub_ or cc_prv_ with commerce:read+ OR JWT (org member)
 *   storeAuthWrite — cc_prv_ with commerce:write+ OR JWT; cc_pub_ rejected
 *   storeAuthAdmin — cc_prv_ with commerce:admin OR JWT; cc_pub_ rejected
 *
 * Also exports:
 *   rateLimitHook — in-memory IP rate-limit preHandler
 *   requireJwt    — JWT-only preHandler (no API key)
 *
 * Resolution flow:
 *   1. Check Authorization header for cc_pub_ / cc_prv_ prefix → API key path
 *      a. Lookup key (cache first, then DB) → validate hash, expiry, active
 *      b. Verify key.orgId === store.organization_id
 *      c. Verify store_id restriction (if set on key)
 *      d. Check scope for required tier
 *      e. Attach { storeId, orgId, authType: "api-key" } to request
 *   2. Otherwise → JWT path
 *      a. Decode JWT from Authorization header
 *      b. Extract sub + org claims
 *      c. Verify storeId param belongs to org (requireStoreAccess)
 *      d. Attach { storeId, orgId, userId, authType: "jwt" } to request
 *
 * Machine-readable 401/403 error codes:
 *   UNAUTHORIZED         — no/invalid/expired credentials
 *   FORBIDDEN            — credentials valid but insufficient scope/access
 *   RATE_LIMIT_EXCEEDED  — IP rate limit hit
 */

import type {
  FastifyRequest,
  FastifyReply,
  FastifyPluginAsync,
  preHandlerHookHandler,
} from "fastify";
import { getPool } from "../../db/pool.js";
import { verifyJwt } from "./jwt.js";
import { lookupApiKey, hasScope } from "../../modules/apikeys/service.js";
import { storeExistsInOrg } from "../../modules/stores/service.js";
import { config } from "../../config/config.js";
import { buildKv, getKvSync, MemoryKv } from "../cache/kv.js";
import { setRequestCtx } from "../request-ctx.js";
import { scopeSatisfies } from "../oauth/scopes.js";

// ── Request decoration ────────────────────────────────────────────────────────

/** Attached to request by auth hooks. */
export interface AuthContext {
  storeId: string;
  orgId: string;
  userId?: string | undefined;
  authType: "jwt" | "api-key";
  /**
   * OAuth principal (T-OAuth): set ONLY when the bearer JWT carries the
   * `oauth_app` + `scope` claims minted by the authorization server. When
   * present, requireScope() asserts the token holds a route's required scope.
   * Absent for normal dashboard JWTs and API keys, so existing auth is
   * unchanged — OAuth is an ADDITIONAL principal type.
   */
  oauthApp?: string | undefined;
  oauthScopes?: string[] | undefined;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext | undefined;
  }
}

// ── IP rate limiter (KV-backed) ───────────────────────────────────────────────

/**
 * Initialise the KV singleton at app boot so the first request doesn't pay
 * the lazy-init cost.  Fire-and-forget — never blocks startup.
 */
export function initRateLimitKv(): void {
  void buildKv();
}

/**
 * P0-2: Return the client IP.
 *
 * When `TRUST_PROXY` is set in the environment, Fastify is configured with
 * `trustProxy` so `request.ip` already reflects the correct originating IP
 * from X-Forwarded-For (handled by Fastify/find-my-way, not by us).
 *
 * When `TRUST_PROXY` is NOT set, `request.ip` is the raw socket peer address,
 * which is safe. We must NOT read XFF directly because an untrusted caller can
 * forge it to bypass rate-limiting or the SUPERADMIN_IP_ALLOWLIST.
 */
function getClientIp(request: FastifyRequest): string {
  return request.ip;
}

/**
 * Fallback in-memory bucket used only during the brief async-init window
 * before the KV singleton is ready.  After init the KV singleton handles all
 * requests.  Exported so tests can inject a custom KV via setKvForTesting()
 * and this path is never hit.
 */
const _fallbackKv = new MemoryKv();

/**
 * IP rate-limit preHandler.
 *
 * Uses the process-singleton KV (MemoryKv by default; RedisKv when REDIS_URL
 * is configured).  The KV's incrWithWindow() enforces a fixed 60-second
 * window — identical semantics to the original ipBuckets Map, so existing
 * apikeys.test.ts behaviour is preserved without modification.
 *
 * Responds 429 with RATE_LIMIT_EXCEEDED on breach.
 */
export const rateLimitHook: preHandlerHookHandler = async (
  request,
  reply
) => {
  const ip = getClientIp(request);
  const limit = config.IP_RATE_LIMIT_PER_MINUTE;

  // Use the already-initialised singleton if available; fall back to the
  // in-memory bucket for the tiny window before first async init resolves.
  const kv = getKvSync() ?? _fallbackKv;

  const count = await kv.incrWithWindow(`rl:${ip}`, 60_000);

  if (count > limit) {
    await reply.status(429).send({
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: `Rate limit exceeded: ${limit} requests per minute`,
      },
    });
  }
};

// ── Error helpers ─────────────────────────────────────────────────────────────

async function sendUnauthorized(
  reply: FastifyReply,
  message: string
): Promise<void> {
  await reply
    .status(401)
    .send({ error: { code: "UNAUTHORIZED", message } });
}

async function sendForbidden(
  reply: FastifyReply,
  message: string
): Promise<void> {
  await reply
    .status(403)
    .send({ error: { code: "FORBIDDEN", message } });
}

async function sendNotFound(
  reply: FastifyReply,
  message: string
): Promise<void> {
  await reply
    .status(404)
    .send({ error: { code: "NOT_FOUND", message } });
}

// ── Core auth resolution ──────────────────────────────────────────────────────

type AuthTier = "read" | "write" | "admin";

/**
 * Resolve auth for a store endpoint.
 *
 * @param request      Fastify request (route must have :storeId param)
 * @param reply        Fastify reply
 * @param requiredTier Minimum scope tier for API key callers
 * @param allowPublic  Whether cc_pub_ keys are accepted
 */
async function resolveStoreAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  requiredTier: AuthTier,
  allowPublic: boolean
): Promise<void> {
  const params = request.params as Record<string, string>;
  const storeId = params["storeId"] ?? params["store_id"];

  if (!storeId) {
    return sendForbidden(reply, "store_id route param missing");
  }

  const authorization = request.headers["authorization"] ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  const isApiKey =
    bearer.startsWith("cc_pub_") || bearer.startsWith("cc_prv_");
  const isPubKey = bearer.startsWith("cc_pub_");

  // ── API key path ──────────────────────────────────────────────────────────
  if (isApiKey) {
    if (isPubKey && !allowPublic) {
      return sendForbidden(
        reply,
        "this endpoint requires a server-side API key (cc_prv_) or JWT; public keys are not permitted"
      );
    }

    const cached = await lookupApiKey(bearer);
    if (!cached) {
      return sendUnauthorized(reply, "invalid or expired API key");
    }

    // Verify the key's org matches the store.
    const pool = getPool();
    const { rows } = await pool.query<{ organization_id: string }>(
      `SELECT organization_id::text FROM stores WHERE id = $1::uuid`,
      [storeId]
    );
    const storeOrg = rows[0]?.organization_id;
    if (!storeOrg) {
      return sendNotFound(reply, "store not found");
    }

    if (cached.orgId !== storeOrg) {
      return sendUnauthorized(
        reply,
        "API key does not belong to this store's organization"
      );
    }

    // Check store restriction on the key.
    if (cached.storeRestriction && cached.storeRestriction !== storeId) {
      return sendUnauthorized(reply, "API key is restricted to a different store");
    }

    // Check scope tier.
    const { scopes } = cached;
    switch (requiredTier) {
      case "read":
        if (!hasScope(scopes, "commerce:read")) {
          return sendForbidden(reply, "insufficient scope for commerce access");
        }
        break;
      case "write":
        if (!hasScope(scopes, "commerce:write")) {
          return sendForbidden(reply, "commerce:write or commerce:admin scope required");
        }
        break;
      case "admin":
        if (!hasScope(scopes, "commerce:admin")) {
          return sendForbidden(reply, "commerce:admin scope required");
        }
        break;
    }

    request.auth = {
      storeId,
      orgId: cached.orgId,
      authType: "api-key",
    };

    // Populate AsyncLocalStorage so withTx can set the RLS GUC.
    // For API-key auth there is no individual userId; use a synthetic identifier
    // that is stable and non-empty (signals an authenticated connection).
    setRequestCtx({ userId: `apikey:${cached.orgId}`, orgId: cached.orgId });
    return;
  }

  // ── JWT path ──────────────────────────────────────────────────────────────
  if (!bearer) {
    return sendUnauthorized(reply, "missing Authorization header");
  }

  const claims = await verifyJwt(bearer);
  if (!claims) {
    return sendUnauthorized(reply, "invalid or expired token");
  }

  const userId = claims.sub;
  const orgId = claims.org;

  const storeOk = await storeExistsInOrg(storeId, orgId);
  if (!storeOk) {
    return sendNotFound(reply, "store not found");
  }

  // OAuth access tokens carry oauth_app + scope claims. They authenticate
  // exactly like a JWT here (org/store-bound), and additionally surface their
  // granted scopes so requireScope() can gate individual routes.
  const oauthApp = typeof claims.oauth_app === "string" ? claims.oauth_app : undefined;
  const oauthScopes = oauthApp
    ? (typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [])
    : undefined;

  request.auth = {
    storeId,
    orgId,
    userId,
    authType: "jwt",
    oauthApp,
    oauthScopes,
  };

  // Populate AsyncLocalStorage so withTx can set the RLS GUC.
  setRequestCtx({ userId, orgId });
}

// ── JWT-only (management endpoints) ──────────────────────────────────────────

/**
 * requireJwt — JWT-only preHandler.
 * Does NOT verify a store; use for org-level endpoints like /commerce/stores
 * (list/create) and /api-keys.
 *
 * Attaches { orgId, userId, authType: "jwt" } to request.auth.
 *
 * NOTE: this also accepts OAuth access tokens (which carry oauth_app + scope
 * claims).  For /account/** management routes that must NOT be reachable by
 * OAuth tokens, use `requireDashboardJwt` instead.
 */
export const requireJwt: preHandlerHookHandler = async (request, reply) => {
  const authorization = request.headers["authorization"] ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!bearer) {
    return sendUnauthorized(reply, "missing Authorization header");
  }

  const claims = await verifyJwt(bearer);
  if (!claims) {
    return sendUnauthorized(reply, "invalid or expired token");
  }

  request.auth = {
    storeId: "",
    orgId: claims.org,
    userId: claims.sub,
    authType: "jwt",
  };

  // Populate AsyncLocalStorage so withTx can set the RLS GUC.
  setRequestCtx({ userId: claims.sub, orgId: claims.org });
};

/**
 * P0-1 — requireDashboardJwt
 *
 * Like requireJwt but REJECTS tokens that carry an `oauth_app` claim.  OAuth
 * access tokens must never reach management routes such as /account/oauth-apps
 * or /account/users — otherwise a low-scope OAuth token could escalate to
 * creating/rotating OAuth app secrets or managing team members.
 *
 * Use this preHandler on every /account/** management route.
 * The /commerce/** and /oauth/** routes continue to use the existing helpers
 * (storeAuthRead/Write/Admin for /commerce, open or requireJwt for /oauth).
 */
export const requireDashboardJwt: preHandlerHookHandler = async (request, reply) => {
  const authorization = request.headers["authorization"] ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!bearer) {
    return sendUnauthorized(reply, "missing Authorization header");
  }

  const claims = await verifyJwt(bearer);
  if (!claims) {
    return sendUnauthorized(reply, "invalid or expired token");
  }

  // P0-1: OAuth access tokens carry oauth_app. Reject them here.
  if (claims.oauth_app) {
    return sendUnauthorized(
      reply,
      "OAuth access tokens cannot access account management endpoints; use a dashboard session token"
    );
  }

  request.auth = {
    storeId: "",
    orgId: claims.org,
    userId: claims.sub,
    authType: "jwt",
  };

  setRequestCtx({ userId: claims.sub, orgId: claims.org });
};

// ── Tier preHandlers ──────────────────────────────────────────────────────────

/**
 * storeAuthRead — storefront reads.
 * Accepts: cc_pub_ (commerce:read), cc_prv_ (commerce:read+), JWT.
 */
export const storeAuthRead: preHandlerHookHandler = async (request, reply) => {
  return resolveStoreAuth(request, reply, "read", true);
};

/**
 * storeAuthWrite — writes that mutate sensitive state.
 * Rejects cc_pub_; requires cc_prv_ with commerce:write+ or JWT.
 */
export const storeAuthWrite: preHandlerHookHandler = async (
  request,
  reply
) => {
  return resolveStoreAuth(request, reply, "write", false);
};

/**
 * storeAuthAdmin — management endpoints (provider config, settings).
 * Rejects cc_pub_; requires cc_prv_ with commerce:admin or JWT.
 */
export const storeAuthAdmin: preHandlerHookHandler = async (
  request,
  reply
) => {
  return resolveStoreAuth(request, reply, "admin", false);
};

// ── OAuth scope enforcement ─────────────────────────────────────────────────

/**
 * requireScope(scope) — assert an OAuth access token carries `scope`.
 *
 * Designed to run AFTER a storeAuth* tier preHandler (which has already
 * authenticated the request and populated request.auth). It is a no-op for
 * non-OAuth principals — normal dashboard JWTs and cc_pub_/cc_prv_ API keys are
 * NOT scope-restricted here, preserving every existing auth path. Only when the
 * token is an OAuth access token (request.auth.oauthApp is set) does it enforce
 * that the granted scope list satisfies the required scope; otherwise it returns
 * 403 INSUFFICIENT_SCOPE.
 *
 * `:write` on a resource implies `:read` (see scopeSatisfies()).
 */
export function requireScope(scope: string): preHandlerHookHandler {
  return async (request, reply) => {
    const auth = request.auth;
    // Not an OAuth principal → existing auth already authorised this route.
    if (!auth || !auth.oauthApp) return;
    if (!scopeSatisfies(auth.oauthScopes ?? [], scope)) {
      return reply.status(403).send({
        error: {
          code: "INSUFFICIENT_SCOPE",
          message: `this OAuth token is missing the required scope: ${scope}`,
        },
      });
    }
  };
}

// ── Fastify plugin (registers decorators) ────────────────────────────────────

/**
 * authPlugin — registers the `auth` request decoration.
 * Mount once at app level via `app.register(authPlugin)`.
 */
export const authPlugin: FastifyPluginAsync = async (app) => {
  // Decorate with undefined (falsy default so the type is AuthContext | undefined)
  app.decorateRequest("auth", undefined);
};
