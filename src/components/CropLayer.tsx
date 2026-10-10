import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { clamp, screenToLocal } from '../lib/geom'
import { setCropSelection, useCropSelection } from '../lib/cropSelection'
import { visibleBox, type CropBox, type PageInfo, type PageModel } from '../lib/model'

type Handle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CURSORS: Record<Handle, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }

interface Drag {
  mode: 'new' | 'move' | Handle
  /** Pointer at the start (canonical page space). */
  x0: number
  y0: number
  start: CropBox
}

/** Box from the drag so far, kept inside the visible part of the page `v`. */
function dragBox(d: Drag, x: number, y: number, v: CropBox): CropBox {
  const vx1 = v.x + v.w
  const vy1 = v.y + v.h
  if (d.mode === 'new') {
    const cx = clamp(x, v.x, vx1)
    const cy = clamp(y, v.y, vy1)
    return { x: Math.min(d.x0, cx), y: Math.min(d.y0, cy), w: Math.abs(cx - d.x0), h: Math.abs(cy - d.y0) }
  }
  const s = d.start
  if (d.mode === 'move') {
    return { ...s, x: clamp(s.x + x - d.x0, v.x, vx1 - s.w), y: clamp(s.y + y - d.y0, v.y, vy1 - s.h) }
  }
  let l = s.x
  let t = s.y
  let r = s.x + s.w
  let b = s.y + s.h
  if (d.mode.includes('w')) l = clamp(s.x + x - d.x0, v.x, vx1)
  if (d.mode.includes('e')) r = clamp(s.x + s.w + x - d.x0, v.x, vx1)
  if (d.mode.includes('n')) t = clamp(s.y + y - d.y0, v.y, vy1)
  if (d.mode.includes('s')) b = clamp(s.y + s.h + y - d.y0, v.y, vy1)
  return { x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t) }
}

/**
 * Crop tool, like Apple Preview: drag on a page to select the area to keep (then move it or
 * resize it by its handles). The crop bar applies it. Lives in the page's full-size layer.
 */
export function CropLayer({ page, info, scale }: { page: PageModel; info: PageInfo; scale: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const sel = useCropSelection()
  const [drag, setDrag] = useState<Drag | null>(null)
  const box = sel?.pageId === page.id ? sel.box : null
  const v = visibleBox(page, info)

  const at = (e: ReactPointerEvent) => {
    const p = screenToLocal(e.clientX, e.clientY, ref.current!, page.rotation)
    return { x: p.x / scale, y: p.y / scale }
  }
  const begin = (e: ReactPointerEvent, mode: Drag['mode']) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const p = at(e)
    const x0 = mode === 'new' ? clamp(p.x, v.x, v.x + v.w) : p.x
    const y0 = mode === 'new' ? clamp(p.y, v.y, v.y + v.h) : p.y
    ref.current!.setPointerCapture(e.pointerId)
    setDrag({ mode, x0, y0, start: box ?? { x: x0, y: y0, w: 0, h: 0 } })
    if (mode === 'new') setCropSelection({ pageId: page.id, box: { x: x0, y: y0, w: 0, h: 0 } })
  }
  const onMove = (e: ReactPointerEvent) => {
    if (!drag) return
    const p = at(e)
    setCropSelection({ pageId: page.id, box: dragBox(drag, p.x, p.y, v) })
  }
  const onUp = () => {
    if (!drag) return
    setDrag(null)
    // a click (or a sliver) is not a selection
    if (box && (box.w < 4 || box.h < 4)) setCropSelection(null)
  }

  const S = (b: CropBox) => ({ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale })
  const fmt = (pt: number) => (pt / 72).toFixed(2)
  return (
    <div
      ref={ref}
      data-crop-layer
      className="absolute inset-0"
      style={{ zIndex: 6, cursor: 'crosshair', touchAction: 'none' }}
      onPointerDown={(e) => begin(e, 'new')}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {box && box.w > 0 && box.h > 0 && (
        <div
          data-crop-box
          className="absolute"
          style={{ ...S(box), boxShadow: '0 0 0 100000px rgba(20,20,20,0.42)', outline: '1px solid #fff', cursor: drag?.mode === 'move' ? 'grabbing' : 'move' }}
          onPointerDown={(e) => begin(e, 'move')}
        >
          <div className="pointer-events-none absolute inset-0 border border-dashed border-sky-deep" />
          {box.w * scale > 70 && box.h * scale > 22 && (
            <span className="pointer-events-none absolute left-1 top-1 bg-ink/80 px-1.5 py-[1px] font-mono text-[10.5px] text-white">
              {fmt(box.w)} × {fmt(box.h)} in
            </span>
          )}
          {HANDLES.map((h) => (
            <div
              key={h}
              data-crop-handle={h}
              className="absolute h-2.5 w-2.5 border border-sky-deep bg-white"
              style={{
                left: h.includes('w') ? -5 : h.includes('e') ? box.w * scale - 5 : (box.w * scale) / 2 - 5,
                top: h.includes('n') ? -5 : h.includes('s') ? box.h * scale - 5 : (box.h * scale) / 2 - 5,
                cursor: CURSORS[h],
              }}
              onPointerDown={(e) => begin(e, h)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
