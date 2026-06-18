/**
 * exchange-rates/routes.ts — Public storefront FX rates endpoint.
 *
 * Route (scoped to /commerce/stores/:storeId):
 *   GET /exchange-rates  — storeAuthRead (accepts public cc_pub_ storefront keys)
 *
 * Returns the newest USD-base FX snapshot plus the store's own currency and the
 * available target currencies. PRESENTMENT ONLY: these rates are for *display*
 * conversion on the storefront — they never change the settlement/charge
 * currency. See lib/fx-convert.ts.
 *
 * Cache-friendly: rates change at most every couple of hours (fx-refresh cron),
 * so we set a short shared-cache TTL. Storefronts and CDNs may cache the result.
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { storeAuthRead } from "../../lib/auth/middleware.js";
import { getStoreExchangeRates } from "./service.js";

const StoreIdParams = z.object({
  storeId: z.string().uuid(),
});

export const exchangeRatesPlugin: FastifyPluginAsync = async (app) => {
  // ── GET /commerce/stores/:storeId/exchange-rates ──────────────────────────
  // Public storefront read: mirrors the storeAuthRead auth used by carts /
  // checkout reads, so a browser-exposed cc_pub_ key can fetch display rates.
  app.get(
    "/commerce/stores/:storeId/exchange-rates",
    {
      preHandler: [storeAuthRead],
      schema: { params: StoreIdParams },
    },
    async (request, reply) => {
      // IDOR-safe: use the store id resolved by auth, not the raw URL param.
      const storeId = request.auth!.storeId;

      const data = await getStoreExchangeRates(storeId);
      if (!data) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "store not found" } });
      }

      // Cache for 5 minutes at shared caches; rates refresh at most ~2h.
      void reply.header("cache-control", "public, max-age=300");

      return reply.send({
        base: data.base,
        rates: data.rates,
        fetched_at: data.fetched_at,
        store_currency: data.store_currency,
        conversion_enabled: data.conversion_enabled,
        currencies: data.currencies,
      });
    }
  );
};
