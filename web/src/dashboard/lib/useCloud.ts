/**
 * useCloud — returns true when PUBLIC_CARTCRFT_CLOUD is set at build time.
 *
 * Astro exposes PUBLIC_* env vars to client bundles via import.meta.env.
 * The value is inlined at build time, so no runtime env lookup happens.
 *
 * NOTE: the router (routes/index.tsx) uses `import.meta.env.PUBLIC_CARTCRFT_CLOUD`
 * directly so Vite can statically analyse and tree-shake cloud-only lazy imports.
 * This function is kept for non-router callers (UI guards, nav rendering) where
 * tree-shaking the dynamic import() is not needed.
 */
const CLOUD_FLAG = import.meta.env.PUBLIC_CARTCRFT_CLOUD === '1'

export function useCloud(): boolean {
  return CLOUD_FLAG
}
