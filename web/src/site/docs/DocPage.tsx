import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import { Link } from 'react-router-dom'
import SiteLayout from '../SiteLayout'
import { useDocumentMeta } from '../useDocumentMeta'
import DocsLayout from './DocsLayout'
import { docMap } from './index'
import 'highlight.js/styles/github.css'
import 'highlight.js/styles/github-dark.css'

/**
 * DocPage — renders a single doc by slug inside the shared SiteLayout chrome,
 * with the docs sidebar + TOC shell (DocsLayout) around the markdown article.
 *
 * Two highlight.js themes are imported (github + github-dark); DocsLayout.css
 * toggles between them via a prefers-color-scheme guard on `.hljs`.
 */
export default function DocPage({ slug }: { slug: string }) {
  const doc = docMap[slug]
  const articleRef = useRef<HTMLElement | null>(null)

  // Always call hooks unconditionally; fall back to a safe title if missing.
  useDocumentMeta({
    title: doc ? `${doc.title} · Cartcrft Docs` : 'Cartcrft Docs',
    description: doc?.description,
  })

  if (!doc) {
    return (
      <SiteLayout>
        <section style={{ maxWidth: 720, margin: '0 auto', padding: '6rem 1.5rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 800 }}>Page not found</h1>
          <p style={{ marginTop: '1rem' }}>
            <Link to="/quickstart">Back to the docs</Link>
          </p>
        </section>
      </SiteLayout>
    )
  }

  return (
    <SiteLayout>
      <DocsLayout slug={slug} articleRef={articleRef}>
        <article className="docs-article" ref={articleRef}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSlug, rehypeRaw, rehypeHighlight]}
          >
            {doc.body}
          </ReactMarkdown>
        </article>
      </DocsLayout>
    </SiteLayout>
  )
}
