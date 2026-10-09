import { useEffect, useRef, useState, type RefObject } from 'react'
import { useApp } from '../context'
import { canvasToScreen } from '../lib/coords'
import { getCachedContent } from '../lib/content/cache'
import { detectMargins, formatLength, UNIT_PT, type Margins, type Unit } from '../lib/margins'
import { groupBounds, pageItems } from '../lib/objects'
import type { PageModel } from '../lib/model'
import { measureOverlay } from './PageOverlays'

export const RULER = 20
const UNITS: Unit[] = ['in', 'cm', 'mm', 'pt']

interface Props {
  enabled: boolean
  scrollRef: RefObject<HTMLDivElement | null>
  /** Top of each page in the scroll content, and the content width (for centring). */
  tops: number[]
  contentW: number
  sizes: { w: number; h: number }[]
  scale: number
  children: React.ReactNode
}

/** Tick spacing (points) for a unit at a zoom: [minor, labelled major, mid]. */
function ticks(unit: Unit, scale: number): { minor: number; major: number; every: number } {
  const u = UNIT_PT[unit]
  if (unit === 'in') {
    const minor = scale * u / 8 >= 5 ? u / 8 : scale * u / 4 >= 5 ? u / 4 : u / 2
    return { minor, major: u, every: u / 2 }
  }
  if (unit === 'pt') {
    const major = scale >= 1.2 ? 50 : scale >= 0.6 ? 100 : 200
    return { minor: major / 10, major, every: major / 2 }
  }
  const cm = UNIT_PT.cm
  const minor = scale * cm / 10 >= 4 ? cm / 10 : cm / 2
  const major = scale * cm >= 22 ? cm : cm * 2
  return { minor, major, every: cm / 2 }
}

function Ruler({
  axis, length, origin, pageLen, scale, unit, margins, band, pointer, onMarginDrag, onMarginReset,
}: {
  axis: 'x' | 'y'
  length: number
  /** Screen offset (px) of the page's top/left edge inside the ruler. */
  origin: number
  pageLen: number
  scale: number
  unit: Unit
  /** [start, end] of the page's margins box (points), or null. */
  margins: [number, number] | null
  band: [number, number] | null
  pointer: number | null
  onMarginDrag: ((which: 0 | 1, pt: number) => void) | null
  onMarginReset: () => void
}) {
  const { minor, major, every } = ticks(unit, scale)
  const els: React.ReactNode[] = []
  const first = Math.ceil(-origin / scale / minor) * minor
  const last = (length - origin) / scale
  const u = UNIT_PT[unit]
  for (let v = first, i = 0; v <= last && i < 2000; v += minor, i += 1) {
    const p = origin + v * scale
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6
    const isMid = !isMajor && Math.abs(v / every - Math.round(v / every)) < 1e-6
    const h = isMajor ? 9 : isMid ? 6 : 3.5
    els.push(axis === 'x' ? <line key={i} x1={p} x2={p} y1={RULER - h} y2={RULER} /> : <line key={i} y1={p} y2={p} x1={RULER - h} x2={RULER} />)
    if (isMajor && Math.abs(v) > 1e-6) {
      const label = String(Math.round((v / u) * 100) / 100)
      els.push(
        axis === 'x' ? (
          <text key={`t${i}`} x={p + 2.5} y={9} fontSize={9}>{label}</text>
        ) : (
          <text key={`t${i}`} x={9} y={p + 2.5} fontSize={9} transform={`rotate(-90 9 ${p + 2.5})`}>{label}</text>
        ),
      )
    }
  }
  const dragRef = useRef<{ which: 0 | 1 } | null>(null)
  const lastDown = useRef<{ at: number; which: 0 | 1 }>({ at: 0, which: 0 })
  const pos = (e: React.PointerEvent) => {
    const r = (e.currentTarget.closest('svg') as SVGSVGElement).getBoundingClientRect()
    return ((axis === 'x' ? e.clientX - r.left : e.clientY - r.top) - origin) / scale
  }
  const page0 = origin
  const page1 = origin + pageLen * scale
  const rect = (a: number, b: number, fill: string, key: string) =>
    axis === 'x' ? <rect key={key} x={a} y={0} width={Math.max(0, b - a)} height={RULER} fill={fill} /> : <rect key={key} x={0} y={a} width={RULER} height={Math.max(0, b - a)} fill={fill} />
  return (
    <svg
      width={axis === 'x' ? length : RULER}
      height={axis === 'x' ? RULER : length}
      className="block select-none"
      data-ruler={axis}
      onPointerMove={(e) => {
        if (dragRef.current && onMarginDrag) onMarginDrag(dragRef.current.which, pos(e))
      }}
      onPointerUp={() => {
        dragRef.current = null
      }}
    >
      {rect(0, length, '#ececec', 'bg')}
      {rect(page0, page1, '#f6f6f6', 'page')}
      {margins && rect(origin + margins[0] * scale, origin + margins[1] * scale, '#ffffff', 'body')}
      {band && rect(origin + band[0] * scale, origin + band[1] * scale, 'rgba(63,166,238,0.28)', 'band')}
      <g stroke="#9a9a9a" strokeWidth={1} fill="#6b6b6b" fontFamily="IBM Plex Mono, monospace">
        {els}
      </g>
      {pointer !== null && (axis === 'x' ? <line x1={pointer} x2={pointer} y1={0} y2={RULER} stroke="#1075dc" /> : <line y1={pointer} y2={pointer} x1={0} x2={RULER} stroke="#1075dc" />)}
      {margins &&
        ([0, 1] as const).map((which) => {
          const p = origin + margins[which] * scale
          const label = `${axis === 'x' ? (which ? 'Right' : 'Left') : which ? 'Bottom' : 'Top'} margin: ${formatLength(which ? pageLen - margins[1] : margins[0], unit)}`
          const tri = axis === 'x' ? `${p - 5},${RULER} ${p + 5},${RULER} ${p},${RULER - 7}` : `${RULER},${p - 5} ${RULER},${p + 5} ${RULER - 7},${p}`
          return (
            <polygon
              key={which}
              points={tri}
              fill="#1075dc"
              data-margin={`${axis}${which}`}
              style={{ cursor: onMarginDrag ? (axis === 'x' ? 'ew-resize' : 'ns-resize') : 'default' }}
              onPointerDown={(e) => {
                // a second press within 350 ms resets (dblclick goes to the capturing svg, not here)
                const now = Date.now()
                if (now - lastDown.current.at < 350 && lastDown.current.which === which) {
                  lastDown.current = { at: 0, which }
                  onMarginReset()
                  return
                }
                lastDown.current = { at: now, which }
                if (!onMarginDrag) return
                e.preventDefault()
                ;(e.currentTarget.closest('svg') as SVGSVGElement).setPointerCapture(e.pointerId)
                dragRef.current = { which }
              }}
            >
              <title>{`${label}${onMarginDrag ? ' · drag to change, double-click to reset' : ''}`}</title>
            </polygon>
          )
        })}
    </svg>
  )
}

/**
 * Rulers along the top and left of the viewer, measured from the top-left of the page in view
 * (the selected object's page, else the current page), with its margins and the selection's extent.
 */
export function Rulers({ enabled, scrollRef, tops, contentW, sizes, scale, children }: Props) {
  const { state, currentIndex, rulerUnit, setRulerUnit, customMargins, setCustomMargins, objSel } = useApp()
  const [, force] = useState(0)
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const holder = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !enabled) return
    setBox({ w: el.clientWidth, h: el.clientHeight })
    const onScroll = () => force((n) => n + 1)
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      setPointer({ x: e.clientX - r.left, y: e.clientY - r.top })
    }
    const onLeave = () => setPointer(null)
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      ro.disconnect()
    }
  }, [scrollRef, enabled])

  if (!enabled)
    return (
      <div ref={holder} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {null}
        <div className="flex min-h-0 flex-1">
          {null}
          {children}
        </div>
      </div>
    )
  const selPageId = objSel?.pageId ?? state.selectedOverlay?.pageId ?? null
  const selIndex = selPageId ? state.pages.findIndex((p) => p.id === selPageId) : -1
  const index = selIndex >= 0 ? selIndex : Math.min(currentIndex, state.pages.length - 1)
  const page: PageModel | undefined = state.pages[index]
  const info = page ? state.sources[page.sourceId]?.pages[page.srcIndex] : undefined
  const el = scrollRef.current
  const sl = el?.scrollLeft ?? 0
  const st = el?.scrollTop ?? 0
  const size = sizes[index]
  const ox = size ? (contentW - size.w * scale) / 2 - sl : 0
  const oy = (tops[index] ?? 0) - st

  // margins and selection, in display space (the page as rotated in the app)
  const view = info && page ? { scale: 1, rotation: page.rotation, width: info.width, height: info.height } : null
  const toDisplay = (b: { x: number; y: number; w: number; h: number }) => {
    if (!view) return null
    const a = canvasToScreen({ x: b.x, y: b.y }, view)
    const c = canvasToScreen({ x: b.x + b.w, y: b.y + b.h }, view)
    return { x0: Math.min(a.x, c.x), x1: Math.max(a.x, c.x), y0: Math.min(a.y, c.y), y1: Math.max(a.y, c.y) }
  }
  const content = page ? getCachedContent(page.sourceId, page.srcIndex) : undefined
  const detected = detectMargins(content)
  const m: Margins | null = customMargins ?? detected
  const mBox = m && info ? toDisplay({ x: m.left, y: m.top, w: info.width - m.left - m.right, h: info.height - m.top - m.bottom }) : null

  let band: ReturnType<typeof toDisplay> = null
  if (page && objSel?.pageId === page.id) {
    const items = pageItems(content, page.overlays, (id) => measureOverlay(page.id, id)).filter((it) => objSel.keys.includes(it.key))
    const g = groupBounds(items)
    if (g) band = toDisplay(g)
  } else if (page && state.selectedOverlay?.pageId === page.id) {
    const b = measureOverlay(page.id, state.selectedOverlay.overlayId)
    if (b) band = toDisplay(b)
  }

  // dragging a margin marker (pages shown unrotated only): applies to every page
  const editable = !!page && page.rotation === 0 && !!info && !!m
  const dragMargin = (axis: 'x' | 'y') => (which: 0 | 1, pt: number) => {
    if (!info || !m) return
    const v = Math.round(Math.max(0, Math.min(axis === 'x' ? info.width : info.height, pt)) * 2) / 2
    const next = { ...m }
    if (axis === 'x') {
      if (which === 0) next.left = Math.min(v, info.width - m.right - 18)
      else next.right = Math.max(0, info.width - Math.max(v, m.left + 18))
    } else if (which === 0) next.top = Math.min(v, info.height - m.bottom - 18)
    else next.bottom = Math.max(0, info.height - Math.max(v, m.top + 18))
    setCustomMargins(next)
  }
  const pageW = size ? size.w : 0
  const pageH = size ? size.h : 0

  return (
    <div ref={holder} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 border-b border-line" style={{ height: RULER }}>
        <button
          type="button"
          title="Ruler units (click to change)"
          aria-label={`Ruler units: ${rulerUnit}`}
          onClick={() => setRulerUnit(UNITS[(UNITS.indexOf(rulerUnit) + 1) % UNITS.length])}
          className="shrink-0 border-r border-line bg-[#ececec] font-mono text-[9px] uppercase text-ink-soft hover:text-ink"
          style={{ width: RULER, height: RULER }}
        >
          {rulerUnit}
        </button>
        <Ruler
          axis="x"
          length={box.w}
          origin={ox}
          pageLen={pageW}
          scale={scale}
          unit={rulerUnit}
          margins={mBox ? [mBox.x0, mBox.x1] : null}
          band={band ? [band.x0, band.x1] : null}
          pointer={pointer ? pointer.x : null}
          onMarginDrag={editable ? dragMargin('x') : null}
          onMarginReset={() => setCustomMargins(null)}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="shrink-0 border-r border-line" style={{ width: RULER }}>
          <Ruler
            axis="y"
            length={box.h}
            origin={oy}
            pageLen={pageH}
            scale={scale}
            unit={rulerUnit}
            margins={mBox ? [mBox.y0, mBox.y1] : null}
            band={band ? [band.y0, band.y1] : null}
            pointer={pointer ? pointer.y : null}
            onMarginDrag={editable ? dragMargin('y') : null}
            onMarginReset={() => setCustomMargins(null)}
          />
        </div>
        {children}
      </div>
    </div>
  )
}
