/**
 * checkout-links/routes.ts — Shareable checkout / payment links.
 *
 * Merchant (storeAuthWrite, mounted /commerce/stores/:storeId/checkout-links):
 *   POST   /checkout-links                — create a link from line_items
 *   GET    /checkout-links                — list the store's links
 *   POST   /checkout-links/:linkId/void   — void an open link
 *
 * Public (NO auth, the token IS the capability):
 *   GET    /storefront/checkout-links/:token              — resolve (totals, branding)
 *   POST   /storefront/checkout-links/:token/start-payment — build cart+checkout,
 *                                                            start provider session,
 *                                                            return redirect payload
 *
 * The public resolve / start-payment endpoints look the link up by token ONLY
 * and derive the store from the row — they never accept a caller-supplied
 * store_id, so they cannot leak or mutate cross-store data. The token is
 * unguessable (cl_<random>, 24 random bytes). All write/list merchant paths are
 * RLS org-gated like every other tenant table (0028 migration).
 *
 * ── Embed snippet ───────────────────────────────────────────────────────────
 * The hosted page also serves a compact iframe mode at /pay/<token>?embed=1.
 * Embed it on any site with:
 *
 *   <iframe
 *     src="https://pay.cartcrft.dev/pay/cl_xxxxx?embed=1"
 *     style="width:100%;max-width:480px;height:640px;border:0;border-radius:14px"
 *     title="Checkout"
 *     allow="payment">
 *   </iframe>
 *
 * The provider redirect (Paystack authorization_url / Stripe / Xendit invoice)
 * breaks out of the iframe to the provider's domain via window.top, then returns
 * to success_url/cancel_url.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthWrite } from "../../lib/auth/middleware.js";
import { getPool } from "../../db/pool.js";
import {
  createCheckoutLink,
  listCheckoutLinks,
  voidCheckoutLink,
  resolveCheckoutLink,
  startCheckoutFromLink,
} from "./service.js";
import {
  createStripeSession,
  createPaystackSession,
  createRazorpaySession,
  createXenditSession,
} from "../payments/service.js";

// ── Zod schemas ───────────────────────────────────────────────────────────────

const StoreIdParams = z.object({ storeId: z.string().uuid() });
const LinkParams = z.object({
  storeId: z.string().uuid(),
  linkId: z.string().uuid(),
});
const TokenParams = z.object({ token: z.string().min(3).max(128) });

const LineItemSchema = z.object({
  variant_id: z.string().uuid(),
  quantity: z.number().int().min(1),
});

const CreateLinkBody = z.object({
  line_items: z.array(LineItemSchema).min(1),
  customer_email: z.string().email().optional(),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
  expires_at: z.string().datetime().optional(),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.enum(["open", "completed", "expired", "void"]).optional(),
});

const StartPaymentBody = z.object({
  email: z.string().email().optional(),
}).partial();

// ── Plugin ────────────────────────────────────────────────────────────────────

export const checkoutLinksPlugin: FastifyPluginAsync = async (app) => {

  // ── POST /commerce/stores/:storeId/checkout-links ────────────────────────
  app.post(
    "/commerce/stores/:storeId/checkout-links",
    {
      preHandler: [storeAuthWrite],
      schema: { params: StoreIdParams, body: CreateLinkBody },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const data = request.body as z.infer<typeof CreateLinkBody>;

      try {
        const { id, token } = await createCheckoutLink(storeId, {
          line_items: data.line_items.map((li) => ({
            variant_id: li.variant_id,
            quantity: li.quantity,
          })),
          ...(data.customer_email !== undefined && { customer_email: data.customer_email }),
          ...(data.success_url !== undefined && { success_url: data.success_url }),
          ...(data.cancel_url !== undefined && { cancel_url: data.cancel_url }),
          ...(data.expires_at !== undefined && { expires_at: data.expires_at }),
          created_by: request.auth!.userId ?? `apikey:${request.auth!.orgId}`,
        });

        const base = process.env["PUBLIC_CHECKOUT_BASE"] ?? "";
        const url = `${base}/pay/${token}`;
        return reply.status(201).send({ id, token, url });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        if (code === "VALIDATION_ERROR") {
          return reply.status(422).send({ error: { code: "VALIDATION_ERROR", message: (err as Error).message } });
        }
        throw err;
      }
    }
  );

  // ── GET /commerce/stores/:storeId/checkout-links ─────────────────────────
  app.get(
    "/commerce/stores/:storeId/checkout-links",
    {
      preHandler: [storeAuthWrite],
      schema: { params: StoreIdParams, querystring: ListQuery },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const q = request.query as z.infer<typeof ListQuery>;
      const links = await listCheckoutLinks(storeId, {
        ...(q.limit !== undefined && { limit: q.limit }),
        ...(q.offset !== undefined && { offset: q.offset }),
        ...(q.status !== undefined && { status: q.status }),
      });
      const base = process.env["PUBLIC_CHECKOUT_BASE"] ?? "";
      return reply.send({
        checkout_links: links.map((l) => ({
          ...l,
          url: `${base}/pay/${l.token}`,
        })),
      });
    }
  );

  // ── POST /commerce/stores/:storeId/checkout-links/:linkId/void ───────────
  app.post(
    "/commerce/stores/:storeId/checkout-links/:linkId/void",
    {
      preHandler: [storeAuthWrite],
      schema: { params: LinkParams },
    },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const { linkId } = request.params as z.infer<typeof LinkParams>;
      const ok = await voidCheckoutLink(storeId, linkId);
      if (!ok) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "checkout link not found or not open" },
        });
      }
      return reply.send({ ok: true, status: "void" });
    }
  );

  // ── GET /storefront/checkout-links/:token (PUBLIC, no auth) ──────────────
  app.get(
    "/storefront/checkout-links/:token",
    { schema: { params: TokenParams } },
    async (request, reply) => {
      const { token } = request.params as z.infer<typeof TokenParams>;
      try {
        const resolved = await resolveCheckoutLink(token);
        return reply.send(resolved);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "NOT_FOUND") {
          return reply.status(404).send({
            error: { code: "NOT_FOUND", message: "checkout link not found" },
          });
        }
        throw err;
      }
    }
  );

  // ── POST /storefront/checkout-links/:token/start-payment (PUBLIC) ────────
  // Build a real cart + checkout from the snapshot, then start a provider
  // payment session via the store's first active provider — REUSING the same
  // create*Session creators + checkout machinery as native checkout, so the
  // existing webhook path finalises the order identically.
  app.post(
    "/storefront/checkout-links/:token/start-payment",
    { schema: { params: TokenParams, body: StartPaymentBody } },
    async (request, reply) => {
      const { token } = request.params as z.infer<typeof TokenParams>;
      const body = request.body as z.infer<typeof StartPaymentBody>;

      // ── 1. Build cart + checkout from the link snapshot ──────────────────
      let started: Awaited<ReturnType<typeof startCheckoutFromLink>>;
      try {
        started = await startCheckoutFromLink(token, {
          ...(body.email !== undefined && { email: body.email }),
        });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "NOT_FOUND") {
          return reply.status(404).send({ error: { code: "NOT_FOUND", message: (err as Error).message } });
        }
        if (code === "LINK_NOT_OPEN") {
          return reply.status(409).send({ error: { code: "LINK_NOT_OPEN", message: (err as Error).message } });
        }
        if (code === "VALIDATION_ERROR") {
          return reply.status(422).send({ error: { code: "VALIDATION_ERROR", message: (err as Error).message } });
        }
        throw err;
      }

      const { storeId, checkoutId, total, currency, email } = started;

      // ── 2. Resolve the store's first active payment provider ─────────────
      const pool = getPool();
      const { rows: provRows } = await pool.query<{
        id: string;
        type: string;
        slug: string | null;
      }>(
        `SELECT id::text, type, slug
         FROM payment_providers
         WHERE store_id = $1::uuid AND is_active = true
         ORDER BY position ASC, created_at ASC
         LIMIT 1`,
        [storeId]
      );

      if (!provRows[0]) {
        return reply.status(501).send({
          error: {
            code: "PROVIDER_NOT_CONFIGURED",
            message: "No active payment provider configured for this store.",
          },
        });
      }

      const provider = provRows[0];
      const totalAmount = parseFloat(total);

      // ── 3. Create the provider session ───────────────────────────────────
      let sessionData: Record<string, unknown>;
      try {
        switch (provider.type) {
          case "stripe": {
            const amountCents = Math.round(totalAmount * 100);
            const result = await createStripeSession(storeId, checkoutId, amountCents, currency, email ?? undefined);
            sessionData = {
              provider: "stripe",
              client_secret: result.clientSecret,
              payment_intent_id: result.paymentIntentId,
            };
            break;
          }
          case "paystack": {
            const amountKobo = Math.round(totalAmount * 100);
            if (!email) {
              return reply.status(422).send({
                error: { code: "VALIDATION_ERROR", message: "Paystack requires a customer email — provide one on the link or in the payment form." },
              });
            }
            const result = await createPaystackSession(storeId, checkoutId, amountKobo, currency, email);
            sessionData = {
              provider: "paystack",
              authorization_url: result.authorizationUrl,
              reference: result.reference,
            };
            break;
          }
          case "razorpay": {
            const amountSmallest = Math.round(totalAmount * 100);
            const result = await createRazorpaySession(storeId, checkoutId, amountSmallest, currency);
            const { rows: cfgRows } = await pool.query<{ config: Record<string, unknown> | string }>(
              `SELECT config FROM payment_providers WHERE id = $1::uuid`,
              [provider.id]
            );
            const rawCfg = cfgRows[0]?.config;
            const cfg = typeof rawCfg === "string" ? (JSON.parse(rawCfg) as Record<string, unknown>) : (rawCfg ?? {});
            sessionData = {
              provider: "razorpay",
              order_id: result.razorpayOrderId,
              amount: result.amount,
              currency: result.currency,
              key_id: cfg["key_id"] ?? "",
            };
            break;
          }
          case "xendit": {
            const result = await createXenditSession(storeId, checkoutId, totalAmount, currency, email ?? undefined);
            sessionData = {
              provider: "xendit",
              invoice_url: result.invoiceUrl,
              invoice_id: result.invoiceId,
            };
            break;
          }
          default: {
            return reply.status(501).send({
              error: {
                code: "PROVIDER_NOT_CONFIGURED",
                message: `Provider type '${provider.type}' does not support hosted payment sessions.`,
              },
            });
          }
        }
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "PROVIDER_NOT_CONFIGURED") {
          return reply.status(501).send({
            error: { code: "PROVIDER_NOT_CONFIGURED", message: (err as Error).message },
          });
        }
        throw err;
      }

      // ── 4. Persist the session on the checkout (mirrors payment-session) ──
      await pool.query(
        `UPDATE checkouts SET payment_session = $1::jsonb, updated_at = now()
         WHERE id = $2::uuid AND store_id = $3::uuid`,
        [JSON.stringify(sessionData), checkoutId, storeId]
      );

      // ── 5. Return provider-shaped payload + checkout id ──────────────────
      return reply.status(200).send({ ...sessionData, checkout_id: checkoutId });
    }
  );
};
