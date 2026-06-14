import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Vitest config for the SPA smoke suites — marketing + docs (site zone), the
// merchant dashboard, and the super-admin console. Plain React component tests
// running under jsdom (the app is a single Vite + React SPA).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/site/**/*.test.{ts,tsx}',
      'src/dashboard/**/*.test.{ts,tsx}',
      'src/superadmin/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['./src/dashboard/test/setup.ts'],
    // Treat CSS imports as no-ops
    css: false,
    logHeapUsage: false,
  },
})
