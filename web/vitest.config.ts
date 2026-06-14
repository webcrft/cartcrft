import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Vitest config for the admin dashboard + super-admin operator console smoke suites.
// (web/src/dashboard/**/*.test.tsx and web/src/superadmin/**/*.test.tsx).
// Astro's own config is not used here — these are plain React component tests
// running under jsdom.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: [
      'src/dashboard/**/*.test.{ts,tsx}',
      'src/superadmin/**/*.test.{ts,tsx}',
    ],
    setupFiles: ['./src/dashboard/test/setup.ts'],
    // Treat CSS imports as no-ops
    css: false,
    logHeapUsage: false,
  },
})
