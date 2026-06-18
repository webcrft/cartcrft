/**
 * digital/routes.ts — Fastify plugin for digital product delivery.
 *
 * Routes:
 *  Admin:
 *    GET  /commerce/stores/:storeId/orders/:orderId/download-links
 *    POST /commerce/stores/:storeId/orders/:orderId/download-links
 *  Public storefront:
 *    GET  /storefront/:storeId/downloads/:token
 *      → validates expiry + max_downloads, increments count, 302 → file_url
 *
 * Note: digital_product_files CRUD is owned by catalog module (T2.2).
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { storeAuthWrite } from "../../lib/auth/middleware.js";
import { generateDownloadLinks, listDownloadLinks, validateAndRedeemToken } from "./service.js";
import { assertSafeOutboundUrl } from "../../lib/net/ssrf.js";
import { config } from "../../config/config.js";

const UUID = z.string().uuid();

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}

// ── Shared param schemas ──────────────────────────────────────────────────────

const OrderParams = z.object({ storeId: UUID, orderId: UUID });
const DownloadTokenParams = z.object({
  storeId: UUID,
  token: z.string().min(1).max(256),
});

// ── Shared body schemas ───────────────────────────────────────────────────────

const GenerateLinksBody = z.object({
  max_downloads: z.number().int().min(1).optional().nullable(),
  expires_at: z.string().optional().nullable(),
});

// ── Plugin ────────────────────────────────────────────────────────────────────

export const digitalPlugin: FastifyPluginAsyncZod = async (app) => {

  // ── Admin: list download links for an order ─────────────────────────────

  app.get(
    "/commerce/stores/:storeId/orders/:orderId/download-links",
    { preHandler: storeAuthWrite("digital"), schema: { params: OrderParams } },
    async (request, reply) => {
      const links = await listDownloadLinks(request.params.storeId, request.params.orderId);
      return reply.send({ links });
    }
  );

  // ── Admin: generate download links for all digital lines in an order ────

  app.post(
    "/commerce/stores/:storeId/orders/:orderId/download-links",
    { preHandler: storeAuthWrite("digital"), schema: { params: OrderParams, body: GenerateLinksBody } },
    async (request, reply) => {
      try {
        const result = await generateDownloadLinks(
          request.params.storeId,
          request.params.orderId,
          request.body
        );
        return reply.status(201).send(result);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "NOT_FOUND") {
          return reply.status(404).send(notFound(err.message));
        }
        throw err;
      }
    }
  );

  // ── Public storefront: download via token (302 redirect) ─────────────────

  app.get(
    "/storefront/:storeId/downloads/:token",
    { schema: { params: DownloadTokenParams } },
    async (request, reply) => {
      try {
        const info = await validateAndRedeemToken(
          request.params.token,
          request.params.storeId
        );
        // Open-redirect / SSRF guard: this is a public, unauthenticated endpoint,
        // so the platform domain must not be usable as a redirector to internal
        // or abusive targets. Validate the (admin-controlled) file_url resolves
        // only to public addresses before issuing the 302. External CDNs still
        // pass; private/loopback/metadata targets are rejected with a 502.
        try {
          await assertSafeOutboundUrl(info.file_url, { allowPrivate: config.APP_ENV !== "production" });
        } catch {
          return reply.status(502).send({
            error: { code: "BAD_GATEWAY", message: "download target is not a valid public URL" },
          });
        }
        // 302 redirect to the file URL
        return reply.redirect(info.file_url, 302);
      } catch (err) {
        if (err instanceof Error) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "NOT_FOUND") {
            return reply.status(404).send(notFound("download link not found or invalid"));
          }
          if (code === "LINK_EXPIRED") {
            return reply.status(410).send({
              error: { code: "LINK_EXPIRED", message: err.message },
            });
          }
          if (code === "DOWNLOAD_LIMIT_EXCEEDED") {
            return reply.status(410).send({
              error: { code: "DOWNLOAD_LIMIT_EXCEEDED", message: err.message },
            });
          }
        }
        throw err;
      }
    }
  );
};
