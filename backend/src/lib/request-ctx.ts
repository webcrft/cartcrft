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

const _store = new AsyncLocalStorage<RequestCtx>();

/**
 * Set the request context for the current async scope and all future
 * continuations derived from it.
 *
 * Uses AsyncLocalStorage.enterWith() so the value persists beyond the current
 * call frame — Fastify's preHandler hook and the route handler it triggers are
 * separate async continuations, but enterWith() propagates through them because
 * they share the same async resource context (the request's HTTP handler).
 *
 * Call this from the auth middleware after resolving auth.
 */
export function setRequestCtx(ctx: RequestCtx): void {
  _store.enterWith(ctx);
}

/**
 * Set the request context for the current async scope.
 *
 * Call this from the auth middleware immediately after resolving auth.
 * The context persists for the lifetime of the current async call chain
 * (the Fastify request handler and everything it awaits).
 */
export function runWithRequestCtx<T>(ctx: RequestCtx, fn: () => T): T {
  return _store.run(ctx, fn);
}

/**
 * Retrieve the request context for the current async scope.
 *
 * Returns undefined when called outside a request context (worker jobs,
 * migrations, test fixture inserts).
 */
export function getRequestCtx(): RequestCtx | undefined {
  return _store.getStore();
}
