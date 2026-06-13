import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Treat CSS imports as no-ops
    css: false,
    // Suppress act() warnings from async effects in smoke tests
    logHeapUsage: false,
  },
  resolve: {
    // Ensure workspace package resolves to its source rather than needing a build
    alias: {},
  },
})
