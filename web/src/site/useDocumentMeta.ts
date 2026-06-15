import { useEffect } from 'react'

const SITE = 'https://cartcrft.dev'

/**
 * Client-side document <title> + meta management (replaces the Astro SEO
 * component). This is a client-only SPA, so meta is set at runtime — adequate
 * for in-app navigation; bots that execute JS still see it.
 */
export function useDocumentMeta(opts: {
  title: string
  description?: string
  ogImage?: string
  canonical?: string
  noindex?: boolean
}) {
  const { title, description, ogImage = '/og-image.png', canonical, noindex } = opts

  useEffect(() => {
    document.title = title

    const setMeta = (selector: string, attr: 'name' | 'property', key: string, content: string) => {
      let el = document.head.querySelector<HTMLMetaElement>(selector)
      if (!el) {
        el = document.createElement('meta')
        el.setAttribute(attr, key)
        document.head.appendChild(el)
      }
      el.setAttribute('content', content)
    }

    const ogImageURL = ogImage.startsWith('http') ? ogImage : `${SITE}${ogImage}`
    const canonicalURL = canonical ?? `${SITE}${window.location.pathname}`

    if (description) {
      setMeta('meta[name="description"]', 'name', 'description', description)
      setMeta('meta[property="og:description"]', 'property', 'og:description', description)
      setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description)
    }
    setMeta('meta[property="og:title"]', 'property', 'og:title', title)
    setMeta('meta[name="twitter:title"]', 'name', 'twitter:title', title)
    setMeta('meta[property="og:image"]', 'property', 'og:image', ogImageURL)
    setMeta('meta[property="og:image:type"]', 'property', 'og:image:type', 'image/png')
    setMeta('meta[property="og:image:width"]', 'property', 'og:image:width', '1200')
    setMeta('meta[property="og:image:height"]', 'property', 'og:image:height', '630')
    setMeta('meta[name="twitter:image"]', 'name', 'twitter:image', ogImageURL)
    setMeta('meta[property="og:type"]', 'property', 'og:type', 'website')
    setMeta('meta[property="og:url"]', 'property', 'og:url', canonicalURL)
    setMeta('meta[property="og:site_name"]', 'property', 'og:site_name', 'Cartcrft')
    setMeta('meta[name="twitter:card"]', 'name', 'twitter:card', 'summary_large_image')
    setMeta('meta[name="twitter:site"]', 'name', 'twitter:site', '@cartcrft')

    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
    if (!link) {
      link = document.createElement('link')
      link.setAttribute('rel', 'canonical')
      document.head.appendChild(link)
    }
    link.setAttribute('href', canonicalURL)

    const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')
    if (noindex) {
      setMeta('meta[name="robots"]', 'name', 'robots', 'noindex, nofollow')
    } else if (robots) {
      robots.remove()
    }
  }, [title, description, ogImage, canonical, noindex])
}
