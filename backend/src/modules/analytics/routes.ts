/**
 * analytics/routes.ts — Ecommerce analytics endpoints.
 *
 * Routes (all JWT-protected, org-scoped):
 *   GET /analytics/ecommerce/overview   — total_orders, total_revenue, avg_order_value, refund_rate
 *   GET /analytics/ecommerce/products   — top products by views/cart/purchases + conversion %
 *   GET /analytics/ecommerce/funnel     — per-stage counts + drop-off %
 *   GET /analytics/ecommerce/revenue    — daily revenue chart
 *
 * Query params: ?store_id=<uuid>&start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * All queries read from analytics_events (event_type='ecommerce').
 * Uses AnalyticsSink's underlying pool — same DB for now (single pg pool).
 * If analytics_events table is absent, endpoints return empty results gracefully.
 *
 * Ported from analytics_ecommerce.go (adapted for store_id instead of site_id
 * — Cartcrft has no sites table).
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireJwt } from "../../lib/auth/middleware.js";
import { getPool } from "../../db/pool.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDateRange(start?: string, end?: string): { start: Date; end: Date } {
  const now = new Date();
  let endDate = new Date(now);
  let startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 30);

  if (start) {
    const parsed = new Date(start + "T00:00:00Z");
    if (!isNaN(parsed.getTime())) startDate = parsed;
  }
  if (end) {
    const parsed = new Date(end + "T23:59:59Z");
    if (!isNaN(parsed.getTime())) endDate = parsed;
  }

  // Cap at 365 days
  const MS_365_DAYS = 365 * 24 * 60 * 60 * 1000;
  if (endDate.getTime() - startDate.getTime() > MS_365_DAYS) {
    startDate = new Date(endDate.getTime() - MS_365_DAYS);
  }
  return { start: startDate, end: endDate };
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const AnalyticsQuerystring = z.object({
  store_id: z.string().uuid("store_id must be a UUID"),
  start: z.string().optional(),
  end: z.string().optional(),
});

// ── Plugin ─────────────────────────────────────────────────────────────────────

export const analyticsPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── GET /analytics/ecommerce/overview ─────────────────────────────────────
  app.get(
    "/analytics/ecommerce/overview",
    { preHandler: [requireJwt], schema: { querystring: AnalyticsQuerystring } },
    async (request, reply) => {
      const { store_id, start, end } = request.query;
      const { start: startDate, end: endDate } = parseDateRange(start, end);

      // Verify the store belongs to the JWT's org
      const { orgId } = request.auth!;
      const pool = getPool();
      const storeCheck = await pool.query<{ ok: boolean }>(
        `SELECT (organization_id = $2::uuid) AS ok FROM stores WHERE id = $1::uuid`,
        [store_id, orgId]
      );
      if (!storeCheck.rows[0]?.ok) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "forbidden" } });
      }

      try {
        const res = await pool.query<{
          total_orders: string;
          total_refunds: string;
          total_revenue_cents: string;
        }>(
          `SELECT
             count(*) FILTER (WHERE event_name = 'order_completed') AS total_orders,
             count(*) FILTER (WHERE event_name = 'order_refunded')  AS total_refunds,
             COALESCE(sum(
               CASE WHEN event_name = 'order_completed'
               THEN ((properties->>'total')::numeric * 100)::bigint
               ELSE 0 END
             ), 0) AS total_revenue_cents
           FROM analytics_events
           WHERE site_id = $1::uuid
             AND event_type = 'ecommerce'
             AND timestamp BETWEEN $2 AND $3`,
          [store_id, startDate.toISOString(), endDate.toISOString()]
        );

        const row = res.rows[0];
        const totalOrders = parseInt(row?.total_orders ?? "0", 10);
        const totalRefunds = parseInt(row?.total_refunds ?? "0", 10);
        const totalRevenueCents = parseInt(row?.total_revenue_cents ?? "0", 10);
        const avgOrderValueCents = totalOrders > 0 ? Math.floor(totalRevenueCents / totalOrders) : 0;
        const refundRate = totalOrders > 0 ? (totalRefunds / totalOrders) * 100 : 0;

        return reply.send({
          total_orders: totalOrders,
          total_revenue_cents: totalRevenueCents,
          avg_order_value_cents: avgOrderValueCents,
          refund_rate: refundRate,
          total_refunds: totalRefunds,
        });
      } catch (err) {
        // analytics_events table may not exist yet — return empty
        console.warn("analytics overview query failed:", err instanceof Error ? err.message : String(err));
        return reply.send({
          total_orders: 0,
          total_revenue_cents: 0,
          avg_order_value_cents: 0,
          refund_rate: 0,
          total_refunds: 0,
        });
      }
    }
  );

  // ── GET /analytics/ecommerce/products ────────────────────────────────────
  app.get(
    "/analytics/ecommerce/products",
    { preHandler: [requireJwt], schema: { querystring: AnalyticsQuerystring } },
    async (request, reply) => {
      const { store_id, start, end } = request.query;
      const { start: startDate, end: endDate } = parseDateRange(start, end);

      const { orgId } = request.auth!;
      const pool = getPool();
      const storeCheck = await pool.query<{ ok: boolean }>(
        `SELECT (organization_id = $2::uuid) AS ok FROM stores WHERE id = $1::uuid`,
        [store_id, orgId]
      );
      if (!storeCheck.rows[0]?.ok) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "forbidden" } });
      }

      try {
        const res = await pool.query<{
          product_id: string | null;
          product_name: string | null;
          views: string;
          add_to_cart: string;
          purchases: string;
        }>(
          `SELECT
             properties->>'product_id'   AS product_id,
             properties->>'product_name' AS product_name,
             count(*) FILTER (WHERE event_name = 'product_viewed')  AS views,
             count(*) FILTER (WHERE event_name = 'add_to_cart')     AS add_to_cart,
             count(*) FILTER (WHERE event_name = 'order_completed') AS purchases
           FROM analytics_events
           WHERE site_id = $1::uuid
             AND event_type = 'ecommerce'
             AND event_name IN ('product_viewed','add_to_cart','order_completed')
             AND timestamp BETWEEN $2 AND $3
           GROUP BY 1, 2
           ORDER BY views DESC
           LIMIT 50`,
          [store_id, startDate.toISOString(), endDate.toISOString()]
        );

        const products = res.rows.map((r) => {
          const views = parseInt(r.views, 10);
          const purchases = parseInt(r.purchases, 10);
          const conversionPct = views > 0 ? (purchases / views) * 100 : 0;
          return {
            product_id: r.product_id,
            product_name: r.product_name,
            views,
            add_to_cart: parseInt(r.add_to_cart, 10),
            purchases,
            conversion_pct: conversionPct,
          };
        });

        return reply.send({ products });
      } catch {
        return reply.send({ products: [] });
      }
    }
  );

  // ── GET /analytics/ecommerce/funnel ───────────────────────────────────────
  app.get(
    "/analytics/ecommerce/funnel",
    { preHandler: [requireJwt], schema: { querystring: AnalyticsQuerystring } },
    async (request, reply) => {
      const { store_id, start, end } = request.query;
      const { start: startDate, end: endDate } = parseDateRange(start, end);

      const { orgId } = request.auth!;
      const pool = getPool();
      const storeCheck = await pool.query<{ ok: boolean }>(
        `SELECT (organization_id = $2::uuid) AS ok FROM stores WHERE id = $1::uuid`,
        [store_id, orgId]
      );
      if (!storeCheck.rows[0]?.ok) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "forbidden" } });
      }

      try {
        const res = await pool.query<{
          product_viewed: string;
          add_to_cart: string;
          checkout_started: string;
          order_completed: string;
        }>(
          `SELECT
             count(*) FILTER (WHERE event_name = 'product_viewed')   AS product_viewed,
             count(*) FILTER (WHERE event_name = 'add_to_cart')      AS add_to_cart,
             count(*) FILTER (WHERE event_name = 'checkout_started') AS checkout_started,
             count(*) FILTER (WHERE event_name = 'order_completed')  AS order_completed
           FROM analytics_events
           WHERE site_id = $1::uuid
             AND event_type = 'ecommerce'
             AND timestamp BETWEEN $2 AND $3`,
          [store_id, startDate.toISOString(), endDate.toISOString()]
        );

        const row = res.rows[0];
        const pv = parseInt(row?.product_viewed ?? "0", 10);
        const atc = parseInt(row?.add_to_cart ?? "0", 10);
        const cs = parseInt(row?.checkout_started ?? "0", 10);
        const oc = parseInt(row?.order_completed ?? "0", 10);

        const dropPct = (from: number, to: number): number => {
          if (from <= 0) return 0;
          return (1 - to / from) * 100;
        };

        return reply.send({
          stages: [
            { name: "Product Viewed",   count: pv,  drop_off_pct: 0 },
            { name: "Add to Cart",      count: atc, drop_off_pct: dropPct(pv, atc) },
            { name: "Checkout Started", count: cs,  drop_off_pct: dropPct(atc, cs) },
            { name: "Order Completed",  count: oc,  drop_off_pct: dropPct(cs, oc) },
          ],
        });
      } catch {
        return reply.send({
          stages: [
            { name: "Product Viewed",   count: 0, drop_off_pct: 0 },
            { name: "Add to Cart",      count: 0, drop_off_pct: 0 },
            { name: "Checkout Started", count: 0, drop_off_pct: 0 },
            { name: "Order Completed",  count: 0, drop_off_pct: 0 },
          ],
        });
      }
    }
  );

  // ── GET /analytics/ecommerce/revenue ──────────────────────────────────────
  app.get(
    "/analytics/ecommerce/revenue",
    { preHandler: [requireJwt], schema: { querystring: AnalyticsQuerystring } },
    async (request, reply) => {
      const { store_id, start, end } = request.query;
      const { start: startDate, end: endDate } = parseDateRange(start, end);

      const { orgId } = request.auth!;
      const pool = getPool();
      const storeCheck = await pool.query<{ ok: boolean }>(
        `SELECT (organization_id = $2::uuid) AS ok FROM stores WHERE id = $1::uuid`,
        [store_id, orgId]
      );
      if (!storeCheck.rows[0]?.ok) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "forbidden" } });
      }

      try {
        const res = await pool.query<{
          day: string;
          orders: string;
          revenue_cents: string;
        }>(
          `SELECT
             date_trunc('day', timestamp)::date AS day,
             count(*)                           AS orders,
             COALESCE(sum(((properties->>'total')::numeric * 100)::bigint), 0) AS revenue_cents
           FROM analytics_events
           WHERE site_id = $1::uuid
             AND event_type = 'ecommerce'
             AND event_name = 'order_completed'
             AND timestamp BETWEEN $2 AND $3
           GROUP BY 1
           ORDER BY 1`,
          [store_id, startDate.toISOString(), endDate.toISOString()]
        );

        const daily = res.rows.map((r) => ({
          day: r.day,
          orders: parseInt(r.orders, 10),
          revenue_cents: parseInt(r.revenue_cents, 10),
        }));

        return reply.send({ daily });
      } catch {
        return reply.send({ daily: [] });
      }
    }
  );
};
