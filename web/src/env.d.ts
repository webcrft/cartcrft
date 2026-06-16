/// <reference types="vite/client" />

/**
 * Cartcrft-specific PUBLIC_* environment variables, inlined at build time by
 * Vite (envPrefix includes PUBLIC_ — see vite.config.ts).
 */
interface ImportMetaEnv {
  /** Base URL of the CartCrft backend API. Defaults to http://localhost:8080 in code. */
  readonly PUBLIC_API_URL: string | undefined
  /**
   * Set to "1" to build a CartCrft Cloud bundle (includes billing/account pages).
   * Leave unset for an OSS build — cloud JS chunks are tree-shaken from the output.
   */
  readonly PUBLIC_CARTCRFT_CLOUD: string | undefined
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
