import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { rotateDelta } from '../lib/geom'
import { LINE_HEIGHT, type FontFamily, type TextOverlay } from '../lib/model'
import { EMBEDDED_FONTS } from '../lib/fonts'
import { activeHighlight, hitHighlight, offsetsOf, rangeFor } from '../lib/highlights'
import { hasSuper, superHtml, toggleSuper } from '../lib/richText'

export const CSS_FONTS: Record<FontFamily, string> = {
  Helvetica: 'Helvetica, Arial, "Liberation Sans", "Helvetica Neue", sans-serif',
  Times: '"Times New Roman", Times, "Liberation Serif", serif',
  Courier: '"Courier New", Courier, "Liberation Mono", monospace',
  Calibri: EMBEDDED_FONTS.Calibri!.css,
  Cambria: EMBEDDED_FONTS.Cambria!.css,
  Georgia: EMBEDDED_FONTS.Georgia!.css,
  Garamond: EMBEDDED_FONTS.Garamond!.css,
  OpenSans: EMBEDDED_FONTS.OpenSans!.css,
  Roboto: EMBEDDED_FONTS.Roboto!.css,
  Lato: EMBEDDED_FONTS.Lato!.css,
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
  /** Search matches in this box (character offsets). */
  marks?: { start: number; end: number; active: boolean }[]
  /** Smart guides: proposed top-left + size → snapped top-left (`free` = snapping off). */
  snap?: (box: { x: number; y: number; w: number; h: number }, free: boolean) => { x: number; y: number }
  onDragEnd?: () => void
}

/** Toggles superscript on the selected characters of the box being edited (keeps the selection). */
export function toggleSuperInSelection(el: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || sel.isCollapsed) return false
  const off = offsetsOf(el, sel.getRangeAt(0))
  if (!off) return false
  const next = toggleSuper(sel.toString())
  document.execCommand('insertText', false, next)
  const r = rangeFor(el, off.start, off.start + next.length)
  if (r) {
    sel.removeAllRanges()
    sel.addRange(r)
  }
  return true
}

type Drag =
  | { kind: 'move'; sx: number; sy: number; ox: number; oy: number; moved: boolean; clickToEdit: boolean }
  | { kind: 'left' | 'right'; sx: number; sy: number; ox: number; ow: number }

export function TextBox({ overlay: o, scale, rotation, selected, editing, caretAt, onSelect, onStartEdit, onStopEdit, onChange, marks, snap, onDragEnd }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const [live, setLive] = useState<{ x: number; y: number; width: number } | null>(null)
  const html = useRef<string | null>(null)

  // The DOM owns the text while editing (so the caret never jumps); React only
  // writes it when it differs from what the model says (undo/redo, external edits).
  // Not editing, superscripts are drawn as smaller raised characters (like the export).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!editing && hasSuper(o.text)) {
      const h = superHtml(o.text, o.fontSize * scale)
      if (html.current !== h) {
        el.innerHTML = h
        html.current = h
      }
      return
    }
    if (el.textContent !== o.text || html.current !== null) {
      el.textContent = o.text
      html.current = null
    }
  }, [o.text, editing, o.fontSize, scale])

  // search matches, painted with the CSS Custom Highlight API
  const marksKey = marks?.map((m) => `${m.start}-${m.end}-${m.active ? 1 : 0}`).join(',') ?? ''
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !marks?.length || !hitHighlight || !activeHighlight) return
    const placed: { r: Range; active: boolean }[] = []
    for (const m of marks) {
      const r = rangeFor(el, m.start, m.end)
      if (!r) continue
      ;(m.active ? activeHighlight : hitHighlight).add(r)
      placed.push({ r, active: m.active })
    }
    return () => placed.forEach((p) => (p.active ? activeHighlight : hitHighlight)!.delete(p.r))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marksKey, o.text, editing, scale])
  const activeMark = marks?.find((m) => m.active)
  useEffect(() => {
    if (activeMark) ref.current?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMark?.start, activeMark?.end, !!activeMark])

  // panel buttons: superscript on the selection
  useEffect(() => {
    if (!editing) return
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ overlayId: string }>).detail
      if (d.overlayId === o.id && ref.current) toggleSuperInSelection(ref.current)
    }
    window.addEventListener('toolbox:superscript', on)
    return () => window.removeEventListener('toolbox:superscript', on)
  }, [editing, o.id])

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
      let nx = d.ox + dx
      let ny = d.oy + dy
      const el = ref.current
      if (snap && el) {
        const p = snap({ x: nx, y: ny, w: el.offsetWidth / scale, h: el.offsetHeight / scale }, e.altKey)
        nx = p.x
        ny = p.y
      }
      setLive({ x: nx, y: ny, width: o.width })
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
    onDragEnd?.()
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
          textDecoration: [o.underline && 'underline', o.strike && 'line-through'].filter(Boolean).join(' ') || undefined,
          textUnderlineOffset: '0.12em',
          outline: showFrame ? '1.5px solid #1075dc' : undefined,
          outlineOffset: 2,
          background: editing ? 'rgba(255,255,255,0.0)' : undefined,
          userSelect: editing ? 'text' : 'none',
        }}
        data-empty={editing && o.text === '' ? 'true' : 'false'}
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
          const mod = e.metaKey || e.ctrlKey
          // ⇧⌘= superscript (Word's shortcut); ⌘F / ⌘G are the find bar's
          if (mod && e.shiftKey && (e.key === '+' || e.key === '=')) {
            e.preventDefault()
            toggleSuperInSelection(e.currentTarget as HTMLElement)
          }
          if (mod && /^[fg]$/i.test(e.key)) return
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
