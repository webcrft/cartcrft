/**
 * modules/account/routes.ts — Fastify plugin for the platform-account auth
 * surface (P3 / audit item 1), mounted under /account.
 *
 * Public:
 *   POST /account/register  — create org + owner; returns access JWT + sets refresh cookie
 *   POST /account/login     — argon2 verify (+lockout); access JWT + refresh cookie
 *   POST /account/refresh   — reads the httpOnly refresh cookie, rotates the session
 *   POST /account/logout    — revokes the session + clears the cookie
 *
 * Authenticated (org access JWT via requireJwt — same token the /commerce
 * routes accept):
 *   GET    /account/me
 *   GET    /account/users           — list team
 *   POST   /account/users/invite    — owner/admin only
 *   DELETE /account/users/:id       — owner/admin only
 *
 * Cookie handling is done with the standard Set-Cookie/Cookie headers (no extra
 * dependency): the opaque refresh token is delivered ONLY as an httpOnly,
 * Secure, SameSite=Lax cookie scoped to /account, so XSS in the dashboard
 * cannot read it and it is never exposed to JS.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireJwt } from "../../lib/auth/middleware.js";
import {
  register,
  login,
  refresh,
  revokeByToken,
  getUser,
  listUsers,
  inviteUser,
  removeUser,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  type IssuedSession,
  type PlatformRole,
} from "./service.js";
import { config } from "../../config/config.js";

// ── Schemas ──────────────────────────────────────────────────────────────────

const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  org_id: z.string().uuid().optional(),
});

const InviteBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "member"]).optional(),
});

// ── Cookie helpers (no @fastify/cookie dependency) ───────────────────────────

function getClientIp(request: FastifyRequest): string {
  const xff = request.headers["x-forwarded-for"];
  if (typeof xff === "string") return xff.split(",")[0]?.trim() ?? request.ip;
  return request.ip;
}

function getUserAgent(request: FastifyRequest): string {
  const ua = request.headers["user-agent"];
  return typeof ua === "string" ? ua : "";
}

/** Parse a single cookie value out of the request Cookie header. */
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

/** In production we require Secure cookies; in dev/test we drop Secure so http localhost works. */
function isProd(): boolean {
  return config.APP_ENV === "production";
}

/** Build the Set-Cookie header value for the refresh token. */
function refreshCookie(token: string, maxAgeMs: number): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isProd()) parts.push("Secure");
  return parts.join("; ");
}

/** Build the Set-Cookie header value that clears the refresh cookie. */
function clearRefreshCookie(): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=`,
    `Path=${REFRESH_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isProd()) parts.push("Secure");
  return parts.join("; ");
}

/** Send the standard success envelope for an issued session + set the refresh cookie. */
async function sendSession(
  reply: FastifyReply,
  status: number,
  session: IssuedSession,
  user: { id: string; org_id: string; email: string; role: PlatformRole }
): Promise<void> {
  void reply.header(
    "set-cookie",
    refreshCookie(session.refreshToken, session.refreshExpiresAt.getTime() - Date.now())
  );
  await reply.status(status).send({
    access_token: session.accessToken,
    token_type: "Bearer",
    expires_at: session.accessExpiresAt.toISOString(),
    user: { id: user.id, org_id: user.org_id, email: user.email, role: user.role },
  });
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const accountPlugin: FastifyPluginAsync = async (app) => {
  // ── Register ────────────────────────────────────────────────────────────────
  app.post("/account/register", { schema: { body: RegisterBody } }, async (request, reply) => {
    const body = request.body as z.infer<typeof RegisterBody>;
    const result = await register({
      email: body.email,
      password: body.password,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
    });
    if (!result.ok) {
      return reply.status(409).send({ error: { code: result.code, message: result.message } });
    }
    return sendSession(reply, 201, result.session, result.user);
  });

  // ── Login ───────────────────────────────────────────────────────────────────
  app.post("/account/login", { schema: { body: LoginBody } }, async (request, reply) => {
    const body = request.body as z.infer<typeof LoginBody>;
    const result = await login({
      email: body.email,
      password: body.password,
      orgId: body.org_id,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
    });
    if (!result.ok) {
      const status = result.code === "LOCKED" ? 423 : result.code === "INACTIVE" ? 403 : 401;
      return reply.status(status).send({ error: { code: result.code, message: result.message } });
    }
    return sendSession(reply, 200, result.session, result.user);
  });

  // ── Refresh (reads the httpOnly cookie, rotates) ────────────────────────────
  app.post("/account/refresh", async (request, reply) => {
    const token = readCookie(request, REFRESH_COOKIE_NAME);
    if (!token) {
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "missing refresh cookie" } });
    }
    const result = await refresh({
      refreshToken: token,
      ip: getClientIp(request),
      userAgent: getUserAgent(request),
    });
    if (!result.ok) {
      // Clear the stale cookie so the browser stops sending it.
      void reply.header("set-cookie", clearRefreshCookie());
      return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: result.message } });
    }
    return sendSession(reply, 200, result.session, result.user);
  });

  // ── Logout (revoke + clear cookie) ──────────────────────────────────────────
  app.post("/account/logout", async (request, reply) => {
    const token = readCookie(request, REFRESH_COOKIE_NAME);
    if (token) await revokeByToken(token);
    void reply.header("set-cookie", clearRefreshCookie());
    return reply.status(200).send({ ok: true });
  });

  // ── Authenticated surface (org access JWT, same as /commerce) ───────────────
  await app.register(async (secure) => {
    secure.addHook("preHandler", requireJwt);

    // GET /account/me
    secure.get("/account/me", async (request, reply) => {
      const userId = request.auth!.userId!;
      const user = await getUser(userId);
      if (!user) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "account not found" } });
      return reply.send({ user });
    });

    // GET /account/users
    secure.get("/account/users", async (request, reply) => {
      const orgId = request.auth!.orgId;
      const users = await listUsers(orgId);
      return reply.send({ users });
    });

    // POST /account/users/invite — owner/admin only
    secure.post("/account/users/invite", { schema: { body: InviteBody } }, async (request, reply) => {
      const orgId = request.auth!.orgId;
      const actingUserId = request.auth!.userId!;
      const acting = await getUser(actingUserId);
      if (!acting || (acting.role !== "owner" && acting.role !== "admin")) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "only owners and admins may invite members" } });
      }
      const body = request.body as z.infer<typeof InviteBody>;
      const result = await inviteUser({
        orgId,
        email: body.email,
        password: body.password,
        role: body.role ?? "member",
      });
      if (!result.ok) {
        return reply.status(409).send({ error: { code: result.code, message: result.message } });
      }
      return reply.status(201).send({ user: result.user });
    });

    // DELETE /account/users/:id — owner/admin only
    secure.delete(
      "/account/users/:id",
      { schema: { params: z.object({ id: z.string().uuid() }) } },
      async (request, reply) => {
        const orgId = request.auth!.orgId;
        const actingUserId = request.auth!.userId!;
        const acting = await getUser(actingUserId);
        if (!acting || (acting.role !== "owner" && acting.role !== "admin")) {
          return reply.status(403).send({ error: { code: "FORBIDDEN", message: "only owners and admins may remove members" } });
        }
        const { id } = request.params as { id: string };
        const result = await removeUser({ orgId, targetUserId: id, actingUserId });
        if (!result.ok) {
          const status = result.code === "NOT_FOUND" ? 404 : 409;
          return reply.status(status).send({ error: { code: result.code, message: result.message } });
        }
        return reply.send({ ok: true });
      }
    );
  });
};
