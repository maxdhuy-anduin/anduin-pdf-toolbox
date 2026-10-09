import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../context'
import { clientToCanvas } from '../lib/coords'
import type { PageInfo, PageModel } from '../lib/model'
import { getCachedLayout, getPageLayout, onLayoutChange } from '../lib/layout/cache'
import { chunkTag, snippet } from '../lib/layout/tree'
import type { ChunkType, LayoutChunk, LayoutPage } from '../lib/layout/types'

/** Outline colours per type: distinct but quiet, drawn from the Anduin palette. */
export const CHUNK_COLORS: Record<ChunkType, string> = {
  HEADING: '#1075dc',
  PARAGRAPH: '#3fa6ee',
  LIST: '#0f766e',
  LIST_ITEM: '#14b8a6',
  TEXT_LINE: '#94a3b8',
  TEXT_SPAN: '#cbd5e1',
  TABLE: '#162950',
  TABLE_ROW: '#8b9bbd',
  TABLE_CELL: '#b08850',
  LINE: '#ef6445',
  RECTANGLE: '#a855f7',
  IMAGE: '#e08a00',
  FIGURE: '#e08a00',
}

export const CHUNK_LEGEND: [string, ChunkType][] = [
  ['Heading', 'HEADING'],
  ['Paragraph', 'PARAGRAPH'],
  ['List / item', 'LIST_ITEM'],
  ['Table', 'TABLE'],
  ['Table cell', 'TABLE_CELL'],
  ['Line / rule', 'LINE'],
  ['Rectangle', 'RECTANGLE'],
  ['Image / figure', 'IMAGE'],
]

/** Cached layout of a source page (computed once by the active provider). */
export function useLayoutPage(sourceId: string | undefined, pageIndex: number, enabled: boolean): LayoutPage | undefined {
  const { layoutProvider } = useApp()
  const [layout, setLayout] = useState<LayoutPage | undefined>(() => (sourceId ? getCachedLayout(sourceId, pageIndex) : undefined))
  useEffect(() => {
    if (!sourceId || !enabled) return
    let live = true
    const load = () => {
      const cached = getCachedLayout(sourceId, pageIndex)
      if (cached) setLayout(cached)
      else getPageLayout(sourceId, pageIndex).then((l) => live && setLayout(l)).catch(() => undefined)
    }
    load()
    const off = onLayoutChange(() => live && load())
    return () => {
      live = false
      off()
    }
  }, [sourceId, pageIndex, enabled, layoutProvider])
  return layout
}

const STRUCTURAL = new Set<ChunkType>(['HEADING', 'PARAGRAPH', 'LIST', 'LIST_ITEM', 'TABLE', 'TABLE_CELL', 'LINE', 'RECTANGLE', 'IMAGE', 'FIGURE'])

interface Props {
  page: PageModel
  info: PageInfo
  scale: number
  /** Ids of chunks whose original content has been replaced by an edit. */
  edited: Set<string>
}

/**
 * Bounding boxes for detected layout chunks, drawn in canonical page space × zoom. The layer sits
 * inside the page's rotated container, so zoom, scrolling, app rotation and resizing all apply.
 *  - "Show bounding boxes": structural chunks, subtle outlines
 *  - "Show detected objects" (debug): every chunk incl. lines/spans, tags, hover inspector
 */
export function LayoutLayer({ page, info, scale, edited }: Props) {
  const { showBoxes, debug } = useApp()
  const layout = useLayoutPage(page.sourceId, page.srcIndex, showBoxes || debug)
  const ref = useRef<HTMLDivElement>(null)
  const [hit, setHit] = useState<{ c: LayoutChunk; x: number; y: number } | null>(null)

  // innermost chunk first (rows/lists are containers, not useful to inspect by hover)
  const ordered = useMemo(
    () => (layout ? Object.values(layout.chunks).filter((c) => c.type !== 'TABLE_ROW' && c.type !== 'LIST').sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height) : []),
    [layout],
  )

  useEffect(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!debug || !el || !host) return
    const onMove = (e: PointerEvent) => {
      const p = clientToCanvas(e.clientX, e.clientY, el, { scale, rotation: page.rotation, width: info.width, height: info.height })
      const slop = 3 / scale
      const c = ordered.find((ch) => p.x >= ch.bounds.x - slop && p.x <= ch.bounds.x + ch.bounds.width + slop && p.y >= ch.bounds.y - slop && p.y <= ch.bounds.y + ch.bounds.height + slop)
      setHit(c ? { c, x: e.clientX, y: e.clientY } : null)
    }
    const onLeave = () => setHit(null)
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerleave', onLeave)
    return () => {
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerleave', onLeave)
    }
  }, [debug, ordered, scale, page.rotation, info.width, info.height])

  if (!layout) return null
  const chunks = Object.values(layout.chunks).filter((c) => debug || (showBoxes && STRUCTURAL.has(c.type)))
  const box = (c: LayoutChunk, pad = 0): React.CSSProperties => ({
    position: 'absolute',
    left: (c.bounds.x - pad) * scale,
    top: (c.bounds.y - pad) * scale,
    width: Math.max(1, (c.bounds.width + 2 * pad) * scale),
    height: Math.max(1, (c.bounds.height + 2 * pad) * scale),
  })

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0" style={{ zIndex: 6 }} data-layout-layer={layout.provider}>
      {chunks.map((c) => {
        const color = CHUNK_COLORS[c.type]
        const thin = c.type === 'TEXT_SPAN' || c.type === 'TEXT_LINE' || c.type === 'TABLE_ROW'
        const strong = c.type === 'TABLE' || c.type === 'LIST' || c.type === 'HEADING'
        const isEdited = edited.has(c.source.objectId ?? c.id)
        return (
          <div
            key={c.id}
            data-chunk-id={c.id}
            data-chunk-type={c.type}
            style={{
              ...box(c, c.type === 'LINE' ? 1 : 0),
              outline: `${strong ? 1.5 : 1}px ${thin || isEdited ? 'dashed' : 'solid'} ${isEdited ? '#9ca3af' : color}`,
              outlineOffset: c.type === 'LIST' || c.type === 'TABLE' ? 2 : 0,
              background: debug && hit?.c === c ? `${color}22` : showBoxes && !debug && c.type !== 'TABLE' && c.type !== 'LIST' ? `${color}0d` : undefined,
            }}
          />
        )
      })}
      {debug &&
        layout.roots.map((id) => {
          const c = layout.chunks[id]
          if (c.type === 'LINE' || c.type === 'RECTANGLE') return null
          return (
            <div key={`t-${id}`} className="absolute font-mono text-[9px] font-medium leading-none text-white" style={{ left: c.bounds.x * scale - 1, top: c.bounds.y * scale - 11, background: CHUNK_COLORS[c.type], padding: '1px 3px' }}>
              {chunkTag(c)}
            </div>
          )
        })}
      {debug && hit && createPortal(<Inspector c={hit.c} layout={layout} x={hit.x} y={hit.y} />, document.body)}
    </div>
  )
}

function Inspector({ c, layout, x, y }: { c: LayoutChunk; layout: LayoutPage; x: number; y: number }) {
  const parent = c.parent ? layout.chunks[c.parent] : null
  const kids = c.children.map((k) => layout.chunks[k]).filter(Boolean)
  const b = c.bounds
  const left = Math.min(x + 16, window.innerWidth - 336)
  const top = y + 18 + 260 > window.innerHeight ? Math.max(8, y - 270) : y + 18
  const row = (k: string, v: React.ReactNode) => (
    <div className="flex gap-2">
      <span className="w-[62px] shrink-0 text-muted">{k}</span>
      <span className="min-w-0 flex-1 break-words">{v}</span>
    </div>
  )
  return (
    <div className="pointer-events-none fixed z-[100] w-[320px] border border-ink bg-white p-2.5 font-mono text-[10.5px] leading-[1.5] text-ink shadow-xl" style={{ left, top }}>
      <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
        <span className="inline-block h-2 w-2" style={{ background: CHUNK_COLORS[c.type] }} />
        {c.type}
        {c.role ? ` / ${c.role}` : ''}
        {c.level ? ` / H${c.level}` : ''}
      </div>
      {row('id', c.id)}
      {row('page', `${c.pageIndex + 1} (source) · ${layout.provider}`)}
      {row('bbox', `x ${b.x.toFixed(1)}  y ${b.y.toFixed(1)}  w ${b.width.toFixed(1)}  h ${b.height.toFixed(1)} pt`)}
      {c.style && row('font', `${c.style.fontFamily} (${c.style.fontName || '?'}) → ${c.style.fallbackFont}`)}
      {c.style && row('size', `${c.style.fontSize}pt · ${c.style.fontWeight}${c.style.italic ? ' italic' : ''} · ${c.style.color ?? '?'} · ${c.style.alignment} · lh ${c.style.lineHeight}`)}
      {c.table && row('table', `${c.table.rows} × ${c.table.columns} · ${c.table.kind}`)}
      {c.cell && row('cell', `r${c.cell.row} c${c.cell.col} · span ${c.cell.rowSpan}×${c.cell.colSpan}${c.cell.header ? ' · header' : ''}`)}
      {c.line && row('line', `(${c.line.x1.toFixed(0)},${c.line.y1.toFixed(0)})→(${c.line.x2.toFixed(0)},${c.line.y2.toFixed(0)}) · ${c.line.strokeWidth.toFixed(2)}pt · ${c.line.color ?? '?'}`)}
      {c.shape && row('shape', `fill ${c.shape.fill ?? 'none'} · stroke ${c.shape.stroke ?? 'none'}`)}
      {row('parent', parent ? `${chunkTag(parent)} ${parent.id}` : '(page)')}
      {row('children', kids.length ? `${kids.length}: ${kids.slice(0, 4).map(chunkTag).join(', ')}${kids.length > 4 ? '…' : ''}` : '0')}
      {row('source', `${c.source.ops ? `${c.source.ops.length} ops ${c.source.opsExclusive ? '(exclusive)' : '(shared)'}` : c.source.path ?? c.source.provider}${c.editable ? ' · editable' : ''}`)}
      {c.text !== undefined && <div className="mt-1.5 line-clamp-4 whitespace-pre-wrap border-t border-line-soft pt-1.5 font-sans text-[11px]">{snippet(c.text, 280) || '(empty)'}</div>}
    </div>
  )
}
