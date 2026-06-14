import type { SiteRoute } from '../types'
import Landing from './Landing'
import Compare from './Compare'
import Pricing from './Pricing'
import Terms from './legal/Terms'
import Privacy from './legal/Privacy'
import Popia from './legal/Popia'
import Gdpr from './legal/Gdpr'

/**
 * Marketing routes for the site zone. Each page renders its own content inside
 * <SiteLayout>; the legal pages additionally wrap content in <LegalLayout>.
 */
export const marketingRoutes: SiteRoute[] = [
  { path: '/', element: <Landing /> },
  { path: '/compare', element: <Compare /> },
  { path: '/pricing', element: <Pricing /> },
  { path: '/legal/terms', element: <Terms /> },
  { path: '/legal/privacy', element: <Privacy /> },
  { path: '/legal/popia', element: <Popia /> },
  { path: '/legal/gdpr', element: <Gdpr /> },
]
