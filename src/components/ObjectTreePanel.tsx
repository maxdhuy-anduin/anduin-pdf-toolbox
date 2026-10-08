import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ClipboardCopy, X } from 'lucide-react'
import { useApp } from '../context'
import { formatTree, chunkTag, snippet, treeRows } from '../lib/layout/tree'
import type { ChunkType } from '../lib/layout/types'
import { CHUNK_COLORS, useLayoutPage } from './LayoutLayer'
import { Eyebrow } from './ui'

const COUNTED: [string, ChunkType[]][] = [
  ['Headings', ['HEADING']],
  ['Paragraphs', ['PARAGRAPH']],
  ['Lists', ['LIST']],
  ['Tables', ['TABLE']],
  ['Cells', ['TABLE_CELL']],
  ['Graphics', ['LINE', 'RECTANGLE', 'IMAGE', 'FIGURE']],
]

/** Developer panel: the current page's layout as a tree. Hover highlights on the page; click pins (and selects in Edit mode). */
export function ObjectTreePanel() {
  const { state, currentIndex, setShowTree, treeFocus, setTreeFocus, tool, setSelectedObject, scrollToPage, toast } = useApp()
  const page = state.pages[currentIndex]
  const layout = useLayoutPage(page?.sourceId, page?.srcIndex ?? 0, !!page)
  const [lines, setLines] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const rows = useMemo(() => {
    if (!layout) return []
    const all = treeRows(layout, { includeTextLines: lines })
    // drop rows below a collapsed ancestor
    const out: typeof all = []
    let hideBelow = Infinity
    for (const r of all) {
      if (r.depth > hideBelow) continue
      hideBelow = collapsed.has(r.id) ? r.depth : Infinity
      out.push(r)
    }
    return out
  }, [layout, lines, collapsed])

  const visibleKids = (id: string) => (layout ? layout.chunks[id].children.filter((k) => lines || !['TEXT_LINE', 'TEXT_SPAN'].includes(layout.chunks[k].type)).length : 0)
  const focused = treeFocus?.pageId === page?.id ? treeFocus?.chunkId : null
  const pinned = treeFocus?.pinned ? treeFocus.chunkId : null

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-white" aria-label="Object tree" data-keep-selection>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Eyebrow>Object tree</Eyebrow>
        <span className="font-mono text-[10.5px] text-muted">Page {currentIndex + 1}</span>
        <button
          type="button"
          className="ml-auto p-1 text-muted hover:text-ink"
          title="Copy tree as text"
          aria-label="Copy tree as text"
          disabled={!layout}
          onClick={() => {
            if (!layout) return
            navigator.clipboard?.writeText(`Page ${currentIndex + 1}\n${formatTree(layout, { includeTextLines: lines })}`).then(
              () => toast('success', 'Object tree copied as text.'),
              () => toast('error', 'The clipboard is not available here.'),
            )
          }}
        >
          <ClipboardCopy size={14} />
        </button>
        <button type="button" className="p-1 text-muted hover:text-ink" aria-label="Close object tree" onClick={() => setShowTree(false)}>
          <X size={14} />
        </button>
      </div>

      {!layout ? (
        <div className="p-4 text-[12.5px] text-muted">Analyzing page…</div>
      ) : (
        <>
          <div className="border-b border-line px-3 py-2.5">
            <div className="mb-2 flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em]">
              <span className="border border-line px-1.5 py-[1px] text-ink-soft">{layout.provider === 'adobe' ? 'Adobe Extract' : layout.provider === 'local-basic' ? 'Basic text' : 'Local'}</span>
              <span className={`border px-1.5 py-[1px] ${layout.status === 'structured' ? 'border-line text-ink-soft' : 'border-coral/60 text-coral'}`}>{layout.status}</span>
              <span className="text-muted">{Object.keys(layout.chunks).length} chunks · {layout.ms.toFixed(0)} ms</span>
            </div>
            <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 text-[11.5px] text-ink-soft">
              {COUNTED.map(([label, types]) => (
                <span key={label}>
                  <span className="tabular-nums font-semibold text-ink">{Object.values(layout.chunks).filter((c) => types.includes(c.type)).length}</span> {label}
                </span>
              ))}
            </div>
            {layout.warnings.map((w) => (
              <p key={w} className="mt-2 border-l-2 border-coral bg-coral-soft px-2 py-1 text-[11.5px] text-ink-soft">
                {w}
              </p>
            ))}
            <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-soft">
              <input type="checkbox" checked={lines} onChange={(e) => setLines(e.target.checked)} />
              Show text lines and spans
            </label>
          </div>
          <div className="thin-scroll min-h-0 flex-1 overflow-y-auto py-1" onPointerLeave={() => !pinned && setTreeFocus(null)}>
            {rows.length === 0 && <div className="px-3 py-2 text-[12.5px] text-muted">No objects detected on this page.</div>}
            {rows.map(({ id, depth }) => {
              const c = layout.chunks[id]
              const n = visibleKids(id)
              const isCollapsed = collapsed.has(id)
              const active = focused === id
              return (
                <div
                  key={id}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={n ? !isCollapsed : undefined}
                  aria-selected={pinned === id}
                  className={`group flex cursor-default items-center gap-1 py-[3px] pr-2 text-[12px] ${active ? 'bg-sky-soft' : 'hover:bg-wash'} ${pinned === id ? 'shadow-[inset_2px_0_0_#1075dc]' : ''}`}
                  style={{ paddingLeft: 6 + depth * 14 }}
                  onPointerEnter={() => page && (!pinned || pinned === id) && setTreeFocus({ pageId: page.id, chunkId: id, pinned: false })}
                  onClick={() => {
                    if (!page) return
                    if (pinned === id) {
                      setTreeFocus(null)
                      return
                    }
                    setTreeFocus({ pageId: page.id, chunkId: id, pinned: true })
                    scrollToPage(currentIndex)
                    if (tool === 'edit' && c.source.objectId && layout.hitOrder.includes(c.id)) setSelectedObject({ pageId: page.id, objectId: c.source.objectId })
                  }}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className={`flex h-4 w-4 shrink-0 items-center justify-center text-muted ${n ? '' : 'invisible'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setCollapsed((s) => {
                        const next = new Set(s)
                        if (next.has(id)) next.delete(id)
                        else next.add(id)
                        return next
                      })
                    }}
                    aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <span className="inline-block h-2 w-2 shrink-0" style={{ background: CHUNK_COLORS[c.type] }} />
                  <span className="shrink-0 font-mono text-[10.5px] font-medium text-ink">{chunkTag(c)}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-soft">{c.type === 'TABLE' || c.type === 'TABLE_ROW' || c.type === 'LIST' ? '' : snippet(c.text, 60)}</span>
                  {n > 0 && isCollapsed && <span className="font-mono text-[10px] text-muted">{n}</span>}
                </div>
              )
            })}
          </div>
        </>
      )}
    </aside>
  )
}
