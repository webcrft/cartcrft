/**
 * Migration list helper for @cartcrft/cloud-billing.
 *
 * Returns the absolute paths of the billing SQL migration files in order.
 * The host server (when CARTCRFT_CLOUD=1) feeds these to its migration runner
 * after applying the core backend migrations.
 *
 * Usage:
 *   import { billingMigrations } from '@cartcrft/cloud-billing';
 *   for (const sql of billingMigrations()) { await runner.apply(sql); }
 */

import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

// Resolve the migrations/ directory relative to this compiled file.
// Works for both src/ (ts-node/tsx) and dist/ (tsc) layouts because
// migrations/ sits alongside both.
function migrationsDir(): string {
  // __dirname equivalent in ESM
  const here = dirname(fileURLToPath(import.meta.url));
  // From dist/ or src/, go up one level to reach migrations/.
  return resolve(here, '..', 'migrations');
}

/**
 * Returns sorted absolute paths of all billing .sql migration files.
 * The caller is responsible for applying them in order via its own runner.
 */
export function billingMigrations(): string[] {
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => resolve(dir, f));
}
