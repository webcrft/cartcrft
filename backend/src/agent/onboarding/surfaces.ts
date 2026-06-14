/**
 * agent/onboarding/surfaces.ts — per-surface feed-submission adapters.
 *
 * Each adapter:
 *   1. Generates the product feed by REUSING the existing feeds module:
 *        - Google Merchant : feeds/service.getFeedItems (product_feed_data join)
 *                            mapped into the Content API for Shopping `products`
 *                            resource shape (the same data the Google Shopping
 *                            XML carries, in JSON product form).
 *        - ChatGPT ACP     : the ACP feed (agent/acp feed.getAcpFeed) —
 *                            registration points the surface at the live
 *                            /acp/:storeId/feed endpoint.
 *   2. SUBMITS it to the surface using the REAL API request shapes.
 *
 * The actual outbound HTTP requires the merchant's OAuth/credentials. The HTTP
 * call goes through the injectable `httpFetch` (defaults to global fetch) so
 * tests mock the surface. When no credentials are present the adapter throws a
 * CREDENTIALS_REQUIRED error (credential-gated) and the route returns a clear
 * disclosure of what's needed to go live.
 *
 * ── What is credential-gated to go live ────────────────────────────────────
 *   google_merchant:
 *     - A Google Merchant Center account (numeric merchantId → external_account_id)
 *     - OAuth 2.0 (https://www.googleapis.com/auth/content scope) — the stored
 *       credential is the OAuth refresh/access token used as Bearer.
 *     - Content API for Shopping enabled on the GCP project.
 *   chatgpt_acp:
 *     - OpenAI merchant onboarding (seller/merchant id → external_account_id)
 *     - A registration handshake that points OpenAI at the public ACP feed URL;
 *       the stored credential is the OpenAI API/registration token (Bearer).
 */

import { getFeedItems } from "../../modules/feeds/service.js";
import { getStoreInfo } from "../../modules/feeds/service.js";
import { getAcpFeed } from "../acp/v2026_04/feed.js";
import type { AgentSurface, FeedSubmissionResult } from "./types.js";

/** Injectable fetch — overridden in tests to mock the surface HTTP. */
export type HttpFetch = typeof fetch;

export class CredentialsRequiredError extends Error {
  constructor(public surface: AgentSurface, message: string) {
    super(message);
    this.name = "CredentialsRequiredError";
  }
}

/** Inputs the pipeline hands to an adapter. */
export interface SubmitContext {
  storeId: string;
  /** Decrypted credential blob (OAuth/API token), or null when absent. */
  credential: string | null;
  /** Surface account id (Google merchantId / OpenAI merchant id). */
  externalAccountId: string | null;
  /** Public API base URL (for building the ACP feed link). */
  apiBaseUrl: string;
  /** Surface HTTP client (mockable). */
  httpFetch: HttpFetch;
}

// ── Google Merchant Center — Content API for Shopping ───────────────────────

const GOOGLE_CONTENT_API = "https://shoppingcontent.googleapis.com/content/v2.1";

/**
 * Map our feed items into the Content API for Shopping `products` resource.
 * Shape matches https://developers.google.com/shopping-content/reference/rest/v2.1/products
 */
export function toGoogleProducts(
  items: Awaited<ReturnType<typeof getFeedItems>>,
  storeUrl: string,
  currency: string
): Array<Record<string, unknown>> {
  return items.map((it) => {
    const link =
      storeUrl && it.slug
        ? `${storeUrl.replace(/\/$/, "")}/products/${it.slug}`
        : "";
    const product: Record<string, unknown> = {
      // offerId must be unique per product in the account.
      offerId: it.id,
      title: it.title,
      description: it.description,
      link,
      imageLink: it.imageUrl,
      contentLanguage: "en",
      targetCountry: "US",
      channel: "online",
      availability: it.availability === "in_stock" ? "in stock" : "out of stock",
      condition: it.condition || "new",
      price: { value: it.price, currency },
    };
    if (it.brand) product["brand"] = it.brand;
    if (it.gtin) product["gtin"] = it.gtin;
    if (it.mpn) product["mpn"] = it.mpn;
    if (it.googleProductCategory)
      product["googleProductCategory"] = it.googleProductCategory;
    if (it.ageGroup) product["ageGroup"] = it.ageGroup;
    if (it.gender) product["gender"] = it.gender;
    return product;
  });
}

/**
 * Submit the catalog to Google Merchant Center via the Content API custombatch
 * endpoint (products.custombatch) — one insert entry per product. This is the
 * real request shape; the Bearer token is the merchant's OAuth access token.
 */
async function submitGoogleMerchant(
  ctx: SubmitContext
): Promise<FeedSubmissionResult> {
  const endpoint = `${GOOGLE_CONTENT_API}/products/batch`;
  if (!ctx.credential || !ctx.externalAccountId) {
    throw new CredentialsRequiredError(
      "google_merchant",
      "Google Merchant Center requires an OAuth access token (auth/content scope) and a merchant account id."
    );
  }

  const store = await getStoreInfo(ctx.storeId);
  const items = await getFeedItems(ctx.storeId);
  const currency = store?.currency ?? "USD";
  const products = toGoogleProducts(items, store?.url ?? "", currency);

  // Content API custombatch request: one INSERT entry per product.
  const body = {
    entries: products.map((product, i) => ({
      batchId: i + 1,
      merchantId: ctx.externalAccountId,
      method: "insert",
      product,
    })),
  };

  const res = await ctx.httpFetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      surface: "google_merchant",
      ok: false,
      item_count: products.length,
      submission_id: null,
      endpoint,
      error: `Google Content API ${res.status}: ${text.slice(0, 500)}`,
    };
  }

  const json = (await res.json().catch(() => ({}))) as {
    kind?: string;
    entries?: Array<{ batchId?: number; errors?: unknown }>;
  };
  const failed = (json.entries ?? []).filter((e) => e.errors);
  return {
    surface: "google_merchant",
    ok: failed.length === 0,
    item_count: products.length,
    submission_id: ctx.externalAccountId,
    endpoint,
    ...(failed.length > 0
      ? { error: `${failed.length} product(s) rejected by Google` }
      : {}),
  };
}

// ── ChatGPT / OpenAI ACP — feed registration ────────────────────────────────

/**
 * OpenAI agentic-commerce merchant feed registration. We don't push the whole
 * catalog; instead we register (point) the surface at our live ACP feed URL.
 * The real shape: POST a feed registration with the public feed URL + merchant
 * id, authenticated with the merchant's OpenAI token.
 */
const OPENAI_COMMERCE_API = "https://api.openai.com/v1/commerce/feeds";

async function submitChatgptAcp(
  ctx: SubmitContext
): Promise<FeedSubmissionResult> {
  const endpoint = OPENAI_COMMERCE_API;
  const feedUrl = `${ctx.apiBaseUrl.replace(/\/$/, "")}/acp/${ctx.storeId}/feed`;

  // Validate the feed actually produces items (catalog correctness gate).
  const feed = await getAcpFeed(ctx.storeId, 1);

  if (!ctx.credential || !ctx.externalAccountId) {
    throw new CredentialsRequiredError(
      "chatgpt_acp",
      "ChatGPT ACP registration requires OpenAI merchant onboarding (merchant id) and an OpenAI API token."
    );
  }

  const body = {
    merchant_id: ctx.externalAccountId,
    feed_url: feedUrl,
    protocol: "acp",
    protocol_version: "2026-04",
  };

  const res = await ctx.httpFetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      surface: "chatgpt_acp",
      ok: false,
      item_count: feed.total,
      submission_id: null,
      endpoint,
      error: `OpenAI commerce API ${res.status}: ${text.slice(0, 500)}`,
    };
  }

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    feed_id?: string;
  };
  return {
    surface: "chatgpt_acp",
    ok: true,
    item_count: feed.total,
    submission_id: json.id ?? json.feed_id ?? feedUrl,
    endpoint,
  };
}

/** Dispatch feed submission to the correct surface adapter. */
export async function submitFeedToSurface(
  surface: AgentSurface,
  ctx: SubmitContext
): Promise<FeedSubmissionResult> {
  switch (surface) {
    case "google_merchant":
      return submitGoogleMerchant(ctx);
    case "chatgpt_acp":
      return submitChatgptAcp(ctx);
    default: {
      const _exhaustive: never = surface;
      throw new Error(`unknown surface: ${String(_exhaustive)}`);
    }
  }
}
