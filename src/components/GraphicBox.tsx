import { useRef, useState } from 'react'
import { rotateDelta } from '../lib/geom'
import type { GraphicOverlay } from '../lib/model'

type Corner = 'nw' | 'ne' | 'sw' | 'se' | 'w' | 'e' | 'n' | 's'
interface Props {
  overlay: GraphicOverlay
  /** Picture of the original image (data URL), drawn at the new place. */
  snapshot?: string
  scale: number
  rotation: number
  selected: boolean
  interactive: boolean
  onSelect: () => void
  onChange: (patch: Partial<GraphicOverlay>, coalesce?: string) => void
}

/** A moved / resized line, rectangle or image (the original is hidden underneath). */
export function GraphicBox({ overlay: o, snapshot, scale, rotation, selected, interactive, onSelect, onChange }: Props) {
  const drag = useRef<{ kind: 'move' | Corner; sx: number; sy: number; box: { x: number; y: number; w: number; h: number } } | null>(null)
  const [live, setLive] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  if (o.deleted) return null
  const b = live ?? o
  const isLine = o.kind === 'line'
  const horizontal = o.w >= o.h

  const begin = (e: React.PointerEvent, kind: 'move' | Corner) => {
    if (!interactive || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    onSelect()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { kind, sx: e.clientX, sy: e.clientY, box: { x: o.x, y: o.y, w: o.w, h: o.h } }
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const r = rotateDelta(e.clientX - d.sx, e.clientY - d.sy, rotation)
    const dx = r.x / scale
    const dy = r.y / scale
    const s = d.box
    let n = { ...s }
    if (d.kind === 'move') n = { ...s, x: s.x + dx, y: s.y + dy }
    else {
      if (d.kind.includes('w')) n = { ...n, x: s.x + Math.min(dx, s.w - 2), w: Math.max(2, s.w - dx) }
      if (d.kind.includes('e')) n = { ...n, w: Math.max(2, s.w + dx) }
      if (d.kind.includes('n')) n = { ...n, y: s.y + Math.min(dy, s.h - 2), h: Math.max(2, s.h - dy) }
      if (d.kind.includes('s')) n = { ...n, h: Math.max(2, s.h + dy) }
    }
    setLive(n)
  }
  const end = () => {
    const d = drag.current
    drag.current = null
    if (d && live) onChange({ x: live.x, y: live.y, w: live.w, h: live.h }, `${d.kind === 'move' ? 'mv' : 'rs'}:${o.id}`)
    setLive(null)
  }

  const style: React.CSSProperties = {
    position: 'absolute',
    left: b.x * scale,
    top: b.y * scale,
    width: Math.max(1, b.w * scale),
    height: Math.max(1, b.h * scale),
    pointerEvents: interactive ? 'auto' : 'none',
    cursor: interactive ? 'move' : undefined,
  }
  let body: React.ReactNode
  if (isLine) body = <div style={{ position: 'absolute', inset: 0, background: o.strokeColor ?? '#000' }} />
  else if (o.kind === 'rect')
    body = <div style={{ position: 'absolute', inset: 0, background: o.fillColor ?? 'transparent', boxShadow: o.strokeColor ? `inset 0 0 0 ${Math.max(1, o.thickness * scale)}px ${o.strokeColor}` : undefined }} />
  else {
    body = snapshot ? <img src={snapshot} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} /> : <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(45deg,#e5e5e5 0 6px,#f5f5f5 6px 12px)' }} />
  }

  const handles: Corner[] = isLine ? (horizontal ? ['w', 'e'] : ['n', 's']) : ['nw', 'ne', 'sw', 'se']
  const hpos = (c: Corner): React.CSSProperties => ({
    left: c.includes('w') ? -5 : c.includes('e') ? 'calc(100% - 3px)' : 'calc(50% - 4px)',
    top: c.includes('n') ? -5 : c.includes('s') ? 'calc(100% - 3px)' : 'calc(50% - 4px)',
    cursor: c === 'w' || c === 'e' ? 'ew-resize' : c === 'n' || c === 's' ? 'ns-resize' : c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
  })
  return (
    <div style={style} data-overlay-id={o.id} onPointerDown={(e) => begin(e, 'move')} onPointerMove={move} onPointerUp={end}>
      {/* generous hit area for thin rules */}
      {isLine && <div style={{ position: 'absolute', left: horizontal ? 0 : -5, right: horizontal ? 0 : -5, top: horizontal ? -5 : 0, bottom: horizontal ? -5 : 0 }} />}
      {body}
      {selected && interactive && (
        <>
          <div className="obj-selected" style={{ inset: -3 }} />
          {handles.map((c) => (
            <div key={c} className="handle" style={hpos(c)} onPointerDown={(e) => begin(e, c)} onPointerMove={move} onPointerUp={end} />
          ))}
        </>
      )}
    </div>
  )
}
