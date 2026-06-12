/**
 * test-setup.ts — Vitest global setup for cloud/billing tests.
 * Loads repo-root .env so DATABASE_URL and other secrets are available.
 */
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// cloud/billing/src → cloud/billing → cloud → cartcrft (repo root)
const repoRoot = path.resolve(__dirname, '../../..');

dotenvConfig({ path: path.join(repoRoot, '.env'), override: false });
