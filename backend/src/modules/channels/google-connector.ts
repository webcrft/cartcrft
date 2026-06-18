/**
 * channels/google-connector.ts — ChannelConnector backed by the Google
 * Content API for Shopping client (providers/channels/google-shopping.ts).
 *
 * Translates the channel-agnostic SyncContext (catalog products + per-store
 * config + credentials) into Content API custombatch insert/delete calls, then
 * folds the per-entry results back into a SyncResult the service persists onto
 * channel_sync_items / channel_syncs.
 *
 * Graceful: a failed batch call (auth error, network) does not throw out of the
 * worker — it returns a SyncResult with status 'error'. Per-product errors are
 * recorded against each item.
 */

import {
  newGoogleShoppingClient,
  toContentProduct,
  GoogleShoppingAPIError,
  type ContentApiBatchEntry,
  type ChannelProductInput,
} from "../../providers/channels/google-shopping.js";
import type {
  ChannelConnector,
  SyncContext,
  ProductSyncOutcome,
} from "./connector.js";
import type { SyncResult } from "./types.js";

const BATCH_SIZE = 200;

function inputFor(
  ctx: SyncContext,
  p: SyncContext["products"][number]
): ChannelProductInput {
  const input: ChannelProductInput = {
    offerId: p.offerId,
    title: p.title,
    link: p.link,
    price: p.price,
    currency: ctx.currency,
    inStock: p.inStock,
    contentLanguage: ctx.contentLanguage,
    targetCountry: ctx.country,
  };
  if (p.description) input.description = p.description;
  if (p.imageLink) input.imageLink = p.imageLink;
  if (p.brand) input.brand = p.brand;
  if (p.gtin) input.gtin = p.gtin;
  if (p.mpn) input.mpn = p.mpn;
  return input;
}

/**
 * Run a custombatch insert over all products and fold the per-entry response
 * back into outcomes. `batchId` indexes into the products array so we can map
 * each response entry back to its product.
 */
async function pushAll(ctx: SyncContext): Promise<{
  outcomes: ProductSyncOutcome[];
  result: SyncResult;
}> {
  const merchantId = ctx.config.merchant_id;
  if (!merchantId) {
    return {
      outcomes: [],
      result: {
        synced: 0,
        errored: 0,
        status: "error",
        error: "google_shopping: merchant_id missing from channel config",
      },
    };
  }
  if (!ctx.accessToken) {
    return {
      outcomes: [],
      result: {
        synced: 0,
        errored: 0,
        status: "error",
        error: "google_shopping: access token missing (configure the merchant integration)",
      },
    };
  }

  const client = newGoogleShoppingClient(ctx.accessToken);
  const outcomes: ProductSyncOutcome[] = [];
  let synced = 0;
  let errored = 0;
  let firstError: string | undefined;

  for (let start = 0; start < ctx.products.length; start += BATCH_SIZE) {
    const slice = ctx.products.slice(start, start + BATCH_SIZE);
    const entries: ContentApiBatchEntry[] = slice.map((p, i) => ({
      batchId: start + i,
      merchantId,
      method: "insert",
      product: toContentProduct(inputFor(ctx, p)),
    }));

    try {
      const resEntries = await client.customBatchProducts(entries, ctx.signal);
      const byBatchId = new Map(resEntries.map((e) => [e.batchId, e]));

      for (let i = 0; i < slice.length; i++) {
        const product = slice[i]!;
        const entry = byBatchId.get(start + i);
        if (entry?.errors) {
          errored++;
          const msg = entry.errors.message || "unknown channel error";
          firstError ??= msg;
          outcomes.push({ productId: product.productId, status: "error", error: msg });
        } else {
          synced++;
          outcomes.push({
            productId: product.productId,
            status: "synced",
            ...(entry?.product?.id ? { externalId: entry.product.id } : { externalId: product.offerId }),
          });
        }
      }
    } catch (err) {
      // Whole-batch failure (auth/network) — mark every product in the slice as
      // errored, but keep going (and never throw out of the worker).
      const msg =
        err instanceof GoogleShoppingAPIError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      firstError ??= msg;
      for (const product of slice) {
        errored++;
        outcomes.push({ productId: product.productId, status: "error", error: msg });
      }
    }
  }

  const status: SyncResult["status"] =
    errored === 0 ? "ok" : synced === 0 ? "error" : "partial";

  return {
    outcomes,
    result: {
      synced,
      errored,
      status,
      ...(firstError ? { error: firstError } : {}),
    },
  };
}

export class GoogleShoppingConnector implements ChannelConnector {
  async syncProducts(ctx: SyncContext): Promise<SyncResult> {
    const { outcomes, result } = await pushAll(ctx);
    await ctx.recordOutcomes(outcomes);
    return result;
  }

  /**
   * Inventory/price sync re-pushes the same product resource (which carries the
   * current availability + price), so for Content API it is the same custombatch
   * insert as a full product sync. Kept as a distinct method so other channels
   * can implement a lighter-weight update path.
   */
  async syncInventory(ctx: SyncContext): Promise<SyncResult> {
    const { outcomes, result } = await pushAll(ctx);
    await ctx.recordOutcomes(outcomes);
    return result;
  }
}

export function newGoogleShoppingConnector(): ChannelConnector {
  return new GoogleShoppingConnector();
}
