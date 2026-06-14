import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

/**
 * Single Vite + React SPA build (replaces the prior Astro app).
 *
 * One client-rendered app hosts every surface — marketing, docs, the merchant
 * dashboard, and the super-admin console — selected at runtime by URL prefix in
 * src/Root.tsx (the "zone router"). Each zone keeps its own <BrowserRouter>, so
 * cross-zone links are plain full-page navigations and the dashboard/superadmin
 * routers stay untouched.
 *
 * envPrefix keeps the existing PUBLIC_* contract (PUBLIC_CARTCRFT_CLOUD,
 * PUBLIC_API_URL) that the dashboard/superadmin/docs read via import.meta.env.
 * envDir points at the repo root so the existing root .env is used in dev.
 * Only VITE_/PUBLIC_-prefixed vars are exposed to the client — repo-root secrets
 * (DATABASE_URL, JWT_SECRET, …) are never bundled.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  envPrefix: ['VITE_', 'PUBLIC_'],
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  server: { port: 4321, host: true },
  preview: { port: 4321 },
  build: { outDir: 'dist', sourcemap: false },
})
