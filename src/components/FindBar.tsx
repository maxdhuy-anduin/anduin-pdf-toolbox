import { useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Loader2, Replace, WholeWord, X } from 'lucide-react'
import { useApp, type SearchView } from '../context'
import { getCachedContent, getPageContent } from '../lib/content/cache'
import { pageUnits, planReplace, search, type Hit, type SearchOptions } from '../lib/search'

interface Props {
  /** Bumped by ⌘F / ⌥⌘F to focus the field again. */
  focusNonce: number
  replaceOpen: boolean
  setReplaceOpen: (v: boolean) => void
  /** ⌘G / ⇧⌘G from anywhere. */
  stepRequest: { dir: 1 | -1; nonce: number } | null
  onClose: () => void
  setSearch: (s: SearchView | null) => void
  /** Distance from the top of the viewer (below the ruler when it's shown). */
  top: number
}

function Toggle({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className={`flex h-7 w-7 shrink-0 items-center justify-center border ${on ? 'border-ink bg-ink text-white' : 'border-transparent text-ink-soft hover:border-line hover:text-ink'}`}
    >
      {children}
    </button>
  )
}

export function FindBar({ focusNonce, replaceOpen, setReplaceOpen, stepRequest, onClose, setSearch, top }: Props) {
  const { state, dispatch, scrollToPage, toast } = useApp()
  const [query, setQuery] = useState('')
  const [repl, setRepl] = useState('')
  const [opts, setOpts] = useState<SearchOptions>({ matchCase: false, wholeWord: false })
  const [keepCase, setKeepCase] = useState(false)
  const [ready, setReady] = useState(0)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const replInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = replaceOpen && query ? replInput.current : input.current
    el?.focus()
    el?.select()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce])

  // every page's text must be analyzed before the results are complete
  const pageKeys = state.pages.map((p) => `${p.sourceId}:${p.srcIndex}`).join('|')
  useEffect(() => {
    let live = true
    const todo = state.pages.filter((p) => !state.sources[p.sourceId]?.likelyScanned && !getCachedContent(p.sourceId, p.srcIndex))
    if (!todo.length) return
    setLoading(true)
    Promise.allSettled(todo.map((p) => getPageContent(p.sourceId, p.srcIndex))).then(() => {
      if (!live) return
      setLoading(false)
      setReady((n) => n + 1)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKeys])

  // what can be searched only changes with the document; matching runs on every keystroke
  const units = useMemo(
    () => state.pages.flatMap((p, i) => pageUnits(p, i, getCachedContent(p.sourceId, p.srcIndex), state.draft?.pageId === p.id ? state.draft.overlay : null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.pages, state.draft, ready],
  )
  const hits = useMemo<Hit[]>(() => (query ? search(units, query, opts) : []), [units, query, opts])

  const idx = hits.length ? Math.min(active, hits.length - 1) : -1
  const current = idx >= 0 ? hits[idx] : null
  useEffect(() => {
    setSearch(query ? { hits, activeId: current?.id ?? null } : null)
  }, [hits, current?.id, query, setSearch])
  useEffect(() => () => setSearch(null), [setSearch])

  const go = (i: number) => {
    if (!hits.length) return
    const n = (i + hits.length) % hits.length
    setActive(n)
    const h = hits[n]
    // bring the page into the viewer; the highlight scrolls itself into view once it's rendered
    if (!document.querySelector(`[data-page-id="${h.pageId}"]`)) scrollToPage(h.pageIndex)
  }
  useEffect(() => {
    if (stepRequest) go(idx + stepRequest.dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepRequest])
  // a new query starts at the first match
  useEffect(() => {
    setActive(0)
    if (hits[0] && !document.querySelector(`[data-page-id="${hits[0].pageId}"]`)) scrollToPage(hits[0].pageIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts.matchCase, opts.wholeWord])

  const canvasOf = (pageId: string) => document.querySelector<HTMLCanvasElement>(`[data-page-id="${pageId}"] canvas:not([data-layer])`)
  const replace = (which: Hit[]) => {
    if (!which.length) return
    const { edits, count } = planReplace(state.pages, (p) => getCachedContent(p.sourceId, p.srcIndex), which, repl, keepCase, canvasOf)
    if (!count) return
    dispatch({ type: 'editMany', edits })
    return count
  }
  const replaceOne = () => {
    if (!current) return
    replace([current])
    // the next match takes this one's place in the list
  }
  const replaceAll = () => {
    const n = replace(hits)
    if (n) toast('success', `Replaced ${n} match${n > 1 ? 'es' : ''}. Undo with ⌘Z.`)
  }
  const touchesPdf = hits.some((h) => !h.overlayId)

  return (
    <div
      className="absolute right-4 z-30 w-[380px] max-w-[calc(100%-32px)] border border-line bg-white shadow-[0_6px_24px_-8px_rgba(20,20,20,0.35)]"
      style={{ top }}
      role="search"
      aria-label="Find and replace"
      data-keep-selection
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        // ⌘F / ⌥⌘F / ⌘G / ⌘S reach the app; other keys stay in the bar
        if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyF' || e.code === 'KeyS' || /^[fs]$/i.test(e.key))) return
        e.stopPropagation()
      }}
    >
      <div className="flex items-center gap-1 px-1.5 py-1.5">
        <button
          type="button"
          aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
          title={replaceOpen ? 'Hide replace' : 'Replace (⌥⌘F)'}
          onClick={() => setReplaceOpen(!replaceOpen)}
          className="flex h-7 w-5 shrink-0 items-center justify-center text-muted hover:text-ink"
        >
          {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <input
          ref={input}
          aria-label="Find"
          placeholder="Find in document"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go(idx + (e.shiftKey ? -1 : 1))
            }
            const mod = e.metaKey || e.ctrlKey
            if (mod && e.key.toLowerCase() === 'g') {
              e.preventDefault()
              go(idx + (e.shiftKey ? -1 : 1))
            }
          }}
          className="h-7 min-w-0 flex-1 border border-line bg-white px-2 text-[13px] text-ink focus:border-ink focus:outline-none"
        />
        <Toggle on={opts.matchCase} onClick={() => setOpts({ ...opts, matchCase: !opts.matchCase })} label="Match case">
          <CaseSensitive size={16} />
        </Toggle>
        <Toggle on={opts.wholeWord} onClick={() => setOpts({ ...opts, wholeWord: !opts.wholeWord })} label="Whole words only">
          <WholeWord size={16} />
        </Toggle>
        <span className="min-w-[58px] shrink-0 whitespace-nowrap px-0.5 text-center font-mono text-[11px] tabular-nums text-muted" aria-live="polite">
          {loading ? <Loader2 size={13} className="mx-auto animate-spin" /> : query ? (hits.length ? `${idx + 1} of ${hits.length}` : 'No results') : ''}
        </span>
        <button type="button" aria-label="Previous match" title="Previous (⇧↵ / ⇧⌘G)" disabled={!hits.length} onClick={() => go(idx - 1)} className="flex h-7 w-6 items-center justify-center text-ink-soft hover:text-ink disabled:text-faint">
          <ChevronUp size={15} />
        </button>
        <button type="button" aria-label="Next match" title="Next (↵ / ⌘G)" disabled={!hits.length} onClick={() => go(idx + 1)} className="flex h-7 w-6 items-center justify-center text-ink-soft hover:text-ink disabled:text-faint">
          <ChevronDown size={15} />
        </button>
        <button type="button" aria-label="Close find" title="Close (Esc)" onClick={onClose} className="flex h-7 w-6 items-center justify-center text-ink-soft hover:text-ink">
          <X size={15} />
        </button>
      </div>
      {replaceOpen && (
        <div className="border-t border-line-soft px-1.5 pb-2 pt-1.5">
          <div className="flex items-center gap-1 pl-6">
            <input
              ref={replInput}
              aria-label="Replace with"
              placeholder="Replace with"
              value={repl}
              onChange={(e) => setRepl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.metaKey || e.ctrlKey) replaceAll()
                  else replaceOne()
                }
              }}
              className="h-7 min-w-0 flex-1 border border-line bg-white px-2 text-[13px] text-ink focus:border-ink focus:outline-none"
            />
            <Toggle on={keepCase} onClick={() => setKeepCase(!keepCase)} label="Preserve case (Fund → Trust, FUND → TRUST)">
              <span className="font-mono text-[11px] font-semibold">AB</span>
            </Toggle>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 pl-6">
            <button type="button" disabled={!current} onClick={replaceOne} className="flex h-7 items-center gap-1.5 border border-line px-2.5 text-[12.5px] text-ink hover:border-ink disabled:text-faint disabled:hover:border-line">
              <Replace size={13} /> Replace
            </button>
            <button type="button" disabled={!hits.length} onClick={replaceAll} className="flex h-7 items-center gap-1.5 border border-ink bg-ink px-2.5 text-[12.5px] text-white disabled:border-line disabled:bg-white disabled:text-faint">
              Replace all{hits.length ? ` (${hits.length})` : ''}
            </button>
          </div>
          {touchesPdf && (
            <p className="mt-2 pl-6 text-[11.5px] leading-snug text-muted">
              Replacing text that is part of the PDF re-types that paragraph or cell with the closest available font, like editing it by hand. Undo with ⌘Z.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
