import { describe, it, expect, beforeAll } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

import Landing from '../marketing/Landing'
import Compare from '../marketing/Compare'
import Pricing from '../marketing/Pricing'
import Terms from '../marketing/legal/Terms'
import Privacy from '../marketing/legal/Privacy'
import DocPage from '../docs/DocPage'
import NotFound from '../NotFound'

// jsdom has no IntersectionObserver; the docs TOC + reveal observer use it.
beforeAll(() => {
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  }
  // @ts-expect-error test stub
  globalThis.IntersectionObserver = IO
  window.scrollTo = () => {}
})

function renderAt(ui: ReactNode, path = '/') {
  return render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>)
}

describe('site zone — marketing renders', () => {
  it('landing mounts with hero copy', () => {
    const { container } = renderAt(<Landing />)
    expect(container.textContent).toMatch(/agent-native/i)
    expect(container.textContent).toMatch(/take rate/i)
  })

  it('compare mounts with competitor content', () => {
    const { container } = renderAt(<Compare />, '/compare')
    expect(container.textContent).toMatch(/shopify/i)
  })

  it('pricing mounts with plan tiers', () => {
    const { container } = renderAt(<Pricing />, '/pricing')
    expect(container.textContent).toMatch(/starter/i)
  })

  it('legal pages mount with draft banner', () => {
    const terms = renderAt(<Terms />, '/legal/terms')
    expect(terms.container.textContent).toMatch(/terms/i)
    const privacy = renderAt(<Privacy />, '/legal/privacy')
    expect(privacy.container.textContent).toMatch(/privacy/i)
  })

  it('404 mounts', () => {
    const { container } = renderAt(<NotFound />, '/nope')
    expect(container.textContent).toMatch(/not found/i)
  })
})

describe('site zone — docs render markdown', () => {
  it('renders a doc page from markdown', () => {
    const { container } = renderAt(<DocPage slug="quickstart" />, '/quickstart')
    expect(container.textContent).toMatch(/quickstart/i)
  })

  it('renders the API overview doc', () => {
    const { container } = renderAt(<DocPage slug="api-overview" />, '/api-overview')
    expect(container.textContent).toMatch(/api/i)
  })
})
