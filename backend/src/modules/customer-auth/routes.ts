/**
 * customer-auth/routes.ts — Fastify plugin for storefront customer auth.
 *
 * Mounts:
 *  - Auth config management (storeAuthAdmin)
 *  - Public storefront auth (register, login, token, etc.)
 *  - OAuth (Google, Microsoft, Discord)
 *  - Bearer-auth routes (GET /me, sessions)
 *  - Dev mock OAuth (APP_ENV != production)
 */

import type { preHandlerHookHandler } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  storeAuthAdmin,
  storeAuthWrite,
} from "../../lib/auth/middleware.js";
import { getPool, getReadDb } from "../../db/pool.js";
import { config } from "../../config/config.js";
import {
  loadStoreConfig,
  getAuthConfig,
  updateAuthConfig,
  getEmailLog,
  sendTestEmail,
  registerCustomer,
  verifyEmail,
  sendEmailVerification,
  loginWithPassword,
  rotateSession,
  revokeAllSessions,
  requestPasswordReset,
  completePasswordReset,
  sendMagicLink,
  verifyMagicLink,
  acceptInvitation,
  oauthUpsertAndLogin,
  bearerAuth,
  saveOAuthState,
  loadOAuthState,
  hashPasswordSync,
  verifyAndMaybeRehash,
  invalidateCustomerTokens,
  type CustomerClaims,
} from "./service.js";

// ── Bearer auth preHandler for storefront ─────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    customer?: CustomerClaims | undefined;
  }
}

function makeCaAuth(): preHandlerHookHandler {
  return async (request, reply) => {
    const params = request.params as Record<string, string>;
    const storeId = params["storeId"] ?? "";
    const authorization = request.headers["authorization"] ?? "";
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";

    const claims = await bearerAuth(pool, authorization, storeId, secretsKey);
    if (!claims) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "invalid or expired customer token" } });
    }
    if (claims.store !== storeId) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "token does not belong to this store" } });
    }
    request.customer = claims;
  };
}

const caBearerAuth = makeCaAuth();

// ── Schemas ───────────────────────────────────────────────────────────────────

const StoreIdParams = z.object({ storeId: z.string().uuid() });

const SessionIdParams = z.object({
  storeId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

const TokenBody = z.object({
  refresh_token: z.string().min(1),
});

const VerifyEmailBody = z.object({
  token: z.string().min(1),
});

const PasswordResetRequestBody = z.object({
  email: z.string().email(),
});

const PasswordResetCompleteBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});

const MagicLinkBody = z.object({
  email: z.string().email(),
});

const MagicLinkVerifyBody = z.object({
  token: z.string().min(1),
});

const InviteAcceptBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
});

const UpdateMeBody = z.object({
  first_name: z.string().max(100).optional(),
  last_name: z.string().max(100).optional(),
  display_name: z.string().max(200).optional(),
  phone: z.string().max(32).optional(),
});

const ChangePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(128),
});

const AuthConfigBody = z.object({
  auth_enabled: z.boolean().optional(),
  auth_email_password_enabled: z.boolean().optional(),
  auth_magic_link_enabled: z.boolean().optional(),
  auth_otp_enabled: z.boolean().optional(),
  auth_google_enabled: z.boolean().optional(),
  auth_google_client_id: z.string().optional(),
  auth_google_client_secret: z.string().optional(),
  auth_microsoft_enabled: z.boolean().optional(),
  auth_ms_client_id: z.string().optional(),
  auth_ms_client_secret: z.string().optional(),
  auth_discord_enabled: z.boolean().optional(),
  auth_discord_client_id: z.string().optional(),
  auth_discord_client_secret: z.string().optional(),
  auth_allow_self_registration: z.boolean().optional(),
  auth_require_email_verification: z.boolean().optional(),
  auth_jwt_secret: z.string().optional(),
  auth_jwt_expiry_mins: z.number().int().positive().optional(),
  auth_session_duration_days: z.number().int().positive().optional(),
  auth_max_sessions: z.number().int().positive().optional(),
  auth_logo_url: z.string().optional(),
  auth_brand_color: z.string().optional(),
  auth_redirect_url: z.string().optional(),
  auth_allowed_origins: z.array(z.string()).optional(),
  auth_email_templates: z.record(z.string(), z.unknown()).optional(),
});

const TestEmailBody = z.object({ email: z.string().email() });

const MockOAuthBody = z.object({
  provider: z.enum(["google", "microsoft", "discord"]),
  email: z.string().email(),
  name: z.string().optional(),
});

const OAuthCallbackBody = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const OAuthUrlQuery = z.object({
  redirect_uri: z.string().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getIp(request: Parameters<preHandlerHookHandler>[0]): string {
  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0]?.trim() ?? request.ip;
  return request.ip;
}

function getUserAgent(request: Parameters<preHandlerHookHandler>[0]): string {
  return request.headers["user-agent"] ?? "";
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const customerAuthPlugin: FastifyPluginAsyncZod = async (app) => {
  // Decorate request with customer slot
  app.decorateRequest("customer", undefined);

  const base = "/commerce/stores/:storeId";

  // ── Auth config management (storeAuthAdmin) ────────────────────────────────

  app.get(`${base}/auth/config`, {
    schema: { params: StoreIdParams },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const cfg = await getAuthConfig(pool, storeId);
    return reply.send({ config: cfg });
  });

  app.put(`${base}/auth/config`, {
    schema: { params: StoreIdParams, body: AuthConfigBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    await updateAuthConfig(pool, storeId, secretsKey, request.body as Record<string, unknown>);
    return reply.send({ ok: true });
  });

  app.get(`${base}/auth/email/log`, {
    schema: { params: StoreIdParams },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const entries = await getEmailLog(getReadDb(), storeId);
    return reply.send({ entries });
  });

  app.post(`${base}/auth/email/test`, {
    schema: { params: StoreIdParams, body: TestEmailBody },
    preHandler: [storeAuthAdmin],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    await sendTestEmail(pool, storeId, cfg, request.body.email);
    return reply.send({ ok: true });
  });

  // email/connect — SMTP connectivity check (not implemented).
  // Returns 501 NOT_IMPLEMENTED rather than a misleading { ok: true } success.
  // A real SMTP connectivity check (nodemailer verify, etc.) is out of scope
  // until a dedicated SMTP provider integration is added; returning a false
  // success would silently hide misconfigured credentials.
  app.post(`${base}/auth/email/connect`, {
    schema: { params: StoreIdParams },
    preHandler: [storeAuthAdmin],
  }, async (_request, reply) => {
    return reply.status(501).send({
      error: {
        code: "NOT_IMPLEMENTED",
        message: "SMTP connectivity check is not implemented. Configure your SMTP provider credentials and send a test email via POST /auth/email/test to verify delivery.",
      },
    });
  });

  // ── Public auth info ───────────────────────────────────────────────────────

  app.get(`${base}/auth/info`, {
    schema: { params: StoreIdParams },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    try {
      const cfg = await loadStoreConfig(pool, storeId, secretsKey);
      return reply.send({
        email_password_enabled: cfg.emailPasswordEnabled,
        magic_link_enabled: cfg.magicLinkEnabled,
        google_enabled: cfg.googleEnabled,
        microsoft_enabled: cfg.microsoftEnabled,
        discord_enabled: cfg.discordEnabled,
        allow_self_registration: cfg.allowSelfRegistration,
        require_email_verification: cfg.requireEmailVerification,
        logo_url: cfg.logoUrl || null,
        brand_color: cfg.brandColor || null,
      });
    } catch {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "store not found" } });
    }
  });

  // ── Register ───────────────────────────────────────────────────────────────

  app.post(`${base}/auth/register`, {
    schema: { params: StoreIdParams, body: RegisterBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    const ip = getIp(request);
    const ua = getUserAgent(request);

    const result = await registerCustomer(pool, storeId, request.body.email, request.body.password, cfg, ip, ua);

    if (result.requiresVerification) {
      return reply.status(201).send({
        customer_id: result.customerId,
        requires_verification: true,
        message: "Check your email to verify your account.",
      });
    }

    // Auto-login if no verification required
    const session = await import("./service.js").then(m =>
      m.issueSession(pool, result.customerId, storeId, cfg, ip, ua)
    );
    return reply.status(201).send({
      customer_id: result.customerId,
      requires_verification: false,
      session_token: session.sessionToken,
      access_token: session.accessToken,
    });
  });

  // ── Login ──────────────────────────────────────────────────────────────────

  app.post(`${base}/auth/login`, {
    schema: { params: StoreIdParams, body: LoginBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    const ip = getIp(request);
    const ua = getUserAgent(request);

    const session = await loginWithPassword(pool, storeId, request.body.email, request.body.password, cfg, ip, ua);
    return reply.send({
      session_token: session.sessionToken,
      access_token: session.accessToken,
    });
  });

  // ── Token refresh ──────────────────────────────────────────────────────────

  app.post(`${base}/auth/token`, {
    schema: { params: StoreIdParams, body: TokenBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    const ip = getIp(request);
    const ua = getUserAgent(request);

    const result = await rotateSession(pool, request.body.refresh_token, storeId, cfg, ip, ua);
    return reply.send({
      session_token: result.newSessionToken,
      access_token: result.accessToken,
    });
  });

  // ── Logout ─────────────────────────────────────────────────────────────────

  const LogoutBody = z.object({ refresh_token: z.string().optional() });

  app.post(`${base}/auth/logout`, {
    schema: { params: StoreIdParams, body: LogoutBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();

    if (request.body.refresh_token) {
      const { hashToken } = await import("./service.js");
      const hash = hashToken(request.body.refresh_token);
      await pool.query(
        `UPDATE customer_sessions
         SET revoked_at = now(), is_revoked = true
         WHERE refresh_token_hash = $1 AND store_id = $2::uuid`,
        [hash, storeId]
      );
    }
    return reply.send({ ok: true });
  });

  // ── Verify email ───────────────────────────────────────────────────────────

  app.post(`${base}/auth/verify-email`, {
    schema: { params: StoreIdParams, body: VerifyEmailBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const customerId = await verifyEmail(pool, storeId, request.body.token);
    if (!customerId) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "invalid or expired verification token" } });
    }
    return reply.send({ ok: true });
  });

  const ResendVerifyBody = z.object({ email: z.string().email() });

  app.post(`${base}/auth/verify-email/resend`, {
    schema: { params: StoreIdParams, body: ResendVerifyBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);

    const { rows } = await pool.query<{ id: string; email_verified: boolean }>(
      `SELECT id::text, email_verified FROM customers WHERE store_id = $1::uuid AND email = $2`,
      [storeId, request.body.email.toLowerCase().trim()]
    );
    const customer = rows[0];
    if (customer && !customer.email_verified) {
      await sendEmailVerification(pool, storeId, customer.id, request.body.email, cfg);
    }
    return reply.send({ ok: true });
  });

  // ── Password reset ─────────────────────────────────────────────────────────

  app.post(`${base}/auth/password-reset/request`, {
    schema: { params: StoreIdParams, body: PasswordResetRequestBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    await requestPasswordReset(pool, storeId, request.body.email, cfg, getIp(request), getUserAgent(request));
    return reply.send({ ok: true });
  });

  app.post(`${base}/auth/password-reset/complete`, {
    schema: { params: StoreIdParams, body: PasswordResetCompleteBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const ok = await completePasswordReset(pool, storeId, request.body.token, request.body.password);
    if (!ok) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "invalid or expired reset token" } });
    }
    return reply.send({ ok: true });
  });

  // ── Magic link ─────────────────────────────────────────────────────────────

  app.post(`${base}/auth/magic-link`, {
    schema: { params: StoreIdParams, body: MagicLinkBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    await sendMagicLink(pool, storeId, request.body.email, cfg, getIp(request), getUserAgent(request));
    return reply.send({ ok: true });
  });

  app.post(`${base}/auth/magic-link/verify`, {
    schema: { params: StoreIdParams, body: MagicLinkVerifyBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    const session = await verifyMagicLink(pool, storeId, request.body.token, cfg, getIp(request), getUserAgent(request));
    return reply.send({ session_token: session.sessionToken, access_token: session.accessToken });
  });

  // ── Invite accept ──────────────────────────────────────────────────────────

  app.post(`${base}/auth/invite/accept`, {
    schema: { params: StoreIdParams, body: InviteAcceptBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";
    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    const session = await acceptInvitation(
      pool, storeId, request.body.token, request.body.password, cfg, getIp(request), getUserAgent(request)
    );
    return reply.send({ session_token: session.sessionToken, access_token: session.accessToken });
  });

  // ── OAuth URL generators ────────────────────────────────────────────────────

  for (const provider of ["google", "microsoft", "discord"] as const) {
    app.get(`${base}/auth/${provider}/url`, {
      schema: { params: StoreIdParams, querystring: OAuthUrlQuery },
    }, async (request, reply) => {
      const { storeId } = request.params;
      const q = request.query;
      const pool = getPool();
      const secretsKey = config.AUTH_SECRETS_KEY ?? "";
      const cfg = await loadStoreConfig(pool, storeId, secretsKey);

      const nonce = randomBytes(16).toString("hex");
      // P1-6: persist redirect_uri in state so callbacks can use it in token exchanges.
      const redirectUri = q.redirect_uri ?? `${cfg.redirectUrl || "http://localhost:3000"}/auth/${provider}/callback`;
      saveOAuthState(storeId, provider, nonce, redirectUri);

      let authUrl: string;
      const state = nonce;

      if (provider === "google") {
        authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(cfg.googleClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+email+profile&state=${state}`;
      } else if (provider === "microsoft") {
        authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${encodeURIComponent(cfg.msClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+email+profile&state=${state}`;
      } else {
        authUrl = `https://discord.com/api/oauth2/authorize?client_id=${encodeURIComponent(cfg.discordClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify+email&state=${state}`;
      }

      return reply.send({ url: authUrl, state });
    });
  }

  // ── OAuth callbacks ────────────────────────────────────────────────────────

  // For Google
  app.post(`${base}/auth/google/callback`, {
    schema: { params: StoreIdParams, body: OAuthCallbackBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";

    // P1-6: loadOAuthState now returns the persisted redirect_uri (or null on failure).
    const redirectUri = loadOAuthState(request.body.state, storeId, "google");
    if (redirectUri === null) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "invalid OAuth state" } });
    }

    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    if (!cfg.googleEnabled) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "Google auth is disabled" } });
    }

    // Exchange code for token — include redirect_uri per OAuth2 spec (P1-6).
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: request.body.code,
        client_id: cfg.googleClientId,
        client_secret: cfg.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "Google token exchange failed" } });
    }
    const tokenData = await tokenRes.json() as Record<string, unknown>;

    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData["access_token"]}` },
    });
    if (!userRes.ok) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "failed to fetch Google user info" } });
    }
    const userInfo = await userRes.json() as Record<string, unknown>;

    const googleInfo: { providerId: string; email: string; name?: string | undefined; avatarUrl?: string | undefined } = {
      providerId: String(userInfo["sub"]),
      email: String(userInfo["email"]),
    };
    if (userInfo["name"]) googleInfo.name = String(userInfo["name"]);
    if (userInfo["picture"]) googleInfo.avatarUrl = String(userInfo["picture"]);
    const result = await oauthUpsertAndLogin(pool, storeId, "google_id", googleInfo, cfg, getIp(request), getUserAgent(request));

    return reply.send({
      session_token: result.sessionToken,
      access_token: result.accessToken,
      customer_id: result.customerId,
    });
  });

  // For Microsoft
  app.post(`${base}/auth/microsoft/callback`, {
    schema: { params: StoreIdParams, body: OAuthCallbackBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";

    // P1-6: capture persisted redirect_uri from state.
    const redirectUri = loadOAuthState(request.body.state, storeId, "microsoft");
    if (redirectUri === null) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "invalid OAuth state" } });
    }

    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    if (!cfg.microsoftEnabled) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "Microsoft auth is disabled" } });
    }

    // Include redirect_uri per OAuth2 spec (P1-6).
    const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: request.body.code,
        client_id: cfg.msClientId,
        client_secret: cfg.msClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "openid email profile",
      }).toString(),
    });
    if (!tokenRes.ok) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "Microsoft token exchange failed" } });
    }
    const tokenData = await tokenRes.json() as Record<string, unknown>;

    const userRes = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokenData["access_token"]}` },
    });
    if (!userRes.ok) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "failed to fetch Microsoft user info" } });
    }
    const userInfo = await userRes.json() as Record<string, string>;

    const email = userInfo["mail"] ?? userInfo["userPrincipalName"] ?? "";

    const msInfo: { providerId: string; email: string; name?: string | undefined } = {
      providerId: userInfo["id"] ?? "",
      email,
    };
    if (userInfo["displayName"]) msInfo.name = userInfo["displayName"];
    const result = await oauthUpsertAndLogin(pool, storeId, "microsoft_id", msInfo, cfg, getIp(request), getUserAgent(request));
    return reply.send({ session_token: result.sessionToken, access_token: result.accessToken, customer_id: result.customerId });
  });

  // For Discord
  app.post(`${base}/auth/discord/callback`, {
    schema: { params: StoreIdParams, body: OAuthCallbackBody },
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const secretsKey = config.AUTH_SECRETS_KEY ?? "";

    // P1-6: capture persisted redirect_uri from state.
    const redirectUri = loadOAuthState(request.body.state, storeId, "discord");
    if (redirectUri === null) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "invalid OAuth state" } });
    }

    const cfg = await loadStoreConfig(pool, storeId, secretsKey);
    if (!cfg.discordEnabled) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "Discord auth is disabled" } });
    }

    // Include redirect_uri per OAuth2 spec (P1-6).
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: request.body.code,
        client_id: cfg.discordClientId,
        client_secret: cfg.discordClientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!tokenRes.ok) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "Discord token exchange failed" } });
    }
    const tokenData = await tokenRes.json() as Record<string, unknown>;

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData["access_token"]}` },
    });
    if (!userRes.ok) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "failed to fetch Discord user info" } });
    }
    const userInfo = await userRes.json() as Record<string, string>;

    const discordInfo: { providerId: string; email: string; name?: string | undefined } = {
      providerId: userInfo["id"] ?? "",
      email: userInfo["email"] ?? "",
    };
    if (userInfo["username"]) discordInfo.name = userInfo["username"];
    const result = await oauthUpsertAndLogin(pool, storeId, "discord_id", discordInfo, cfg, getIp(request), getUserAgent(request));
    return reply.send({ session_token: result.sessionToken, access_token: result.accessToken, customer_id: result.customerId });
  });

  // ── Bearer-auth customer routes ────────────────────────────────────────────

  app.get(`${base}/auth/me`, {
    schema: { params: StoreIdParams },
    preHandler: [caBearerAuth],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const customerId = request.customer!.sub;

    const { rows } = await pool.query(
      `SELECT id::text, store_id::text, email, first_name, last_name, display_name,
              avatar_url, phone, coalesce(is_admin, false) as is_admin,
              coalesce(email_verified, false) as email_verified,
              coalesce(tags, '{}') as tags, metadata, created_at, updated_at
       FROM customers WHERE id = $1::uuid AND store_id = $2::uuid`,
      [customerId, storeId]
    );
    const customer = rows[0];
    if (!customer) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "customer not found" } });
    }
    return reply.send({ customer });
  });

  app.put(`${base}/auth/me`, {
    schema: { params: StoreIdParams, body: UpdateMeBody },
    preHandler: [caBearerAuth],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const customerId = request.customer!.sub;

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [customerId, storeId];

    if (request.body.first_name !== undefined) { params.push(request.body.first_name || null); sets.push(`first_name = $${params.length}`); }
    if (request.body.last_name !== undefined) { params.push(request.body.last_name || null); sets.push(`last_name = $${params.length}`); }
    if (request.body.display_name !== undefined) { params.push(request.body.display_name || null); sets.push(`display_name = $${params.length}`); }
    if (request.body.phone !== undefined) { params.push(request.body.phone || null); sets.push(`phone = $${params.length}`); }

    await pool.query(
      `UPDATE customers SET ${sets.join(", ")} WHERE id = $1::uuid AND store_id = $2::uuid`,
      params
    );
    return reply.send({ ok: true });
  });

  app.put(`${base}/auth/me/password`, {
    schema: { params: StoreIdParams, body: ChangePasswordBody },
    preHandler: [caBearerAuth],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const customerId = request.customer!.sub;

    const { rows } = await pool.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM customers WHERE id = $1::uuid AND store_id = $2::uuid`,
      [customerId, storeId]
    );
    const stored = rows[0]?.password_hash;
    if (!stored) {
      return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "no password set on this account" } });
    }

    if (!await verifyAndMaybeRehash(pool, customerId, request.body.current_password, stored)) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "current password is incorrect" } });
    }

    const newHash = hashPasswordSync(request.body.new_password);
    await pool.query(
      `UPDATE customers SET password_hash = $2, updated_at = now() WHERE id = $1::uuid`,
      [customerId, newHash]
    );
    // Invalidate all OTHER sessions (keep current one valid for UX)
    await invalidateCustomerTokens(pool, customerId);
    return reply.send({ ok: true });
  });

  app.get(`${base}/auth/sessions`, {
    schema: { params: StoreIdParams },
    preHandler: [caBearerAuth],
  }, async (request, reply) => {
    const { storeId } = request.params;
    const pool = getPool();
    const customerId = request.customer!.sub;

    const { rows } = await pool.query(
      `SELECT id::text, ip_address::text, user_agent, created_at, last_used_at, expires_at,
              coalesce(is_revoked, revoked_at is not null) as is_revoked
       FROM customer_sessions
       WHERE customer_id = $1::uuid AND store_id = $2::uuid
         AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC`,
      [customerId, storeId]
    );
    return reply.send({ sessions: rows });
  });

  app.delete(`${base}/auth/sessions/:sessionId`, {
    schema: { params: SessionIdParams },
    preHandler: [caBearerAuth],
  }, async (request, reply) => {
    const { storeId, sessionId } = request.params;
    const pool = getPool();
    const customerId = request.customer!.sub;

    const res = await pool.query(
      `UPDATE customer_sessions
       SET revoked_at = now(), is_revoked = true
       WHERE id = $1::uuid AND customer_id = $2::uuid AND store_id = $3::uuid`,
      [sessionId, customerId, storeId]
    );
    if ((res.rowCount ?? 0) === 0) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "session not found" } });
    }
    return reply.send({ ok: true });
  });

  // ── Dev mock OAuth (non-production only) ──────────────────────────────────

  if (config.APP_ENV !== "production") {
    app.post(`${base}/auth/mock-oauth`, {
      schema: { params: StoreIdParams, body: MockOAuthBody },
    }, async (request, reply) => {
      const { storeId } = request.params;
      const pool = getPool();
      const secretsKey = config.AUTH_SECRETS_KEY ?? "";
      const cfg = await loadStoreConfig(pool, storeId, secretsKey);

      const providerCol =
        request.body.provider === "google" ? "google_id" as const
          : request.body.provider === "microsoft" ? "microsoft_id" as const
          : "discord_id" as const;

      const providerId = `mock-${request.body.provider}-${request.body.email.replace(/[^a-z0-9]/gi, "-")}`;

      const mockInfo: { providerId: string; email: string; name?: string | undefined } = {
        providerId,
        email: request.body.email,
      };
      if (request.body.name) mockInfo.name = request.body.name;
      const result = await oauthUpsertAndLogin(pool, storeId, providerCol, mockInfo, cfg, getIp(request), getUserAgent(request));
      return reply.send({
        session_token: result.sessionToken,
        access_token: result.accessToken,
        customer_id: result.customerId,
      });
    });
  }
};

// Import randomBytes for oauth url generation
import { randomBytes } from "node:crypto";
