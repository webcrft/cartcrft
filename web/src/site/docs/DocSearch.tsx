import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import MiniSearch from 'minisearch'
import { Search } from 'lucide-react'
import { docList } from './index'

/**
 * DocSearch — a ⌘K / Ctrl-K search modal backed by MiniSearch over every doc's
 * {title, description, body}. Lives in the sidebar; opens a centred dialog.
 * Keyboard accessible: ↑/↓ to move, Enter to open, Esc to close.
 */

interface SearchHit {
  slug: string
  path: string
  title: string
  description: string
  snippet: string
}

function buildIndex() {
  const mini = new MiniSearch<{
    id: string
    slug: string
    path: string
    title: string
    description: string
    body: string
  }>({
    fields: ['title', 'description', 'body'],
    storeFields: ['slug', 'path', 'title', 'description', 'body'],
    searchOptions: {
      boost: { title: 4, description: 2 },
      prefix: true,
      fuzzy: 0.2,
    },
  })
  mini.addAll(
    docList.map((d) => ({
      id: d.slug,
      slug: d.slug,
      path: d.path,
      title: d.title,
      description: d.description,
      body: d.body,
    })),
  )
  return mini
}

/** Pull a short context snippet around the first matched term in the body. */
function makeSnippet(body: string, query: string): string {
  const plain = body.replace(/[#>*`_\-|]/g, ' ').replace(/\s+/g, ' ').trim()
  const term = query.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const idx = term ? plain.toLowerCase().indexOf(term) : -1
  if (idx === -1) return plain.slice(0, 120)
  const start = Math.max(0, idx - 40)
  return (start > 0 ? '… ' : '') + plain.slice(start, start + 140)
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function DocSearch({ variant: _variant }: { variant?: 'sidebar' | 'hero' } = {}) {
  const navigate = useNavigate()
  const mini = useMemo(buildIndex, [])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // ⌘K / Ctrl-K opens the modal from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus the input + reset state when opened.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // Defer focus until the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Lock body scroll while open.
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = ''
      }
    }
    return undefined
  }, [open])

  const results: SearchHit[] = useMemo(() => {
    if (!query.trim()) return []
    return mini
      .search(query)
      .slice(0, 8)
      .map((r) => ({
        slug: String(r['slug']),
        path: String(r['path']),
        title: String(r['title']),
        description: String(r['description']),
        snippet: makeSnippet(String(r['body'] ?? ''), query),
      }))
  }, [mini, query])

  // Keep the active index in range as results change.
  useEffect(() => {
    setActive(0)
  }, [query])

  function go(hit: SearchHit | undefined) {
    if (!hit) return
    setOpen(false)
    navigate(hit.path)
  }

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      go(results[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <>
      <button className="docs-search-trigger" onClick={() => setOpen(true)}>
        <Search size={15} aria-hidden="true" />
        <span>Search docs</span>
        <kbd className="docs-search-kbd">⌘K</kbd>
      </button>

      {open && (
        <div
          className="docs-search-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Search documentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div className="docs-search-modal">
            <div className="docs-search-input-row">
              <Search size={18} aria-hidden="true" className="docs-search-input-icon" />
              <input
                ref={inputRef}
                type="text"
                className="docs-search-input"
                placeholder="Search the docs…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                aria-label="Search query"
                autoComplete="off"
                spellCheck={false}
              />
              <kbd className="docs-search-kbd">Esc</kbd>
            </div>

            {query.trim() !== '' && (
              <ul className="docs-search-results" role="listbox">
                {results.length === 0 ? (
                  <li className="docs-search-empty">No results for “{query}”.</li>
                ) : (
                  results.map((hit, i) => (
                    <li key={hit.slug} role="option" aria-selected={i === active}>
                      <button
                        className={`docs-search-result${i === active ? ' is-active' : ''}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(hit)}
                      >
                        <span className="docs-search-result-title">{hit.title}</span>
                        <span className="docs-search-result-snippet">
                          {hit.description || hit.snippet}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </>
  )
}
