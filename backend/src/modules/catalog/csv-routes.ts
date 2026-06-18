/**
 * catalog/csv-routes.ts — CSV import/export routes for the catalog.
 *
 * Registered as a separate Fastify plugin (added additively, does not modify
 * the existing catalog/routes.ts).
 *
 * Routes:
 *   GET  /commerce/stores/:storeId/products/export.csv
 *     → streams (or buffers) all products+variants as RFC4180 CSV
 *
 *   GET  /commerce/stores/:storeId/products/import/template
 *     → returns the CSV template (header + example row) with Content-Type text/csv
 *
 *   POST /commerce/stores/:storeId/products/import
 *     → accepts raw text/csv (or multipart file); upserts products/variants;
 *       returns ImportResult JSON; ?dry_run=true for validation-only
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthAdmin } from "../../lib/auth/middleware.js";
import {
  exportProductsCsv,
  importProductsCsv,
  csvTemplateString,
} from "./csv.js";

const StoreIdParams = z.object({
  storeId: z.string().uuid(),
});

const ImportQuery = z.object({
  dry_run: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export const catalogCsvPlugin: FastifyPluginAsync = async (app) => {

  // ── Register text/csv content-type parser ───────────────────────────────────
  // Fastify only parses application/json by default; without this, any
  // request with Content-Type: text/csv would have request.body === undefined.
  app.addContentTypeParser(
    ["text/csv", "text/plain"],
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // ── GET .../products/export.csv ─────────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/products/export.csv",
    { preHandler: [storeAuthAdmin("catalog")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;
      const params = StoreIdParams.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "Invalid storeId" },
        });
      }

      try {
        const csv = await exportProductsCsv(storeId);
        return reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header(
            "Content-Disposition",
            `attachment; filename="products-${storeId}.csv"`
          )
          .send(csv);
      } catch (err) {
        app.log.error({ err }, "csv export error");
        throw err;
      }
    }
  );

  // ── GET .../products/import/template ────────────────────────────────────────
  app.get(
    "/commerce/stores/:storeId/products/import/template",
    { preHandler: [storeAuthAdmin("catalog")] },
    async (request, reply) => {
      const template = csvTemplateString();
      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="product_import_template.csv"')
        .send(template);
    }
  );

  // ── POST .../products/import ─────────────────────────────────────────────────
  app.post(
    "/commerce/stores/:storeId/products/import",
    { preHandler: [storeAuthAdmin("catalog")] },
    async (request, reply) => {
      const storeId = request.auth!.storeId;

      // Parse ?dry_run query param
      const queryResult = ImportQuery.safeParse(request.query);
      const dryRun = queryResult.success ? queryResult.data.dry_run : false;

      // Accept raw text/csv body or multipart file
      let csvText = "";
      const contentType = (request.headers["content-type"] ?? "").toLowerCase();

      if (contentType.includes("text/csv") || contentType.includes("text/plain")) {
        // Raw body
        const body = request.body;
        if (typeof body === "string") {
          csvText = body;
        } else if (Buffer.isBuffer(body)) {
          csvText = body.toString("utf-8");
        } else {
          return reply.status(400).send({
            error: { code: "VALIDATION_ERROR", message: "Expected text/csv body" },
          });
        }
      } else if (contentType.includes("multipart/form-data")) {
        // Multipart: try to extract 'file' field from parsed body
        // Fastify does not parse multipart by default; check for raw body
        const body = request.body as Record<string, unknown> | null;
        if (body && typeof body["file"] === "string") {
          csvText = body["file"];
        } else if (body && typeof body["csv"] === "string") {
          csvText = body["csv"];
        } else {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message:
                "Multipart upload detected but could not extract file field. " +
                "Send raw text/csv body instead.",
            },
          });
        }
      } else {
        // Fallback: try to parse body as string
        const body = request.body;
        if (typeof body === "string") {
          csvText = body;
        } else if (Buffer.isBuffer(body)) {
          csvText = body.toString("utf-8");
        } else {
          return reply.status(400).send({
            error: {
              code: "VALIDATION_ERROR",
              message:
                "Send the CSV as a raw text/csv body: Content-Type: text/csv",
            },
          });
        }
      }

      if (!csvText.trim()) {
        return reply.status(400).send({
          error: { code: "VALIDATION_ERROR", message: "CSV body is empty" },
        });
      }

      try {
        const importResult = await importProductsCsv(storeId, csvText, {
          dryRun,
        });
        return reply.status(200).send({
          dry_run: dryRun,
          ...importResult,
        });
      } catch (err) {
        app.log.error({ err }, "csv import error");
        throw err;
      }
    }
  );
};
