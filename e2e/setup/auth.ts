/**
 * e2e/setup/auth.ts — credential helpers for E2E tests.
 *
 * Reads from the repo-root .env so we never commit passwords into the e2e
 * package itself. Falls back to the known demo values so tests can still
 * run even without the .env (e.g. on CI with the seed already applied).
 */
import dotenv from 'dotenv';
import path from 'path';

// e2e/ is the cwd when playwright runs; so ../ gets us to repo root
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

export const ADMIN_EMAIL    = process.env['DEMO_ADMIN_EMAIL']         ?? 'demo@cartcrft.test';
export const ADMIN_PASS     = process.env['DEMO_ADMIN_PASSWORD']      ?? 'demodemo123';
export const SA_EMAIL       = process.env['DEMO_SUPERADMIN_EMAIL']    ?? 'ops@cartcrft.test';
export const SA_PASS        = process.env['DEMO_SUPERADMIN_PASSWORD'] ?? 'opsopsops123';
export const BACKEND_URL    = 'http://localhost:8080';
export const FRONTEND_URL   = 'http://localhost:4321';
