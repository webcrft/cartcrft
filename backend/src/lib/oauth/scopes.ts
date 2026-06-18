/**
 * lib/oauth/scopes.ts — the fixed OAuth2 scope catalogue.
 *
 * Each OAuth scope maps onto the storeAuth read/write/admin tiers the existing
 * middleware already enforces (lib/auth/middleware.ts). When an access token
 * carries the `oauth_app` + `scope` claims, the route's storeAuth tier still
 * runs (so the token is org/store-bound exactly like a JWT). A route that passes
 * a RESOURCE tag to its tier guard (e.g. `storeAuthWrite("orders")`) is gated
 * PER-RESOURCE in resolveStoreAuth(): the token must hold `${resource}:${tier}`
 * (or a higher tier on the same resource). Untagged routes keep the COARSE
 * tier-class gate. OAuth tokens are an ADDITIONAL principal type layered on
 * top of the JWT path — they never weaken the existing cc_pub_/cc_prv_/JWT auth.
 *
 * NOTE: there is no admin-class scope in this catalogue, so admin-tier routes
 * (e.g. payment-providers, most /customers routes) are never reachable by an
 * OAuth token — they fail closed. `payments:*` is intentionally absent for the
 * same reason; payments mutations are admin/write-only and not OAuth-grantable.
 *
 *   tier "read"  → satisfied by *:read  (and the *:write / checkout:write that imply it where noted)
 *   tier "write" → requires a write-class scope
 *   tier "admin" → requires an admin-class scope
 *
 * The mapping is intentionally a SUPERSET-friendly list: a route asserts the
 * single most specific scope it needs; the token must contain it (or a broader
 * scope on the same resource — see scopeSatisfies()).
 */

/** Every scope a merchant can grant an app. */
export const OAUTH_SCOPES = [
  "catalog:read",
  "catalog:write",
  "orders:read",
  "orders:write",
  "customers:read",
  "customers:write",
  "checkout:write",
  "inventory:read",
  "inventory:write",
  "discounts:read",
  "discounts:write",
  "shipping:read",
  "shipping:write",
  "tax:read",
  "tax:write",
  "returns:read",
  "returns:write",
  "subscriptions:read",
  "subscriptions:write",
  "wallet:read",
  "b2b:read",
  "b2b:write",
  "digital:read",
  "digital:write",
  "marketing:read",
  "marketing:write",
  "channels:read",
  "channels:write",
  "threepl:read",
  "segments:read",
  "segments:write",
  "feeds:read",
  "feeds:write",
  "engagement:read",
  "engagement:write",
  "exchange-rates:read",
  "bookings:read",
  "bookings:write",
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

const SCOPE_SET = new Set<string>(OAUTH_SCOPES);

/** Human-readable consent-screen descriptions, keyed by scope. */
export const SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  "catalog:read": "View products, variants, and collections",
  "catalog:write": "Create and modify products, variants, and collections",
  "orders:read": "View orders and fulfillment",
  "orders:write": "Create and modify orders and fulfillment",
  "customers:read": "View customer accounts",
  "customers:write": "Create and modify customer accounts",
  "checkout:write": "Create carts and complete checkouts",
  "inventory:read": "View inventory levels",
  "inventory:write": "Adjust inventory levels",
  "discounts:read": "View discounts",
  "discounts:write": "Create and modify discounts",
  "shipping:read": "View shipping zones, rates, and methods",
  "shipping:write": "Create and modify shipping zones, rates, and methods",
  "tax:read": "View tax rates and configuration",
  "tax:write": "Create and modify tax rates and configuration",
  "returns:read": "View returns",
  "returns:write": "Create and modify returns",
  "subscriptions:read": "View subscriptions and plans",
  "subscriptions:write": "Create and modify subscriptions and plans",
  "wallet:read": "View store-credit and gift-card balances",
  "b2b:read": "View B2B companies, groups, quotes, and purchase orders",
  "b2b:write": "Create and modify B2B companies, groups, quotes, and purchase orders",
  "digital:read": "View digital product downloads",
  "digital:write": "Generate and manage digital product download links",
  "marketing:read": "View marketing automation flows and runs",
  "marketing:write": "Create and modify marketing automation flows",
  "channels:read": "View sales channels",
  "channels:write": "Create and modify sales channels",
  "threepl:read": "View 3PL fulfillment providers and shipments",
  "segments:read": "View customer segments",
  "segments:write": "Create and modify customer segments",
  "feeds:read": "View product feeds",
  "feeds:write": "Create and modify product feeds",
  "engagement:read": "View wishlists and engagement data",
  "engagement:write": "Create and modify wishlists and engagement data",
  "exchange-rates:read": "View currency exchange rates",
  "bookings:read": "View bookings, resources, and availability",
  "bookings:write": "Create and modify bookings, resources, and availability",
};

/** Returns true if `scope` is one of the fixed, known OAuth scopes. */
export function isValidScope(scope: string): scope is OAuthScope {
  return SCOPE_SET.has(scope);
}

/**
 * Validate + normalise a space-delimited `scope` parameter (OAuth2 wire format)
 * into a deduped array. Returns an error message when any token is unknown.
 */
export function parseScopeParam(
  raw: string | undefined
): { ok: true; scopes: string[] } | { ok: false; message: string } {
  const tokens = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!isValidScope(t)) return { ok: false, message: `unknown scope: ${t}` };
    seen.add(t);
  }
  return { ok: true, scopes: [...seen] };
}

/**
 * Validate a requested scope list against the app's `allowed_scopes`.
 * Every requested scope must be in allowed_scopes (and a known scope).
 */
export function validateRequestedScopes(
  requested: string[],
  allowed: string[]
): { ok: true } | { ok: false; message: string } {
  const allowedSet = new Set(allowed);
  for (const s of requested) {
    if (!isValidScope(s)) return { ok: false, message: `unknown scope: ${s}` };
    if (!allowedSet.has(s)) {
      return { ok: false, message: `scope not permitted for this app: ${s}` };
    }
  }
  return { ok: true };
}

/**
 * Does the granted scope list satisfy a required scope?
 *
 * `:write` on a resource implies `:read` on that resource (a write grant can
 * also read), mirroring hasScope() in the api-keys module. Otherwise exact
 * membership is required.
 */
export function scopeSatisfies(granted: string[], required: string): boolean {
  for (const g of granted) {
    if (g === required) return true;
    if (required.endsWith(":read")) {
      const resource = required.slice(0, -":read".length);
      if (g === `${resource}:write`) return true;
    }
  }
  return false;
}

/** Are all `subset` scopes present (satisfied) by `superset`? */
export function scopesCovered(subset: string[], superset: string[]): boolean {
  return subset.every((s) => scopeSatisfies(superset, s));
}
