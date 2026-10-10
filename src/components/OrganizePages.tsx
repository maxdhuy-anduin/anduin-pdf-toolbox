import { useEffect, useRef, useState } from 'react'
import { Check, Copy, FileOutput, FilePlus2, Minus, Plus, RotateCcw, RotateCw, Trash2, Type } from 'lucide-react'
import { useApp } from '../context'
import { displaySize, movePages } from '../lib/model'
import { formatPageRange, parsePageRange } from '../lib/pageRange'
import { PageThumb } from './ThumbnailPanel'
import { Divider, ToolBtn } from './ui'

interface Props {
  onClose: (openIndex?: number) => void
  onInsert: () => void
  onExtract: () => void
  onDelete: () => void
}

const MIN = 110
const MAX = 280

/**
 * Organize pages: the whole document as a grid. Select (click, Shift-click a range, ⌘/Ctrl-click,
 * or type a range), drag pages anywhere to reorder, and extract / insert / rotate / duplicate /
 * delete. Everything goes through the same document model and undo history as the editor.
 */
export function OrganizePages({ onClose, onInsert, onExtract, onDelete }: Props) {
  const { state, dispatch, toast } = useApp()
  const { pages, sources, selection } = state
  const selected = new Set(selection)
  const [size, setSize] = useState(170)
  const [rangeText, setRangeText] = useState('')
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [dragIds, setDragIds] = useState<string[] | null>(null)
  const [dropBefore, setDropBefore] = useState<number | null>(null)
  const anchor = useRef(0)
  const gridRef = useRef<HTMLDivElement>(null)
  const n = pages.length
  const selIdx = pages.flatMap((p, i) => (selected.has(p.id) ? [i] : []))
  const has = selIdx.length > 0

  // reflect the selection in the range box unless the user is typing in it
  const typing = useRef(false)
  useEffect(() => {
    if (!typing.current) setRangeText(selIdx.length ? formatPageRange(selIdx).replace(/–/g, '-') : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx.join(',')])

  const applyRange = () => {
    typing.current = false
    if (!rangeText.trim()) {
      dispatch({ type: 'setSelection', ids: [] })
      setRangeError(null)
      return
    }
    const r = parsePageRange(rangeText, n)
    if (!r.ok) return setRangeError(r.error)
    setRangeError(null)
    dispatch({ type: 'setSelection', ids: r.indices.map((i) => pages[i].id) })
  }

  const onCardClick = (e: React.MouseEvent, i: number) => {
    const id = pages[i].id
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)]
      dispatch({ type: 'setSelection', ids: pages.slice(a, b + 1).map((p) => p.id) })
    } else if (e.metaKey || e.ctrlKey) {
      anchor.current = i
      dispatch({ type: 'setSelection', ids: selected.has(id) ? selection.filter((s) => s !== id) : [...selection, id] })
    } else {
      anchor.current = i
      dispatch({ type: 'setSelection', ids: [id] })
    }
  }

  // ---- drag & drop reordering (pointer events: mouse, pen and touch alike) ----
  const press = useRef<{ i: number; x: number; y: number; ids: string[] | null } | null>(null)
  const suppressClick = useRef(false)
  const [ghost, setGhost] = useState<{ x: number; y: number; count: number; i: number } | null>(null)
  const scrollVel = useRef(0)

  const dropIndexAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const card = el?.closest<HTMLElement>('[data-index]')
    if (card && gridRef.current?.contains(card)) {
      const i = Number(card.dataset.index)
      const r = card.getBoundingClientRect()
      return x < r.left + r.width / 2 ? i : i + 1
    }
    if (!el || !gridRef.current?.contains(el)) return null
    // empty space: before the first card that starts after the pointer (row-major), else the end
    const cards = [...gridRef.current.querySelectorAll<HTMLElement>('[data-index]')]
    for (const c of cards) {
      const r = c.getBoundingClientRect()
      if (r.bottom >= y && (r.top > y || r.left + r.width / 2 > x)) return Number(c.dataset.index)
    }
    return n
  }

  useEffect(() => {
    if (!ghost) return
    let raf = 0
    const tick = () => {
      if (scrollVel.current && gridRef.current) gridRef.current.scrollTop += scrollVel.current
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [!!ghost])

  const onPointerDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    press.current = { i, x: e.clientX, y: e.clientY, ids: null }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const pr = press.current
    if (!pr) return
    if (!pr.ids) {
      if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < 6) return
      const id = pages[pr.i].id
      pr.ids = selected.has(id) ? pages.filter((p) => selected.has(p.id)).map((p) => p.id) : [id]
      if (!selected.has(id)) dispatch({ type: 'setSelection', ids: pr.ids })
      setDragIds(pr.ids)
    }
    setGhost({ x: e.clientX, y: e.clientY, count: pr.ids.length, i: pr.i })
    setDropBefore(dropIndexAt(e.clientX, e.clientY))
    const g = gridRef.current?.getBoundingClientRect()
    const edge = 70
    scrollVel.current = !g ? 0 : e.clientY < g.top + edge ? -Math.min(24, (g.top + edge - e.clientY) / 3) : e.clientY > g.bottom - edge ? Math.min(24, (e.clientY - g.bottom + edge) / 3) : 0
  }
  const onPointerUp = () => {
    const pr = press.current
    press.current = null
    scrollVel.current = 0
    if (!pr?.ids) return
    suppressClick.current = true
    const before = dropBefore
    setGhost(null)
    setDragIds(null)
    setDropBefore(null)
    if (before === null) return
    const ids = pr.ids
    if (movePages(pages, ids, before).every((p, k) => p === pages[k])) return // dropped where it already was
    dispatch({ type: 'movePages', ids, before })
    const landed = pages.slice(0, before).filter((p) => !ids.includes(p.id)).length
    toast('info', `Moved ${ids.length > 1 ? `${ids.length} pages` : 'page'} to position ${landed + 1}. Undo with ⌘Z.`)
  }

  const act = (fn: () => void) => () => {
    if (has) fn()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      {/* toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-white px-3" role="toolbar" aria-label="Organize pages">
        <span className="eyebrow sky mr-2 whitespace-nowrap">Organize pages</span>
        <div className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor="page-range">Select pages</label>
          <input
            id="page-range"
            value={rangeText}
            placeholder="Select pages, e.g. 1-3, 5"
            onChange={(e) => {
              typing.current = true
              setRangeText(e.target.value)
              setRangeError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyRange()
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur()
            }}
            onBlur={applyRange}
            title={rangeError ?? 'Type pages or ranges and press Enter: 1-3, 5, 8-, odd, even, last'}
            className={`h-8 w-[190px] border bg-white px-2.5 font-mono text-[12.5px] text-ink focus:outline-none ${rangeError ? 'border-coral' : 'border-line focus:border-ink'}`}
          />
          <button type="button" className="h-8 px-2 text-[12.5px] font-medium text-ink-soft hover:text-ink" onClick={() => dispatch({ type: 'setSelection', ids: pages.map((p) => p.id) })}>
            All
          </button>
          <button type="button" className="h-8 px-2 text-[12.5px] font-medium text-ink-soft hover:text-ink disabled:text-faint" disabled={!has} onClick={() => dispatch({ type: 'setSelection', ids: [] })}>
            None
          </button>
        </div>
        <Divider />
        <ToolBtn icon={<FileOutput size={16} />} label="Extract" onClick={onExtract} title="Extract pages into a new PDF (selected pages or a range)" />
        <ToolBtn icon={<FilePlus2 size={16} />} label="Insert" onClick={onInsert} title="Insert pages from another PDF after the selection" />
        <ToolBtn icon={<RotateCcw size={16} />} label="Left" disabled={!has} onClick={act(() => dispatch({ type: 'rotatePages', ids: selection, delta: -90 }))} title="Rotate selected pages counter-clockwise" />
        <ToolBtn icon={<RotateCw size={16} />} label="Right" disabled={!has} onClick={act(() => dispatch({ type: 'rotatePages', ids: selection, delta: 90 }))} title="Rotate selected pages clockwise" />
        <ToolBtn icon={<Copy size={16} />} label="Duplicate" disabled={!has} onClick={act(() => dispatch({ type: 'duplicatePages', ids: selection }))} title="Duplicate selected pages" />
        <ToolBtn icon={<Trash2 size={16} />} label="Delete" disabled={!has} onClick={act(onDelete)} title="Delete selected pages (Delete)" />
        <div className="ml-auto flex items-center gap-1 pl-3">
          <span className="mr-2 whitespace-nowrap font-mono text-[11px] uppercase text-muted">{has ? `${selIdx.length} of ${n} selected` : `${n} pages`}</span>
          <ToolBtn iconOnly icon={<Minus size={15} />} label="Smaller thumbnails" disabled={size <= MIN} onClick={() => setSize((s) => Math.max(MIN, s - 30))} />
          <input aria-label="Thumbnail size" type="range" min={MIN} max={MAX} step={10} value={size} onChange={(e) => setSize(Number(e.target.value))} className="w-24 accent-[#141414]" />
          <ToolBtn iconOnly icon={<Plus size={15} />} label="Larger thumbnails" disabled={size >= MAX} onClick={() => setSize((s) => Math.min(MAX, s + 30))} />
          <Divider />
          <button
            type="button"
            onClick={() => onClose()}
            className="inline-flex h-8 items-center gap-1.5 bg-ink px-3 text-[13px] font-medium text-white hover:bg-ink-2"
            title="Back to the document (Esc)"
          >
            <Check size={14} />
            Done
          </button>
        </div>
      </div>

      {/* grid */}
      <div
        ref={gridRef}
        className="thin-scroll min-h-0 flex-1 overflow-y-auto"
        onClick={(e) => e.target === e.currentTarget && dispatch({ type: 'setSelection', ids: [] })}
      >
        <div className="flex flex-wrap content-start gap-x-5 gap-y-6 p-6" data-grid-fill onClick={(e) => e.target === e.currentTarget && dispatch({ type: 'setSelection', ids: [] })}>
          {pages.map((p, i) => {
            const info = sources[p.sourceId].pages[p.srcIndex]
            const ds = displaySize(p, info)
            // fit the rotated page inside a size×size box
            const w = ds.w >= ds.h ? size : (size * ds.w) / ds.h
            const thumbW = p.rotation % 180 ? (w * ds.h) / ds.w : w
            const isSel = selected.has(p.id)
            const dragging = dragIds?.includes(p.id)
            return (
              <div
                key={p.id}
                data-index={i}
                onPointerDown={(e) => onPointerDown(e, i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onClick={(e) => {
                  if (suppressClick.current) {
                    suppressClick.current = false
                    return
                  }
                  onCardClick(e, i)
                }}
                onDoubleClick={() => onClose(i)}
                aria-label={`Page ${i + 1}`}
                aria-selected={isSel}
                className={`group relative flex cursor-grab touch-none select-none flex-col items-center p-2 active:cursor-grabbing ${isSel ? 'bg-sky-soft ring-2 ring-sky-deep' : 'hover:bg-ink/[0.04]'} ${dragging ? 'opacity-35' : ''}`}
                style={{ width: size + 16 }}
              >
                {dropBefore === i && <div className="pointer-events-none absolute -left-[13px] bottom-1 top-1 w-[3px] bg-sky-deep" />}
                {dropBefore === n && i === n - 1 && <div className="pointer-events-none absolute -right-[13px] bottom-1 top-1 w-[3px] bg-sky-deep" />}
                <div className="flex items-center justify-center" style={{ height: size }}>
                  <PageThumb sourceId={p.sourceId} srcIndex={p.srcIndex} info={info} rotation={p.rotation} width={thumbW} crop={p.crop} />
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-ink-soft">
                  <span className={isSel ? 'text-sky-deep' : ''}>{i + 1}</span>
                  {p.overlays.length > 0 && (
                    <span title={`${p.overlays.length} edit(s) on this page`} className="inline-flex items-center gap-0.5 bg-line-soft px-1 text-[10px]">
                      <Type size={9} />
                      {p.overlays.length}
                    </span>
                  )}
                </div>
                {/* quick actions on hover */}
                <div className="absolute right-3 top-3 hidden gap-0.5 bg-ink/90 p-0.5 group-hover:flex" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                  {[
                    { icon: <RotateCcw size={13} />, label: 'Rotate left', run: () => dispatch({ type: 'rotatePages', ids: [p.id], delta: -90 }) },
                    { icon: <RotateCw size={13} />, label: 'Rotate right', run: () => dispatch({ type: 'rotatePages', ids: [p.id], delta: 90 }) },
                    {
                      icon: <Trash2 size={13} />,
                      label: 'Delete page',
                      run: () => (n > 1 ? dispatch({ type: 'deletePages', ids: [p.id] }) : toast('warning', 'A PDF needs at least one page.')),
                    },
                  ].map((b) => (
                    <button key={b.label} type="button" title={b.label} aria-label={`${b.label} ${i + 1}`} onClick={b.run} className="flex h-6 w-6 items-center justify-center text-white/85 hover:bg-white/15 hover:text-white">
                      {b.icon}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        {ghost && (
          <div className="pointer-events-none fixed z-[80]" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>
            <div className="relative">
              {ghost.count > 1 && <div className="absolute left-1.5 top-1.5 h-full w-full border border-line bg-white" />}
              <div className="relative border border-sky-deep bg-white p-1 shadow-xl" style={{ width: 70 }}>
                <PageThumb sourceId={pages[ghost.i].sourceId} srcIndex={pages[ghost.i].srcIndex} info={sources[pages[ghost.i].sourceId].pages[pages[ghost.i].srcIndex]} rotation={pages[ghost.i].rotation} width={60} crop={pages[ghost.i].crop} />
              </div>
              {ghost.count > 1 && <span className="absolute -right-2 -top-2 bg-ink px-1.5 py-[1px] font-mono text-[10.5px] font-semibold text-white">{ghost.count}</span>}
            </div>
          </div>
        )}
        <p className="px-6 pb-8 text-[12px] text-muted">
          Drag pages to reorder them (drag a selection to move several). Shift-click selects a range, ⌘/Ctrl-click adds a page. Double-click a page to open it.
        </p>
      </div>
    </div>
  )
}
