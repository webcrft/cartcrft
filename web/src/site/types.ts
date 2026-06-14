import type { ReactNode } from 'react'

/** A route in the site zone (marketing or docs). */
export interface SiteRoute {
  path: string
  element: ReactNode
}
