/**
 * lib/request-ctx.ts — Per-request auth context carrier via AsyncLocalStorage.
 *
 * Purpose
 * -------
 * pool.ts/withTx needs to know the authenticated user's ID and org ID so it
 * can set the `app.user_id` / `app.org_id` Postgres GUCs inside each
 * transaction (enabling RLS enforcement via the cartcrft_app role).
 *
 * Rather than changing withTx's signature (which would require touching all 34
 * call sites across 26 modules), we use AsyncLocalStorage to carry the auth
 * context from the Fastify request hook through the entire async call chain
 * without explicit threading.
 *
 * Lifecycle
 * ---------
 *   1. Auth middleware (middleware.ts) resolves the principal and calls
 *      `setRequestCtx({ userId, orgId })` AFTER setting request.auth.
 *   2. Any async call that eventually reaches withTx will see the stored
 *      context via `getRequestCtx()`.
 *   3. withTx calls `getRequestCtx()` and, if present, executes:
 *        SET LOCAL ROLE cartcrft_app
 *        SELECT set_config('app.user_id', userId, true)
 *        SELECT set_config('app.org_id',  orgId,  true)
 *      before handing the client to the caller's fn().
 *   4. At COMMIT/ROLLBACK the role and GUCs revert automatically (LOCAL scope).
 *
 * Non-request contexts
 * --------------------
 * Worker jobs, migration runner, seeding, and test fixture inserts run outside
 * a request context. In those cases `getRequestCtx()` returns undefined and
 * withTx skips the role-switch + GUC setup, executing as neondb_owner
 * (BYPASSRLS). This is correct: those operations are trusted infrastructure
 * code that must not be blocked by RLS.
 *
 * Test harness
 * ------------
 * HTTP requests made through ctx.request() carry a JWT or API key; the auth
 * middleware resolves auth and populates the AsyncLocalStorage store. Direct
 * SQL inserts via ctx.pool.query() bypass this store entirely — intentional.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ── Context shape ─────────────────────────────────────────────────────────────

export interface RequestCtx {
  /**
   * The authenticated user's UUID.  For JWT auth this is claims.sub; for
   * API-key auth we use `apikey:<orgId>` as a synthetic stable identifier
   * (non-empty signals an authenticated connection to the RLS policy).
   */
  userId: string;

  /** The org UUID the request is acting on behalf of. */
  orgId: string;
}

// ── Singleton store ───────────────────────────────────────────────────────────

// The store holds a *mutable per-request holder*, not the context value
// directly. The holder is created once per request by runInRequestScope()
// (wired into the HTTP server via Fastify's serverFactory) and then mutated in
// place by setRequestCtx() from the auth middleware. This deliberately avoids
// AsyncLocalStorage.enterWith() on the request path: enterWith() can leak its
// value to an ancestor async frame (and is documented to "break out of run()"),
// which previously bled one request's tenant context into unrelated work — a
// later non-request DB call would inherit a stale app.org_id, switch to the
// cartcrft_app role, and trip RLS for the wrong tenant.
interface CtxHolder {
  ctx?: RequestCtx;
}

const _store = new AsyncLocalStorage<CtxHolder>();

/**
 * Run `fn` (and all its async continuations) inside a fresh per-request scope
 * with its own empty holder. Wired into the HTTP server via serverFactory (see
 * http/app.ts) so every request gets an isolated holder; the holder and any
 * context written into it vanish the moment the request's async work unwinds.
 */
export function runInRequestScope<T>(fn: () => T): T {
  return _store.run({}, fn);
}

/**
 * Record the resolved auth context for the current request by mutating the
 * per-request holder. Call from the auth middleware after resolving auth.
 *
 * If there is no holder — i.e. not running inside a serverFactory-wrapped
 * request (e.g. app.inject()) — we fall back to enterWith() so RLS is still
 * enforced. That fallback can leak, but neither the real HTTP server nor the
 * test harness use it; both run every request inside a holder.
 */
export function setRequestCtx(ctx: RequestCtx): void {
  const holder = _store.getStore();
  if (holder) {
    holder.ctx = ctx;
  } else {
    _store.enterWith({ ctx });
  }
}

/**
 * Establish a request context for the duration of `fn` in a fresh scope.
 * Used by entry points that aren't a normal Fastify preHandler (e.g. the MCP
 * tool dispatcher). Scoped via run(), so it never leaks past `fn`.
 */
export function runWithRequestCtx<T>(ctx: RequestCtx, fn: () => T): T {
  return _store.run({ ctx }, fn);
}

/**
 * Retrieve the request context for the current async scope.
 *
 * Returns undefined when called outside a request context (worker jobs,
 * migrations, test fixture inserts) or before auth has resolved.
 */
export function getRequestCtx(): RequestCtx | undefined {
  return _store.getStore()?.ctx;
}
