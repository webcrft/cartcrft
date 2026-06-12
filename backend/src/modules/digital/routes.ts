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

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthWrite } from "../../lib/auth/middleware.js";
import { generateDownloadLinks, listDownloadLinks, validateAndRedeemToken } from "./service.js";

const UUID = z.string().uuid();

function notFound(msg: string) {
  return { error: { code: "NOT_FOUND", message: msg } };
}
function badRequest(msg: string, code = "VALIDATION_ERROR") {
  return { error: { code, message: msg } };
}

export const digitalPlugin: FastifyPluginAsync = async (app) => {
  // ── Admin: list download links for an order ─────────────────────────────

  app.get(
    "/commerce/stores/:storeId/orders/:orderId/download-links",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, orderId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const links = await listDownloadLinks(params.data.storeId, params.data.orderId);
      return reply.send({ links });
    }
  );

  // ── Admin: generate download links for all digital lines in an order ────

  app.post(
    "/commerce/stores/:storeId/orders/:orderId/download-links",
    { preHandler: storeAuthWrite },
    async (request, reply) => {
      const params = z.object({ storeId: UUID, orderId: UUID }).safeParse(request.params);
      if (!params.success) return reply.status(400).send(badRequest("invalid params"));
      const body = z
        .object({
          max_downloads: z.number().int().min(1).optional().nullable(),
          expires_at: z.string().optional().nullable(),
        })
        .safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send(badRequest("validation failed"));

      try {
        const result = await generateDownloadLinks(
          params.data.storeId,
          params.data.orderId,
          body.data
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
    async (request, reply) => {
      const params = z
        .object({
          storeId: UUID,
          token: z.string().min(1).max(256),
        })
        .safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send(badRequest("invalid token format"));
      }

      try {
        const info = await validateAndRedeemToken(
          params.data.token,
          params.data.storeId
        );
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
