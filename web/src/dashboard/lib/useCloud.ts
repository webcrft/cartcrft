/**
 * useCloud — returns true when PUBLIC_CARTCRFT_CLOUD is set at build time.
 *
 * Astro exposes PUBLIC_* env vars to client bundles via import.meta.env.
 * The value is inlined at build time, so no runtime env lookup happens.
 * The dashboard router conditionally registers cloud-only routes based on
 * this flag so that an OFF build ships zero cloud surface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CLOUD_FLAG = Boolean((import.meta as any).env?.PUBLIC_CARTCRFT_CLOUD)

export function useCloud(): boolean {
  return CLOUD_FLAG
}
