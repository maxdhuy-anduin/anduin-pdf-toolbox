import { memo, useEffect, useRef, useState } from 'react'
import { Type } from 'lucide-react'
import { useApp } from '../context'
import { displaySize, type PageInfo } from '../lib/model'
import { getCachedThumb, renderThumb, THUMB_WIDTH } from '../lib/thumbs'
import { Rotated } from './ui'

/** Renders (lazily, once per source page) a thumbnail into a canvas. Shared by the panel and the insert dialog. */
export const PageThumb = memo(function PageThumb({
  sourceId,
  srcIndex,
  info,
  rotation = 0,
  width = THUMB_WIDTH,
}: {
  sourceId: string
  srcIndex: number
  info: PageInfo
  rotation?: number
  width?: number
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(!!getCachedThumb(sourceId, srcIndex))
  const [failed, setFailed] = useState(false)
  const h = (width * info.height) / info.width

  // Only thumbnails near the viewport hold pixels; the rest are released.
  useEffect(() => {
    if (!wrapRef.current) return
    const io = new IntersectionObserver((entries) => setVisible(entries[entries.length - 1].isIntersecting), { rootMargin: '600px' })
    io.observe(wrapRef.current)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    const c = canvasRef.current
    if (!visible) {
      if (c) {
        c.width = 0
        c.height = 0
      }
      return
    }
    let cancelled = false
    renderThumb(sourceId, srcIndex, info)
      .then((src) => {
        const c = canvasRef.current
        if (cancelled || !c) return
        c.width = src.width
        c.height = src.height
        c.getContext('2d')?.drawImage(src, 0, 0)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [visible, sourceId, srcIndex, info])

  return (
    <div ref={wrapRef}>
      <Rotated w={width} h={h} rotation={rotation}>
        <div className="h-full w-full bg-white shadow-[0_0_0_1px_rgba(20,20,20,0.12)]">
          {failed ? (
            <div className="flex h-full items-center justify-center text-[10px] text-faint">Preview unavailable</div>
          ) : (
            <canvas ref={canvasRef} className="block h-full w-full" />
          )}
        </div>
      </Rotated>
    </div>
  )
})

export function ThumbnailPanel() {
  const { state, dispatch, currentIndex, scrollToPage } = useApp()
  const { pages, sources, selection } = state
  const [dragIds, setDragIds] = useState<string[] | null>(null)
  const [dropBefore, setDropBefore] = useState<number | null>(null)
  const anchor = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = new Set(selection)

  // Keep the current page's thumbnail in view while scrolling the document.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${currentIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [currentIndex])

  const onClick = (e: React.MouseEvent, i: number) => {
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
      scrollToPage(i)
    }
  }

  const onDragStart = (e: React.DragEvent, i: number) => {
    const id = pages[i].id
    let ids = selected.has(id) ? pages.filter((p) => selected.has(p.id)).map((p) => p.id) : [id]
    if (!selected.has(id)) dispatch({ type: 'setSelection', ids })
    ids = pages.filter((p) => ids.includes(p.id)).map((p) => p.id)
    setDragIds(ids)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-anduin-pages', ids.join(','))
  }

  const onDragOverItem = (e: React.DragEvent, i: number) => {
    if (!dragIds) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const r = e.currentTarget.getBoundingClientRect()
    setDropBefore(e.clientY < r.top + r.height / 2 ? i : i + 1)
  }

  const finishDrag = () => {
    setDragIds(null)
    setDropBefore(null)
  }

  const onDrop = (e: React.DragEvent) => {
    if (!dragIds || dropBefore === null) return finishDrag()
    e.preventDefault()
    dispatch({ type: 'movePages', ids: dragIds, before: dropBefore })
    finishDrag()
  }

  return (
    <aside className="flex w-[212px] shrink-0 flex-col border-r border-line bg-wash" aria-label="Page thumbnails">
      <div className="flex h-10 items-center justify-between border-b border-line px-3">
        <span className="eyebrow sky">Pages</span>
        <span className="font-mono text-[10.5px] uppercase text-muted">{selection.length > 1 ? `${selection.length} selected` : `${pages.length} total`}</span>
      </div>
      <div
        ref={listRef}
        className="thin-scroll flex-1 overflow-y-auto px-3 py-3"
        onDragOver={(e) => {
          if (dragIds && e.target === e.currentTarget) {
            e.preventDefault()
            setDropBefore(pages.length)
          }
        }}
        onDrop={onDrop}
        onClick={(e) => e.target === e.currentTarget && dispatch({ type: 'setSelection', ids: [] })}
      >
        {pages.map((p, i) => {
          const info = sources[p.sourceId].pages[p.srcIndex]
          const isSel = selected.has(p.id)
          const isCurrent = i === currentIndex
          const ds = displaySize(p, info)
          const thumbH = (THUMB_WIDTH * (ds.h / ds.w)) // rotated footprint height
          return (
            <div
              key={p.id}
              data-index={i}
              draggable
              onDragStart={(e) => onDragStart(e, i)}
              onDragOver={(e) => onDragOverItem(e, i)}
              onDragEnd={finishDrag}
              onClick={(e) => onClick(e, i)}
              className={`group relative mb-3 cursor-grab p-1.5 transition-colors active:cursor-grabbing ${
                isSel ? 'bg-sky-soft ring-2 ring-sky-deep' : isCurrent ? 'bg-white ring-1 ring-line' : 'hover:bg-ink/5'
              } ${dragIds?.includes(p.id) ? 'opacity-40' : ''}`}
              aria-label={`Page ${i + 1}`}
              aria-selected={isSel}
              style={{ minHeight: Math.min(thumbH, 400) }}
            >
              {dropBefore === i && <div className="pointer-events-none absolute -top-2 left-0 right-0 h-1 bg-sky-deep" />}
              {dropBefore === pages.length && i === pages.length - 1 && <div className="pointer-events-none absolute -bottom-2 left-0 right-0 h-1 bg-sky-deep" />}
              <div className="flex justify-center">
                <PageThumb sourceId={p.sourceId} srcIndex={p.srcIndex} info={info} rotation={p.rotation} />
              </div>
              <div className="mt-1.5 flex items-center justify-center gap-1.5 text-[11px] font-medium text-ink-soft">
                <span className={isCurrent ? 'text-sky-deep' : ''}>{i + 1}</span>
                {p.overlays.length > 0 && (
                  <span title={`${p.overlays.length} text edit(s)`} className="inline-flex items-center gap-0.5 bg-line-soft px-1 text-[10px] text-ink-soft">
                    <Type size={9} />
                    {p.overlays.length}
                  </span>
                )}
              </div>
            </div>
          )
        })}
        <div className="h-4" />
      </div>
    </aside>
  )
}
