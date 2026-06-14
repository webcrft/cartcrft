/// <reference types="astro/client" />

/**
 * Extends Astro's ImportMeta with Cartcrft-specific PUBLIC_* environment variables.
 * These are inlined at build time by Vite/Astro.
 */
interface ImportMetaEnv {
  /** Base URL of the Cartcrft backend API. Defaults to http://localhost:8080 in code. */
  readonly PUBLIC_API_URL: string | undefined
  /**
   * Set to "1" to build a Cartcrft Cloud bundle (includes billing/account pages).
   * Leave unset for an OSS build — cloud JS chunks are tree-shaken from the output.
   */
  readonly PUBLIC_CARTCRFT_CLOUD: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
