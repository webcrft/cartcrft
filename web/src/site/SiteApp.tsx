import { BrowserRouter, Routes, Route } from 'react-router-dom'
import '../styles/global.css'
import { marketingRoutes } from './marketing'
import { docRoutes } from './docs'
import NotFound from './NotFound'

/**
 * SiteApp — the marketing + docs zone of the SPA. One <BrowserRouter> covering
 * every public page; the dashboard/superadmin zones run their own routers and
 * are reached via full-page navigation (see Root.tsx).
 *
 * Routes are contributed by two modules with disjoint ownership:
 *   - ./marketing → marketingRoutes (landing, compare, pricing, legal)
 *   - ./docs      → docRoutes (the migrated Starlight content)
 */
export default function SiteApp() {
  return (
    <BrowserRouter>
      <Routes>
        {marketingRoutes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        {docRoutes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
