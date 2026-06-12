import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Load .env from repo root via a setup file
    setupFiles: [path.resolve(__dirname, 'src/test-setup.ts')],
  },
});
