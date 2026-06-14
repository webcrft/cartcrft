/**
 * api.ts — Cloud billing read-API Fastify plugin.
 *
 * Exposes account + billing read endpoints for the Cartcrft Cloud dashboard:
 *
 *   GET  /cloud/account               — org account info (subscription + tier)
 *   PATCH /cloud/account              — update account display name / billing email
 *   GET  /cloud/billing/plan          — active subscription + tier details
 *   GET  /cloud/billing/invoices      — paginated invoice list (latest first)
 *   GET  /cloud/billing/invoices/:id  — single invoice detail
 *   GET  /cloud/billing/wallet        — wallet balance + auto-topup config
 *
 * Auth: requires a valid platform JWT (iss=cartcrft, aud=cartcrft).
 * All data is org-scoped to the JWT's `org` claim.
 *
 * This plugin is registered by backend/src/http/app.ts ONLY when
 * CARTCRFT_CLOUD is set (same dynamic-import gate as billingWebhookPlugin).
 * The OSS build must not eagerly import this module.
 *
 * @module
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

// ── JWT helpers (inlined — no jose dep; uses node:crypto for HS256) ──────────
//
// We inline a minimal HS256 verifier here rather than depending on `jose` so
// the cloud-billing package keeps a small dependency footprint.
// The backend already validates JWTs via jose; here we just need to verify
// the same tokens it issues (HS256, iss=cartcrft, aud=cartcrft).

const JWT_ISSUER = 'cartcrft';
const JWT_AUDIENCE = 'cartcrft';

interface PlatformClaims {
  sub: string;
  org: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
}

/**
 * Minimal HS256 JWT verifier using node:crypto.
 * Verifies signature, expiry, iss, and aud.
 * Returns claims on success, null on any failure.
 */
function verifyPlatformJwt(token: string, secret: string): PlatformClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header64, payload64, sig64] = parts as [string, string, string];

    // Verify HMAC-SHA256 signature (timing-safe).
    const expected = createHmac('sha256', secret)
      .update(`${header64}.${payload64}`)
      .digest('base64url');

    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(sig64, 'utf8');
    if (
      expectedBuf.length !== providedBuf.length ||
      !timingSafeEqual(expectedBuf, providedBuf)
    ) {
      return null;
    }

    // Decode header to check algorithm.
    const header = JSON.parse(Buffer.from(header64, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (header['alg'] !== 'HS256') return null;

    // Decode payload.
    const payload = JSON.parse(Buffer.from(payload64, 'base64url').toString('utf8')) as PlatformClaims;

    // Check expiry.
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp !== undefined && payload.exp < now) return null;

    // Check issuer.
    if (payload.iss !== JWT_ISSUER) return null;

    // Check audience (jose accepts string or array).
    const aud = payload.aud;
    const audOk = aud === JWT_AUDIENCE ||
      (Array.isArray(aud) && aud.includes(JWT_AUDIENCE));
    if (!audOk) return null;

    // Require sub and org claims.
    if (!payload.sub || !payload.org) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function unauthorized(reply: unknown): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (reply as any)
    .status(401)
    .send({ error: { code: 'UNAUTHORIZED', message: 'valid platform JWT required' } });
}

function notFound(reply: unknown, msg = 'resource not found'): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (reply as any)
    .status(404)
    .send({ error: { code: 'NOT_FOUND', message: msg } });
}

// ── Plugin options ─────────────────────────────────────────────────────────────

export type BillingApiPluginOptions = {
  pool: pg.Pool;
  /** JWT_SECRET — read from env when not provided (for test injection). */
  jwtSecret?: string;
};

// ── billingApiPlugin ──────────────────────────────────────────────────────────

/**
 * Fastify plugin that mounts cloud billing read endpoints.
 *
 * Mount in backend/src/http/app.ts under CARTCRFT_CLOUD gate:
 *
 * ```ts
 * if (process.env.CARTCRFT_CLOUD) {
 *   const { billingApiPlugin } = await import('@cartcrft/cloud-billing');
 *   await app.register(billingApiPlugin, { prefix: '/cloud', pool: getPool() });
 * }
 * ```
 */
export async function billingApiPlugin(
  // any: Fastify instance — cloud package has no Fastify dep; quarantined here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance: any,
  opts: BillingApiPluginOptions & Record<string, unknown>
): Promise<void> {
  const pool: pg.Pool = opts.pool;
  const jwtSecretStr: string =
    (opts.jwtSecret as string | undefined) ?? process.env['JWT_SECRET'] ?? '';

  // ── Auth middleware ──────────────────────────────────────────────────────────

  /**
   * Verify the platform JWT and extract orgId.
   * Returns null and sends 401 if invalid.
   */
  async function resolveOrg(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    req: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reply: any
  ): Promise<string | null> {
    const authorization: string = req.headers['authorization'] ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!bearer) {
      await unauthorized(reply);
      return null;
    }
    const claims = await verifyPlatformJwt(bearer, jwtSecretStr);
    if (!claims) {
      await unauthorized(reply);
      return null;
    }
    return claims.org;
  }

  // ── GET /account ────────────────────────────────────────────────────────────

  instance.get('/account', async (req: unknown, reply: unknown) => {
    const orgId = await resolveOrg(req, reply);
    if (!orgId) return;

    // Fetch subscription + tier in one query.
    const { rows } = await pool.query<{
      sub_id: string | null;
      sub_status: string | null;
      sub_period_start: string | null;
      sub_period_end: string | null;
      sub_cancel_at_period_end: boolean | null;
      tier_id: string | null;
      tier_name: string | null;
      tier_slug: string | null;
      tier_price_usd_cents: number | null;
      tier_features: Record<string, unknown> | null;
      wallet_balance_cents: number | null;
    }>(
      `SELECT
         s.id                   AS sub_id,
         s.status               AS sub_status,
         s.current_period_start AS sub_period_start,
         s.current_period_end   AS sub_period_end,
         s.cancel_at_period_end AS sub_cancel_at_period_end,
         t.id                   AS tier_id,
         t.name                 AS tier_name,
         t.slug                 AS tier_slug,
         t.price_usd_cents      AS tier_price_usd_cents,
         t.features             AS tier_features,
         w.balance_cents        AS wallet_balance_cents
       FROM billing_subscriptions s
       JOIN billing_tiers t ON t.id = s.tier_id
       LEFT JOIN billing_wallets w ON w.organization_id = s.organization_id
       WHERE s.organization_id = $1::uuid
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [orgId]
    );

    const row = rows[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (reply as any).send({
      organization_id: orgId,
      subscription: row
        ? {
            id: row.sub_id,
            status: row.sub_status,
            current_period_start: row.sub_period_start,
            current_period_end: row.sub_period_end,
            cancel_at_period_end: row.sub_cancel_at_period_end,
          }
        : null,
      plan: row
        ? {
            id: row.tier_id,
            name: row.tier_name,
            slug: row.tier_slug,
            price_usd_cents: row.tier_price_usd_cents,
            features: row.tier_features,
          }
        : null,
      wallet: {
        balance_cents: row?.wallet_balance_cents ?? 0,
      },
    });
  });

  // ── PATCH /account ───────────────────────────────────────────────────────────

  instance.patch('/account', async (req: unknown, reply: unknown) => {
    const orgId = await resolveOrg(req, reply);
    if (!orgId) return;

    // Accept display_name and billing_email updates in subscription metadata.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (req as any).body as Record<string, unknown> ?? {};
    const allowed: Record<string, unknown> = {};
    if (typeof body['display_name'] === 'string') {
      allowed['display_name'] = body['display_name'];
    }
    if (typeof body['billing_email'] === 'string') {
      allowed['billing_email'] = body['billing_email'];
    }

    if (Object.keys(allowed).length === 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (reply as any).status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'provide at least one of: display_name, billing_email',
        },
      });
    }

    // Merge into subscription metadata (org-scoped).
    await pool.query(
      `UPDATE billing_subscriptions
          SET metadata = metadata || $1::jsonb, updated_at = now()
        WHERE organization_id = $2::uuid`,
      [JSON.stringify(allowed), orgId]
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (reply as any).send({ organization_id: orgId, updated: allowed });
  });

  // ── GET /billing/plan ────────────────────────────────────────────────────────

  instance.get('/billing/plan', async (req: unknown, reply: unknown) => {
    const orgId = await resolveOrg(req, reply);
    if (!orgId) return;

    const { rows } = await pool.query<{
      sub_id: string;
      status: string;
      current_period_start: string | null;
      current_period_end: string | null;
      cancel_at_period_end: boolean;
      failed_payment_count: number;
      billing_day: number | null;
      tier_id: string;
      tier_name: string;
      tier_slug: string;
      tier_price_usd_cents: number;
      tier_interval: string;
      tier_features: Record<string, unknown>;
    }>(
      `SELECT
         s.id                   AS sub_id,
         s.status,
         s.current_period_start,
         s.current_period_end,
         s.cancel_at_period_end,
         s.failed_payment_count,
         s.billing_day,
         t.id                   AS tier_id,
         t.name                 AS tier_name,
         t.slug                 AS tier_slug,
         t.price_usd_cents      AS tier_price_usd_cents,
         t.interval             AS tier_interval,
         t.features             AS tier_features
       FROM billing_subscriptions s
       JOIN billing_tiers t ON t.id = s.tier_id
       WHERE s.organization_id = $1::uuid
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [orgId]
    );

    const row = rows[0];
    if (!row) {
      return notFound(reply, 'no subscription found for this organization');
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (reply as any).send({
      subscription: {
        id: row.sub_id,
        status: row.status,
        current_period_start: row.current_period_start,
        current_period_end: row.current_period_end,
        cancel_at_period_end: row.cancel_at_period_end,
        failed_payment_count: row.failed_payment_count,
        billing_day: row.billing_day,
      },
      plan: {
        id: row.tier_id,
        name: row.tier_name,
        slug: row.tier_slug,
        price_usd_cents: row.tier_price_usd_cents,
        interval: row.tier_interval,
        features: row.tier_features,
      },
    });
  });

  // ── GET /billing/invoices ────────────────────────────────────────────────────

  instance.get('/billing/invoices', async (req: unknown, reply: unknown) => {
    const orgId = await resolveOrg(req, reply);
    if (!orgId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = (req as any).query as Record<string, string> ?? {};
    const limit = Math.min(parseInt(query['limit'] ?? '20', 10) || 20, 100);
    const offset = parseInt(query['offset'] ?? '0', 10) || 0;

    const { rows } = await pool.query<{
      id: string;
      invoice_number: string;
      status: string;
      subtotal_cents: number;
      total_cents: number;
      usd_amount: string;
      fx_rate: string;
      zar_amount: string;
      due_at: string | null;
      paid_at: string | null;
      created_at: string;
    }>(
      `SELECT
         id,
         invoice_number,
         status,
         subtotal_cents,
         total_cents,
         usd_amount::text,
         fx_rate::text,
         zar_amount::text,
         due_at,
         paid_at,
         created_at
       FROM billing_invoices
       WHERE organization_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [orgId, limit, offset]
    );

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM billing_invoices WHERE organization_id = $1::uuid`,
      [orgId]
    );
    const total = parseInt(countRows[0]?.count ?? '0', 10);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (reply as any).send({
      invoices: rows,
      pagination: { total, limit, offset },
    });
  });

  // ── GET /billing/invoices/:invoiceId ─────────────────────────────────────────

  instance.get('/billing/invoices/:invoiceId', async (req: unknown, reply: unknown) => {
    const orgId = await resolveOrg(req, reply);
    if (!orgId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = (req as any).params as Record<string, string> ?? {};
    const invoiceId = params['invoiceId'];

    const { rows } = await pool.query<{
      id: string;
      invoice_number: string;
      status: string;
      subtotal_cents: number;
      tax_cents: number;
      total_cents: number;
      usd_amount: string;
      fx_rate: string;
      zar_amount: string;
      fx_fetched_at: string | null;
      due_at: string | null;
      paid_at: string | null;
      recipient_email: string | null;
      recipient_name: string | null;
      created_at: string;
      organization_id: string;
    }>(
      `SELECT
         id,
         invoice_number,
         status,
         subtotal_cents,
         tax_cents,
         total_cents,
         usd_amount::text,
         fx_rate::text,
         zar_amount::text,
         fx_fetched_at,
         due_at,
         paid_at,
         recipient_email,
         recipient_name,
         created_at,
         organization_id::text
       FROM billing_invoices
       WHERE id = $1::uuid`,
      [invoiceId]
    );

    const row = rows[0];
    if (!row) {
      return notFound(reply, 'invoice not found');
    }

    // Org-scope check: prevent cross-org access.
    if (row.organization_id !== orgId) {
      return notFound(reply, 'invoice not found');
    }

    // Fetch line items.
    const { rows: items } = await pool.query<{
      id: string;
      description: string;
      quantity: number;
      unit_amount_cents: number;
      line_total_cents: number;
    }>(
      `SELECT id, description, quantity, unit_amount_cents, line_total_cents
         FROM billing_invoice_items
        WHERE invoice_id = $1::uuid
        ORDER BY created_at`,
      [invoiceId]
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (reply as any).send({ invoice: row, items });
  });

  // ── GET /billing/wallet ──────────────────────────────────────────────────────

  instance.get('/billing/wallet', async (req: unknown, reply: unknown) => {
    const orgId = await resolveOrg(req, reply);
    if (!orgId) return;

    const { rows } = await pool.query<{
      id: string;
      balance_cents: number;
      auto_topup_enabled: boolean;
      auto_topup_amount_cents: number;
      auto_topup_threshold_cents: number;
      updated_at: string;
    }>(
      `SELECT
         id,
         balance_cents,
         auto_topup_enabled,
         auto_topup_amount_cents,
         auto_topup_threshold_cents,
         updated_at
       FROM billing_wallets
       WHERE organization_id = $1::uuid
       LIMIT 1`,
      [orgId]
    );

    const row = rows[0];
    // Wallet may not exist yet (created on first topup).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (reply as any).send({
      wallet: row ?? {
        balance_cents: 0,
        auto_topup_enabled: false,
        auto_topup_amount_cents: 0,
        auto_topup_threshold_cents: 0,
      },
    });
  });
}
