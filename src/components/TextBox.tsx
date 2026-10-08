import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { rotateDelta } from '../lib/geom'
import { LINE_HEIGHT, type FontFamily, type TextOverlay } from '../lib/model'

export const CSS_FONTS: Record<FontFamily, string> = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", "Helvetica Neue", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
}

interface Props {
  overlay: TextOverlay
  scale: number
  /** Extra page rotation in degrees (pointer deltas must be un-rotated). */
  rotation: number
  selected: boolean
  editing: boolean
  /** Where the user clicked, to place the caret when entering edit mode. */
  caretAt: { x: number; y: number } | null
  onSelect: () => void
  onStartEdit: (at: { x: number; y: number } | null) => void
  onStopEdit: (e: React.FocusEvent | null) => void
  onChange: (patch: Partial<TextOverlay>, coalesce?: string) => void
}

type Drag =
  | { kind: 'move'; sx: number; sy: number; ox: number; oy: number; moved: boolean; clickToEdit: boolean }
  | { kind: 'left' | 'right'; sx: number; sy: number; ox: number; ow: number }

export function TextBox({ overlay: o, scale, rotation, selected, editing, caretAt, onSelect, onStartEdit, onStopEdit, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [live, setLive] = useState<{ x: number; y: number; width: number } | null>(null)

  // The DOM owns the text while editing (so the caret never jumps); React only
  // writes it when it differs from what the model says (undo/redo, external edits).
  useLayoutEffect(() => {
    const el = ref.current
    if (el && el.textContent !== o.text) el.textContent = o.text
  }, [o.text])

  useEffect(() => {
    const el = ref.current
    if (!editing || !el) return
    el.focus({ preventScroll: true })
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    let placed = false
    if (caretAt) {
      const doc = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
        caretRangeFromPoint?: (x: number, y: number) => Range | null
      }
      const r = doc.caretRangeFromPoint?.(caretAt.x, caretAt.y)
      const pos = doc.caretPositionFromPoint?.(caretAt.x, caretAt.y)
      if (r && el.contains(r.startContainer)) {
        sel.removeAllRanges()
        sel.addRange(r)
        placed = true
      } else if (pos && el.contains(pos.offsetNode)) {
        range.setStart(pos.offsetNode, pos.offset)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        placed = true
      }
    }
    if (!placed) {
      range.selectNodeContents(el)
      range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const x = live?.x ?? o.x
  const y = live?.y ?? o.y
  const width = live?.width ?? o.width

  const begin = (e: React.PointerEvent, d: Drag) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = d
  }

  const onBodyDown = (e: React.PointerEvent) => {
    if (editing || e.button !== 0) return
    onSelect()
    begin(e, { kind: 'move', sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, moved: false, clickToEdit: true })
  }

  const onGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    onSelect()
    begin(e, { kind: 'move', sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, moved: false, clickToEdit: false })
  }

  const onResizeDown = (e: React.PointerEvent, side: 'left' | 'right') => {
    if (e.button !== 0) return
    const current = ref.current ? ref.current.offsetWidth / scale : o.width
    begin(e, { kind: side, sx: e.clientX, sy: e.clientY, ox: o.x, ow: Math.max(o.width, o.wrap ? o.width : current) })
  }

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const delta = rotateDelta(e.clientX - d.sx, e.clientY - d.sy, rotation)
    const dx = delta.x / scale
    const dy = delta.y / scale
    if (d.kind === 'move') {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return
      d.moved = true
      setLive({ x: d.ox + dx, y: d.oy + dy, width: o.width })
    } else if (d.kind === 'right') {
      setLive({ x: d.ox, y: o.y, width: Math.max(16, d.ow + dx) })
    } else {
      const nw = Math.max(16, d.ow - dx)
      setLive({ x: d.ox + d.ow - nw, y: o.y, width: nw })
    }
  }

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    const l = live
    setLive(null)
    if (d.kind === 'move') {
      if (d.moved && l) onChange({ x: l.x, y: l.y }, `mv:${o.id}`)
      else if (d.clickToEdit) onStartEdit({ x: e.clientX, y: e.clientY })
    } else if (l) {
      onChange({ x: l.x, width: l.width, wrap: true }, `rs:${o.id}`)
    }
  }

  const fs = o.fontSize * scale
  const showFrame = selected || editing
  return (
    <div
      style={{ position: 'absolute', left: x * scale, top: y * scale, width: o.wrap || live ? width * scale : undefined, minWidth: o.wrap ? undefined : width * scale, zIndex: showFrame ? 30 : 20, pointerEvents: 'auto' }}
      className="group"
      data-overlay-id={o.id}
    >
      <div
        ref={ref}
        className={`ov-text ${!editing ? 'cursor-move' : 'cursor-text'}`}
        style={{
          position: 'relative',
          fontFamily: CSS_FONTS[o.fontFamily],
          fontSize: fs,
          fontWeight: o.bold ? 700 : 400,
          fontStyle: o.italic ? 'italic' : 'normal',
          color: o.color,
          textAlign: o.align,
          whiteSpace: o.wrap || live ? 'pre-wrap' : 'pre',
          lineHeight: o.lineHeight ?? LINE_HEIGHT,
          minHeight: fs * (o.lineHeight ?? LINE_HEIGHT),
          textDecoration: o.underline ? 'underline' : undefined,
          textUnderlineOffset: '0.12em',
          outline: showFrame ? '1.5px solid #1075dc' : undefined,
          outlineOffset: 2,
          background: editing ? 'rgba(255,255,255,0.0)' : undefined,
          userSelect: editing ? 'text' : 'none',
        }}
        data-empty={o.text === '' ? 'true' : 'false'}
        data-placeholder="Type here"
        contentEditable={editing ? 'plaintext-only' : false}
        suppressContentEditableWarning
        spellCheck={false}
        role="textbox"
        aria-label="Text box"
        onPointerDown={onBodyDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onInput={(e) => onChange({ text: (e.currentTarget.textContent ?? '').replace(/ /g, ' ') }, `ov:${o.id}`)}
        onBlur={(e) => onStopEdit(e)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            ;(e.currentTarget as HTMLElement).blur()
          }
          e.stopPropagation()
        }}
        onPaste={(e) => {
          // plain text only
          e.preventDefault()
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
        }}
        onDragStart={(e) => e.preventDefault()}
      />
      {showFrame && (
        <>
          {/* move grip (works while editing, when the text itself is busy being edited) */}
          <div
            title="Drag to move"
            onPointerDown={onGripDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            className="absolute -top-[18px] left-[-3.5px] flex h-[14px] w-[22px] cursor-move items-center justify-center bg-sky-deep"
            style={{ touchAction: 'none' }}
          >
            <svg width="10" height="6" viewBox="0 0 10 6" fill="#fff">
              <circle cx="1.5" cy="1.5" r="1" /><circle cx="5" cy="1.5" r="1" /><circle cx="8.5" cy="1.5" r="1" />
              <circle cx="1.5" cy="4.5" r="1" /><circle cx="5" cy="4.5" r="1" /><circle cx="8.5" cy="4.5" r="1" />
            </svg>
          </div>
          {(['left', 'right'] as const).map((side) => (
            <div
              key={side}
              title="Drag to resize"
              onPointerDown={(e) => onResizeDown(e, side)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              className="absolute top-1/2 h-[14px] w-[8px] -translate-y-1/2 cursor-ew-resize border-[1.5px] border-sky-deep bg-white"
              style={{ [side === 'left' ? 'left' : 'right']: -7, touchAction: 'none' }}
            />
          ))}
        </>
      )}
    </div>
  )
}
