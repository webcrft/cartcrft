/**
 * modules/superadmin/routes.ts — Fastify plugin for the hardened SUPER-ADMIN
 * portal (mounted under /superadmin).
 *
 * Auth surface:
 *   POST /superadmin/auth/login    — public (email+password[+totp]) → super JWT
 *   POST /superadmin/auth/logout   — requireSuperAdmin (revoke session)
 *   POST /superadmin/auth/refresh  — requireSuperAdmin (rotate session)
 *   GET  /superadmin/me            — requireSuperAdmin
 *
 * Everything below requireSuperAdmin runs as the OWNER role (BYPASSRLS) so it
 * reads across ALL tenants. Every access is written to super_admin_audit_log.
 *
 *   GET  /superadmin/orgs                     — list/search all orgs
 *   GET  /superadmin/orgs/:orgId              — org detail (+ billing)
 *   GET  /superadmin/stores                   — list/search all stores
 *   GET  /superadmin/stores/:storeId          — store detail
 *   GET  /superadmin/customers                — search customers by email
 *   GET  /superadmin/analytics/overview       — platform totals
 *   GET  /superadmin/analytics/timeseries     — orders/GMV/signups over time
 *   GET  /superadmin/analytics/health         — DB/pool/migration health
 *   POST /superadmin/stores/:storeId/takedown — takedown (reason + audit)
 *   POST /superadmin/stores/:storeId/restore  — restore
 *   POST /superadmin/stores/:storeId/suspend  — suspend
 *   GET  /superadmin/audit-log                — operator's own audit trail
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  loginSuperAdmin,
  requireSuperAdmin,
  revokeSession,
  refreshSession,
  auditRequest,
  getClientIp,
} from "../../lib/superadmin-auth.js";
import * as svc from "./service.js";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

const ListQuery = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const StoresQuery = ListQuery.extend({
  org_id: z.string().uuid().optional(),
  active: z.enum(["true", "false"]).optional(),
});

const CustomersQuery = ListQuery.extend({
  store_id: z.string().uuid().optional(),
});

const TimeseriesQuery = z.object({
  days: z.coerce.number().int().positive().max(365).optional(),
  interval: z.enum(["day", "week", "month"]).optional(),
});

const ReasonBody = z.object({
  reason: z.string().min(1).max(2000),
});

const AuditQuery = z.object({
  action: z.string().optional(),
  super_admin_id: z.string().uuid().optional(),
  mine: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function loginErrorStatus(code: string): number {
  switch (code) {
    case "IP_BLOCKED":
      return 403;
    case "LOCKED":
      return 423; // Locked
    case "MFA_REQUIRED":
      return 401;
    default:
      return 401;
  }
}

export const superadminPlugin: FastifyPluginAsync = async (app) => {
  // ── Public: login ──────────────────────────────────────────────────────────
  app.post(
    "/superadmin/auth/login",
    { schema: { body: LoginBody } },
    async (request, reply) => {
      const body = request.body as z.infer<typeof LoginBody>;
      const ip = getClientIp(request);
      const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "";

      const result = await loginSuperAdmin({
        email: body.email,
        password: body.password,
        totp: body.totp,
        ip,
        userAgent,
      });

      if (!result.ok) {
        return reply
          .status(loginErrorStatus(result.code))
          .send({ error: { code: result.code, message: result.message } });
      }

      return reply.status(200).send({
        token: result.token,
        expires_at: result.expiresAt.toISOString(),
        super_admin: result.superAdmin,
      });
    }
  );

  // ── Protected surface ───────────────────────────────────────────────────────
  // All routes registered in this encapsulated child context run requireSuperAdmin.
  await app.register(async (secure) => {
    secure.addHook("preHandler", requireSuperAdmin);

    // GET /superadmin/me
    secure.get("/superadmin/me", async (request, reply) => {
      const ctx = request.superAdmin!;
      await auditRequest(request, "me.read");
      return reply.send({ id: ctx.superAdminId, email: ctx.email, session_id: ctx.sessionId });
    });

    // POST /superadmin/auth/logout
    secure.post("/superadmin/auth/logout", async (request, reply) => {
      const ctx = request.superAdmin!;
      await revokeSession(ctx.sessionId);
      await auditRequest(request, "logout", { targetType: "session", targetId: ctx.sessionId });
      return reply.send({ ok: true });
    });

    // POST /superadmin/auth/refresh
    secure.post("/superadmin/auth/refresh", async (request, reply) => {
      const ctx = request.superAdmin!;
      const refreshed = await refreshSession({
        superAdminId: ctx.superAdminId,
        sessionId: ctx.sessionId,
        email: ctx.email,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      if (!refreshed) {
        return reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "session not refreshable" } });
      }
      await auditRequest(request, "session.refresh");
      return reply.send({ token: refreshed.token, expires_at: refreshed.expiresAt.toISOString() });
    });

    // ── Tenants ───────────────────────────────────────────────────────────────
    secure.get("/superadmin/orgs", { schema: { querystring: ListQuery } }, async (request, reply) => {
      const q = request.query as z.infer<typeof ListQuery>;
      const data = await svc.listOrgs({ search: q.search, limit: q.limit, offset: q.offset });
      await auditRequest(request, "orgs.list", { data: { search: q.search ?? null, count: data.items.length } });
      return reply.send(data);
    });

    secure.get("/superadmin/orgs/:orgId", { schema: { params: z.object({ orgId: z.string().uuid() }) } }, async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const detail = await svc.getOrgDetail(orgId);
      await auditRequest(request, "org.read", { targetType: "org", targetId: orgId });
      if (!detail) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "org not found" } });
      return reply.send(detail);
    });

    secure.get("/superadmin/stores", { schema: { querystring: StoresQuery } }, async (request, reply) => {
      const q = request.query as z.infer<typeof StoresQuery>;
      const data = await svc.listStores({
        search: q.search,
        orgId: q.org_id,
        active: q.active === undefined ? undefined : q.active === "true",
        limit: q.limit,
        offset: q.offset,
      });
      await auditRequest(request, "stores.list", { data: { search: q.search ?? null, count: data.items.length } });
      return reply.send(data);
    });

    secure.get("/superadmin/stores/:storeId", { schema: { params: z.object({ storeId: z.string().uuid() }) } }, async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const detail = await svc.getStoreDetail(storeId);
      await auditRequest(request, "store.read", { targetType: "store", targetId: storeId });
      if (!detail) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "store not found" } });
      return reply.send(detail);
    });

    secure.get("/superadmin/customers", { schema: { querystring: CustomersQuery } }, async (request, reply) => {
      const q = request.query as z.infer<typeof CustomersQuery>;
      const data = await svc.listCustomers({ search: q.search, storeId: q.store_id, limit: q.limit, offset: q.offset });
      await auditRequest(request, "customers.list", { data: { search: q.search ?? null, count: data.items.length } });
      return reply.send(data);
    });

    // ── System analytics ────────────────────────────────────────────────────
    secure.get("/superadmin/analytics/overview", async (request, reply) => {
      const data = await svc.analyticsOverview();
      await auditRequest(request, "analytics.overview");
      return reply.send(data);
    });

    secure.get("/superadmin/analytics/timeseries", { schema: { querystring: TimeseriesQuery } }, async (request, reply) => {
      const q = request.query as z.infer<typeof TimeseriesQuery>;
      const data = await svc.analyticsTimeseries({ days: q.days, interval: q.interval });
      await auditRequest(request, "analytics.timeseries", { data: { days: q.days ?? 30, interval: q.interval ?? "day" } });
      return reply.send({ points: data });
    });

    secure.get("/superadmin/analytics/health", async (request, reply) => {
      const data = await svc.systemHealth();
      await auditRequest(request, "analytics.health");
      return reply.send(data);
    });

    // ── Tenant management ─────────────────────────────────────────────────────
    secure.post("/superadmin/stores/:storeId/takedown", { schema: { params: z.object({ storeId: z.string().uuid() }), body: ReasonBody } }, async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const { reason } = request.body as z.infer<typeof ReasonBody>;
      const ok = await svc.takedownStore(storeId, reason);
      await auditRequest(request, "store.takedown", { targetType: "store", targetId: storeId, data: { reason, applied: ok } });
      if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "store not found" } });
      return reply.send({ ok: true });
    });

    secure.post("/superadmin/stores/:storeId/restore", { schema: { params: z.object({ storeId: z.string().uuid() }) } }, async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const ok = await svc.restoreStore(storeId);
      await auditRequest(request, "store.restore", { targetType: "store", targetId: storeId, data: { applied: ok } });
      if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "store not found" } });
      return reply.send({ ok: true });
    });

    secure.post("/superadmin/stores/:storeId/suspend", { schema: { params: z.object({ storeId: z.string().uuid() }), body: ReasonBody } }, async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const { reason } = request.body as z.infer<typeof ReasonBody>;
      const ok = await svc.suspendStore(storeId, reason);
      await auditRequest(request, "store.suspend", { targetType: "store", targetId: storeId, data: { reason, applied: ok } });
      if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "store not found" } });
      return reply.send({ ok: true });
    });

    // ── Audit log (operator's own trail) ──────────────────────────────────────
    secure.get("/superadmin/audit-log", { schema: { querystring: AuditQuery } }, async (request, reply) => {
      const q = request.query as z.infer<typeof AuditQuery>;
      const superAdminId = q.mine === "true" ? request.superAdmin!.superAdminId : q.super_admin_id;
      const data = await svc.listAuditLog({ superAdminId, action: q.action, limit: q.limit, offset: q.offset });
      return reply.send(data);
    });
  });
};
