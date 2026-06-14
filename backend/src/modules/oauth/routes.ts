/**
 * modules/oauth/routes.ts — OAuth2 authorization-server + app-platform routes.
 *
 * Two surfaces:
 *
 *   App management (authenticated as a platform user via requireJwt, org-scoped),
 *   mounted under /account/oauth-apps:
 *     GET    /account/oauth-apps                 — list the org's apps
 *     POST   /account/oauth-apps                 — register an app (secret shown ONCE)
 *     GET    /account/oauth-apps/:id             — fetch one app
 *     PATCH  /account/oauth-apps/:id             — update an app
 *     POST   /account/oauth-apps/:id/rotate-secret — rotate secret (shown ONCE)
 *     DELETE /account/oauth-apps/:id             — delete an app
 *
 *   Authorization-server endpoints (public), mounted under /oauth:
 *     GET  /oauth/authorize          — validate client/redirect/scope/PKCE; resolve
 *                                      the logged-in merchant (refresh cookie);
 *                                      return a consent descriptor OR auto-issue
 *                                      when a remembered grant already covers scopes.
 *     POST /oauth/authorize/consent  — on approve, mint a one-time code + redirect.
 *     POST /oauth/token              — authorization_code | refresh_token |
 *                                      client_credentials → { access_token, … }.
 *     POST /oauth/revoke             — revoke a token.
 *     GET  /oauth/userinfo           — introspect: granted org/app/scopes for a token.
 *
 * The merchant session is resolved by reading the SAME httpOnly refresh cookie
 * the platform-account layer (modules/account) sets — non-destructively (we do
 * NOT rotate it here). If absent/invalid, /oauth/authorize returns a 401
 * "login_required" descriptor the frontend consent page uses to send the user
 * through /account/login first.
 */

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { requireJwt } from "../../lib/auth/middleware.js";
import { getPool } from "../../db/pool.js";
import { verifyJwt } from "../../lib/auth/jwt.js";
import {
  REFRESH_COOKIE_NAME,
  type PlatformRole,
} from "../account/service.js";
import {
  OAUTH_SCOPES,
  SCOPE_DESCRIPTIONS,
  parseScopeParam,
  validateRequestedScopes,
  scopesCovered,
  type OAuthScope,
} from "../../lib/oauth/scopes.js";
import {
  createApp,
  listApps,
  getApp,
  updateApp,
  rotateSecret,
  deleteApp,
  findAppByClientId,
  getGrant,
  issueAuthorizationCode,
  verifyClientSecret,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  clientCredentialsGrant,
  revokeToken,
  type ClientType,
} from "./service.js";

// ── Schemas ──────────────────────────────────────────────────────────────────

const CreateAppBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  client_type: z.enum(["confidential", "public"]).optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(20),
  allowed_scopes: z.array(z.enum(OAUTH_SCOPES)).min(1),
  logo_url: z.string().url().nullable().optional(),
  homepage_url: z.string().url().nullable().optional(),
});

const UpdateAppBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  redirect_uris: z.array(z.string().url()).min(1).max(20).optional(),
  allowed_scopes: z.array(z.enum(OAUTH_SCOPES)).min(1).optional(),
  logo_url: z.string().url().nullable().optional(),
  homepage_url: z.string().url().nullable().optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

const AppIdParams = z.object({ id: z.string().uuid() });

const AuthorizeQuery = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  response_type: z.string().min(1),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.enum(["S256", "plain"]).optional(),
});

const ConsentBody = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  scope: z.string().optional(),
  state: z.string().optional(),
  code_challenge: z.string().optional(),
  code_challenge_method: z.enum(["S256", "plain"]).optional(),
  approve: z.boolean(),
});

const TokenBody = z.object({
  grant_type: z.enum(["authorization_code", "refresh_token", "client_credentials"]),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
}).passthrough();

const RevokeBody = z.object({ token: z.string().min(1) }).passthrough();

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers["cookie"];
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

interface MerchantSession {
  subject: string;       // platform_user id
  organizationId: string;
  email: string;
  role: PlatformRole;
}

/**
 * Resolve the logged-in merchant from the refresh cookie (preferred) or a
 * dashboard access JWT in the Authorization header (fallback). Non-destructive:
 * we never rotate the session here. Returns null when no valid session exists.
 */
async function resolveMerchantSession(request: FastifyRequest): Promise<MerchantSession | null> {
  // 1. Refresh cookie → platform_sessions (the consent page's normal path).
  const cookie = readCookie(request, REFRESH_COOKIE_NAME);
  if (cookie) {
    const { rows } = await getPool().query<{
      org_id: string; email: string; role: PlatformRole; user_id: string;
    }>(
      `SELECT u.id::text AS user_id, u.org_id::text AS org_id, u.email, u.role
         FROM platform_sessions s
         JOIN platform_users u ON u.id = s.platform_user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.is_active = true`,
      [sha256Hex(cookie)]
    );
    const r = rows[0];
    if (r) return { subject: r.user_id, organizationId: r.org_id, email: r.email, role: r.role };
  }

  // 2. Fallback — a dashboard access JWT (Authorization: Bearer) but NOT an
  //    OAuth token (an OAuth token must not be usable to grant further consent).
  const authorization = request.headers["authorization"] ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (bearer) {
    const claims = await verifyJwt(bearer);
    if (claims && !claims.oauth_app) {
      return {
        subject: claims.sub,
        organizationId: claims.org,
        email: claims.email ?? "",
        role: "member",
      };
    }
  }
  return null;
}

/** Append query params to a redirect URI (preserving any existing query). */
function buildRedirect(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const oauthPlugin: FastifyPluginAsync = async (app) => {
  // ════════════════════════════════════════════════════════════════════════
  // App management (requireJwt, org-scoped) — /account/oauth-apps
  // ════════════════════════════════════════════════════════════════════════

  app.get("/account/oauth-apps", { preHandler: [requireJwt] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const apps = await listApps(orgId);
    return reply.send({ apps });
  });

  app.post(
    "/account/oauth-apps",
    { preHandler: [requireJwt], schema: { body: CreateAppBody } },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const body = request.body as z.infer<typeof CreateAppBody>;
      const created = await createApp({
        orgId,
        name: body.name,
        description: body.description ?? null,
        clientType: (body.client_type ?? "confidential") as ClientType,
        redirectUris: body.redirect_uris,
        allowedScopes: body.allowed_scopes,
        logoUrl: body.logo_url ?? null,
        homepageUrl: body.homepage_url ?? null,
      });
      // client_secret is returned ONCE here; only its hash is persisted.
      return reply.status(201).send(created);
    }
  );

  app.get(
    "/account/oauth-apps/:id",
    { preHandler: [requireJwt], schema: { params: AppIdParams } },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = request.params as z.infer<typeof AppIdParams>;
      const found = await getApp(orgId, id);
      if (!found) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "app not found" } });
      return reply.send({ app: found });
    }
  );

  app.patch(
    "/account/oauth-apps/:id",
    { preHandler: [requireJwt], schema: { params: AppIdParams, body: UpdateAppBody } },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = request.params as z.infer<typeof AppIdParams>;
      const body = request.body as z.infer<typeof UpdateAppBody>;
      const updated = await updateApp(orgId, id, {
        name: body.name,
        description: body.description,
        redirectUris: body.redirect_uris,
        allowedScopes: body.allowed_scopes,
        logoUrl: body.logo_url,
        homepageUrl: body.homepage_url,
        status: body.status,
      });
      if (!updated) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "app not found" } });
      return reply.send({ app: updated });
    }
  );

  app.post(
    "/account/oauth-apps/:id/rotate-secret",
    { preHandler: [requireJwt], schema: { params: AppIdParams } },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = request.params as z.infer<typeof AppIdParams>;
      const result = await rotateSecret(orgId, id);
      if (!result.ok) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return reply.status(status).send({ error: { code: result.code, message: result.code === "NOT_FOUND" ? "app not found" : "public clients have no secret to rotate" } });
      }
      return reply.send({ client_secret: result.client_secret });
    }
  );

  app.delete(
    "/account/oauth-apps/:id",
    { preHandler: [requireJwt], schema: { params: AppIdParams } },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { id } = request.params as z.infer<typeof AppIdParams>;
      const ok = await deleteApp(orgId, id);
      if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "app not found" } });
      return reply.send({ ok: true });
    }
  );

  // ════════════════════════════════════════════════════════════════════════
  // Authorization-server endpoints (public) — /oauth
  // ════════════════════════════════════════════════════════════════════════

  /**
   * GET /oauth/authorize — validate the request, resolve the merchant session,
   * and either return a consent descriptor or (when a remembered grant already
   * covers the requested scopes) auto-issue a code + redirect descriptor.
   *
   * We return JSON descriptors (not HTML) — the frontend renders the consent
   * screen. `redirect` in the response is the URL the frontend navigates to.
   */
  app.get(
    "/oauth/authorize",
    { schema: { querystring: AuthorizeQuery } },
    async (request, reply) => {
      const q = request.query as z.infer<typeof AuthorizeQuery>;

      if (q.response_type !== "code") {
        return reply.status(400).send({ error: { code: "unsupported_response_type", message: "only response_type=code is supported" } });
      }

      const app_ = await findAppByClientId(q.client_id);
      if (!app_ || app_.status !== "active") {
        return reply.status(400).send({ error: { code: "invalid_client", message: "unknown or inactive client_id" } });
      }

      // redirect_uri must EXACTLY match a registered uri (no open redirect).
      if (!app_.redirect_uris.includes(q.redirect_uri)) {
        return reply.status(400).send({ error: { code: "invalid_redirect_uri", message: "redirect_uri is not registered for this app" } });
      }

      // From here, errors per OAuth2 should redirect back with ?error=… — but
      // only to the validated redirect_uri.
      const parsed = parseScopeParam(q.scope);
      if (!parsed.ok) {
        return reply.status(302).header("location", buildRedirect(q.redirect_uri, { error: "invalid_scope", error_description: parsed.message, ...(q.state ? { state: q.state } : {}) })).send();
      }
      const requested = parsed.scopes.length > 0 ? parsed.scopes : app_.allowed_scopes;
      const scopeCheck = validateRequestedScopes(requested, app_.allowed_scopes);
      if (!scopeCheck.ok) {
        return reply.status(302).header("location", buildRedirect(q.redirect_uri, { error: "invalid_scope", error_description: scopeCheck.message, ...(q.state ? { state: q.state } : {}) })).send();
      }

      // PKCE: required for public clients (S256 only).
      if (app_.client_type === "public") {
        if (!q.code_challenge) {
          return reply.status(400).send({ error: { code: "invalid_request", message: "code_challenge required for public clients (PKCE)" } });
        }
        if ((q.code_challenge_method ?? "plain") !== "S256") {
          return reply.status(400).send({ error: { code: "invalid_request", message: "public clients must use code_challenge_method=S256" } });
        }
      }

      // Resolve the logged-in merchant. If absent, the frontend must log in first.
      const session = await resolveMerchantSession(request);
      if (!session) {
        return reply.status(401).send({
          error: { code: "login_required", message: "merchant must be logged in to authorize" },
          login_required: true,
        });
      }

      // Remembered consent → auto-issue without showing the consent screen.
      const grant = await getGrant({ appId: app_.id, subject: session.subject, organizationId: session.organizationId });
      if (grant && scopesCovered(requested, grant.scopes)) {
        const code = await issueAuthorizationCode({
          appId: app_.id,
          organizationId: session.organizationId,
          subject: session.subject,
          scopes: requested,
          redirectUri: q.redirect_uri,
          codeChallenge: q.code_challenge ?? null,
          codeChallengeMethod: q.code_challenge_method ?? null,
        });
        return reply.send({
          auto_approved: true,
          redirect: buildRedirect(q.redirect_uri, { code, ...(q.state ? { state: q.state } : {}) }),
        });
      }

      // Otherwise return a consent descriptor for the frontend to render.
      return reply.send({
        consent_required: true,
        app: { name: app_.name, logo_url: app_.logo_url, homepage_url: app_.homepage_url },
        organization_id: session.organizationId,
        account: { email: session.email },
        scopes: requested.map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s as OAuthScope] ?? s })),
        // Echo the params the frontend must POST back to /oauth/authorize/consent.
        request: {
          client_id: q.client_id,
          redirect_uri: q.redirect_uri,
          scope: requested.join(" "),
          ...(q.state ? { state: q.state } : {}),
          ...(q.code_challenge ? { code_challenge: q.code_challenge } : {}),
          ...(q.code_challenge_method ? { code_challenge_method: q.code_challenge_method } : {}),
        },
      });
    }
  );

  /**
   * POST /oauth/authorize/consent — the merchant approved (or denied). On
   * approve we mint a one-time code and return the redirect URL. On deny we
   * return an access_denied redirect.
   */
  app.post(
    "/oauth/authorize/consent",
    { schema: { body: ConsentBody } },
    async (request, reply) => {
      const body = request.body as z.infer<typeof ConsentBody>;

      const app_ = await findAppByClientId(body.client_id);
      if (!app_ || app_.status !== "active") {
        return reply.status(400).send({ error: { code: "invalid_client", message: "unknown or inactive client_id" } });
      }
      if (!app_.redirect_uris.includes(body.redirect_uri)) {
        return reply.status(400).send({ error: { code: "invalid_redirect_uri", message: "redirect_uri is not registered for this app" } });
      }

      const session = await resolveMerchantSession(request);
      if (!session) {
        return reply.status(401).send({ error: { code: "login_required", message: "merchant must be logged in to authorize" } });
      }

      if (!body.approve) {
        return reply.send({ redirect: buildRedirect(body.redirect_uri, { error: "access_denied", ...(body.state ? { state: body.state } : {}) }) });
      }

      const parsed = parseScopeParam(body.scope);
      if (!parsed.ok) {
        return reply.status(400).send({ error: { code: "invalid_scope", message: parsed.message } });
      }
      const requested = parsed.scopes.length > 0 ? parsed.scopes : app_.allowed_scopes;
      const scopeCheck = validateRequestedScopes(requested, app_.allowed_scopes);
      if (!scopeCheck.ok) {
        return reply.status(400).send({ error: { code: "invalid_scope", message: scopeCheck.message } });
      }

      if (app_.client_type === "public") {
        if (!body.code_challenge || (body.code_challenge_method ?? "plain") !== "S256") {
          return reply.status(400).send({ error: { code: "invalid_request", message: "public clients must use PKCE S256" } });
        }
      }

      const code = await issueAuthorizationCode({
        appId: app_.id,
        organizationId: session.organizationId,
        subject: session.subject,
        scopes: requested,
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge ?? null,
        codeChallengeMethod: body.code_challenge_method ?? null,
      });

      return reply.send({ redirect: buildRedirect(body.redirect_uri, { code, ...(body.state ? { state: body.state } : {}) }) });
    }
  );

  /**
   * POST /oauth/token — the token endpoint for all three grant types.
   * Client authentication for confidential clients is via client_secret (body
   * or HTTP Basic). Returns the standard OAuth2 token response.
   */
  app.post(
    "/oauth/token",
    { schema: { body: TokenBody } },
    async (request, reply) => {
      const body = request.body as z.infer<typeof TokenBody>;

      // Client auth: client_id/secret may come from the body or HTTP Basic.
      let clientId = body.client_id;
      let clientSecret = body.client_secret;
      const authz = request.headers["authorization"];
      if (typeof authz === "string" && authz.startsWith("Basic ")) {
        const decoded = Buffer.from(authz.slice(6), "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        if (idx !== -1) {
          clientId = decodeURIComponent(decoded.slice(0, idx));
          clientSecret = decodeURIComponent(decoded.slice(idx + 1));
        }
      }

      if (!clientId) {
        return reply.status(400).send({ error: "invalid_client", error_description: "client_id required" });
      }

      const app_ = await findAppByClientId(clientId);
      if (!app_ || app_.status !== "active") {
        return reply.status(401).send({ error: "invalid_client", error_description: "unknown or inactive client" });
      }

      // Confidential clients MUST authenticate with their secret.
      if (app_.client_type === "confidential") {
        if (!clientSecret || !(await verifyClientSecret(clientId, clientSecret))) {
          return reply.status(401).send({ error: "invalid_client", error_description: "client authentication failed" });
        }
      }

      if (body.grant_type === "authorization_code") {
        if (!body.code || !body.redirect_uri) {
          return reply.status(400).send({ error: "invalid_request", error_description: "code and redirect_uri are required" });
        }
        const result = await exchangeAuthorizationCode({
          clientId,
          code: body.code,
          redirectUri: body.redirect_uri,
          codeVerifier: body.code_verifier ?? null,
        });
        if (!result.ok) {
          return reply.status(400).send({ error: result.error, error_description: result.message });
        }
        return reply.send(result.body);
      }

      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) {
          return reply.status(400).send({ error: "invalid_request", error_description: "refresh_token required" });
        }
        const result = await exchangeRefreshToken({ clientId, refreshToken: body.refresh_token });
        if (!result.ok) {
          return reply.status(400).send({ error: result.error, error_description: result.message });
        }
        return reply.send(result.body);
      }

      // client_credentials
      const parsed = parseScopeParam(body.scope);
      if (!parsed.ok) {
        return reply.status(400).send({ error: "invalid_scope", error_description: parsed.message });
      }
      const result = await clientCredentialsGrant({ clientId, scopes: parsed.scopes });
      if (!result.ok) {
        const status = result.error === "invalid_client" ? 401 : 400;
        return reply.status(status).send({ error: result.error, error_description: result.message });
      }
      return reply.send(result.body);
    }
  );

  /** POST /oauth/revoke — revoke a refresh token (RFC 7009; always 200). */
  app.post(
    "/oauth/revoke",
    { schema: { body: RevokeBody } },
    async (request, reply) => {
      const body = request.body as z.infer<typeof RevokeBody>;
      await revokeToken(body.token);
      return reply.send({ ok: true });
    }
  );

  /**
   * GET /oauth/userinfo — introspect the bearer access token: return the granted
   * org, app, and scopes. Used by integrators to discover what the token can do.
   */
  app.get("/oauth/userinfo", async (request, reply) => {
    const authorization = request.headers["authorization"] ?? "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!bearer) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "missing bearer token" } });
    }
    const claims = await verifyJwt(bearer);
    if (!claims || !claims.oauth_app) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "not a valid OAuth access token" } });
    }
    return reply.send({
      active: true,
      sub: claims.sub,
      organization_id: claims.org,
      oauth_app: claims.oauth_app,
      scope: typeof claims.scope === "string" ? claims.scope : "",
      scopes: typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [],
      exp: claims.exp,
    });
  });
};
