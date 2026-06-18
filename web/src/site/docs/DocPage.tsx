import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
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
 *
 * Security: doc markdown may embed raw HTML (rehypeRaw). Without sanitisation
 * that is a stored-XSS sink (a doc author / PR could inject <script>). We run
 * rehypeSanitize AFTER rehypeRaw so the parsed raw HTML is scrubbed against an
 * allow-list before it ever reaches the DOM.
 *
 * The sanitiser uses hast-util-sanitize's defaultSchema with two tweaks needed
 * to keep our rendering intact:
 *  - clobberPrefix: ''  — the default prefixes element ids with "user-content-"
 *    to prevent DOM clobbering. We render trusted-author docs (not arbitrary
 *    user input) and DocsLayout's TOC scroll-spy looks up the *unprefixed*
 *    rehype-slug ids via getElementById, so we disable the prefix.
 *  - allow `className` on code/span/pre — rehype-highlight emits hljs-* token
 *    classes on <span>/<pre> that the default schema would strip, killing
 *    syntax highlighting. (className on <code> is already allowed by default.)
 * The allow-list still removes <script>, event handlers (onerror, …), and
 * other dangerous markup.
 */
const sanitizeSchema = {
  ...defaultSchema,
  clobberPrefix: '',
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    span: [...(defaultSchema.attributes?.span ?? []), 'className'],
    pre: [...(defaultSchema.attributes?.pre ?? []), 'className'],
  },
}
export default function DocPage({ slug }: { slug: string }) {
  const doc = docMap[slug]
  const articleRef = useRef<HTMLElement | null>(null)

  // Always call hooks unconditionally; fall back to a safe title if missing.
  useDocumentMeta({
    title: doc ? `${doc.title} · CartCrft Docs` : 'CartCrft Docs',
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
    <SiteLayout noFooter>
      <DocsLayout slug={slug} articleRef={articleRef}>
        <article className="docs-article" ref={articleRef}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[
              rehypeSlug,
              rehypeRaw,
              rehypeHighlight,
              // Sanitise AFTER raw HTML is parsed (and after highlight adds its
              // hljs-* classes, which sanitizeSchema allow-lists) — this is the
              // XSS guard on author-supplied raw HTML in docs.
              [rehypeSanitize, sanitizeSchema],
            ]}
          >
            {doc.body}
          </ReactMarkdown>
        </article>
      </DocsLayout>
    </SiteLayout>
  )
}
